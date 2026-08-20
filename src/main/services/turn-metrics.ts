/**
 * Per-turn metric collection.
 *
 * A turn is the unit that matters: one prompt in, one answer out, with an
 * unbounded amount of agent work in between. Everything interesting about how
 * Roxy performs lives INSIDE that gap - how many model round trips it took, how
 * many tools ran, how much context it burned, what it cost, whether it worked -
 * and none of it is visible from either end.
 *
 * WHY A COLLECTOR AND NOT `track()` CALLS IN THE LOOP
 *
 * The obvious implementation is to call `track()` at each interesting point in
 * the harness. That produces one event per model call and per tool call, which
 * for a single overnight run is thousands of events from one user - a fleet of
 * a few hundred installs would drown the ingest endpoint, and the rate limiter
 * would start shedding exactly the heaviest sessions, biasing every chart
 * toward light usage.
 *
 * So the harness accumulates into a per-turn collector and emits ONE summary
 * event when the turn ends. A 200-step overnight run reports the same single
 * event as a one-line question, with the depth captured as counters. That keeps
 * the volume proportional to *users* rather than to how hard they work.
 *
 * WHAT IT DELIBERATELY DOES NOT HOLD
 *
 * No prompt text, no file paths, no model ids, no error strings, no MCP server
 * names. The collector stores counters plus values already collapsed through
 * `shared/telemetry.ts`'s closed vocabularies. There is nothing in here that
 * could identify a person or a codebase, by construction rather than by
 * convention.
 *
 * LIFECYCLE. `beginTurn()` at the top of a session turn, mutations from the
 * harness as work happens, `finishTurn()` when it ends. The collector is keyed
 * by session id and held in a module map because the harness is deep and
 * threading a context object through every frame would touch fifty call sites
 * for no benefit. A turn that never finishes (process killed) simply leaves a
 * dead entry, which `beginTurn` overwrites and a size cap bounds.
 */
import {
  bucketCount,
  classifyTurnError,
  modelFamily,
  reportableToolName,
  roundUsd,
  safeTokens,
  type ModelFamily,
  type TurnErrorKind
} from '../../shared/telemetry'

/** What one in-flight turn has accumulated so far. */
interface TurnMetrics {
  startedAt: number
  /** Model round trips - the real measure of how hard the agent worked. */
  steps: number
  /** Tool executions, and how many of them failed. */
  tools: number
  toolErrors: number
  /**
   * Per-tool call/error counts, keyed by the already-collapsed safe name.
   *
   * Counts rather than a bare set of names: "grep ran 40 times this turn" and
   * "grep ran once" are different facts about how the agent works, and the
   * distinction is the whole reason to break tools out by name at all.
   */
  toolCounts: Map<string, { calls: number; errors: number }>
  /** Subagents spawned by this turn. */
  subagents: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  /** USD, priced from the models.dev catalog at record time. */
  costUsd: number
  /** Model family of the LAST model call - what actually served the turn. */
  family: ModelFamily | null
  /** Transient provider failures the harness rode out without the user seeing. */
  retries: number
  /** Whether the conversation was trimmed to fit the context window. */
  trimmed: boolean
}

/**
 * Live turns, keyed by session id.
 *
 * Bounded: a leaked entry (a turn whose process died mid-flight) is ~200 bytes
 * and would otherwise accumulate for the life of the app. The cap is far above
 * any plausible number of concurrent sessions, so it only ever evicts garbage.
 */
const MAX_LIVE_TURNS = 64
const live = new Map<string, TurnMetrics>()

function fresh(): TurnMetrics {
  return {
    startedAt: Date.now(),
    steps: 0,
    tools: 0,
    toolErrors: 0,
    toolCounts: new Map(),
    subagents: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    family: null,
    retries: 0,
    trimmed: false
  }
}

/**
 * Start collecting for a session's turn. Replaces any previous collector for
 * the same session, which is correct: a session runs one turn at a time, so an
 * existing entry is a turn that died without finishing.
 */
export function beginTurn(sessionId: string): void {
  if (live.size >= MAX_LIVE_TURNS && !live.has(sessionId)) {
    // Evict the oldest rather than refusing to track the new turn - a stuck
    // entry should never be able to blind us to live traffic.
    const oldest = [...live.entries()].sort((a, b) => a[1].startedAt - b[1].startedAt)[0]
    if (oldest) live.delete(oldest[0])
  }
  live.set(sessionId, fresh())
}

/**
 * Mutate the collector for a session, if one is live.
 *
 * Every recorder goes through this so that a metric call from a code path with
 * no active turn (a background job, a subagent whose parent already finished)
 * is a silent no-op rather than a crash. Telemetry must never be able to break
 * a turn - that principle is worth more than the occasional lost counter.
 */
function edit(sessionId: string | undefined, fn: (m: TurnMetrics) => void): void {
  if (!sessionId) return
  const m = live.get(sessionId)
  if (!m) return
  try {
    fn(m)
  } catch {
    /* a metric must never throw into the harness */
  }
}

/** One model round trip completed, with whatever usage it reported. */
export function recordStep(
  sessionId: string | undefined,
  model: string,
  usage: { input: number; output: number; cacheRead: number } | null,
  costUsd: number
): void {
  edit(sessionId, (m) => {
    m.steps++
    // Last writer wins: a turn can switch models mid-flight (a subagent may run
    // a different one), and the model that produced the final answer is the one
    // the user experienced.
    m.family = modelFamily(model)
    if (usage) {
      m.inputTokens += safeTokens(usage.input)
      m.outputTokens += safeTokens(usage.output)
      m.cacheReadTokens += safeTokens(usage.cacheRead)
    }
    if (Number.isFinite(costUsd) && costUsd > 0) m.costUsd += costUsd
  })
}

/** One tool call finished. `name` is collapsed here so callers can't forget. */
export function recordTool(sessionId: string | undefined, name: string, ok: boolean): void {
  edit(sessionId, (m) => {
    m.tools++
    if (!ok) m.toolErrors++
    // Collapsed at the boundary: an MCP tool's qualified name (which embeds a
    // user-chosen server id) must never reach the map, let alone the wire.
    const key = reportableToolName(name)
    const cur = m.toolCounts.get(key)
    if (cur) {
      cur.calls++
      if (!ok) cur.errors++
      return
    }
    // Bounded. The names are already collapsed to a closed set, so this cap is
    // unreachable in practice - it exists so that a future addition to the
    // vocabulary can't turn this map into an unbounded allocation.
    if (m.toolCounts.size < 40) m.toolCounts.set(key, { calls: 1, errors: ok ? 0 : 1 })
  })
}

/** A subagent was delegated to. */
export function recordSubagent(sessionId: string | undefined): void {
  edit(sessionId, (m) => {
    m.subagents++
  })
}

/**
 * The harness rode out a transient provider failure.
 *
 * Invisible to the user by design - that's the point of the retry logic - which
 * is exactly why it's worth counting. A provider that silently costs us three
 * retries per turn is degrading, and this is the only place that shows it.
 */
export function recordRetry(sessionId: string | undefined): void {
  edit(sessionId, (m) => {
    m.retries++
  })
}

/** The rolling conversation was trimmed to fit the model's context window. */
export function recordTrim(sessionId: string | undefined): void {
  edit(sessionId, (m) => {
    m.trimmed = true
  })
}

/** The shape handed to `track('turn_end', ...)`. Scalars only. */
export interface TurnSummary extends Record<string, string | number | boolean> {
  ok: boolean
  outcome: string
  durationMs: number
  steps: number
  stepBucket: string
  tools: number
  toolErrors: number
  subagents: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  costUsd: number
  model: string
  retries: number
  trimmed: boolean
}

/**
 * Close out a turn and produce its summary, or null if nothing was collected.
 *
 * `errorKind` is only present on a failure, so a successful turn's props stay
 * small. Per-tool counts come back SEPARATELY rather than inside the summary:
 * they ship as their own `tool_use` events, because folding them into one prop
 * would mean either an unbounded joined string or a nested object, and the
 * server accepts neither.
 */
export function finishTurn(
  sessionId: string,
  outcome: 'ok' | 'stopped' | 'error',
  error?: { status?: number; text?: string }
): {
  summary: TurnSummary
  errorKind?: TurnErrorKind
  toolCounts: { tool: string; calls: number; errors: number }[]
} | null {
  const m = live.get(sessionId)
  if (!m) return null
  live.delete(sessionId)

  const summary: TurnSummary = {
    // Kept alongside `outcome` for continuity: the server has been receiving
    // `ok` since the first version of this event, and dropping it would put a
    // discontinuity through every historical chart at the release boundary.
    ok: outcome === 'ok',
    outcome,
    durationMs: Math.max(0, Date.now() - m.startedAt),
    steps: m.steps,
    stepBucket: bucketCount(m.steps),
    tools: m.tools,
    toolErrors: m.toolErrors,
    subagents: m.subagents,
    inputTokens: m.inputTokens,
    outputTokens: m.outputTokens,
    cacheReadTokens: m.cacheReadTokens,
    costUsd: roundUsd(m.costUsd),
    model: m.family ?? 'other',
    retries: m.retries,
    trimmed: m.trimmed
  }

  return {
    summary,
    errorKind: outcome === 'error' ? classifyTurnError(error?.status, error?.text) : undefined,
    toolCounts: [...m.toolCounts].map(([tool, c]) => ({
      tool,
      calls: c.calls,
      errors: c.errors
    }))
  }
}

/** Test-only: drop all in-flight collectors. */
export function _resetTurnMetrics(): void {
  live.clear()
}

/** Test-only: how many turns are currently being collected. */
export function _liveTurnCount(): number {
  return live.size
}
