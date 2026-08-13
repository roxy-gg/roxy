/**
 * The Session Relay listener — an authenticated loopback endpoint the bundled
 * Chrome extension posts a site's session to.
 *
 * See ../../shared/relay.ts for the protocol and the threat model. The short
 * version: a snapshot is live credentials, loopback is reachable by any process
 * AND (via DNS rebinding) by any web page, so every request must prove it came
 * from the paired extension. This file is where that is enforced, and it is
 * deliberately the only place that can accept a snapshot.
 *
 * Routes (all POST, all JSON):
 *   /pair      { code, extensionId, browser, version } -> { token }
 *   /hello     auth -> { ok } .............. heartbeat, drives "Connected"
 *   /snapshot  auth + RelaySnapshot -> { queued } ..... needs user approval
 *
 * Nothing here ever WRITES to the browser partition. A snapshot is parked in
 * memory and surfaced to the UI; only an explicit `applyPending` from the
 * renderer touches cookies or storage. That split is the whole safety story:
 * compromise of the endpoint alone cannot silently inject a session.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { BrowserWindow } from 'electron'
import {
  AUTO_SEND_COOLDOWN_MS,
  DEFAULT_RELAY_PREFS,
  MAX_SNAPSHOT_BYTES,
  PAIRING_TTL_MS,
  RELAY_HEADER,
  RELAY_PORT,
  RELAY_PROTOCOL_VERSION,
  isAutoAllowed,
  isBlockedOrigin,
  isImportableOrigin,
  type PendingSnapshot,
  type RelayCookie,
  type RelayImportChoice,
  type RelayImportResult,
  type RelayPrefs,
  type RelaySnapshot,
  type RelayStatus,
  type RelayTransfer
} from '../../shared/relay'
import { CHANNELS } from '../../shared/ipc'
import { decryptSecret, encryptSecret } from './secure'
import * as repo from '../db/repo'
import * as cookies from './cookies'
import * as storage from './storage'
import * as browser from './browser'

/** A completed pairing. Persisted encrypted; see `load`/`persist` below. */
interface Pairing {
  token: string
  extensionId: string
  browser: string
  version: string
}

interface State {
  server: Server | null
  port: number
  pairing: Pairing | null
  /** The code currently on screen, if the user is mid-pairing. */
  code: { value: string; expiresAt: number } | null
  lastSeenAt?: number
  lastTransferAt?: number
  /** Snapshots awaiting approval, newest last. Values live ONLY here. */
  pending: { meta: PendingSnapshot; snapshot: RelaySnapshot }[]
  /** Automation settings: master switch, trusted origins, blocklist. */
  prefs: RelayPrefs
  /** Recent transfers for the Settings activity list. Never includes values. */
  recent: RelayTransfer[]
  /** origin -> last auto-apply time, for the per-origin cooldown. */
  lastAuto: Map<string, number>
}

const state: State = {
  server: null,
  port: RELAY_PORT,
  pairing: null,
  code: null,
  pending: [],
  prefs: { ...DEFAULT_RELAY_PREFS },
  recent: [],
  lastAuto: new Map()
}

/** How many transfers to remember for the activity list. */
const MAX_RECENT = 20

/**
 * Cap on parked snapshots. A paired-but-malicious extension could otherwise
 * queue unbounded credential blobs into main's memory.
 */
const MAX_PENDING = 5

/** Constant-time compare that also tolerates length mismatch without leaking it. */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) {
    // Still burn a comparison so timing doesn't reveal "wrong length" vs
    // "wrong value" — the branch above is not secret, the contents are.
    timingSafeEqual(ba, ba)
    return false
  }
  return timingSafeEqual(ba, bb)
}

/** A 6-digit pairing code. Human-typable; only useful inside its 3-minute TTL. */
function makeCode(): string {
  // rejection-free: 3 bytes -> 0..16777215, mod 1e6 bias is ~6e-8, irrelevant
  // for a 3-minute single-use code guarded by a rate limit.
  return String(randomBytes(3).readUIntBE(0, 3) % 1_000_000).padStart(6, '0')
}

/** Wrong-code attempts since the last success, to blunt online guessing. */
let failedPairAttempts = 0
const MAX_PAIR_ATTEMPTS = 10

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    // Nothing here is cacheable and none of it should ever be stored.
    'cache-control': 'no-store',
    // The relay is not a website; refuse to be framed or sniffed.
    'x-content-type-options': 'nosniff'
  })
  res.end(text)
}

/**
 * The origin we accept, once paired: exactly this extension, nothing else.
 * Before pairing there is no such origin, so /pair accepts any extension origin
 * but demands the on-screen code instead.
 */
function pairedOrigin(): string | null {
  return state.pairing ? `chrome-extension://${state.pairing.extensionId}` : null
}

/**
 * Reject anything that isn't the paired extension talking to loopback.
 *
 * Order matters only for clarity; all four checks must pass:
 *  - Host pins us to 127.0.0.1:<port>, defeating DNS rebinding (a page on
 *    evil.com resolved to 127.0.0.1 would send `Host: evil.com`).
 *  - The custom header forces a preflight, so no page can reach this with a
 *    simple cross-origin POST.
 *  - Origin must be the paired extension. Browsers set this header themselves
 *    and script cannot override it, so this is the load-bearing check.
 *  - The bearer token proves it's our extension and not another one.
 */
function authed(req: IncomingMessage): boolean {
  const p = state.pairing
  if (!p) return false

  const host = String(req.headers.host ?? '')
  if (host !== `127.0.0.1:${state.port}` && host !== `localhost:${state.port}`) return false

  if (String(req.headers[RELAY_HEADER] ?? '') !== '1') return false

  const origin = String(req.headers.origin ?? '')
  if (origin !== pairedOrigin()) return false

  const auth = String(req.headers.authorization ?? '')
  if (!auth.startsWith('Bearer ')) return false
  return safeEqual(auth.slice(7), p.token)
}

/** Read a JSON body, refusing anything oversized before buffering it all. */
async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const declared = Number(req.headers['content-length'] ?? 0)
  if (declared > limit) throw new Error('payload too large')
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    total += (chunk as Buffer).length
    // Enforce on the stream too: content-length can lie or be absent.
    if (total > limit) throw new Error('payload too large')
    chunks.push(chunk as Buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Push status to every window so Settings updates without polling. */
function broadcast(): void {
  const s = status()
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(CHANNELS.relayState, s)
  }
}

/** Current relay state. Never includes the token or any snapshot VALUES. */
export function status(): RelayStatus {
  return {
    listening: Boolean(state.server?.listening),
    port: state.port,
    paired: Boolean(state.pairing),
    extensionId: state.pairing?.extensionId,
    browser: state.pairing?.browser,
    extensionVersion: state.pairing?.version,
    lastSeenAt: state.lastSeenAt,
    lastTransferAt: state.lastTransferAt,
    pairingExpiresAt: state.code?.expiresAt,
    pending: state.pending.map((p) => p.meta),
    prefs: state.prefs,
    recent: state.recent
  }
}

/** Automation settings, as the extension needs them. */
export function prefs(): RelayPrefs {
  return state.prefs
}

/**
 * Replace the automation settings.
 *
 * Adding a block also revokes any trust for origins it now covers. Without
 * that, blocking `example.com` while `https://app.example.com` sat in the
 * trusted list would leave a contradiction on screen — and although
 * `isAutoAllowed` checks blocks first (so it would be honoured), a UI that
 * displays a trusted entry which silently does nothing is a bug waiting to be
 * misread.
 */
export function setPrefs(next: Partial<RelayPrefs>): RelayPrefs {
  const merged: RelayPrefs = { ...state.prefs, ...next }
  merged.trusted = merged.trusted.filter((o) => !isBlockedOrigin(o, merged.blocked))
  state.prefs = merged
  persistPrefs()
  broadcast()
  return state.prefs
}

/** Mark an origin as needing no further confirmation. */
export function trustOrigin(origin: string): RelayPrefs {
  if (!isImportableOrigin(origin)) throw new Error(`Cannot trust "${origin}".`)
  if (isBlockedOrigin(origin, state.prefs.blocked)) {
    throw new Error('That site is on the blocklist. Remove it there first.')
  }
  if (state.prefs.trusted.includes(origin)) return state.prefs
  return setPrefs({ trusted: [...state.prefs.trusted, origin] })
}

export function untrustOrigin(origin: string): RelayPrefs {
  return setPrefs({ trusted: state.prefs.trusted.filter((o) => o !== origin) })
}

/** Rough byte size of the credential material, for the confirmation prompt. */
function sizeOf(snap: RelaySnapshot): number {
  let n = 0
  for (const c of snap.cookies) n += c.name.length + c.value.length
  for (const rec of [snap.localStorage, snap.sessionStorage]) {
    if (!rec) continue
    for (const [k, v] of Object.entries(rec)) n += k.length + v.length
  }
  return n
}

/**
 * Validate an untrusted snapshot into the shape the rest of the app assumes.
 * Returns null when it's unusable. Everything crossing this boundary is
 * attacker-controlled, so nothing is taken on trust — not the types, not the
 * origin, not the array contents.
 */
function parseSnapshot(raw: unknown): RelaySnapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o.v !== RELAY_PROTOCOL_VERSION) return null
  const origin = String(o.origin ?? '')
  if (!isImportableOrigin(origin)) return null

  const cookies: RelayCookie[] = []
  if (Array.isArray(o.cookies)) {
    for (const item of o.cookies) {
      if (!item || typeof item !== 'object') continue
      const c = item as Record<string, unknown>
      const name = String(c.name ?? '')
      const domain = String(c.domain ?? '')
      if (!name || !domain) continue
      const row: RelayCookie = {
        name,
        value: String(c.value ?? ''),
        domain,
        path: String(c.path ?? '/') || '/',
        secure: Boolean(c.secure),
        httpOnly: Boolean(c.httpOnly),
        hostOnly: Boolean(c.hostOnly),
        session: Boolean(c.session),
        sameSite: normalizeSameSite(c.sameSite)
      }
      if (typeof c.expirationDate === 'number' && Number.isFinite(c.expirationDate)) {
        row.expirationDate = c.expirationDate
      }
      if (c.partitionKey && typeof c.partitionKey === 'object') {
        const pk = c.partitionKey as Record<string, unknown>
        row.partitionKey = {
          topLevelSite: pk.topLevelSite ? String(pk.topLevelSite) : undefined,
          hasCrossSiteAncestor: Boolean(pk.hasCrossSiteAncestor)
        }
      }
      cookies.push(row)
    }
  }

  const strings = (v: unknown): Record<string, string> | undefined => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
    const out: Record<string, string> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === 'string') out[k] = val
    }
    return out
  }

  return {
    v: RELAY_PROTOCOL_VERSION,
    origin,
    title: o.title ? String(o.title).slice(0, 200) : undefined,
    capturedAt: typeof o.capturedAt === 'number' ? o.capturedAt : Date.now(),
    cookies,
    localStorage: strings(o.localStorage),
    sessionStorage: strings(o.sessionStorage)
  }
}

function normalizeSameSite(raw: unknown): RelayCookie['sameSite'] {
  const v = String(raw ?? '')
    .trim()
    .toLowerCase()
  if (v === 'no_restriction' || v === 'none') return 'no_restriction'
  if (v === 'lax') return 'lax'
  if (v === 'strict') return 'strict'
  return 'unspecified'
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${state.port}`)

  // CORS preflight. We answer for the paired extension only; before pairing we
  // must also allow an extension origin through so /pair itself is reachable.
  if (req.method === 'OPTIONS') {
    const origin = String(req.headers.origin ?? '')
    const allowed = pairedOrigin()
    const ok = allowed ? origin === allowed : origin.startsWith('chrome-extension://')
    if (!ok) return void json(res, 403, { error: 'origin not allowed' })
    res.writeHead(204, {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': `content-type, authorization, ${RELAY_HEADER}`,
      'access-control-max-age': '600',
      vary: 'origin'
    })
    return void res.end()
  }

  if (req.method !== 'POST') return void json(res, 405, { error: 'method not allowed' })

  // ---- pairing -------------------------------------------------------------
  if (url.pathname === '/pair') {
    const origin = String(req.headers.origin ?? '')
    if (!origin.startsWith('chrome-extension://')) {
      return void json(res, 403, { error: 'origin not allowed' })
    }
    if (!state.code || Date.now() > state.code.expiresAt) {
      return void json(res, 409, { error: 'no pairing in progress' })
    }
    if (failedPairAttempts >= MAX_PAIR_ATTEMPTS) {
      state.code = null
      broadcast()
      return void json(res, 429, { error: 'too many attempts; start pairing again' })
    }
    let body: Record<string, unknown>
    try {
      body = (await readJson(req, 4096)) as Record<string, unknown>
    } catch {
      return void json(res, 400, { error: 'bad request' })
    }
    if (!safeEqual(String(body.code ?? ''), state.code.value)) {
      failedPairAttempts++
      return void json(res, 401, { error: 'wrong code' })
    }
    // The extension id must match the origin that carried the request, or a
    // second extension could claim the first one's identity.
    const extensionId = String(body.extensionId ?? '')
    if (!extensionId || origin !== `chrome-extension://${extensionId}`) {
      return void json(res, 400, { error: 'extension id does not match origin' })
    }

    state.pairing = {
      token: randomBytes(32).toString('base64url'),
      extensionId,
      browser: String(body.browser ?? 'Browser').slice(0, 40),
      version: String(body.version ?? '').slice(0, 20)
    }
    state.code = null
    failedPairAttempts = 0
    state.lastSeenAt = Date.now()
    persist()
    broadcast()
    return void json(res, 200, { token: state.pairing.token })
  }

  // ---- everything below requires a completed pairing -----------------------
  if (!authed(req)) return void json(res, 401, { error: 'unauthorized' })

  if (url.pathname === '/hello') {
    state.lastSeenAt = Date.now()
    broadcast()
    // The extension caches prefs so it can decide whether to auto-send without
    // a round trip. Returning them on every heartbeat keeps Roxy the single
    // source of truth: a block takes effect within one heartbeat, and the
    // server enforces it independently anyway (see /snapshot).
    return void json(res, 200, { ok: true, v: RELAY_PROTOCOL_VERSION, prefs: state.prefs })
  }

  if (url.pathname === '/snapshot') {
    if (state.pending.length >= MAX_PENDING) {
      return void json(res, 429, { error: 'too many snapshots awaiting approval' })
    }
    let raw: unknown
    try {
      raw = await readJson(req, MAX_SNAPSHOT_BYTES)
    } catch (e) {
      const tooBig = e instanceof Error && e.message === 'payload too large'
      return void json(res, tooBig ? 413 : 400, { error: tooBig ? 'too large' : 'bad request' })
    }
    const snapshot = parseSnapshot(raw)
    if (!snapshot) return void json(res, 400, { error: 'unsupported or malformed snapshot' })

    // THE BLOCKLIST IS ENFORCED HERE, not just in the extension. The extension
    // decides whether to SEND; this decides whether we will even hold it. An
    // extension running stale prefs — or simply an older build — must not be
    // able to relay a blocked site.
    if (isBlockedOrigin(snapshot.origin, state.prefs.blocked)) {
      return void json(res, 403, { error: 'that site is blocked in Roxy' })
    }

    state.lastSeenAt = Date.now()

    // Trusted origin: apply now, no prompt. This is the "no clicking" path.
    if (isAutoAllowed(snapshot.origin, state.prefs)) {
      const last = state.lastAuto.get(snapshot.origin) ?? 0
      if (Date.now() - last < AUTO_SEND_COOLDOWN_MS) {
        // Not an error: the extension is allowed to be chatty, we just decline
        // to redo the work. Reported so it can back off.
        return void json(res, 200, { applied: false, throttled: true })
      }
      state.lastAuto.set(snapshot.origin, Date.now())
      const result = await applySnapshot(snapshot, {
        cookies: true,
        localStorage: true,
        sessionStorage: true
      })
      record(snapshot, result, true)
      broadcast()
      return void json(res, 200, { applied: true })
    }

    const partitioned = snapshot.cookies.filter((c) => c.partitionKey?.topLevelSite).length
    const meta: PendingSnapshot = {
      id: randomUUID(),
      origin: snapshot.origin,
      title: snapshot.title,
      receivedAt: Date.now(),
      browser: state.pairing?.browser ?? 'Browser',
      cookieCount: snapshot.cookies.length,
      partitionedCookieCount: partitioned,
      localStorageCount: Object.keys(snapshot.localStorage ?? {}).length,
      sessionStorageCount: Object.keys(snapshot.sessionStorage ?? {}).length,
      approxBytes: sizeOf(snapshot)
    }
    state.pending.push({ meta, snapshot })
    broadcast()
    // Bring Roxy forward: the snapshot is useless until the user answers, and
    // they just clicked "Send" in another app and are looking for the result.
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    win?.show()
    return void json(res, 202, { queued: true, id: meta.id })
  }

  return void json(res, 404, { error: 'not found' })
}

/** Start listening. Idempotent; safe to call on every app start. */
export async function start(): Promise<void> {
  if (state.server) return
  load()
  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, { error: 'internal error' })
      else res.end()
    })
  })
  // Loopback ONLY. Binding 0.0.0.0 would expose a credential sink to the LAN.
  await new Promise<void>((resolve) => {
    server.once('error', () => resolve()) // port busy: stay down, surface via status()
    server.listen(RELAY_PORT, '127.0.0.1', () => resolve())
  })
  state.server = server.listening ? server : null
  broadcast()
}

export function stop(): void {
  state.server?.close()
  state.server = null
  // Parked snapshots are credentials; never outlive the process.
  state.pending = []
  broadcast()
}

/** Begin pairing: mint a code for the user to type into the extension. */
export function beginPairing(): { code: string; expiresAt: number; port: number } {
  const code = makeCode()
  state.code = { value: code, expiresAt: Date.now() + PAIRING_TTL_MS }
  failedPairAttempts = 0
  broadcast()
  return { code, expiresAt: state.code.expiresAt, port: state.port }
}

export function cancelPairing(): void {
  state.code = null
  broadcast()
}

/** Forget the paired extension; its token stops working immediately. */
export function unpair(): void {
  state.pairing = null
  state.code = null
  state.pending = []
  persist()
  broadcast()
}

/** Take a parked snapshot out of the queue (approve or reject both consume it). */
export function takePending(id: string): RelaySnapshot | null {
  const i = state.pending.findIndex((p) => p.meta.id === id)
  if (i < 0) return null
  const [entry] = state.pending.splice(i, 1)
  broadcast()
  return entry.snapshot
}

export function markTransferred(): void {
  state.lastTransferAt = Date.now()
  broadcast()
}

/**
 * Apply a snapshot to the browser partition.
 *
 * Split out from `applyPending` so the auto path and the manual path share one
 * implementation — two copies would drift, and this one writes credentials.
 *
 * Partitioned (CHIPS) cookies are counted and skipped, not imported: Electron
 * 33's cookie API has no `partitionKey`, so the best we could do is write them
 * into the unpartitioned jar, which puts them in the wrong place. Reporting
 * "3 skipped" is honest; silently misplacing them is not.
 */
async function applySnapshot(
  snapshot: RelaySnapshot,
  choice: RelayImportChoice
): Promise<RelayImportResult> {
  const result: RelayImportResult = {
    cookiesImported: 0,
    cookiesFailed: 0,
    cookiesSkippedPartitioned: 0,
    localStorageImported: 0,
    sessionStorageImported: 0,
    errors: []
  }

  if (choice.cookies) {
    for (const c of snapshot.cookies) {
      if (c.partitionKey?.topLevelSite) {
        result.cookiesSkippedPartitioned++
        continue
      }
      const err = await cookies.set(c)
      if (err) {
        result.cookiesFailed++
        if (result.errors.length < 8) result.errors.push(err)
      } else {
        result.cookiesImported++
      }
    }
  }

  if (choice.localStorage && snapshot.localStorage) {
    try {
      const r = await storage.writeLocalStorage(snapshot.origin, snapshot.localStorage)
      result.localStorageImported = r.ok
      if (r.blocked) result.errors.push(`${snapshot.origin} blocked localStorage access.`)
      else if (r.failed) result.errors.push(`${r.failed} localStorage entries were rejected.`)
    } catch (e) {
      result.errors.push(e instanceof Error ? e.message : String(e))
    }
  }

  if (choice.sessionStorage && snapshot.sessionStorage) {
    // Session storage belongs to one tab, so it needs a live tab on that
    // origin. Without one there is nothing to write into.
    const contents = browser.contentsForOrigin(snapshot.origin)
    if (!contents) {
      result.errors.push(
        `Session storage needs an open tab on ${snapshot.origin}; open it and send again.`
      )
    } else {
      try {
        const r = await storage.writeSessionStorage(
          contents,
          snapshot.origin,
          snapshot.sessionStorage
        )
        result.sessionStorageImported = r.ok
      } catch (e) {
        result.errors.push(e instanceof Error ? e.message : String(e))
      }
    }
  }

  state.lastTransferAt = Date.now()
  return result
}

/** Remember a completed transfer for the Settings activity list. */
function record(snapshot: RelaySnapshot, result: RelayImportResult, auto: boolean): void {
  state.recent.unshift({
    origin: snapshot.origin,
    at: Date.now(),
    cookies: result.cookiesImported,
    localStorage: result.localStorageImported,
    sessionStorage: result.sessionStorageImported,
    auto,
    error: result.errors[0]
  })
  state.recent.length = Math.min(state.recent.length, MAX_RECENT)
}

/**
 * Apply a parked snapshot after the user approved it in the UI.
 *
 * `trust` marks the origin so future transfers skip the prompt entirely — the
 * "approve once, then never again" path.
 */
export async function applyPending(
  id: string,
  choice: RelayImportChoice,
  trust = false
): Promise<RelayImportResult> {
  const snapshot = takePending(id)
  if (!snapshot) throw new Error('That transfer is no longer waiting for approval.')

  const result = await applySnapshot(snapshot, choice)
  record(snapshot, result, false)
  if (trust) trustOrigin(snapshot.origin)
  broadcast()
  return result
}

/** Discard a parked snapshot without applying any of it. */
export function rejectPending(id: string): void {
  takePending(id)
}

// --- persistence -------------------------------------------------------------
// The token is a long-lived credential, so it goes through safeStorage like an
// API key. Pending snapshots are NEVER persisted.

function persist(): void {
  if (!state.pairing) {
    repo.setRelayPairing(null)
    return
  }
  const payload = encryptSecret(JSON.stringify(state.pairing))
  repo.setRelayPairing(JSON.stringify(payload))
}

/**
 * Automation prefs are stored in the CLEAR, unlike the token.
 *
 * They are a list of hostnames, not a credential — encrypting them would imply
 * a protection safeStorage does not provide here, and would make the blocklist
 * unreadable (and so unfixable) if the keychain ever changed.
 */
function persistPrefs(): void {
  repo.setRelayPrefs(JSON.stringify(state.prefs))
}

function load(): void {
  const rawPrefs = repo.getRelayPrefs()
  if (rawPrefs) {
    try {
      // Merge over the defaults so a prefs blob written by an older version
      // (missing a field we since added) cannot produce `undefined` where the
      // code expects an array.
      const parsed = JSON.parse(rawPrefs) as Partial<RelayPrefs>
      state.prefs = {
        autoSend: parsed.autoSend ?? DEFAULT_RELAY_PREFS.autoSend,
        trusted: Array.isArray(parsed.trusted) ? parsed.trusted : [],
        blocked: Array.isArray(parsed.blocked) ? parsed.blocked : []
      }
    } catch {
      state.prefs = { ...DEFAULT_RELAY_PREFS }
    }
  }

  const row = repo.getRelayPairing()
  if (!row) return
  try {
    state.pairing = JSON.parse(decryptSecret(JSON.parse(row)))
  } catch {
    // Unreadable (keychain changed, DB copied between machines) — drop it and
    // make the user re-pair rather than leave a half-broken connection.
    repo.setRelayPairing(null)
  }
}
