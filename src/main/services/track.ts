/**
 * Anonymous usage tracking.
 *
 * WHAT IT SENDS: a random UUID minted once at install, an event name, and the
 * coarse build facts (platform, arch, app version, stable/dev). No account, no
 * IP, no file paths, no prompt text, no model, no repo names. The server HMACs
 * the id before storing it, so a row cannot be mapped back to the id this client
 * holds.
 *
 * THE EXCEPTIONS ARE ALL CLOSED VOCABULARIES. Some events carry a little shape:
 * which PROVIDER served a turn, which model FAMILY, which built-in TOOL ran,
 * which KIND of error ended it. Every one of those values is produced by a
 * classifier in `shared/telemetry.ts` that maps ANY input to a fixed set of
 * strings shipped in this repo, and `sanitize` below re-applies the provider
 * allow-list at the queue boundary. The wire format therefore cannot express a
 * model id, an MCP server name, a file path, or an error message - not by
 * convention, but because no code path can put one there.
 *
 * The classifiers fail safe: an id nobody anticipated becomes `other` rather
 * than leaking. A private endpoint is configured against the shipped
 * `openai-compatible` seed id (its URL lives in a different column entirely and
 * is never passed here), so that install is indistinguishable from every other
 * custom-endpoint install.
 *
 * COUNTERS, NOT CONTENT. `turn_end` carries how many model steps a turn took,
 * how many tools it ran, how many tokens it burned and what it cost. Those are
 * measures of how much work happened, never of what the work was.
 *
 * WHY IT'S SHAPED LIKE THIS:
 *  - **Never blocks the app.** Every call is fire-and-forget and every failure
 *    is swallowed. Analytics must not be able to break, slow, or crash a launch.
 *  - **Queued and batched.** Events accumulate and flush on a timer, so a user
 *    on a plane doesn't lose their session and we don't make one HTTP request
 *    per action.
 *  - **Idempotent.** Each event carries a `clientId`; the server dedupes on it,
 *    so re-sending a failed batch can't inflate the numbers.
 *  - **Opt-out is real.** `setTrackingEnabled(false)` stops collection *and*
 *    drops anything already queued.
 *
 * The install id and the opt-out live in their own JSON file, NOT in the
 * settings table: a factory reset (`repo.resetAll`) wipes settings, and someone
 * who opted out must stay opted out across one. It also means tracking has no
 * dependency on the database being open or mid-migration.
 */
import { isSeedProviderId } from '../../shared/providers'
import { isFeatureId, type ActivationMilestone, type FeatureId } from '../../shared/telemetry'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/** Production ingest endpoint. Read per-request so tests can point it at a stub. */
function endpoint(): string {
  return process.env.ROXY_TRACK_ENDPOINT || 'https://roxy.gg/track'
}

/** Events the server accepts. Anything else is dropped server-side. */
export type TrackEvent =
  /** App launched. The DAU heartbeat — sent exactly once per process start. */
  | 'app_open'
  /**
   * A turn was submitted to the agent. The "real usage" signal. Carries
   * `{ provider, agent }` - an allow-listed provider id (or `other`), and
   * which agent mode was driving (build/plan/subagent).
   */
  | 'prompt'
  /**
   * An agent turn finished - the richest event we send, and the one that makes
   * the difference between "someone pressed enter" and "we know how this
   * product performs".
   *
   * Carries `{ ok, outcome, durationMs, steps, stepBucket, tools, toolErrors,
   * subagents, inputTokens, outputTokens, cacheReadTokens, costUsd, model,
   * retries, trimmed }` and, on a failure, `errorKind`. `model` is a coarse
   * FAMILY (`claude-sonnet`, `gpt-5`, `llama`), never a model id.
   */
  | 'turn_end'
  /**
   * One built-in tool was used during a turn, with how many times and how many
   * of those failed. Emitted per distinct tool at the END of a turn rather than
   * per call: a long autonomous run makes hundreds of tool calls, and one event
   * each would swamp the ingest endpoint with the heaviest sessions - biasing
   * every chart toward light usage.
   *
   * Carries `{ tool, calls, errors }`. `tool` is a built-in name or the literal
   * `mcp`; an MCP server's own name is never sent.
   */
  | 'tool_use'
  /**
   * A one-time-per-install activation milestone (`provider_connected`,
   * `first_prompt`, `first_turn_ok`). Carries `{ milestone }`.
   *
   * Sent at most once ever, tracked in the same JSON file as the install id, so
   * the counts form a real funnel instead of being dominated by whoever
   * relaunches the app most.
   */
  | 'activation'
  /**
   * A provider was connected. Carries `{ provider }`. Distinct from `prompt`'s
   * provider: this is "what did people set up", which is a different question
   * from "what did they end up using", and the gap between the two is where
   * broken onboarding hides.
   */
  | 'provider_connect'
  /**
   * A capability surface was used for the first time in a session. Carries
   * `{ feature }` from the fixed `FeatureId` set. Deduped per session so one
   * enthusiastic user can't manufacture a trend.
   */
  | 'feature'
  /** Keeps a long-running session counted as active on later days. */
  | 'heartbeat'
  /** Remote Workspace paired with a phone. */
  | 'remote_pair'
  /** The app updated itself (first launch on a new version). */
  | 'update'
  /** Clean shutdown. */
  | 'app_close'

/** Only scalars — the server rejects nested objects and arrays anyway. */
type Props = Record<string, string | number | boolean>

/**
 * The server caps a batch at 50 events and drops the excess, so a turn that
 * would emit more `tool_use` events than this reports only its most-used tools.
 * Well above a normal turn's distinct-tool count; it exists so a pathological
 * run can't spend the whole batch on one event type.
 */
const MAX_TOOL_EVENTS_PER_TURN = 12

/**
 * Collapse a `provider` prop to the shipped seed list, mapping anything else to
 * `other`.
 *
 * Done HERE rather than at the call site so the guarantee is structural. The
 * provider is the one identifying-ish field this module sends, and the reason
 * it's safe to send is that it can only ever be one of ~50 ids already public in
 * this repo. A private id like `acme-internal-gateway` would be near-unique and
 * would tag every event this install ever sends - so it must be impossible to
 * report by construction, not merely absent from the current caller.
 *
 * The raw value is REPLACED, not copied alongside, or the allow-list would be
 * decorative.
 */
function sanitize(props?: Props): Props | undefined {
  if (!props || !('provider' in props)) return props
  const raw = props.provider
  return {
    ...props,
    provider: typeof raw === 'string' && isSeedProviderId(raw) ? raw : 'other'
  }
}

interface QueuedEvent {
  name: TrackEvent
  clientId: string
  ts: number
  props?: Props
}

interface StoredState {
  deviceId?: string
  enabled?: boolean
  /** Last version that reported an `app_open`, so we can detect an update. */
  appVersion?: string
  /**
   * Activation milestones already reported, so each is sent at most once EVER.
   *
   * Stored next to the install id rather than in the settings table for the
   * same reason the id is: a factory reset wipes settings, and someone whose
   * `first_prompt` was re-reported after a reset would appear in the funnel
   * twice, quietly inflating the one number that is supposed to be a count of
   * distinct people getting through onboarding.
   */
  activated?: string[]
}

const FLUSH_INTERVAL_MS = 30_000
const HEARTBEAT_INTERVAL_MS = 30 * 60_000
/** The server caps a batch at 50; stay under it. */
const MAX_QUEUE = 40
const REQUEST_TIMEOUT_MS = 8_000

let queue: QueuedEvent[] = []
let deviceId: string | null = null
let enabled = true
let flushTimer: NodeJS.Timeout | null = null
let heartbeatTimer: NodeJS.Timeout | null = null
/** `ROXY_TRACK_DISABLE=1` — a hard machine-level kill the toggle can't undo. */
let forcedOff = false

/** Where the install id lives. Persisting it is what makes retention possible. */
function stateFilePath(): string {
  return join(app.getPath('userData'), 'install-id.json')
}

function readState(): StoredState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(stateFilePath(), 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as StoredState
  } catch {
    /* first run, or unreadable — treat as empty */
  }
  return {}
}

/** Best-effort persist. A read-only profile must not break anything. */
function writeState(next: StoredState): void {
  try {
    writeFileSync(stateFilePath(), JSON.stringify(next), 'utf8')
  } catch {
    /* non-fatal — the id just won't survive this launch */
  }
}

/** Turn tracking on/off and persist the choice. Wired to the Settings toggle. */
export function setTrackingEnabled(next: boolean): boolean {
  if (forcedOff) return false
  if (next === enabled) return enabled
  enabled = next

  if (!next) {
    // Opting out has to be immediate: drop the queue, stop the timers, and let
    // go of the id in memory. Nothing further is collected or sent.
    queue = []
    stopTimers()
    persist()
    deviceId = null
    return enabled
  }

  // Opting back in. Reuse the stored id if there is one so this doesn't look
  // like a brand-new install, and mint one otherwise.
  const state = readState()
  deviceId =
    typeof state.deviceId === 'string' && state.deviceId.length >= 8 ? state.deviceId : randomUUID()
  persist()
  startTimers()
  return enabled
}

/** Write the current id + opt-out, keeping whatever else is in the file. */
function persist(): void {
  const state = readState()
  writeState({ ...state, deviceId: deviceId ?? state.deviceId, enabled })
}

export function isTrackingEnabled(): boolean {
  return enabled
}

/**
 * Record an event. Cheap, synchronous, and safe to call from anywhere — it only
 * appends to an in-memory queue.
 */
export function track(name: TrackEvent, props?: Props): void {
  if (!enabled || !deviceId) return
  if (queue.length >= MAX_QUEUE) return // shed rather than grow without bound
  queue.push({ name, clientId: randomUUID(), ts: Date.now(), props: sanitize(props) })
}

/**
 * Report an activation milestone, at most once per install, ever.
 *
 * The dedupe is persisted rather than in-memory because the milestones span
 * launches by definition: `first_prompt` usually happens in a different session
 * from `provider_connected`, and an in-memory guard would re-report every one
 * of them on every restart - turning a funnel into a launch counter.
 *
 * Returns whether it actually reported, which the tests assert on.
 */
export function markActivation(milestone: ActivationMilestone): boolean {
  if (!enabled || !deviceId) return false
  const state = readState()
  const seen = Array.isArray(state.activated) ? state.activated : []
  if (seen.includes(milestone)) return false
  writeState({ ...state, activated: [...seen, milestone] })
  track('activation', { milestone })
  return true
}

/**
 * Per-session feature dedupe.
 *
 * In memory, unlike activation: the question here is "how many SESSIONS use
 * subagents", so re-reporting across launches is correct and desirable. What we
 * must avoid is counting the same session's 200 subagent spawns as 200 signals,
 * which would make one overnight run look like a fleet-wide trend.
 *
 * Bounded so a long-lived process with many sessions can't grow it without
 * limit; evicting just means a later session re-reports, which is harmless.
 */
const featuresSeen = new Set<string>()
const MAX_FEATURE_KEYS = 500

/** Report that a session used a capability surface, once per session. */
export function trackFeature(sessionId: string | undefined, feature: FeatureId): void {
  if (!enabled || !deviceId) return
  if (!isFeatureId(feature)) return
  const key = `${sessionId ?? 'global'}\u0000${feature}`
  if (featuresSeen.has(key)) return
  if (featuresSeen.size >= MAX_FEATURE_KEYS) featuresSeen.clear()
  featuresSeen.add(key)
  track('feature', { feature })
}

/**
 * Report per-tool usage for a finished turn.
 *
 * Takes the whole map at once so the cap is applied to the turn as a unit -
 * emitting these one at a time from the caller would make it impossible to
 * bound a turn's share of the batch.
 */
export function trackToolUse(tools: { tool: string; calls: number; errors: number }[]): void {
  if (!enabled || !deviceId) return
  // Busiest first, so if a turn exceeds the cap the tools that get dropped are
  // the ones that ran once, not the one that ran two hundred times.
  const ranked = [...tools].sort((a, b) => b.calls - a.calls).slice(0, MAX_TOOL_EVENTS_PER_TURN)
  for (const t of ranked) track('tool_use', { tool: t.tool, calls: t.calls, errors: t.errors })
}

/**
 * Send whatever is queued.
 *
 * On failure the batch goes BACK on the queue: each event keeps its original
 * `clientId`, so the server dedupes the retry and the counts stay honest.
 */
export async function flush(): Promise<void> {
  if (!enabled || !deviceId || queue.length === 0) return

  const batch = queue
  queue = []

  try {
    const res = await fetch(endpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId,
        platform: process.platform,
        arch: process.arch,
        appVersion: app.getVersion(),
        channel: app.isPackaged ? 'stable' : 'dev',
        events: batch
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })

    // 4xx means we sent something malformed — retrying won't fix it, so drop
    // the batch instead of looping forever. 5xx and network errors are worth a
    // retry, since the events are idempotent.
    if (!res.ok && res.status >= 500) throw new Error(`status ${res.status}`)
  } catch {
    // Requeue, oldest first, without letting the backlog grow unbounded.
    queue = [...batch, ...queue].slice(0, MAX_QUEUE)
  }
}

/**
 * Call once from the main process after `app.whenReady()`.
 *
 * Set `ROXY_TRACK_DISABLE=1` to opt a whole machine out without touching the
 * stored preference — handy for CI, smoke runs, and contributors who don't want
 * their dev builds counted.
 */
export function initTracking(): void {
  if (process.env.ROXY_TRACK_DISABLE === '1') {
    forcedOff = true
    enabled = false
    return
  }

  const state = readState()
  if (state.enabled === false) enabled = false
  // Someone who opted out gets no id at all — not a stored one we promise never
  // to send. There is nothing to leak if it was never generated.
  if (!enabled) return

  const existing =
    typeof state.deviceId === 'string' && state.deviceId.length >= 8 ? state.deviceId : null
  deviceId = existing ?? randomUUID()

  const version = app.getVersion()
  // A different version than last launch means an update landed and restarted
  // into this build. Only meaningful once we've seen a previous launch — a
  // fresh install is an install, not an update.
  const updated = Boolean(state.appVersion) && state.appVersion !== version
  if (!existing || state.appVersion !== version) {
    writeState({ ...state, deviceId, enabled, appVersion: version })
  }

  // The DAU heartbeat.
  track('app_open')
  if (updated) track('update')
  void flush()

  startTimers()
}

/** Idempotent: start the flush + heartbeat timers if they aren't already up. */
function startTimers(): void {
  if (flushTimer) return
  flushTimer = setInterval(() => void flush(), FLUSH_INTERVAL_MS)
  // Someone who leaves Roxy open for days is active on every one of those days.
  heartbeatTimer = setInterval(() => track('heartbeat'), HEARTBEAT_INTERVAL_MS)
  // Don't hold the event loop open on quit.
  flushTimer.unref?.()
  heartbeatTimer.unref?.()
}

function stopTimers(): void {
  if (flushTimer) clearInterval(flushTimer)
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  flushTimer = null
  heartbeatTimer = null
}

/**
 * Stop the timers and make a last attempt to drain the queue. Called from the
 * app's quit path; the flush is genuinely best-effort, since Electron won't
 * wait on a promise there.
 */
export function shutdownTracking(): void {
  stopTimers()
  track('app_close')
  void flush()
}

/** Test-only: drop all module state so each case starts from a known point. */
export function _resetTracking(): void {
  stopTimers()
  queue = []
  deviceId = null
  enabled = true
  forcedOff = false
  featuresSeen.clear()
}

/** Test-only: how many events are waiting to be sent. */
export function _queueDepth(): number {
  return queue.length
}
