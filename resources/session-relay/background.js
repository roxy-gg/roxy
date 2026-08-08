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
}

function startHeartbeat() {
  chrome.alarms.create('roxy-heartbeat', { periodInMinutes: HEARTBEAT_MINUTES })
}

chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === 'roxy-heartbeat') heartbeat()
})

chrome.runtime.onStartup.addListener(startHeartbeat)
chrome.runtime.onInstalled.addListener(startHeartbeat)

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
globalThis.__roxyRelay = { pair, sendSnapshot, getToken }
