/**
 * Session Relay security checks.
 *
 * The relay is a loopback endpoint that hands out and accepts live credentials,
 * so its ACCESS CONTROL is the thing worth testing — not the happy path. Each
 * case below is an attack the endpoint must refuse:
 *
 *   - a web page POSTing to 127.0.0.1 (wrong Origin)
 *   - a DNS-rebinding attack (right Origin, wrong Host)
 *   - a second extension guessing the token
 *   - brute-forcing the 6-digit pairing code
 *   - a paired client flooding memory with queued snapshots
 *
 * Runs against the REAL server in a real Electron main process; the module is
 * driven exactly as the app drives it. Nothing here touches the browser
 * partition: every test stops at the queue, which is precisely the boundary
 * that makes the design safe (receiving != applying).
 *
 * Run: npm run smoke:relay
 */
import { app } from 'electron'
import { connect } from 'node:net'
import { RELAY_HEADER, RELAY_PORT } from '../src/shared/relay'
import * as relay from '../src/main/services/relay'

let failures = 0

function check(name: string, cond: boolean, detail: unknown = ''): void {
  const line = cond ? `  ok   ${name}` : `  FAIL ${name} ${detail === '' ? '' : String(detail)}`
  if (!cond) failures++
  // stderr: Electron on Windows does not reliably deliver stdout to a
  // redirected parent shell, so a failure would otherwise vanish in CI.
  process.stderr.write(line + '\n')
}

const BASE = `http://127.0.0.1:${RELAY_PORT}`

/** A raw request with full control over the headers an attacker would forge. */
async function call(
  path: string,
  opts: { origin?: string; host?: string; token?: string; header?: boolean; body?: unknown } = {}
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.origin !== undefined) headers.origin = opts.origin
  if (opts.host !== undefined) headers.host = opts.host
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  if (opts.header !== false) headers[RELAY_HEADER] = '1'
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(opts.body ?? {})
  })
  let json: Record<string, unknown> | null = null
  try {
    json = (await res.json()) as Record<string, unknown>
  } catch {
    /* some responses have no body */
  }
  return { status: res.status, json }
}

/**
 * A raw-socket request, so we can forge headers `fetch` refuses to send.
 *
 * This matters for the DNS-rebinding case specifically: undici silently
 * replaces a user-supplied `Host` with the real authority, which would make
 * that test pass without proving anything. A real attacker writes bytes to a
 * socket, so the test does too.
 */
function raw(
  path: string,
  headers: Record<string, string>,
  body: unknown
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body ?? {}), 'utf8')
    const lines = [
      `POST ${path} HTTP/1.1`,
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      `content-length: ${payload.length}`,
      'connection: close',
      '',
      ''
    ].join('\r\n')
    const sock = connect(RELAY_PORT, '127.0.0.1', () => {
      sock.write(lines)
      sock.write(payload)
    })
    const chunks: Buffer[] = []
    sock.on('data', (d) => chunks.push(d))
    sock.on('error', reject)
    sock.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      const status = Number(text.match(/^HTTP\/1\.1 (\d{3})/)?.[1] ?? 0)
      resolve({ status, text })
    })
  })
}

/** A syntactically valid snapshot, so rejections are about AUTH, not shape. */
function snapshot(origin = 'https://example.com'): unknown {
  return {
    v: 1,
    origin,
    capturedAt: Date.now(),
    cookies: [
      {
        name: 'sid',
        value: 'secret',
        domain: '.example.com',
        path: '/',
        secure: true,
        httpOnly: true,
        hostOnly: false,
        session: true,
        sameSite: 'lax'
      }
    ]
  }
}

const EXT = 'bekpajpbgjeloofgicpnkgahfllakeao'
const EXT_ORIGIN = `chrome-extension://${EXT}`
const HOST = `127.0.0.1:${RELAY_PORT}`

async function main(): Promise<void> {
  await app.whenReady()
  process.stderr.write('session relay:\n')

  await relay.start()
  check('listener is up on loopback', relay.status().listening)
  check('  and starts unpaired', !relay.status().paired)

  // --- pairing is required before anything works ---------------------------
  let r = await call('/snapshot', { origin: EXT_ORIGIN, host: HOST, body: snapshot() })
  check('snapshot without pairing is rejected', r.status === 401, r.status)

  r = await call('/pair', { origin: EXT_ORIGIN, host: HOST, body: { code: '123456' } })
  check('pairing without a code on screen is rejected', r.status === 409, r.status)

  // --- a web page cannot pair ----------------------------------------------
  const { code } = relay.beginPairing()
  check('beginPairing issues a 6-digit code', /^\d{6}$/.test(code), code)

  r = await call('/pair', {
    origin: 'https://evil.com',
    host: HOST,
    body: { code, extensionId: EXT }
  })
  check('a website cannot pair even with the right code', r.status === 403, r.status)

  // --- an extension cannot claim another extension's id --------------------
  r = await call('/pair', {
    origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    host: HOST,
    body: { code, extensionId: EXT }
  })
  check('extension id must match the request origin', r.status === 400, r.status)

  // --- wrong code ----------------------------------------------------------
  r = await call('/pair', {
    origin: EXT_ORIGIN,
    host: HOST,
    body: { code: '000000', extensionId: EXT }
  })
  check('a wrong code is rejected', r.status === 401, r.status)

  // --- the real pairing ----------------------------------------------------
  r = await call('/pair', { origin: EXT_ORIGIN, host: HOST, body: { code, extensionId: EXT } })
  check('the paired extension gets a token', r.status === 200 && typeof r.json?.token === 'string')
  const token = String(r.json?.token ?? '')
  check('  token is long enough to not be guessable', token.length >= 32, token.length)
  check('  status reports paired', relay.status().paired)
  check('  status never leaks the token', !JSON.stringify(relay.status()).includes(token))

  // --- authenticated requests now work -------------------------------------
  r = await call('/hello', { origin: EXT_ORIGIN, host: HOST, token })
  check('paired heartbeat succeeds', r.status === 200, r.status)

  // --- and every forged variant still fails --------------------------------
  r = await call('/hello', { origin: 'https://evil.com', host: HOST, token })
  check('a website with a STOLEN token is still rejected (Origin)', r.status === 401, r.status)

  // A forged Host is the DNS-rebinding case: a page on evil.com resolved to
  // 127.0.0.1 reaches our socket, but the browser sends `Host: evil.com`.
  // Must go over a raw socket — `fetch` would rewrite the header (see `raw`).
  const rebind = await raw(
    '/hello',
    {
      host: 'evil.com',
      origin: EXT_ORIGIN,
      authorization: `Bearer ${token}`,
      [RELAY_HEADER]: '1',
      'content-type': 'application/json'
    },
    {}
  )
  check('DNS-rebinding is rejected (forged Host)', rebind.status === 401, rebind.status)

  // Control: the same raw request with the correct Host must succeed, or the
  // check above would pass for the wrong reason (e.g. a malformed request).
  const rawOk = await raw(
    '/hello',
    {
      host: HOST,
      origin: EXT_ORIGIN,
      authorization: `Bearer ${token}`,
      [RELAY_HEADER]: '1',
      'content-type': 'application/json'
    },
    {}
  )
  check(
    '  (control: the same request with the real Host succeeds)',
    rawOk.status === 200,
    rawOk.status
  )

  r = await call('/hello', {
    origin: EXT_ORIGIN,
    host: HOST,
    token: 'wrong-token-wrong-token-wrong'
  })
  check('a bad token is rejected', r.status === 401, r.status)

  r = await call('/hello', { origin: EXT_ORIGIN, host: HOST })
  check('a missing token is rejected', r.status === 401, r.status)

  r = await call('/hello', { origin: EXT_ORIGIN, host: HOST, token, header: false })
  check('a request without the custom header is rejected', r.status === 401, r.status)

  // --- CORS preflight only ever names the paired extension -----------------
  const pre = await fetch(`${BASE}/snapshot`, {
    method: 'OPTIONS',
    headers: { origin: 'https://evil.com', host: HOST }
  })
  check('preflight refuses a website origin', pre.status === 403, pre.status)

  // --- snapshots queue, they do NOT apply ----------------------------------
  r = await call('/snapshot', { origin: EXT_ORIGIN, host: HOST, token, body: snapshot() })
  check('a valid snapshot is queued', r.status === 202, r.status)
  check('  it appears as pending', relay.status().pending.length === 1)
  const pending = relay.status().pending[0]
  check('  pending reports counts, not values', pending.cookieCount === 1)
  check('  no cookie VALUE crosses into status', !JSON.stringify(relay.status()).includes('secret'))

  // --- malformed input is rejected without throwing ------------------------
  r = await call('/snapshot', { origin: EXT_ORIGIN, host: HOST, token, body: { v: 99 } })
  check('an unknown protocol version is rejected', r.status === 400, r.status)

  r = await call('/snapshot', {
    origin: EXT_ORIGIN,
    host: HOST,
    token,
    body: { v: 1, origin: 'file:///etc/passwd', cookies: [] }
  })
  check('a non-http origin is rejected', r.status === 400, r.status)

  // --- a paired client cannot flood memory ---------------------------------
  for (let i = 0; i < 6; i++) {
    await call('/snapshot', { origin: EXT_ORIGIN, host: HOST, token, body: snapshot() })
  }
  check(
    'the pending queue is capped',
    relay.status().pending.length <= 5,
    relay.status().pending.length
  )

  // --- rejecting drops it untouched ----------------------------------------
  const before = relay.status().pending.length
  relay.rejectPending(relay.status().pending[0].id)
  check('reject removes the snapshot', relay.status().pending.length === before - 1)

  // --- unpair revokes immediately ------------------------------------------
  relay.unpair()
  check('unpair clears the pairing', !relay.status().paired)
  check('  and drops queued snapshots', relay.status().pending.length === 0)
  r = await call('/hello', { origin: EXT_ORIGIN, host: HOST, token })
  check('the old token stops working at once', r.status === 401, r.status)

  relay.stop()
  check('stop closes the listener', !relay.status().listening)

  process.stderr.write(
    failures ? `\nRELAY FAILED — ${failures} failing\n` : '\nAll relay checks passed.\n'
  )
  app.exit(failures ? 1 : 0)
}

process.on('uncaughtException', (e) => {
  process.stderr.write(`CRASH: ${e?.stack ?? e}\n`)
  app.exit(1)
})
process.on('unhandledRejection', (e) => {
  process.stderr.write(`REJECT: ${e instanceof Error ? e.stack : String(e)}\n`)
  app.exit(1)
})

void main()
