/**
 * Roxy Session Relay — background service worker.
 *
 * Owns the connection to Roxy: pairing, the bearer token, and the heartbeat.
 * The popup never talks to the network directly; it messages this worker. That
 * keeps the token in one place and means a compromised page (which cannot reach
 * the worker anyway) has no path to it.
 *
 * The token lives in `chrome.storage.local`, which is readable only by this
 * extension's own contexts — not by web pages, not by other extensions.
 */

/** Must match RELAY_PORT / RELAY_HEADER in Roxy's shared/relay.ts. */
const RELAY_ORIGIN = 'http://127.0.0.1:4317'
const RELAY_HEADER = 'x-roxy-relay'

/** Heartbeat cadence. Drives the "Connected" dot in Roxy's Settings. */
const HEARTBEAT_MINUTES = 1

/**
 * Roxy's automation prefs, refreshed on every heartbeat.
 *
 * Cached so an auto-send decision costs no round trip, but never authoritative:
 * Roxy re-checks the blocklist server-side on every snapshot, so a stale cache
 * here cannot leak a blocked site.
 */
let prefs = { autoSend: false, trusted: [], blocked: [] }

/** origin -> last auto-send, so a chatty site cannot spam Roxy. */
const lastSent = new Map()
const COOLDOWN_MS = 15_000

async function getToken() {
  const { token } = await chrome.storage.local.get('token')
  return token || null
}

/** POST JSON to the relay, attaching the bearer token when we have one. */
async function post(path, body, token) {
  const headers = {
    'content-type': 'application/json',
    // Forces a CORS preflight, so this can never be mistaken for a "simple"
    // request that a web page could also make.
    [RELAY_HEADER]: '1'
  }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${RELAY_ORIGIN}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  })
  let json = null
  try {
    json = await res.json()
  } catch {
    // A non-JSON body means something other than Roxy answered on this port.
  }
  return { ok: res.ok, status: res.status, json }
}

/** Exchange the on-screen code for a long-lived token. */
async function pair(code) {
  const manifest = chrome.runtime.getManifest()
  const r = await post('/pair', {
    code,
    extensionId: chrome.runtime.id,
    browser: detectBrowser(),
    version: manifest.version
  })
  if (r.ok && r.json?.token) {
    await chrome.storage.local.set({ token: r.json.token })
    startHeartbeat()
    // Pull prefs straight away rather than waiting up to a minute for the
    // first heartbeat — otherwise a freshly trusted site would not auto-send.
    void heartbeat()
    return { ok: true }
  }
  return { ok: false, error: r.json?.error || `Pairing failed (${r.status}).` }
}

/**
 * Best-effort browser name for Roxy's UI ("Chrome wants to send…").
 *
 * Chromium forks are mostly indistinguishable from the UA string alone; brand
 * data from userAgentData is the only reliable signal, and even it falls back
 * to Chrome. This is cosmetic, never a security decision.
 */
function detectBrowser() {
  const brands = navigator.userAgentData?.brands ?? []
  for (const { brand } of brands) {
    if (/edge/i.test(brand)) return 'Edge'
    if (/brave/i.test(brand)) return 'Brave'
    if (/opera|opr/i.test(brand)) return 'Opera'
    if (/vivaldi/i.test(brand)) return 'Vivaldi'
  }
  if (brands.some((b) => /chromium/i.test(b.brand))) return 'Chromium'
  return 'Chrome'
}

/** Tell Roxy we're alive, so Settings can show a live connection. */
async function heartbeat() {
  const token = await getToken()
  if (!token) return
  const r = await post('/hello', {}, token)
  // 401 means Roxy revoked us (the user hit Disconnect). Drop the dead token
  // so the popup prompts to pair again instead of failing silently forever.
  if (r.status === 401) await chrome.storage.local.remove('token')
  else if (r.json?.prefs) prefs = r.json.prefs
}

/**
 * Suffix match on a dot boundary — the same rule as Roxy's `isBlockedHost`.
 *
 * The two boundaries that matter: `example.com` must not match
 * `notexample.com` (no dot) nor `example.com.evil.net` (not a suffix).
 */
function isBlocked(host) {
  const h = String(host || '')
    .toLowerCase()
    .replace(/\.$/, '')
  if (!h) return true
  return prefs.blocked.some((raw) => {
    const p = String(raw)
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^\*\./, '')
      .split('/')[0]
      .replace(/:\d+$/, '')
      .replace(/\.$/, '')
    return p && (h === p || h.endsWith(`.${p}`))
  })
}

/** Is this origin cleared for a hands-off transfer? */
function mayAutoSend(origin) {
  if (!prefs.autoSend) return false
  let host
  try {
    host = new URL(origin).hostname
  } catch {
    return false
  }
  if (isBlocked(host)) return false
  return prefs.trusted.includes(origin)
}

/**
 * Capture and send a trusted origin without any UI.
 *
 * Runs only for origins the user already granted host access to, so it never
 * triggers a permission prompt: `permissions.contains` is checked first and a
 * miss simply means "not ready yet, wait for a manual send".
 */
async function autoSend(origin, tabId) {
  if (!mayAutoSend(origin)) return
  const last = lastSent.get(origin) ?? 0
  if (Date.now() - last < COOLDOWN_MS) return

  const allowed = await chrome.permissions.contains({ origins: [`${origin}/*`] }).catch(() => false)
  if (!allowed) return

  lastSent.set(origin, Date.now())
  try {
    const cookies = await chrome.cookies.getAll({ url: `${origin}/` })
    // Nothing to relay yet (signed out, or cookies not set). Don't send an
    // empty session — it would overwrite nothing but still churn.
    if (!cookies.length) return

    const snapshot = {
      v: 1,
      origin,
      capturedAt: Date.now(),
      cookies: cookies.map(toRow)
    }

    // localStorage needs the page. Best-effort: a backgrounded or discarded tab
    // cannot be scripted, and cookies alone are still worth sending.
    if (tabId != null) {
      try {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const out = {}
            for (let i = 0; i < localStorage.length; i++) {
              const k = localStorage.key(i)
              if (k != null) out[k] = localStorage.getItem(k) ?? ''
            }
            return out
          }
        })
        if (res?.result) snapshot.localStorage = res.result
      } catch {
        // Not scriptable right now; cookies still go.
      }
    }

    await sendSnapshot(snapshot)
  } catch {
    // Auto-send is invisible, so a failure must stay invisible too — the next
    // cookie change or navigation will try again.
  }
}

/** chrome.cookies.Cookie -> the wire shape (see shared/relay.ts). */
function toRow(c) {
  const row = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    hostOnly: c.hostOnly,
    session: c.session,
    sameSite: c.sameSite ?? 'unspecified'
  }
  if (typeof c.expirationDate === 'number') row.expirationDate = c.expirationDate
  if (c.partitionKey) row.partitionKey = c.partitionKey
  return row
}

/** The active tab's origin, or null when it isn't a website. */
async function activeOrigin() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.url) return null
  try {
    const u = new URL(tab.url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return { origin: u.origin, tabId: tab.id }
  } catch {
    return null
  }
}

// A cookie changing is the signal that matters: it is what happens when a
// token rotates mid-session, which is the case auto-send exists for. The
// cooldown upstream keeps a busy site from turning this into a flood.
chrome.cookies.onChanged.addListener(async (change) => {
  if (change.cause === 'evicted' || change.cause === 'expired') return
  const active = await activeOrigin()
  if (!active) return
  // Only react to cookies that actually belong to the tab in front of the
  // user, so a background tab's analytics cannot drive a transfer.
  const domain = String(change.cookie?.domain ?? '').replace(/^\./, '')
  let host
  try {
    host = new URL(active.origin).hostname
  } catch {
    return
  }
  if (host !== domain && !host.endsWith(`.${domain}`)) return
  autoSend(active.origin, active.tabId)
})

// Landing on a trusted site should hand its session over without waiting for a
// cookie to change.
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'complete' || !tab.active || !tab.url) return
  try {
    const u = new URL(tab.url)
    if (u.protocol === 'http:' || u.protocol === 'https:') autoSend(u.origin, tabId)
  } catch {
    // Not a website.
  }
})

function startHeartbeat() {
  chrome.alarms.create('roxy-heartbeat', { periodInMinutes: HEARTBEAT_MINUTES })
}

chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === 'roxy-heartbeat') heartbeat()
})

chrome.runtime.onStartup.addListener(startHeartbeat)
chrome.runtime.onInstalled.addListener(startHeartbeat)

// A service worker is torn down aggressively and respawned on demand, so the
// cached prefs start empty on every wake. Refresh immediately rather than
// leaving auto-send dormant until the next alarm fires.
void heartbeat()

/** Send a captured snapshot. Returns Roxy's verdict for the popup to render. */
async function sendSnapshot(snapshot) {
  const token = await getToken()
  if (!token) return { ok: false, error: 'Not connected to Roxy yet.' }
  const r = await post('/snapshot', snapshot, token)
  if (r.ok) return { ok: true }
  if (r.status === 401) {
    await chrome.storage.local.remove('token')
    return { ok: false, error: 'Roxy disconnected this browser. Pair again.' }
  }
  if (r.status === 413) return { ok: false, error: 'That session is too large to send.' }
  return { ok: false, error: r.json?.error || `Roxy rejected the transfer (${r.status}).` }
}

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  // Only our own popup can reach this; content scripts and pages cannot.
  if (msg?.type === 'pair') pair(msg.code).then(respond)
  else if (msg?.type === 'send') sendSnapshot(msg.snapshot).then(respond)
  else if (msg?.type === 'status') {
    getToken().then((token) => respond({ paired: Boolean(token) }))
  } else if (msg?.type === 'unpair') {
    chrome.storage.local.remove('token').then(() => respond({ ok: true }))
  } else {
    return false
  }
  // Keep the message channel open for the async respond above.
  return true
})

// Exposed for the end-to-end harness (test/relay-e2e.ts), which drives this
// worker over the DevTools Protocol. `chrome.runtime.sendMessage` cannot be
// used there: a service worker sending to itself has no receiver. Nothing on a
// web page can reach this object — it lives in the worker's own global scope.
globalThis.__roxyRelay = { pair, sendSnapshot, getToken, heartbeat, prefs: () => prefs }
