import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'

const require = createRequire(import.meta.url)
const directory = await mkdtemp(join(tmpdir(), 'roxy-voice-test-'))
await build({
  entryPoints: ['src/shared/voice.ts'],
  outfile: 'test/.out/voice-shared.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs'
})
const shared = require(resolve('test/.out/voice-shared.cjs'))
const contentsByName = new Map(
  shared.VOICE_MODELS[0].files.map((file) => [file.name, Buffer.from(file.name)])
)
const originalFiles = shared.VOICE_MODELS[0].files
let renamed = false
let savedMarker = false
const handlers = new Map()
const registrations = new Map()
const events = []
let forks = 0
let loads = 0
let kills = 0
let begins = 0
const workers = []
const makeWorker = () => {
  const worker = new EventEmitter()
  workers.push(worker)
  worker.postMessage = (data) => {
    if (data.type === 'load') loads++
    if (data.type === 'load') setTimeout(() => worker.emit('message', { type: 'ready' }), 0)
    if (data.type === 'begin') {
      begins++
      worker.emit('message', { type: 'started', recordingId: data.recordingId })
    }
    if (data.type === 'audio') {
      worker.emit('message', { type: 'text', recordingId: data.recordingId, text: 'live text' })
      worker.emit('message', {
        type: 'ack',
        recordingId: data.recordingId,
        frames: data.samples.length
      })
    }
    if (data.type === 'finish')
      worker.emit('message', { type: 'finished', recordingId: data.recordingId })
  }
  worker.kill = () => {
    kills++
    worker.emit('exit', 0)
    return true
  }
  return worker
}
let settings = { enabled: false, modelId: null, microphone: null, hotkeys: ['', ''] }
let captureOptions
let releaseOpen
let closes = 0
let available = true
const recorder = {
  isRecording: false,
  start() {
    this.isRecording = true
    captureOptions.onChunk({ samples: new Float32Array(1600) })
  },
  async stop() {
    this.isRecording = false
    return { complete: true }
  },
  async close() {
    closes++
    this.isRecording = false
  }
}
let holding = false
globalThis.__voiceMocks = {
  shared,
  electron: {
    app: { getPath: () => directory },
    BrowserWindow: class {},
    globalShortcut: {
      isRegistered: (key) => registrations.has(key),
      register: (key, callback) => {
        if (key === 'Taken') return false
        registrations.set(key, callback)
        return true
      },
      unregister: (key) => registrations.delete(key)
    },
    ipcMain: { handle: (key, callback) => handlers.set(key, callback) },
    powerMonitor: new EventEmitter(),
    shell: { openExternal: async () => {} },
    systemPreferences: { getMediaAccessStatus: () => 'granted' },
    utilityProcess: {
      fork: () => {
        forks++
        return makeWorker()
      }
    }
  },
  repo: {
    getVoiceSettings: () => settings,
    setVoiceSettings: (next) => {
      settings = next
    },
    getChat: () => ({ id: 'chat' })
  },
  fs: {
    mkdir: async () => {},
    rm: async () => {},
    rename: async () => {
      renamed = true
    },
    writeFile: async () => {
      savedMarker = true
    },
    open: async () => ({
      write: async (chunk, offset) => ({ bytesWritten: chunk.length - offset }),
      close: async () => {}
    }),
    readFile: async () => '7551fd26fc810cc1e4e043e608db4d13b59be31e',
    stat: async (path) => {
      if (!available) throw new Error('missing')
      const name = path.split(/[\\/]/).pop()
      return {
        size: {
          'encoder.int8.onnx': 654046389,
          'decoder.int8.onnx': 7257777,
          'joiner.int8.onnx': 1735860,
          'tokens.txt': 8952
        }[name]
      }
    }
  },
  native: {
    listInputDevices: async () => [{ id: 'usb', name: 'Mic', occurrence: 0, isDefault: true }],
    Recorder: {
      open: async (options) => {
        captureOptions = options
        if (holding)
          await new Promise((resolve) => {
            releaseOpen = resolve
          })
        return recorder
      }
    }
  }
}
await build({
  entryPoints: ['src/main/services/voice.ts'],
  outfile: 'test/.out/voice-service.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  plugins: [
    {
      name: 'voice-boundaries',
      setup(plugin) {
        plugin.onResolve(
          { filter: /^(electron|@handy-computer\/recorder)$|^\.\.\/db\/repo$/ },
          (args) => ({ path: args.path, namespace: 'voice-mock' })
        )
        plugin.onResolve({ filter: /^node:fs\/promises$/ }, () => ({
          path: 'fs',
          namespace: 'voice-mock'
        }))
        plugin.onResolve({ filter: /^\.\.\/\.\.\/shared\/voice$/ }, () => ({
          path: 'shared',
          namespace: 'voice-mock'
        }))
        plugin.onLoad({ filter: /.*/, namespace: 'voice-mock' }, (args) => {
          const key =
            args.path === 'electron'
              ? 'electron'
              : args.path.includes('recorder')
                ? 'native'
                : args.path === 'shared'
                  ? 'shared'
                  : args.path === 'fs'
                    ? 'fs'
                    : 'repo'
          return { contents: `module.exports = globalThis.__voiceMocks.${key}` }
        })
      }
    }
  ]
})
try {
  const service = require(resolve('test/.out/voice-service.cjs'))
  const contents = new EventEmitter()
  contents.getURL = () => 'file:///untrusted'
  contents.mainFrame = {}
  contents.send = (_channel, event) => events.push(event)
  const window = new EventEmitter()
  Object.assign(window, { isDestroyed: () => false, webContents: contents })
  service.setVoiceWindow(window)
  service.registerVoiceIpc()
  process.env.ELECTRON_RENDERER_URL = 'http://localhost:3105'
  contents.getURL = () => 'http://localhost:3105/'
  const trusted = { sender: contents, senderFrame: contents.mainFrame }
  const invoke = (name, ...args) => handlers.get('voice:' + name)(trusted, ...args)
  assert.equal(registrations.size, 0)
  assert.equal(forks, 0, 'Disabled voice does not boot a model')
  contents.getURL = () => 'https://untrusted.example/'
  assert.equal((await invoke('start', 'one', 'chat')).error, 'disabled')
  contents.getURL = () => 'http://localhost:3105/'
  assert.equal((await invoke('start', 'one', 'chat')).error, 'disabled')
  assert.equal(
    (await handlers.get('voice:start')({ sender: {}, senderFrame: {} }, 'one', 'chat')).error,
    'disabled'
  )
  assert.equal(
    (await handlers.get('voice:start')({ sender: contents, senderFrame: {} }, 'one', 'chat')).error,
    'disabled'
  )
  assert(
    (
      await invoke('update', {
        enabled: true,
        modelId: 'parakeet-unified-en-streaming',
        hotkeys: ['Ctrl+Space', 'Alt+Space']
      })
    ).ok
  )
  assert.equal(registrations.size, 2)
  while (!loads) await new Promise((resolve) => setTimeout(resolve, 1))
  assert.equal(loads, 1, 'Selecting an enabled model preloads weights')
  assert.equal(captureOptions, undefined, 'Preload does not open the microphone')
  assert.equal((await invoke('update', { hotkeys: ['Taken', 'Alt+Space'] })).error, 'shortcutTaken')
  assert.deepEqual([...registrations.keys()], ['Ctrl+Space', 'Alt+Space'])
  assert.equal(
    (await invoke('update', { hotkeys: ['Ctrl+Space', 'ctrl+space'] })).error,
    'shortcutInvalid'
  )
  assert((await invoke('start', 'one', 'chat')).ok)
  assert(events.some((event) => event.type === 'transcript' && event.text === 'live text'))
  assert.equal((await invoke('start', 'two', 'chat')).error, 'busy')
  await invoke('stop', 'foreign', false)
  assert.equal(recorder.isRecording, true)
  await invoke('stop', 'one', true)
  assert.equal(kills, 0, 'Stopping retains loaded model weights')
  assert.equal(closes, 1)
  assert(events.some((event) => event.type === 'recording' && event.phase === 'stopped'))
  holding = true
  const opening = invoke('start', 'late', 'chat')
  while (!releaseOpen) await new Promise((resolve) => setTimeout(resolve, 1))
  const stopping = invoke('stop', 'late', false)
  assert.equal((await invoke('start', 'overlap', 'chat')).error, 'busy')
  releaseOpen()
  await Promise.all([opening, stopping])
  assert.equal(recorder.isRecording, false)
  assert(closes >= 2)
  assert.equal(forks, 1, 'Recording again reuses the warm model process')
  assert.equal(loads, 1)
  assert.equal(begins, 2, 'Every recording gets a fresh recognition stream')
  holding = false
  const cancelledBeforeValidation = invoke('start', 'before-check', 'chat')
  await invoke('stop', 'before-check', false)
  assert.equal((await cancelledBeforeValidation).ok, false)
  assert.equal(recorder.isRecording, false)
  await invoke('update', { enabled: false })
  assert.equal(kills, 1, 'Disabling releases loaded model memory')
  assert.equal(registrations.size, 0)
  available = true
  await invoke('update', { enabled: true })
  while (loads < 2) await new Promise((resolve) => setTimeout(resolve, 1))
  await invoke('update', { modelId: shared.VOICE_MODELS[1].id })
  assert.equal(kills, 2, 'Switching models unloads previous weights')
  assert.equal((await invoke('start', 'missing-model', 'chat')).error, 'modelRequired')
  await invoke('update', { modelId: shared.VOICE_MODELS[0].id })
  while (loads < 3) await new Promise((resolve) => setTimeout(resolve, 1))
  assert((await invoke('start', 'isolated', 'chat')).ok)
  const beforeStale = events.filter((event) => event.type === 'transcript').length
  workers.at(-1).emit('message', { type: 'text', recordingId: 'one', text: 'stale' })
  assert.equal(
    events.filter((event) => event.type === 'transcript').length,
    beforeStale,
    'Warm process rejects earlier recording text'
  )
  await invoke('stop', 'isolated', false)
  await invoke('update', { microphone: { id: 'usb', name: 'Mic', occurrence: 0 } })
  assert.equal(loads, 3, 'Microphone settings do not reload unchanged weights')
  await invoke('update', { enabled: false })
  assert.equal(kills, 3)
  await invoke('update', { enabled: true })
  while (loads < 4) await new Promise((resolve) => setTimeout(resolve, 1))
  assert((await invoke('start', 'crash', 'chat')).ok)
  workers.at(-1).emit('exit', 1)
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert(
    events.some(
      (event) =>
        event.type === 'recording' &&
        event.recordingId === 'crash' &&
        event.error === 'engineFailed'
    )
  )
  assert((await invoke('start', 'recovered', 'chat')).ok)
  assert.equal(loads, 5, 'Next recording recovers a crashed model process')
  await invoke('stop', 'recovered', false)
  await invoke('remove', shared.VOICE_MODELS[0].id)
  assert.equal(settings.modelId, null, 'Removing the selected model clears selection')
  assert.equal(kills, 4, 'Removing the selected model unloads it')
  await invoke('update', { enabled: false, modelId: shared.VOICE_MODELS[0].id })
  available = false
  await invoke('update', { enabled: true })
  assert.equal((await invoke('start', 'missing', 'chat')).error, 'modelRequired')
  shared.VOICE_MODELS[0].files = originalFiles.map((file) => ({
    ...file,
    bytes: contentsByName.get(file.name).length,
    sha256: createHash('sha256').update(contentsByName.get(file.name)).digest('hex')
  }))
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async (url) => new Response(contentsByName.get(url.split('/').pop()))
    assert((await invoke('download', shared.VOICE_MODELS[0].id)).ok)
    assert(renamed && savedMarker, 'Only verified files publish a completed directory')
    renamed = savedMarker = false
    globalThis.fetch = async () => new Response('corrupt')
    assert.equal((await invoke('download', shared.VOICE_MODELS[0].id)).error, 'integrityFailed')
    assert(!renamed && !savedMarker, 'Corrupt download never publishes')
    globalThis.fetch = (_url, { signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(Error('cancelled')))
      )
    const pending = invoke('download', shared.VOICE_MODELS[0].id)
    await new Promise((resolve) => setTimeout(resolve, 5))
    await invoke('cancelDownload')
    assert((await pending).ok, 'Explicit cancellation is not a download error')
    assert(!renamed && !savedMarker, 'Cancelled download never publishes')
  } finally {
    globalThis.fetch = originalFetch
  }
  service.shutdownVoice()
  console.log(
    'VOICE SERVICE OK: opt-in, isolation, hotkeys, streaming, warm reuse without mic, unload/switch/removal, crash recovery, cancellation, verified downloads'
  )
} finally {
  await rm(directory, { recursive: true, force: true })
  delete globalThis.__voiceMocks
}
