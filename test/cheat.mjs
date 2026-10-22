import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const directory = await mkdtemp(join(tmpdir(), 'roxy-cheat-test-'))
const handlers = new Map()
const sender = { mainFrame: {}, getURL: () => 'http://localhost:3117/' }
const trusted = { sender, senderFrame: sender.mainFrame }
process.env.ELECTRON_RENDERER_URL = 'http://localhost:3117'
let identity = '100'
let supported = true
let read = '0102'
let executions = []
let hold
let dllHash = 'a'.repeat(64)
let dllStatus = 'loaded'
let pointerSize = 8
globalThis.__cheatTest = {
  electron: {
    app: { getPath: () => directory },
    BrowserWindow: { getAllWindows: () => [], fromWebContents: (s) => (s === sender ? {} : null) },
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) }
  },
  runtime: {
    cheatSupported: () => supported,
    executeMemory: async (input, signal) => {
      executions.push(input)
      if (hold) return await hold(input, signal)
      if (input.operation === 'open_process')
        return { pid: input.pid, identity, name: 'OwnedLabFixture', pointerSize }
      if (input.operation === 'inspect_dll')
        return {
          path: 'C:\\lab\\fixture.dll',
          sha256: dllHash,
          bytes: 1024,
          architecture: 'x64',
          managed: false,
          executed: false
        }
      assert.equal(input.identity, identity, 'PID reuse is rejected by backend')
      if (input.operation === 'load_dll') {
        if (input.sha256 !== undefined)
          assert.equal(input.sha256, dllHash, 'Changed DLL hash is rejected by backend')
        return { status: dllStatus, dispatched: true }
      }
      if (input.operation === 'read_memory') return { complete: true, hex: read }
      if (input.operation === 'write_memory') {
        if (input.expected !== undefined)
          assert.equal(input.expected, read, 'Expected bytes mismatch')
        read = input.data
        return { verified: true, bytesWritten: 2 }
      }
      return {}
    }
  }
}
await build({
  entryPoints: ['src/main/services/cheat.ts'],
  outfile: 'test/.out/cheat.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  plugins: [
    {
      name: 'boundaries',
      setup(plugin) {
        plugin.onResolve({ filter: /^(electron|\.\/cheat-runtime)$/ }, ({ path }) => ({
          path,
          namespace: 'mock'
        }))
        plugin.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({
          contents: `module.exports = globalThis.__cheatTest.${path === 'electron' ? 'electron' : 'runtime'}`
        }))
      }
    }
  ]
})
await build({
  entryPoints: ['src/shared/cheat.ts'],
  outfile: 'test/.out/cheat-shared.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs'
})
const shared = require(resolve('test/.out/cheat-shared.cjs'))
const originalFetch = globalThis.fetch
try {
  // Only the current names are exported/registered; the old tool namespace is
  // deliberately not an executable alias for historical transcript entries.
  assert(shared.CHEAT_SCHEMAS.every(({ function: f }) => f.name.startsWith('cheat_')))
  assert.equal(new Set(shared.CHEAT_SCHEMAS.map(({ function: f }) => f.name)).size, 27)
  assert.deepEqual(shared.cheatPreferences(null), { enabled: false, disabledCalls: [] })
  assert.equal(shared.cheatSchemas('linux', { enabled: true, writes: true }).length, 0)
  assert.equal(shared.cheatSchemas('win32', { enabled: true, disabledCalls: [] }).length, 27)
  const service = require(resolve('test/.out/cheat.cjs'))
  service.registerCheatIpc()
  assert([...handlers.keys()].every((channel) => channel.startsWith('cheat:')))
  const invoke = (name, ...args) => handlers.get('cheat:' + name)(trusted, ...args)
  const run = (name, input = {}, session = 'chat', actor = 'host', signal) =>
    service.runCheatTool('cheat_' + name, input, session, actor, signal)
  const patch = { address: '0x1234', expected: '0102', data: '0304' }
  assert.equal((await service.cheatTurn()).schemas.length, 0)
  assert.equal((await service.cheatTurn()).guidance, undefined)
  assert.deepEqual(
    shared.cheatPreferences({
      enabled: true,
      disabledCalls: ['cheat_load_dll', 'unknown', 'cheat_load_dll']
    }),
    { enabled: true, disabledCalls: ['cheat_load_dll'] }
  )
  assert.equal(shared.cheatGuidance('linux', shared.cheatPreferences({ enabled: true })), undefined)
  assert.equal((await run('open_process', { pid: 42 })).ok, false)
  assert.equal(executions.length, 0)
  assert.equal(
    (
      await handlers.get('cheat:update')(
        { sender: {}, senderFrame: {} },
        { enabled: true, disabledCalls: [] }
      )
    ).error,
    'permission'
  )
  assert.equal((await invoke('update', { enabled: 'true' })).error, 'invalid')
  assert.equal((await invoke('update', { disabled: false })).error, 'invalid')
  assert.equal((await invoke('update', { disabledCalls: 'cheat_load_dll' })).error, 'invalid')
  assert.equal((await invoke('update', { disabledCalls: ['not_a_tool'] })).error, 'invalid')
  assert.equal((await invoke('update', { disabledCalls: [17] })).error, 'invalid')
  assert((await invoke('update', { enabled: true, disabledCalls: [] })).ok)
  assert.equal((await service.runCheatTool('ace_open_process', { pid: 42 }, 'chat')).ok, false)
  assert.equal(executions.length, 0, 'Retired tool names never execute')
  assert.equal((await service.cheatTurn()).schemas.length, 27)
  const beforeDisable = executions.length
  assert((await invoke('update', { disabledCalls: ['cheat_write_memory', 'cheat_load_dll'] })).ok)
  const selective = await service.cheatTurn()
  assert.equal(selective.schemas.length, 25)
  assert(
    !selective.schemas.some(({ function: f }) =>
      ['cheat_write_memory', 'cheat_load_dll'].includes(f.name)
    )
  )
  const enabledLine = selective.guidance.split('\n')[1]
  assert(!enabledLine.includes('cheat_write_memory') && !enabledLine.includes('cheat_load_dll'))
  assert.equal((await run('write_memory', patch)).ok, false, 'Stale disabled write cannot dispatch')
  assert.equal((await run('load_dll', { path: 'C:\\lab\\fixture.dll' })).ok, false)
  assert.equal(executions.length, beforeDisable)
  const selectedNames = shared.CHEAT_SCHEMAS.map(({ function: f }) => f.name)
  assert((await invoke('update', { disabledCalls: selectedNames })).ok)
  assert.deepEqual(
    await service.cheatTurn(),
    { schemas: [], guidance: undefined },
    'No schema or prompt if every call is disabled'
  )
  assert((await invoke('update', { enabled: false })).ok)
  assert.deepEqual(
    (await invoke('state')).preferences.disabledCalls,
    selectedNames,
    'Master off retains choices'
  )
  assert((await invoke('update', { enabled: true })).ok)
  assert.equal((await service.cheatTurn()).schemas.length, 0)
  assert((await invoke('update', { disabledCalls: [] })).ok)
  assert.equal((await service.cheatTurn()).schemas.length, 27)
  assert((await run('open_process', { pid: 42 })).ok)
  assert.equal(
    (await run('read_memory', { address: '0x1', length: 2, pid: 999 })).ok,
    false,
    'Cannot substitute backend target'
  )
  assert.equal(
    (await invoke('update', { writes: true })).error,
    'invalid',
    'No separate write switch'
  )
  assert((await invoke('update', { enabled: false, disabledCalls: [] })).ok)
  assert.equal((await run('write_memory', patch)).ok, false)
  assert((await invoke('update', { enabled: true, disabledCalls: [] })).ok)
  assert.equal(handlers.has('cheat:approve'), false, 'No approval IPC')
  assert.equal('approvals' in (await invoke('state')), false)
  assert.equal(
    (await service.cheatTurn()).guidance,
    shared.cheatGuidance('win32', (await invoke('state')).preferences)
  )
  await assert.rejects(run('write_memory', patch), /Open an authorized process/)
  await run('open_process', { pid: 42 })
  assert((await run('write_memory', patch)).ok, 'One call writes real data without approval')
  assert.equal(read, '0304')
  assert(
    (await run('write_memory', { address: patch.address, data: '0506' })).ok,
    'Expected check is optional'
  )
  assert.equal(read, '0506')
  await assert.rejects(run('write_memory', patch), /Expected bytes mismatch/)
  await assert.rejects(run('write_memory', { address: patch.address, data: '0' }), /hex/)
  await assert.rejects(run('write_memory', { address: patch.address, data: 'gg' }), /hex/)
  await assert.rejects(
    run('write_memory', { address: patch.address, data: '00'.repeat(65537) }),
    /65536/
  )
  await assert.rejects(run('write_memory', { ...patch, expected: '00' }), /equal-length/)
  for (const name of ['request_write', 'apply_write', 'request_load_dll'])
    assert.equal((await run(name, {})).ok, false, 'Retired calls are not executable aliases')
  await assert.rejects(run('write_memory', patch, 'chat', 'bot'), /Open an authorized/)
  await assert.rejects(run('write_memory', patch, 'other'), /Open an authorized/)
  const now = Date.now
  Date.now = () => now() + 31 * 60000
  try {
    assert(
      (await run('read_memory', { address: patch.address, length: 2 })).ok,
      'Selected target does not expire'
    )
  } finally {
    Date.now = now
  }
  identity = '101'
  await assert.rejects(run('write_memory', { address: patch.address, data: '0102' }), /PID reuse/)
  await run('open_process', { pid: 42 })
  hold = (_input, signal) =>
    new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
    )
  const pending = run('read_memory', { address: '0x1', length: 2 })
  const cancelled = assert.rejects(pending, /cancelled/)
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal((await run('open_process', { pid: 1 })).ok, false, 'One operation per chat/actor')
  await invoke('update', { enabled: false, disabledCalls: [] })
  await cancelled
  hold = undefined
  await invoke('update', { enabled: true, disabledCalls: [] })
  await run('open_process', { pid: 42 })
  const dll = { path: 'C:\\lab\\fixture.dll', sha256: dllHash }
  assert((await run('inspect_dll', { path: dll.path })).ok)
  await assert.rejects(run('load_dll', { ...dll, sha256: 'b'.repeat(64) }), /Changed DLL/)
  assert((await run('load_dll', dll)).ok, 'DLL loading has no per-change approval')
  assert((await run('load_dll', { path: dll.path })).ok, 'Hash is optional')
  await assert.rejects(run('load_dll', dll, 'chat', 'bot'), /Open an authorized/)
  dllStatus = 'unknown'
  assert.equal((await run('load_dll', dll)).ok, false, 'Unknown is not successful loading')
  dllStatus = 'loaded'
  pointerSize = 4
  await run('open_process', { pid: 42 })
  await assert.rejects(run('load_dll', dll), /x64/)
  pointerSize = 8
  await invoke('update', { enabled: false, disabledCalls: [] })
  assert.equal((await service.cheatTurn()).schemas.length, 0)
  await invoke('update', { enabled: true, disabledCalls: [] })
  await run('open_process', { pid: 42 })
  service.closeCheatSession('chat')
  await assert.rejects(run('read_memory', { address: '0x1', length: 2 }), /Open an authorized/)
  assert((await invoke('update', { disabledCalls: ['cheat_load_dll'] })).ok)
  const saved = JSON.parse(await readFile(join(directory, 'cheat-tools/preferences.json'), 'utf8'))
  assert.deepEqual(saved.disabledCalls, ['cheat_load_dll'], 'Individual choices persist on disk')
  globalThis.fetch = async () => new Response('archive fixture')
  const before = (await invoke('state')).preferences
  assert((await invoke('download', 'reclass')).ok)
  assert.deepEqual((await invoke('state')).preferences, before, 'Download never enables tools')
  const source = (await invoke('state')).sources.reclass
  assert.equal(await readFile(source.path, 'utf8'), 'archive fixture')
  assert.match(source.sha256, /^[a-f0-9]{64}$/)
  supported = false
  assert.equal((await service.cheatTurn()).schemas.length, 0)
  assert.equal((await invoke('update', { enabled: true, disabledCalls: [] })).error, 'unsupported')
  supported = true
  await service.resetCheatTools()
  assert.deepEqual((await invoke('state')).preferences, { enabled: false, disabledCalls: [] })
  // Bootstrap fresh service instances to exercise persisted storage migration.
  const bundle = resolve('test/.out/cheat.cjs')
  const legacy = join(directory, 'anti-cheat-tools')
  const current = join(directory, 'cheat-tools')
  const archive = `${shared.CHEAT_SOURCES[0].id}-${shared.CHEAT_SOURCES[0].commit}.zip`
  const restart = async () => {
    delete require.cache[bundle]
    const fresh = require(bundle)
    fresh.registerCheatIpc()
    return await invoke('state')
  }
  await rm(current, { recursive: true, force: true })
  await mkdir(legacy)
  await writeFile(
    join(legacy, 'preferences.json'),
    JSON.stringify({ enabled: true, writes: false })
  )
  await writeFile(join(legacy, archive), 'legacy source fixture')
  let migrated = await restart()
  assert.deepEqual(migrated.preferences, { enabled: true, disabledCalls: [] })
  assert.equal(migrated.sources.reclass.path, join(current, archive))
  assert.equal(await readFile(join(current, archive), 'utf8'), 'legacy source fixture')
  await assert.rejects(stat(legacy), { code: 'ENOENT' })
  migrated = await restart()
  assert.deepEqual(
    migrated.preferences,
    { enabled: true, disabledCalls: [] },
    'Migration is idempotent'
  )
  await mkdir(legacy)
  await writeFile(join(legacy, 'preferences.json'), JSON.stringify({ enabled: true, writes: true }))
  await writeFile(join(legacy, archive), 'conflicting legacy source')
  await writeFile(
    join(current, 'preferences.json'),
    JSON.stringify({ enabled: false, writes: false })
  )
  migrated = await restart()
  assert.deepEqual(
    migrated.preferences,
    { enabled: false, disabledCalls: [] },
    'Current preferences win; writes are not re-enabled'
  )
  assert.equal(await readFile(join(current, archive), 'utf8'), 'legacy source fixture')
  assert.equal(
    await readFile(join(legacy, archive), 'utf8'),
    'conflicting legacy source',
    'Conflicting data is preserved, not overwritten or deleted'
  )
  console.log(
    'CHEAT OK: direct single-switch writes/DLL loads, no approval IPC/state, optional integrity checks, persistent selected targets, actor/session isolation, cancellation, PID reuse, unknown dispatch, provenance and migration'
  )
} finally {
  globalThis.fetch = originalFetch
  delete globalThis.__cheatTest
  await rm(directory, { recursive: true, force: true })
}
