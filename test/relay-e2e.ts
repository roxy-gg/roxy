/**
 * Session Relay — end-to-end check against a REAL Chrome.
 *
 * The in-process suite (test/relay.ts) proves the server refuses the attacks.
 * This proves the other half: that the actual bundled extension loads in a real
 * Chrome, pairs over the real protocol, and lands a snapshot in Roxy's queue.
 * Between them, both sides of the wire are covered by real code.
 *
 * It runs the relay in THIS process (so it can mint a pairing code directly,
 * exactly as Settings does) and drives Chrome over the DevTools Protocol.
 *
 * WHY CDP AND NOT `--load-extension`: Chrome 137+ removed that flag from
 * branded builds because malware abused it, and the escape-hatch feature flag
 * has since been removed too. `Extensions.loadUnpacked` is the documented
 * replacement. The USER flow is unaffected — "Load unpacked" on
 * chrome://extensions with Developer mode on, which is what the setup wizard
 * walks through, still works. This is a harness limitation, not a product one.
 *
 * Not part of `npm run smoke`: it needs a Chrome install and drives a real
 * browser, which is too environment-dependent for CI.
 *
 * Run: npm run e2e:relay
 */
import { app } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as relay from '../src/main/services/relay'
import { RELAY_EXTENSION_ID } from '../src/shared/relay'

const CDP_PORT = 9333
const EXT = resolve('resources/session-relay')

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome'
].find((p) => existsSync(p))

let failures = 0
function check(name: string, cond: boolean, detail: unknown = ''): void {
  const line = cond ? `  ok   ${name}` : `  FAIL ${name} ${detail === '' ? '' : String(detail)}`
  if (!cond) failures++
  process.stderr.write(line + '\n')
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Minimal CDP client, over the `ws` package (already a direct dependency).
 *
 * Not the platform WebSocket: Electron's MAIN process has no global one, and
 * routing through a hidden renderer does not work either — an `about:blank`
 * page has an opaque origin, and Chrome refuses CDP socket upgrades from it.
 */
async function cdp(wsUrl: string): Promise<{
  send: (method: string, params?: unknown, sessionId?: string) => Promise<Record<string, never>>
  close: () => void
}> {
  const { WebSocket } = await import('ws')
  const ws = new WebSocket(wsUrl, { maxPayload: 256 * 1024 * 1024 })
  await new Promise<void>((res, rej) => {
    ws.once('open', res)
    ws.once('error', rej)
  })

  let id = 0
  const waiting = new Map<number, { res: (v: never) => void; rej: (e: Error) => void }>()
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data))
    const w = waiting.get(msg.id)
    if (!w) return
    waiting.delete(msg.id)
    if (msg.error) w.rej(new Error(msg.error.message))
    else w.res((msg.result ?? {}) as never)
  })

  return {
    send: (method, params = {}, sessionId) =>
      new Promise((res, rej) => {
        const n = ++id
        waiting.set(n, { res: res as (v: never) => void, rej })
        const frame: Record<string, unknown> = { id: n, method, params }
        if (sessionId) frame.sessionId = sessionId
        ws.send(JSON.stringify(frame))
        // loadUnpacked installs an extension; give it room, but never hang.
        setTimeout(() => {
          if (waiting.delete(n)) rej(new Error(`CDP ${method} timed out`))
        }, 60_000)
      }),
    close: () => ws.close()
  }
}

async function main(): Promise<void> {
  await app.whenReady()
  process.stderr.write('session relay e2e:\n')

  if (!CHROME) {
    process.stderr.write('  no Chrome installed; skipping.\n')
    app.exit(0)
    return
  }

  await relay.start()
  check('relay is listening', relay.status().listening)
  // Start from a clean slate so a previous run's pairing can't mask a failure.
  relay.unpair()

  const profile = mkdtempSync(join(tmpdir(), 'roxy-relay-'))
  const chrome = spawn(
    CHROME,
    [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${CDP_PORT}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank'
    ],
    { stdio: 'ignore' }
  )

  try {
    let version: { Browser: string; webSocketDebuggerUrl: string } | null = null
    for (let i = 0; i < 40 && !version; i++) {
      await sleep(500)
      version = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
        .then((r) => r.json())
        .catch(() => null)
    }
    if (!version) throw new Error('Chrome DevTools never came up.')
    process.stderr.write(`  (${version.Browser})\n`)

    const client = await cdp(version.webSocketDebuggerUrl)
    const loaded = (await client.send('Extensions.loadUnpacked', { path: EXT })) as unknown as {
      id?: string
    }
    check('the bundled extension loads in real Chrome', Boolean(loaded?.id), JSON.stringify(loaded))
    check('  and takes the ID we authorize', loaded?.id === RELAY_EXTENSION_ID, loaded?.id)

    await sleep(2000)
    const targets = (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) =>
      r.json()
    )) as { id: string; type: string; url: string }[]
    const sw = targets.find(
      (t) => t.type === 'service_worker' && t.url.includes(RELAY_EXTENSION_ID)
    )
    check('its service worker starts', Boolean(sw))
    if (!sw) throw new Error('no service worker to drive')

    const sessionId = (
      (await client.send('Target.attachToTarget', {
        targetId: sw.id,
        flatten: true
      })) as unknown as { sessionId: string }
    ).sessionId

    /** Run an expression inside the extension's service worker. */
    const inSw = async (expression: string): Promise<unknown> => {
      const r = (await client.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        sessionId
      )) as unknown as { exceptionDetails?: { text: string }; result: { value: unknown } }
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
      return r.result.value
    }

    // Everything below goes through the extension's OWN message handlers, so
    // this exercises the shipped background.js, not a re-implementation.
    const bad = (await inSw(`__roxyRelay.pair('000000')`)) as {
      ok?: boolean
    }
    check('a wrong pairing code is refused', bad?.ok === false, JSON.stringify(bad))
    check('  and nothing is paired', !relay.status().paired)

    const { code } = relay.beginPairing()
    const paired = (await inSw(`__roxyRelay.pair('${code}')`)) as { ok?: boolean }
    check('the real code pairs', paired?.ok === true, JSON.stringify(paired))
    check('  Roxy now reports paired', relay.status().paired)
    check('  as the extension we pinned', relay.status().extensionId === RELAY_EXTENSION_ID)

    const status = (await inSw(`__roxyRelay.getToken().then(t => ({ paired: Boolean(t) }))`)) as {
      paired?: boolean
    }
    check('  and the extension agrees', status?.paired === true)

    const sent = (await inSw(`__roxyRelay.sendSnapshot({
      v: 1,
      origin: 'https://example.com',
      capturedAt: Date.now(),
      cookies: [{
        name: 'e2e', value: 'from-chrome', domain: '.example.com', path: '/',
        secure: true, httpOnly: false, hostOnly: false, session: true, sameSite: 'lax'
      }]
    })`)) as { ok?: boolean; error?: string }
    check('a snapshot reaches Roxy', sent?.ok === true, JSON.stringify(sent))

    const pending = relay.status().pending
    check('  it is QUEUED, not applied', pending.length === 1, pending.length)
    check('  with the right origin', pending[0]?.origin === 'https://example.com')
    check(
      '  and its value never reaches status',
      !JSON.stringify(relay.status()).includes('from-chrome')
    )

    // Disconnecting must cut the extension off immediately.
    relay.unpair()
    const after = (await inSw(
      `__roxyRelay.sendSnapshot({ v: 1, origin: 'https://example.com', capturedAt: Date.now(), cookies: [] })`
    )) as { ok?: boolean }
    check('after Disconnect the extension is refused', after?.ok === false, JSON.stringify(after))

    client.close()
  } finally {
    chrome.kill()
    relay.stop()
    try {
      rmSync(profile, { recursive: true, force: true })
    } catch {
      // Chrome holds the profile briefly after kill; harmless in a temp dir.
    }
  }

  process.stderr.write(
    failures ? `\nE2E FAILED — ${failures} failing\n` : '\nAll relay e2e checks passed.\n'
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
