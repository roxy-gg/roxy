import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const root =
  process.env.REA_RUNTIME_ROOT || join(process.env.APPDATA || '', 'roxy/engineering-tools')
const node = process.env.REA_NODE || join(root, 'node/node-v24.18.0-win-x64/node.exe')
const packageRoot = join(root, 'rea/node_modules/rea-agents')
if (!existsSync(node) || !existsSync(packageRoot))
  throw new Error('Install private REA first or set REA_RUNTIME_ROOT and REA_NODE')
const { build } = await import('esbuild')
await build({
  entryPoints: ['src/shared/engineering-tools.ts'],
  outfile: 'test/.out/engineering-shared.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs'
})
const shared = require(resolve('test/.out/engineering-shared.cjs'))
const temp = await mkdtemp(join(tmpdir(), 'roxy-rea-native-live-'))
const children = []
function worker() {
  const child = fork(resolve('resources/engineering-worker.mjs'), [packageRoot], {
    execPath: node,
    execArgv: [],
    silent: true,
    env: { ...process.env, ROXY_REA_GHIDRA: '0' }
  })
  children.push(child)
  child.stdout.resume()
  child.stderr.pipe(process.stderr)
  const ready = once(child, 'message').then(([message]) => message.catalog)
  let counter = 0
  const call = (operation, input) =>
    new Promise((resolve, reject) => {
      const id = String(++counter)
      const timeout = setTimeout(() => {
        child.off('message', onMessage)
        reject(new Error('Native request timed out'))
      }, 60_000)
      const onMessage = (message) => {
        if (message.id !== id) return
        clearTimeout(timeout)
        child.off('message', onMessage)
        if (message.error) reject(new Error(message.error))
        else resolve(message.result)
      }
      child.on('message', onMessage)
      child.send({ kind: 'execute', id, operation, input })
    })
  return { child, ready, call }
}
try {
  const first = worker()
  const catalog = await first.ready
  const status = await first.call('binary_session', {})
  assert(!status.isError, JSON.stringify(status))
  assert.equal(catalog.length, 207)
  for (const operation of shared.ENGINEERING_OPERATIONS)
    assert(
      catalog.some(({ function: f }) => f.name === shared.engineeringName(operation)),
      operation
    )
  assert.match(
    catalog.find(({ function: f }) => f.name === 'rea_open_binary').function.description,
    /rea_close_binary/
  )
  await assert.rejects(
    first.call('open_binary', { path: 'secret', provider_id: 5 }),
    /pinned REA contract/
  )
  await assert.rejects(first.call('no_such_tool', {}), /Unknown native REA operation/)
  // A real ZIP target exercises retained active-target routing without a native engine.
  const archive = join(temp, 'fixture.zip')
  // Valid empty ZIP, with EOCD record and no entries.
  await writeFile(archive, Buffer.from('504b0506000000000000000000000000000000000000', 'hex'))
  const opened = await first.call('open_binary', { path: archive })
  assert(!opened.isError, JSON.stringify(opened))
  const inspection = await first.call('inspect_artifact', { detail: 'summary' })
  assert(!inspection.isError, JSON.stringify(inspection))
  assert.equal(inspection._meta.provenance.untrusted_content, true)
  const evidence = await first.call('get_evidence_bundle', { detail: 'summary' })
  assert(evidence.structuredContent.result.total_retained_records > 0)
  const second = worker()
  await second.ready
  const isolated = await second.call('get_evidence_bundle', { detail: 'summary' })
  assert.equal(isolated.structuredContent.result.total_retained_records, 0)
  assert((await second.call('inspect_artifact', {})).isError)
  assert(!(await first.call('close_binary', {})).isError)
  assert((await first.call('inspect_artifact', {})).isError)
  // Exercise Roxy's actual manager as well as its worker. No app settings change.
  globalThis.__engineeringApp = { isPackaged: false, getAppPath: () => resolve('.') }
  await build({
    entryPoints: ['src/main/services/engineering-runtime.ts'],
    outfile: 'test/.out/engineering-runtime-live.cjs',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    plugins: [
      {
        name: 'electron-app-only',
        setup(plugin) {
          plugin.onResolve({ filter: /^electron$/ }, () => ({
            path: 'electron',
            namespace: 'mock'
          }))
          plugin.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({
            contents: 'export const app = globalThis.__engineeringApp'
          }))
        }
      }
    ]
  })
  const manager = require(resolve('test/.out/engineering-runtime-live.cjs'))
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => typeof value === 'string')
  )
  environment.ROXY_REA_GHIDRA = '0'
  environment.ROXY_REA_GROUPS = ''
  try {
    assert.equal(
      (await manager.engineeringCatalog(node, packageRoot, temp, environment)).length,
      207
    )
    const abort = new AbortController()
    const cold = manager.executeEngineering(
      'cold-abort',
      node,
      packageRoot,
      temp,
      environment,
      'get_evidence_bundle',
      { detail: 'summary' },
      abort.signal
    )
    abort.abort()
    await assert.rejects(cold)
    const actual = await manager.executeEngineering(
      'managed-owner',
      node,
      packageRoot,
      temp,
      environment,
      'open_binary',
      { path: archive }
    )
    assert(!actual.isError)
    const retained = await manager.executeEngineering(
      'managed-owner',
      node,
      packageRoot,
      temp,
      environment,
      'inspect_artifact',
      {}
    )
    assert(!retained.isError)
    await assert.rejects(
      manager.executeEngineering(
        'denied',
        node,
        packageRoot,
        temp,
        environment,
        'close_binary',
        {},
        undefined,
        () => false
      ),
      /no longer enabled/
    )
  } finally {
    await manager.closeEngineeringRuntimes()
    delete globalThis.__engineeringApp
  }
  console.log(
    'ENGINEERING LIVE OK: 207 canonical contracts, curated parity, schema validation, native handler invocation, retained target/evidence, provenance, chat isolation, graceful cleanup; no REA MCP transport'
  )
} finally {
  await Promise.all(
    children.map(async (child) => {
      const exited = once(child, 'exit')
      child.send({ kind: 'close' })
      const timer = setTimeout(() => child.kill(), 5000)
      await exited
      clearTimeout(timer)
    })
  )
  await rm(temp, { recursive: true, force: true })
}
