import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, writeFile, readFile, copyFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'

if (process.platform !== 'win32' || process.arch !== 'x64') {
  console.log('DLL LAB SKIP: Windows x64 and installed Visual Studio C++ tools are required.')
  process.exit(0)
}
const require = createRequire(import.meta.url)
const directory = await mkdtemp(join(tmpdir(), 'roxy-dll-owned-lab-'))
const handlers = new Map()
const sender = { mainFrame: {}, getURL: () => 'http://localhost:3117/' }
const trusted = { sender, senderFrame: sender.mainFrame }
process.env.ELECTRON_RENDERER_URL = 'http://localhost:3117'
globalThis.__dllLabElectron = {
  app: { isPackaged: false, getPath: () => directory, getAppPath: () => resolve('.') },
  BrowserWindow: {
    getAllWindows: () => [],
    fromWebContents: (value) => (value === sender ? {} : null)
  },
  ipcMain: { handle: (name, callback) => handlers.set(name, callback) }
}
let host
try {
  await build({
    entryPoints: ['src/main/services/cheat.ts'],
    outfile: 'test/.out/cheat-dll.cjs',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    plugins: [
      {
        name: 'electron-lab-only',
        setup(plugin) {
          plugin.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'lab' }))
          plugin.onLoad({ filter: /.*/, namespace: 'lab' }, () => ({
            contents: 'module.exports = globalThis.__dllLabElectron'
          }))
        }
      }
    ]
  })
  const service = require(resolve('test/.out/cheat-dll.cjs'))
  service.registerCheatIpc()
  const invoke = (name, ...args) => handlers.get('cheat:' + name)(trusted, ...args)
  const run = async (name, input = {}, signal) => {
    const result = await service.runCheatTool('cheat_' + name, input, 'owned-lab', 'host', signal)
    assert(result.ok, result.output)
    return JSON.parse(result.output.split('\n').slice(1).join('\n'))
  }
  assert((await invoke('update', { enabled: true })).ok)
  const built = await run('build_dll', {
    sources: [resolve('test/fixtures/cheat-lab.cpp')],
    name: 'roxy-owned-lab'
  })
  assert(built.built && !built.executed)
  const info = await run('inspect_dll', { path: built.path })
  assert.equal(info.sha256, built.sha256)
  assert.equal(info.architecture, 'x64')
  assert.equal(info.managed, false)
  assert.equal(info.executed, false)
  assert(info.sections.length > 0)
  const cc = join(directory, 'fixture with spaces.cc')
  await copyFile(resolve('test/fixtures/cheat-lab.cpp'), cc)
  assert(
    (await run('build_dll', { sources: [cc], name: 'cc-with-spaces' })).built,
    'Explicit C++ compilation for .cc paths'
  )
  const badCpp = join(directory, 'bad.cpp')
  await writeFile(badCpp, 'this is not valid C++;')
  const badBuild = await service.runCheatTool(
    'cheat_build_dll',
    { sources: [badCpp], name: 'bad-build' },
    'owned-lab',
    'host'
  )
  assert.equal(badBuild.ok, false, 'Compiler diagnostics are not a successful build')
  const invalid = join(directory, 'invalid.dll')
  await writeFile(invalid, Buffer.alloc(512))
  await assert.rejects(run('inspect_dll', { path: invalid }), /PE image/)
  for (const path of [
    '\\\\server\\share\\test.dll',
    '//server/share/test.dll',
    'C:relative.dll',
    '\\relative.dll',
    '\\\\?\\C:\\fixture.dll',
    'C:\\fixture.dll:stream.dll'
  ])
    await assert.rejects(run('inspect_dll', { path }), /local DLL|DLL path/)
  const hostPath = join(directory, 'owned-lab-host.exe')
  const compiled = spawnSync(
    join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
    [
      '/nologo',
      '/platform:x64',
      '/target:exe',
      '/out:' + hostPath,
      resolve('test/fixtures/cheat-lab-host.cs')
    ],
    { encoding: 'utf8', timeout: 30000 }
  )
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr)
  host = spawn(hostPath, [built.path], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const lines = createInterface({ input: host.stdout })[Symbol.asyncIterator]()
  const line = async () => {
    let timer
    try {
      return await Promise.race([
        lines.next().then((value) => {
          if (value.done) throw new Error('Lab host exited')
          return value.value
        }),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Lab host response timeout')), 15000)
        })
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  assert.equal(Number(await line()), host.pid)
  host.stdin.write('verify\n')
  assert.equal(await line(), 'absent:')
  await run('open_process', { pid: host.pid })
  const mutable = join(directory, 'mutable.dll')
  await copyFile(built.path, mutable)
  const mutableInfo = await run('inspect_dll', { path: mutable })
  const modified = await readFile(mutable)
  modified[modified.length - 1] ^= 1
  await writeFile(mutable, modified)
  await assert.rejects(
    run('load_dll', { path: mutable, sha256: mutableInfo.sha256 }),
    /hash does not match/,
    'Optional hash check rejects changed artifact'
  )
  await assert.rejects(
    run('load_dll', { path: built.path, sha256: '0'.repeat(64) }),
    /hash does not match/
  )
  host.stdin.write('verify\n')
  assert.equal(await line(), 'absent:', 'Inspection and hash failures do not execute DLL')
  const loaded = await run('load_dll', { path: built.path })
  assert.equal(loaded.status, 'loaded')
  assert(loaded.dispatched && loaded.moduleBase)
  host.stdin.write('verify\n')
  assert.equal(
    await line(),
    'mapped:owned-fixture',
    'Direct DLL call runs DllMain in our selected lab host without UI approval'
  )
  assert.equal(
    (await run('load_dll', { path: built.path, sha256: built.sha256 })).status,
    'already-loaded'
  )
  await run('close_process')
  await assert.rejects(run('load_dll', { path: built.path }), /Open an authorized/)
  host.stdin.end('exit\n')
  await new Promise((resolve) => host.once('exit', resolve))
  host = undefined
  // A deliberately slow DllMain tests retained ownership after timeout/cancel.
  for (const cancel of [false, true]) {
    host = spawn(hostPath, [built.path], {
      env: { ...process.env, ROXY_LAB_DLL_DELAY: '1' },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const pendingLines = createInterface({ input: host.stdout })[Symbol.asyncIterator]()
    assert.equal(Number((await pendingLines.next()).value), host.pid)
    await run('open_process', { pid: host.pid })
    const controller = new AbortController()
    const timer = cancel ? setTimeout(() => controller.abort(), 5000) : undefined
    const result = await service.runCheatTool(
      'cheat_load_dll',
      { path: built.path },
      'owned-lab',
      'host',
      controller.signal
    )
    clearTimeout(timer)
    assert.equal(result.ok, false, 'Timeout/cancel must not claim loaded')
    assert(result.output.includes('unknown'))
    await assert.rejects(
      writeFile(built.path, await readFile(built.path)),
      /EBUSY|EACCES|EPERM/,
      'Selected file remains locked while loader can execute'
    )
    await assert.rejects(
      run('load_dll', { path: built.path }),
      /still owns this process/,
      'No concurrent loader retry while helper owns target'
    )
    host.stdin.write('verify\n')
    let observed = (await pendingLines.next()).value
    const finishBy = Date.now() + 40000
    while (observed !== 'mapped:owned-fixture' && Date.now() < finishBy) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      host.stdin.write('verify\n')
      observed = (await pendingLines.next()).value
    }
    assert.equal(
      observed,
      'mapped:owned-fixture',
      'Unknown outcome can complete later; mapped does not mean DllMain finished'
    )
    host.stdin.end('exit\n')
    await new Promise((resolve) => host.once('exit', resolve))
    host = undefined
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  console.log(
    'DLL LAB OK: real DLL/.cc builds, compiler failure, PE read/hash, local-path validation, optional hash check, direct native load + DllMain in owned fixture only, selected target close, timeout/cancel retained-file lock and retry exclusion'
  )
} finally {
  if (host) {
    host.kill()
    await new Promise((resolve) => {
      if (host.exitCode !== null) resolve()
      else host.once('exit', resolve)
    })
  }
  delete globalThis.__dllLabElectron
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
