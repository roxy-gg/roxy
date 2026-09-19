import { app, session } from 'electron'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  BROWSER_PARTITION,
  credentialsFor,
  get,
  reset,
  set
} from '../src/main/services/browser-proxy'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
  if (!ok) failures++
}

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roxy-proxy-'))
  app.setPath('userData', root)
  await app.whenReady()
  console.log('\nbrowser proxy:')

  const initial = await get()
  check('starts disabled', !initial.enabled && !initial.hasPassword)

  const invalid = await set({
    enabled: true,
    scheme: 'http',
    host: '',
    port: 0,
    username: ''
  })
  check('rejects an incomplete enabled proxy', !invalid.ok && Boolean(invalid.error))

  const saved = await set({
    enabled: true,
    scheme: 'http',
    host: '127.0.0.1',
    port: 7890,
    username: 'roxy',
    password: 'not-plain-text'
  })
  check('saves an HTTP proxy', saved.ok && saved.config.enabled, saved.error ?? '')
  check(
    'reports but does not return the password',
    saved.config.hasPassword && !('password' in saved.config)
  )

  const raw = await fs.readFile(path.join(root, 'browser-proxy.json'), 'utf8')
  check('does not persist the password in plain text', !raw.includes('not-plain-text'))

  const proxySession = session.fromPartition(BROWSER_PARTITION)
  const resolved = await proxySession.resolveProxy('https://example.com')
  check('applies the proxy to the browser partition', resolved.includes('127.0.0.1:7890'), resolved)

  const credentials = await credentialsFor({
    isProxy: true,
    scheme: 'basic',
    host: '127.0.0.1',
    port: 7890,
    realm: 'test'
  })
  check(
    'returns credentials only for the configured proxy',
    credentials?.username === 'roxy' && credentials.password === 'not-plain-text'
  )
  const unrelated = await credentialsFor({
    isProxy: true,
    scheme: 'basic',
    host: 'other.example',
    port: 7890,
    realm: 'test'
  })
  check('does not leak credentials to another proxy', unrelated === null)

  const socksAuth = await set({
    enabled: true,
    scheme: 'socks5',
    host: '127.0.0.1',
    port: 1080,
    username: 'unsupported'
  })
  check('rejects SOCKS username/password auth', !socksAuth.ok && Boolean(socksAuth.error))

  await reset()
  const direct = await proxySession.resolveProxy('https://example.com')
  check('reset restores a direct connection', direct === 'DIRECT', direct)
  check(
    'reset removes the saved profile',
    !(await fs.stat(path.join(root, 'browser-proxy.json')).catch(() => null))
  )

  console.log(
    failures
      ? `\nBROWSER PROXY FAILED - ${failures} failing\n`
      : '\nAll browser proxy checks passed.\n'
  )
  app.exit(failures ? 1 : 0)
}

void main().catch((error) => {
  console.error(error)
  app.exit(1)
})
