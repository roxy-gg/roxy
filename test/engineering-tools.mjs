import { EventEmitter } from 'node:events'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
const require = createRequire(import.meta.url)
await build({
  entryPoints: ['src/shared/engineering-tools.ts', 'src/main/services/engineering-downloads.ts'],
  outdir: 'test/.out/engineering-shared',
  bundle: true,
  platform: 'node',
  format: 'cjs'
})
const shared = require(resolve('test/.out/engineering-shared/shared/engineering-tools.js'))
const downloads = require(
  resolve('test/.out/engineering-shared/main/services/engineering-downloads.js')
)
const off = shared.engineeringPreferences(null)
const installed = shared.ENGINEERING_TOOLS.map(({ id }) => id)
assert.deepEqual(off, { enabled: false, guidance: false, groups: [], disabledCalls: [] })
assert.deepEqual(shared.engineeringToolCalls(installed, 'win32', off), [])
const all = { enabled: true, guidance: false, groups: installed, disabledCalls: [] }
const calls = shared.engineeringToolCalls(installed, 'win32', all)
assert(calls.includes('analyze_function') && calls.includes('inspect_android_method'))
assert(!calls.includes('inspect_packet_fields'))
assert(shared.engineeringToolCalls(installed, 'linux', all).includes('inspect_packet_fields'))
assert(
  !shared
    .engineeringToolCalls(installed, 'win32', { ...all, disabledCalls: ['analyze_function'] })
    .includes('analyze_function')
)
assert.deepEqual(shared.engineeringToolCalls(['ghidra'], 'win32', all), [])
assert(
  shared
    .engineeringToolCalls(installed, 'win32', { ...all, groups: ['ghidra'] })
    .includes('inspect_analysis_view')
)
assert(
  !shared
    .engineeringToolCalls(installed, 'win32', { ...all, groups: ['ghidra'] })
    .includes('inspect_android_method')
)
for (const name of shared.ENGINEERING_OPERATIONS)
  assert.match(shared.engineeringName(name), /^[a-zA-Z0-9_-]{1,64}$/)
const directory = await mkdtemp(join(tmpdir(), 'roxy-engineering-test-'))
const handlers = new Map()
const sender = { mainFrame: {}, getURL: () => 'http://localhost:3107/' }
const trusted = { sender, senderFrame: sender.mainFrame }
process.env.ELECTRON_RENDERER_URL = 'http://localhost:3107'
process.env.ROXY_MCP = '0'
process.env.ROXY_SKILLS = '0'
let catalogs = 0
let executions = []
let closes = 0
let downloadBody = Buffer.from('bad')
const originalFetch = globalThis.fetch
const put = async (path, text = '') => {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, text)
}
for (const { id, version } of shared.ENGINEERING_TOOLS) {
  await put(join(directory, 'engineering-tools', id, 'verified'), version)
  const asset = downloads.engineeringDownload(id)
  if (asset) await put(join(directory, 'engineering-tools', id, asset.directory, asset.executable))
}
for (const id of ['node', 'java']) {
  const asset = downloads.engineeringDownload(id)
  await put(join(directory, 'engineering-tools', id, asset.directory, asset.executable))
}
await put(join(directory, 'engineering-tools/rea/node_modules/rea-agents/scripts/rea.mjs'))
await put(join(directory, 'engineering-tools/rea/node_modules/frida/build/frida_binding.node'))
const catalog = shared.ENGINEERING_OPERATIONS.map((operation) => ({
  type: 'function',
  function: {
    name: shared.engineeringName(operation),
    description: operation,
    parameters: { type: 'object' }
  }
}))
globalThis.__engineeringMocks = {
  electron: {
    app: { getPath: () => directory },
    BrowserWindow: {
      getAllWindows: () => [],
      fromWebContents: (contents) => (contents === sender ? {} : null)
    },
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) }
  },
  runtime: {
    engineeringCatalog: async () => {
      catalogs++
      return catalog
    },
    executeEngineering: async (...args) => {
      executions.push(args)
      return { structuredContent: { result: 'native' } }
    },
    closeEngineeringRuntimes: async () => {
      closes++
    }
  },
  processes: {
    spawn: (_command, args) => {
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.exitCode = null
      child.kill = () => {}
      setTimeout(() => {
        child.stdout.emit('data', args.includes('--list-modules') ? 'jdk.compiler@21' : 'v24.18.0')
        child.exitCode = 0
        child.emit('exit', 0)
      }, 0)
      return child
    }
  },
  downloads: {
    engineeringDownload: (id) =>
      id === 'jadx'
        ? {
            url: 'https://example.invalid/pinned.jar',
            sha256: createHash('sha256').update('good').digest('hex'),
            directory: '.',
            executable: 'jadx.jar',
            jar: true
          }
        : downloads.engineeringDownload(id)
  }
}
await build({
  entryPoints: ['src/main/services/engineering-tools.ts'],
  outfile: 'test/.out/engineering-service.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  plugins: [
    {
      name: 'boundaries',
      setup(plugin) {
        plugin.onResolve(
          { filter: /^(electron|node:child_process)$|^\.\/engineering-(runtime|downloads)$/ },
          (args) => ({ path: args.path, namespace: 'mock' })
        )
        plugin.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({
          contents: `module.exports = globalThis.__engineeringMocks.${path === 'electron' ? 'electron' : path === 'node:child_process' ? 'processes' : path.endsWith('runtime') ? 'runtime' : 'downloads'}`
        }))
      }
    }
  ]
})
try {
  const service = require(resolve('test/.out/engineering-service.cjs'))
  service.registerEngineeringIpc()
  const invoke = (name, ...args) => handlers.get('engineering:' + name)(trusted, ...args)
  assert.equal((await invoke('state')).preferences.enabled, false)
  assert.equal((await service.engineeringTurn()).schemas.length, 0)
  assert.equal(catalogs, 0, 'Default off does not spawn even a catalog worker')
  assert.equal(
    (await service.runEngineeringTool('rea_inspect_artifact', {}, 'one', directory)).ok,
    false
  )
  assert.equal(executions.length, 0)
  assert.equal(
    (await handlers.get('engineering:update')({ sender: {}, senderFrame: {} }, { enabled: true }))
      .error,
    'permission'
  )
  assert.equal((await invoke('update', { groups: ['bad'] })).error, 'invalid')
  assert.equal((await invoke('install', 'wireshark', false)).error, 'permission')
  assert((await invoke('update', { guidance: true })).ok)
  let turn = await service.engineeringTurn()
  assert.equal(turn.schemas.length, 0)
  assert.match(turn.guidance, /no native reverse engineering tools/)
  assert.equal(catalogs, 0, 'Guidance-only does not start a runtime')
  assert((await invoke('update', { enabled: true, groups: ['rea', 'ghidra', 'jadx'] })).ok)
  turn = await service.engineeringTurn()
  assert(turn.schemas.some(({ function: f }) => f.name === 'rea_analyze_function'))
  assert.match(turn.guidance, /rea_inspect_artifact/)
  assert(!turn.guidance.includes('mcp__roxy-'))
  assert((await service.runEngineeringTool('rea_inspect_artifact', {}, 'one', directory)).ok)
  assert.equal(executions.at(-1)[0], 'one')
  assert((await service.runEngineeringTool('rea_inspect_artifact', {}, 'two', directory)).ok)
  assert.equal(executions.at(-1)[0], 'two', 'Separate chats have separate native runtime keys')
  assert.equal(
    (
      await service.runEngineeringTool(
        'rea_open_binary',
        { provider_id: 'hopper' },
        'one',
        directory
      )
    ).ok,
    false
  )
  assert((await invoke('update', { guidance: false })).ok)
  const before = closes
  turn = await service.engineeringTurn()
  assert.equal(turn.guidance, undefined)
  assert(turn.schemas.length > 0, 'Guidance switch does not remove actual tools')
  assert((await invoke('update', { guidance: true })).ok)
  assert.equal(closes, before, 'Guidance-only change does not close runtime sessions')
  assert((await invoke('update', { disabledCalls: ['inspect_artifact'] })).ok)
  turn = await service.engineeringTurn()
  assert(!turn.schemas.some(({ function: f }) => f.name === 'rea_inspect_artifact'))
  assert(!turn.guidance.includes('rea_inspect_artifact'))
  const count = executions.length
  assert.equal(
    (await service.runEngineeringTool('rea_inspect_artifact', {}, 'one', directory)).ok,
    false
  )
  assert.equal(executions.length, count, 'Disabled stale call cannot execute')
  assert((await invoke('update', { enabled: false })).ok)
  assert.equal((await service.engineeringTurn()).schemas.length, 0)
  assert.equal(
    (await service.runEngineeringTool('rea_analyze_function', {}, 'one', directory)).ok,
    false
  )
  const saved = JSON.parse(await readFile(join(directory, 'engineering-tools/preferences.json')))
  assert.equal(saved.enabled, false)
  assert.equal(saved.guidance, true)
  // Unified switch updates tools and prompt together without reinstalling.
  assert((await invoke('update', { enabled: true, guidance: true })).ok)
  assert((await service.engineeringTurn()).schemas.length > 0)
  assert((await service.engineeringTurn()).guidance)
  assert((await invoke('update', { enabled: false, guidance: false })).ok)
  assert.equal((await service.engineeringTurn()).schemas.length, 0)
  assert.equal((await service.engineeringTurn()).guidance, undefined)
  // Download integrity/cancel paths use real files and a deterministic pinned asset.
  await rm(join(directory, 'engineering-tools/jadx'), { recursive: true, force: true })
  await invoke('state')
  globalThis.fetch = async () => new Response(downloadBody)
  assert.equal((await invoke('install', 'jadx')).error, 'integrity')
  assert.equal((await invoke('state')).installed.includes('jadx'), false)
  let downloading = false
  globalThis.fetch = (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      downloading = true
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
    })
  const pending = invoke('install', 'jadx')
  while (!downloading) await new Promise((resolve) => setTimeout(resolve, 1))
  assert.equal((await invoke('install', 'adb')).error, 'busy')
  assert.equal((await invoke('update', { enabled: true })).error, 'busy')
  await invoke('cancel')
  assert.equal((await pending).error, 'cancelled')
  downloadBody = Buffer.from('good')
  globalThis.fetch = async () => new Response(downloadBody)
  assert((await invoke('install', 'jadx')).ok)
  assert((await invoke('state')).installed.includes('jadx'))
  assert.equal(
    (await invoke('state')).preferences.enabled,
    false,
    'Individual install does not enable tools'
  )
  // One-click setup can adopt already installed dependencies and auto-enable.
  // Supply system-package test executables without touching actual system dependencies.
  if (process.platform === 'win32') {
    const previousProgramFiles = process.env.ProgramFiles
    process.env.ProgramFiles = join(directory, 'system')
    await put(join(process.env.ProgramFiles, 'Wireshark/tshark.exe'))
    await put(join(process.env.ProgramFiles, 'Wireshark/capinfos.exe'))
    try {
      // Install-all rescans missing payloads and only enables after success.
      await rm(join(directory, 'engineering-tools/jadx'), { recursive: true, force: true })
      downloadBody = Buffer.from('bad')
      assert.equal((await invoke('installAll', true)).error, 'integrity')
      assert.equal((await invoke('state')).preferences.enabled, false)
      assert.equal((await invoke('state')).preferences.guidance, false)
      downloadBody = Buffer.from('good')
      assert((await invoke('installAll', true)).ok)
      assert.equal((await invoke('state')).error, null)
      assert.equal((await invoke('state')).preferences.enabled, true)
      assert.equal((await invoke('state')).preferences.guidance, true)
      assert.equal((await invoke('state')).preferences.disabledCalls.length, 0)
      assert((await invoke('update', { enabled: false, guidance: false })).ok)
    } finally {
      if (previousProgramFiles === undefined) delete process.env.ProgramFiles
      else process.env.ProgramFiles = previousProgramFiles
    }
  }
  await rm(join(directory, 'engineering-tools/jadx'), { recursive: true, force: true })
  await invoke('state')
  downloading = false
  globalThis.fetch = (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      downloading = true
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
    })
  const interrupted = invoke('install', 'jadx')
  while (!downloading) await new Promise((resolve) => setTimeout(resolve, 1))
  await service.resetEngineeringTools()
  assert.equal((await interrupted).error, 'cancelled')
  await service.resetEngineeringTools()
  assert((await invoke('update', { enabled: true, groups: ['rea'] })).ok)
  // A failed reset must not leave the settings admission lock stuck.
  const fs = await import('node:fs/promises')
  // A filesystem-level failure is covered below by turning the root into a file.
  await service.resetEngineeringTools()
  const prefsRoot = join(directory, 'engineering-tools')
  const movedRoot = join(directory, 'engineering-tools-backup')
  await fs.rename(prefsRoot, movedRoot)
  await writeFile(prefsRoot, 'blocked')
  await assert.rejects(service.resetEngineeringTools())
  await rm(prefsRoot)
  await fs.rename(movedRoot, prefsRoot)
  assert(
    (await invoke('update', { guidance: false })).ok,
    'Failed reset releases its admission lock'
  )
  await service.resetEngineeringTools()
  assert.deepEqual((await invoke('state')).preferences, off)
  assert.equal((await service.engineeringTurn()).guidance, undefined)
  console.log(
    `ENGINEERING OK: ${shared.ENGINEERING_OPERATIONS.length} curated operations, default off, independent prompt, catalog/dispatch parity, native isolation, consent, persistence, reset`
  )
} finally {
  globalThis.fetch = originalFetch
  await rm(directory, { recursive: true, force: true })
  delete globalThis.__engineeringMocks
}
