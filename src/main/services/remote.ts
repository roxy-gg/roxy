/**
 * Remote Workspace — host side (desktop → roxy.gg relay).
 *
 * The desktop dials *out* to roxy.gg over a WebSocket and hosts the running
 * session for one or more phone **guests**. roxy.gg is a dumb pipe: it pairs a
 * guest (who entered the PIN) with this host and shuttles opaque JSON frames.
 * The desktop stays authoritative — a phone's prompt is run here through the
 * exact same `runSessionTurn` a local prompt uses, and every streamed event is
 * relayed back to the phone. Code and files never leave the machine.
 *
 * State is a single active share: the desktop mints one room and dials the relay
 * once, but the phone can roam the **entire workspace** — it lists every session
 * and switches between them freely, while the desktop's own active session stays
 * put. `start` mints + connects, `stop` tears down + revokes, and `remote:state`
 * pushes keep the desktop dialog live.
 */
import { BrowserWindow } from 'electron'
import { is } from '@electron-toolkit/utils'
import WebSocket from 'ws'
import { CHANNELS } from '../../shared/ipc'
import type { LlmEvent, RemotePhase, RemoteState, RemoteStartInput } from '../../shared/api'
import type { Message } from '../../shared/types'
import { PartsFold } from '../../shared/parts'
import * as repo from '../db/repo'
import { enqueuePrompt } from './automation'
import { stopTurn } from './turn-state'
import { track, trackFeature } from './track'
import { sessionCwd } from './workspace'
import {
  MAX_FRAME_BYTES,
  parseFrame,
  type HostFrame,
  type RemoteSessionInfo
} from './remote-protocol'
/**
 * Relay base. Prod dials roxy.gg; a dev build defaults to the local roxy.gg
 * (localhost:3000). Override with `ROXY_REMOTE_BASE` (e.g. a staging URL).
 */
const HTTP_BASE = (
  process.env.ROXY_REMOTE_BASE || (is.dev ? 'http://localhost:3000' : 'https://roxy.gg')
).replace(/\/$/, '')

/** ws(s):// origin derived from the http(s):// base. */
const WS_BASE = HTTP_BASE.replace(/^http/, 'ws')

/** Reconnect backoff (ms) after an unexpected host-socket drop; then give up. */
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 15_000]

/** The mint response from `POST /api/remote/sessions`. */
interface MintResponse {
  brokerId: string
  hostToken: string
  guestToken: string
  url: string
  pin: string
  expiresAt: number
}

/** Everything about the one active share. */
interface Share {
  brokerId: string
  hostToken: string
  url: string
  pin: string
  expiresAt: number
  /** The session the phone is currently viewing + prompting (it can switch). */
  currentSessionId: string
  socket: WebSocket | null
  guests: number
  phase: RemotePhase
  error?: string
  /** Live parts accumulators for in-flight turns, so a guest that joins/switches
   *  mid-turn can be seeded with the reply-so-far (keyed by sessionId). */
  liveTurns: Map<string, PartsFold>
  reconnectAttempts: number
  reconnectTimer: ReturnType<typeof setTimeout> | null
  /** True once we intentionally tear down, so `close` doesn't try to reconnect. */
  closing: boolean
  rev: number
}

let share: Share | null = null

// --- Public state ----------------------------------------------------------

const IDLE_STATE: RemoteState = { phase: 'idle', guests: 0, rev: 0 }

/** Project the internal share into the renderer-facing state. */
function toState(): RemoteState {
  if (!share) return { ...IDLE_STATE }
  return {
    phase: share.phase,
    brokerId: share.brokerId,
    url: share.url,
    pin: share.pin,
    sessionId: share.currentSessionId,
    guests: share.guests,
    expiresAt: share.expiresAt,
    error: share.error,
    rev: share.rev
  }
}

/** Push the current state to every open window (guarded against teardown). */
function broadcast(): void {
  const state = toState()
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(CHANNELS.remoteState, state)
  }
}

/** Bump the revision + push. Called on any status change or shared-session activity. */
function bump(patch?: Partial<Pick<Share, 'phase' | 'error' | 'guests' | 'expiresAt'>>): void {
  if (!share) return
  if (patch) Object.assign(share, patch)
  share.rev += 1
  broadcast()
}

// --- Frame helpers ---------------------------------------------------------

/** Send a host frame to the guests via the relay (dropped if oversized/closed). */
function sendFrame(frame: HostFrame): void {
  const sock = share?.socket
  if (!sock || sock.readyState !== WebSocket.OPEN) return
  const raw = JSON.stringify(frame)
  if (Buffer.byteLength(raw) > MAX_FRAME_BYTES) return
  sock.send(raw)
}

/**
 * Share-bound frame send: a no-op if `active` is no longer the current share
 * (stopped/replaced mid-turn), so a stale turn can't leak frames into a new one.
 */
function sendFrameFor(active: Share, frame: HostFrame): void {
  if (share === active) sendFrame(frame)
}

/** Share-bound bump: only bumps if `active` is still the current share. */
function bumpFor(active: Share): void {
  if (share === active) bump()
}

/**
 * Send the transcript snapshot for `sessionId`, trimming the oldest messages
 * until it fits the relay's frame cap (a fresh phone still gets the recent, most
 * relevant history). Tagged with `sessionId` so the phone can drop a snapshot
 * for a session it already switched away from.
 */
function sendSnapshot(sessionId: string): void {
  const sock = share?.socket
  if (!sock || sock.readyState !== WebSocket.OPEN) return
  const messages = repo.listMessages(sessionId)
  for (let start = 0; start < messages.length; start += 1) {
    const slice = messages.slice(start)
    const raw = JSON.stringify({ t: 'snapshot', sessionId, messages: slice })
    if (Buffer.byteLength(raw) <= MAX_FRAME_BYTES) {
      sock.send(raw)
      return
    }
    // A single trailing message that alone exceeds the cap: send a truncated
    // copy so the phone still gets a usable tail instead of an oversized (dropped) frame.
    if (slice.length === 1) {
      sock.send(JSON.stringify({ t: 'snapshot', sessionId, messages: [truncateMessage(slice[0])] }))
      return
    }
  }
  // No messages yet — send an empty snapshot so the phone leaves its loading state.
  sock.send(JSON.stringify({ t: 'snapshot', sessionId, messages: [] }))
}

/** Shrink one message so a snapshot of just it fits under the frame cap. */
function truncateMessage(m: Message): Message {
  // The serialized message carries the text twice (content + parts[].text), so
  // each copy gets half the frame, minus headroom for the JSON envelope/fields.
  const budget = Math.floor(MAX_FRAME_BYTES / 2) - 8_192
  let content = m.content
  if (Buffer.byteLength(content) > budget) {
    content = content.slice(0, budget) // ≤ budget UTF-16 units; tighten by bytes below
    while (content.length > 0 && Buffer.byteLength(content) > budget) {
      content = content.slice(0, Math.floor(content.length * 0.9))
    }
    content += '\n\n… (truncated)'
  }
  return { ...m, content, parts: [{ type: 'text', text: content }] }
}

/** Session title + workspace dir for the phone header. */
function sendMeta(sessionId: string): void {
  const chat = repo.getChat(sessionId)
  sendFrame({
    t: 'meta',
    sessionId,
    title: chat?.title,
    // Show the phone where work actually lands (the worktree, when there is one).
    cwd: sessionCwd(sessionId) || undefined
  })
}

/**
 * Mirror a session's pending prompt queue to the phone(s). The queue is the same
 * persisted `repo` queue the desktop uses, so both ends see one FIFO. Sent on
 * join/switch and whenever the queue changes (phone/desktop enqueue, dequeue, or
 * drain). Text-only — no image blobs cross the wire.
 */
function sendQueue(sessionId: string): void {
  sendFrame({
    t: 'queue',
    sessionId,
    items: repo.listQueue(sessionId).map((q) => ({ id: q.id, text: q.content }))
  })
}

/** Folder basename used to group sessions on the phone (mirrors the desktop sidebar). */
function projectName(workspacePath: string | null): string {
  if (!workspacePath) return '(no folder)'
  return workspacePath.split(/[\\/]/).filter(Boolean).pop() ?? workspacePath
}

/**
 * Build the workspace's session list for the phone switcher: every top-level
 * (`main`) session, most-recently-updated first, grouped by project on the phone.
 */
function buildSessionList(): RemoteSessionInfo[] {
  return repo
    .listChats()
    .filter((c) => c.kind === 'main')
    .map((c) => ({
      id: c.id,
      title: c.title,
      project: projectName(c.workspacePath),
      cwd: c.workspacePath ?? undefined,
      updatedAt: c.updatedAt,
      messageCount: repo.listMessages(c.id).length
    }))
}

/** Push the workspace session list + the current selection to the phone(s). */
function sendSessions(): void {
  if (!share) return
  sendFrame({ t: 'sessions', sessions: buildSessionList(), currentId: share.currentSessionId })
}

/**
 * Push a session's current turn state to the phone(s). If a turn is in flight we
 * include its accumulated parts so a guest that just joined/switched sees the
 * whole reply-so-far, not only the tail of subsequent deltas.
 */
function sendTurnState(sessionId: string): void {
  if (!share) return
  const acc = share.liveTurns.get(sessionId)
  if (acc) sendFrame({ t: 'turn', sessionId, state: 'running', parts: acc.parts })
  else sendFrame({ t: 'turn', sessionId, state: 'idle' })
}

/**
 * Switch the phone(s) to a different session. Only the phone view moves — the
 * desktop's own active session is untouched. We re-emit the list (to update the
 * highlighted current), then meta + snapshot + the target's live turn state.
 */
function switchSession(sessionId: string): void {
  const active = share
  if (!active) return
  if (!repo.getChat(sessionId)) {
    sendFrame({ t: 'error', message: 'That session no longer exists.' })
    return
  }
  active.currentSessionId = sessionId
  sendSessions()
  sendMeta(sessionId)
  sendSnapshot(sessionId)
  sendTurnState(sessionId)
  sendQueue(sessionId)
  // Surface the phone's current session to the desktop dialog + mirror logic.
  bump()
}

/** Phone prompts join the same durable queue as desktop and scheduled prompts. */
async function handlePrompt(sessionId: string, text: string): Promise<void> {
  const active = share
  if (!active || !text.trim()) return
  try {
    enqueuePrompt(sessionId, text)
    sendQueue(sessionId)
    bumpFor(active)
  } catch (error) {
    sendFrame({ t: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}
/**
 * Re-broadcast the shared queue to the phone(s) after a *desktop-side* change
 * (the renderer added/removed/reordered a queued prompt). Called from the queue
 * IPC handlers so both ends stay in sync regardless of who edited the queue.
 */
export function notifyQueueChanged(): void {
  if (share) sendQueue(share.currentSessionId)
}

/** Reconcile queued turns and out-of-band bot replies with the phone transcript. */
export function notifyTranscriptChanged(sessionId: string): void {
  if (share?.currentSessionId === sessionId) sendSnapshot(sessionId)
}

// --- Relaying a *desktop-driven* turn to the phone -------------------------

/** Opaque handle threading one local turn's relay state through the IPC layer. */
export interface LocalTurnRelay {
  active: Share
  sessionId: string
  acc: PartsFold
}

/**
 * Relay a *desktop-typed* turn to the phone(s) — the mirror of `runTurn` for
 * locally-driven prompts. The phone shows the same user bubble, streams the reply
 * token-by-token, and flushes it on end, exactly like a phone-typed turn appears
 * on the desktop. Returns a handle the caller feeds events into, or `null` when
 * nothing is shared (so the local `llm:start` path skips the per-token overhead).
 *
 * A live accumulator is registered in `liveTurns` so a phone that joins/switches
 * to this session mid-turn is still seeded with the reply-so-far via `sendTurnState`.
 * Only phones viewing this session react (`forCurrent`); one on another session
 * re-syncs from the snapshot when it switches back — code/files never cross.
 */
export function relayLocalTurnStart(sessionId: string, userText?: string): LocalTurnRelay | null {
  const active = share
  if (!active) return null
  const acc = new PartsFold()
  active.liveTurns.set(sessionId, acc)
  // `userText` mirrors the drained-queue announce path: the phone never echoed a
  // desktop-typed prompt, so it shows the bubble now and opens the streaming spinner.
  sendFrameFor(active, {
    t: 'turn',
    sessionId,
    state: 'running',
    userText: userText && userText.trim() ? userText : undefined
  })
  return { active, sessionId, acc }
}

/** Fan one streamed event of a desktop-driven turn to the phone(s). */
export function relayLocalTurnEvent(relay: LocalTurnRelay, event: LlmEvent): void {
  relay.acc.apply(event)
  sendFrameFor(relay.active, { t: 'delta', sessionId: relay.sessionId, event })
}

/**
 * Close out a relayed desktop turn: release the busy slot, drop the live
 * accumulator, and tell the phone(s) the turn is idle so they flush the streamed
 * reply into the transcript. The desktop persisted the reply itself (renderer
 * `finishTurn`); the phone's own authoritative snapshot reconciles it on the next
 * switch/reconnect.
 *
 * Queue ownership belongs to automation; relay teardown never drains or cancels it.
 */
export function relayLocalTurnEnd(relay: LocalTurnRelay): void {
  const { active, sessionId, acc } = relay
  if (active.liveTurns.get(sessionId) === acc) active.liveTurns.delete(sessionId)
  sendFrameFor(active, { t: 'turn', sessionId, state: 'idle' })
}

// --- Socket lifecycle ------------------------------------------------------

function connect(): void {
  const active = share
  if (!active) return
  const socket = new WebSocket(
    `${WS_BASE}/api/remote/ws?token=${encodeURIComponent(active.hostToken)}`
  )
  active.socket = socket

  socket.on('open', () => {
    if (share !== active) return
    active.reconnectAttempts = 0
    bump({ phase: 'live', error: undefined })
    // Sync the authoritative guest count / expiry from the relay after (re)connect.
    void refreshStatus()
  })

  socket.on('message', (data: WebSocket.RawData) => {
    if (share !== active) return
    onFrame(data.toString())
  })

  socket.on('close', () => {
    if (share !== active) return
    active.socket = null
    if (active.closing) return
    scheduleReconnect()
  })

  // Swallow socket errors — a following `close` drives reconnect/teardown.
  socket.on('error', () => undefined)
}

function scheduleReconnect(): void {
  const active = share
  if (!active || active.closing) return
  const delay = RECONNECT_DELAYS_MS[active.reconnectAttempts]
  if (delay === undefined) {
    bump({ phase: 'error', error: 'Lost connection to the relay.' })
    return
  }
  active.reconnectAttempts += 1
  bump({ phase: 'offline' })
  active.reconnectTimer = setTimeout(() => {
    if (share === active && !active.closing) connect()
  }, delay)
}

function onFrame(raw: string): void {
  const frame = parseFrame(raw)
  if (!frame || typeof frame.t !== 'string' || !share) return
  switch (frame.t) {
    case 'guest-joined': {
      // A pairing actually completed. Counted here rather than at share start:
      // opening a share nobody scans isn't someone using Remote Workspace.
      track('remote_pair')
      // Also recorded as a capability so it lands in the one feature-adoption
      // breakdown alongside subagents, MCP and the rest, rather than being the
      // one surface you have to remember to look up separately. Keyed globally:
      // pairing is an install-level act, not a session-level one.
      trackFeature(undefined, 'remote_pair')
      // A phone entered the PIN and paired — send it the workspace session list
      // plus the current session's transcript + live turn state.
      share.guests = typeof frame.guests === 'number' ? frame.guests : share.guests
      const current = share.currentSessionId
      sendSessions()
      sendMeta(current)
      sendSnapshot(current)
      sendTurnState(current)
      sendQueue(current)
      bump()
      break
    }
    case 'guest-left': {
      share.guests = typeof frame.guests === 'number' ? frame.guests : Math.max(0, share.guests - 1)
      bump()
      break
    }
    case 'list': {
      // Phone asked for a fresh workspace session list (opened the switcher).
      sendSessions()
      break
    }
    case 'switch': {
      // Phone tapped a different session in the switcher.
      if (typeof frame.sessionId === 'string') switchSession(frame.sessionId)
      break
    }
    case 'prompt': {
      // Prompts run against whatever session the phone is currently viewing.
      if (typeof frame.text === 'string') void handlePrompt(share.currentSessionId, frame.text)
      break
    }
    case 'abort': {
      stopTurn(share.currentSessionId)
      break
    }
    case 'dequeue': {
      // Phone tapped × on a queued prompt — drop it from the shared queue and
      // re-broadcast so both ends update. `bump` refreshes the desktop's view.
      if (typeof frame.id === 'string') {
        try {
          repo.removeQueueItem(frame.id)
        } catch (error) {
          sendFrame({ t: 'error', message: error instanceof Error ? error.message : String(error) })
        }
        sendQueue(share.currentSessionId)
        bump()
      }
      break
    }
    case 'bye': {
      // The relay tore the room down (expiry, PIN lockout, or capacity). Keep
      // the share in a terminal `error` phase so the dialog can explain why;
      // Start/Stop clears it.
      const reason = typeof frame.reason === 'string' ? frame.reason : 'Session ended.'
      teardown()
      bump({ phase: 'error', error: reason })
      break
    }
    default:
      break
  }
}

async function refreshStatus(): Promise<void> {
  const active = share
  if (!active) return
  try {
    const res = await fetch(`${HTTP_BASE}/api/remote/sessions/${active.brokerId}`)
    if (!res.ok) return
    const status = (await res.json()) as { guests?: number; expiresAt?: number }
    if (share !== active) return
    if (typeof status.guests === 'number') active.guests = status.guests
    if (typeof status.expiresAt === 'number') active.expiresAt = status.expiresAt
    broadcast()
  } catch {
    // Best-effort — deltas/counts still flow over the socket.
  }
}

/** Close the socket + clear timers for the active share (no server revoke). */
function teardown(): void {
  const active = share
  if (!active) return
  active.closing = true
  if (active.reconnectTimer) {
    clearTimeout(active.reconnectTimer)
    active.reconnectTimer = null
  }
  active.liveTurns.clear()
  const sock = active.socket
  active.socket = null
  if (sock) {
    sock.removeAllListeners()
    // `ws` can still emit 'error' while closing (esp. a CONNECTING socket); keep
    // a no-op handler attached so Node doesn't throw on an unhandled 'error'.
    sock.on('error', () => undefined)
    try {
      sock.close()
    } catch {
      sock.terminate()
    }
  }
}

/** Revoke the room on roxy.gg (host-token gated; idempotent). Best-effort. */
async function revoke(brokerId: string, hostToken: string): Promise<void> {
  try {
    await fetch(`${HTTP_BASE}/api/remote/sessions/${brokerId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${hostToken}` }
    })
  } catch {
    // The relay also reaps the room when the host socket drops + on TTL expiry.
  }
}

// --- Public API (called from IPC handlers) ---------------------------------

/**
 * Serialize lifecycle ops (start/stop) through a single chain so a double-click
 * or reentrant IPC can't mint two rooms and leak an orphan host socket.
 */
let lifecycle: Promise<unknown> = Promise.resolve()
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = lifecycle.then(fn, fn)
  lifecycle = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

/** Mint a room + open the host relay socket for a session. Returns the state. */
export function start(input: RemoteStartInput): Promise<RemoteState> {
  return enqueue(() => startInternal(input))
}

/** Tear down the active share + revoke its tokens (Stop sharing). Idempotent. */
export function stop(): Promise<RemoteState> {
  return enqueue(() => stopInternal())
}

async function startInternal(input: RemoteStartInput): Promise<RemoteState> {
  // Seed the phone's initial session with the desktop's active chat; if that's
  // gone (or none was passed), fall back to the most-recently-updated session so
  // the phone always opens onto something real and can switch from there.
  let sessionId = input.sessionId
  if (!sessionId || !repo.getChat(sessionId)) {
    const fallback = repo.listChats().find((c) => c.kind === 'main')
    if (!fallback) {
      return {
        ...IDLE_STATE,
        phase: 'error',
        error: 'Open a session first, then share your workspace.'
      }
    }
    sessionId = fallback.id
  }
  // Only one active share — stop any previous one first (internal, already serialized).
  if (share) await stopInternal()

  let mint: MintResponse
  try {
    const res = await fetch(`${HTTP_BASE}/api/remote/sessions`, { method: 'POST' })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(detail || `relay responded ${res.status}`)
    }
    mint = (await res.json()) as MintResponse
  } catch (e) {
    return {
      ...IDLE_STATE,
      phase: 'error',
      error: `Couldn't start sharing: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  share = {
    brokerId: mint.brokerId,
    hostToken: mint.hostToken,
    url: mint.url,
    pin: mint.pin,
    expiresAt: mint.expiresAt,
    currentSessionId: sessionId,
    socket: null,
    guests: 0,
    phase: 'starting',
    liveTurns: new Map(),
    reconnectAttempts: 0,
    reconnectTimer: null,
    closing: false,
    rev: 1
  }
  connect()
  broadcast()
  return toState()
}

async function stopInternal(): Promise<RemoteState> {
  const active = share
  if (!active) return { ...IDLE_STATE }
  const { brokerId, hostToken } = active
  teardown()
  share = null
  broadcast()
  await revoke(brokerId, hostToken)
  return { ...IDLE_STATE }
}

/** Current sharing status. */
export function status(): RemoteState {
  return toState()
}

/** Close the host socket on app quit (best-effort; the relay reaps on drop). */
export function shutdownRemote(): void {
  teardown()
  share = null
}
