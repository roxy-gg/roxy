/**
 * The Session Relay wire protocol — shared by the Electron main process, the
 * renderer, and the bundled Chrome extension.
 *
 * The relay moves a site's session (cookies + origin storage) from a real
 * browser into Roxy's browser partition, so you can debug a signed-in site
 * without signing in again. It is deliberately ONE-WAY (browser -> Roxy) and
 * deliberately manual: nothing is captured without a click in the extension,
 * and nothing is applied without a second confirmation inside Roxy.
 *
 * THREAT MODEL. A snapshot is live credentials. The relay listens on loopback,
 * which any process on the machine — and, via a form POST or an <img> tag, any
 * WEBSITE the user visits — can also reach. So the endpoint is not "local
 * therefore trusted". Every request must prove three things:
 *
 *   1. WHO: a bearer token issued during an explicit pairing handshake, held in
 *      the extension's own storage. Random web pages don't have it.
 *   2. WHERE FROM: an `Origin` of exactly `chrome-extension://<paired id>`.
 *      Browsers set `Origin` themselves and forbid pages from forging it, so
 *      this alone rejects every `https://evil.com` request even if the token
 *      somehow leaked.
 *   3. WHICH HOST: a `Host` header of `127.0.0.1:<port>`. Without this, an
 *      attacker who controls DNS can point `evil.com` at 127.0.0.1 and have the
 *      browser treat the relay as same-origin (DNS rebinding).
 *
 * Requests are also JSON-only with a required custom header, so they can never
 * be a simple/no-preflight cross-origin request from a page.
 *
 * WHY NOT NATIVE MESSAGING (yet). `chrome.runtime.connectNative` is a stronger
 * transport — no listening socket at all — but it needs a registered host
 * manifest plus a Windows registry key or a per-browser profile path on
 * macOS/Linux, and a separate stdio executable we'd have to ship and sign. The
 * loopback endpoint below reaches the same place with checks a reviewer can
 * read in one file. The extension talks to a small module boundary, so the
 * transport can be swapped later without touching the popup or this schema.
 */

/** Bumped when the snapshot shape changes incompatibly. */
export const RELAY_PROTOCOL_VERSION = 1

/**
 * The loopback port. Fixed so the extension can find Roxy without discovery
 * (an extension cannot read a file to learn a random port). Chosen well above
 * the dev-server range in `ports.ts` (3100-3999) so it never collides with a
 * session's own server.
 */
export const RELAY_PORT = 4317

/**
 * Required on every relay request. Custom headers force a CORS preflight, so a
 * web page cannot reach the relay with a "simple" request that skips one — and
 * our preflight only ever approves the paired extension's origin.
 */
export const RELAY_HEADER = 'x-roxy-relay'

/** How long a pairing code is valid. Short: it's read off a screen and typed. */
export const PAIRING_TTL_MS = 3 * 60 * 1000

/** Hard cap on a snapshot body. Generous for cookies, far below a memory risk. */
export const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024

/**
 * The bundled extension's ID.
 *
 * Fixed by the `key` field in its manifest.json, which pins the ID even when
 * the extension is loaded unpacked — without it Chrome derives an ID from the
 * install path, so every reinstall would produce a different origin and break
 * the pairing. Roxy authorizes exactly this one `chrome-extension://` origin.
 *
 * Derived as Chrome does: sha256 of the DER public key, first 16 bytes, each
 * nibble mapped 0-15 -> a-p. If the manifest key ever changes, this must too.
 */
export const RELAY_EXTENSION_ID = 'bekpajpbgjeloofgicpnkgahfllakeao'

/** One cookie as the extension sees it (`chrome.cookies.Cookie`). */
export interface RelayCookie {
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  hostOnly: boolean
  session: boolean
  sameSite: 'no_restriction' | 'lax' | 'strict' | 'unspecified'
  /** Seconds since epoch; absent for session cookies. */
  expirationDate?: number
  /**
   * Set when the cookie is partitioned (CHIPS). Carried so we can TELL the user
   * it was skipped — Electron 33's cookie API has no `partitionKey` field, so
   * such a cookie cannot be reproduced faithfully. Importing it unpartitioned
   * would put it in the wrong jar, which is worse than not importing it.
   */
  partitionKey?: { topLevelSite?: string; hasCrossSiteAncestor?: boolean }
}

/** Key/value pairs lifted from one origin's Web Storage. */
export type RelayStorage = Record<string, string>

/** What the extension sends after the user presses "Send session". */
export interface RelaySnapshot {
  v: typeof RELAY_PROTOCOL_VERSION
  /** The exact origin the storage belongs to, e.g. `https://app.example.com`. */
  origin: string
  /** Page title at capture time, purely to make the Roxy prompt legible. */
  title?: string
  capturedAt: number
  cookies: RelayCookie[]
  /** Absent when the user unticked it, or the page blocked access. */
  localStorage?: RelayStorage
  sessionStorage?: RelayStorage
}

/** A snapshot held in main, awaiting the user's confirmation in the UI. */
export interface PendingSnapshot {
  id: string
  origin: string
  title?: string
  receivedAt: number
  /** Which browser sent it, for the prompt ("Chrome wants to send…"). */
  browser: string
  cookieCount: number
  /** Partitioned cookies, counted separately: they are reported, not applied. */
  partitionedCookieCount: number
  localStorageCount: number
  sessionStorageCount: number
  /**
   * Byte size of the values, so the UI can say "12 cookies, 4 KB" without ever
   * shipping the values themselves to the renderer. Credentials stay in main
   * until the user approves the import.
   */
  approxBytes: number
}

/** Connection state, as the Settings UI renders it. */
export interface RelayStatus {
  /** The loopback listener is up. */
  listening: boolean
  port: number
  /** An extension has completed pairing and holds a live token. */
  paired: boolean
  /** The paired extension id, shown in the manage screen. */
  extensionId?: string
  /** Which browser paired, self-reported at pairing time. */
  browser?: string
  extensionVersion?: string
  lastSeenAt?: number
  lastTransferAt?: number
  /** A pairing code is on screen right now, and this is when it expires. */
  pairingExpiresAt?: number
  /** Snapshots waiting on the user's yes/no. */
  pending: PendingSnapshot[]
}

/** What the user chose to apply from a pending snapshot. */
export interface RelayImportChoice {
  cookies: boolean
  localStorage: boolean
  sessionStorage: boolean
}

/** Outcome of applying a snapshot. */
export interface RelayImportResult {
  cookiesImported: number
  cookiesFailed: number
  /** Partitioned cookies deliberately not applied (see `RelayCookie`). */
  cookiesSkippedPartitioned: number
  localStorageImported: number
  sessionStorageImported: number
  errors: string[]
}

/**
 * Whether an origin can receive storage. Storage is written by loading the
 * origin in a hidden page and touching `window.localStorage`, which only exists
 * for http/https — `file:`, `data:` and extension pages have no usable,
 * addressable Web Storage for our purposes.
 */
export function isImportableOrigin(origin: string): boolean {
  try {
    const u = new URL(origin)
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === origin
  } catch {
    return false
  }
}
