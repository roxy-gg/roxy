import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const handlers = new Map(),
  overlays = []
let enabled = false,
  failCapture = false,
  failCrop = false,
  compositionFailure = false,
  holdComposition = false
let pointer,
  escape,
  releaseComposition,
  snapshots = 0,
  stops = 0,
  encodings = 0,
  resized,
  crop,
  composed
let point = { x: 0, y: 0 }
const wait = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (probe) => {
  for (let n = 0; n < 200; n++) {
    if (probe()) return
    await wait()
  }
  throw Error('Timed out')
}
class Window extends EventEmitter {
  constructor(options) {
    super()
    this.options = options
    this.visible = false
    this.destroyed = false
    this.webContents = new EventEmitter()
    this.webContents.mainFrame = {}
    this.webContents.getURL = () => this.url ?? 'http://localhost:3101/'
    this.webContents.setWindowOpenHandler = () => {}
    this.webContents.send = (channel, state) => {
      this.lastEvent = { channel, state }
    }
    if (options) overlays.push(this)
  }
  isDestroyed() {
    return this.destroyed
  }
  isVisible() {
    return this.visible
  }
  getBounds() {
    return this.options
  }
  hide() {
    this.visible = false
  }
  show() {
    this.visible = true
  }
  showInactive() {
    this.visible = true
  }
  focus() {
    this.focused = true
  }
  blur() {
    this.focused = false
  }
  setFocusable(value) {
    this.focusable = value
  }
  setSkipTaskbar() {}
  moveTop() {
    this.raises = (this.raises ?? 0) + 1
  }
  isFocused() {
    return this.focused
  }
  setIgnoreMouseEvents(value) {
    this.ignoring = value
  }
  setMenu() {}
  async loadURL(url) {
    this.url = url
    handlers.get('narrete:ready')({
      sender: this.webContents,
      senderFrame: this.webContents.mainFrame
    })
  }
  destroy() {
    this.destroyed = true
    this.emit('closed')
  }
}
const image = {
  isEmpty: () => false,
  getSize: () => ({ width: 3000, height: 1500 }),
  toDataURL: () => 'data:image/png;base64,AAAA',
  crop: (region) => {
    if (failCrop) throw Error('Invalid image')
    crop = region
    return {
      getSize: () => ({ width: region.width, height: region.height }),
      resize: (options) => {
        resized = options
        return { toJPEG: () => Buffer.from('resized') }
      },
      toJPEG: () => {
        encodings++
        return Buffer.from('cropped')
      }
    }
  }
}
const powerMonitor = new EventEmitter(),
  screen = new EventEmitter()
// Exercise the real observer boundary without loading a native hook.
const hook = new EventEmitter()
let starts = 0,
  hookStops = 0,
  escapes = 0
hook.start = () => starts++
hook.stop = () => hookStops++
const observed = []
globalThis.__narreteInputMock = { uIOhook: hook, UiohookKey: { Escape: 1 } }
await build({
  entryPoints: ['src/main/services/narrete-input.ts'],
  outfile: 'test/.out/narrete-input.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  plugins: [
    {
      name: 'input-boundary',
      setup(plugin) {
        plugin.onResolve({ filter: /^uiohook-napi$/ }, () => ({ path: 'input', namespace: 'mock' }))
        plugin.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({
          contents: 'module.exports = globalThis.__narreteInputMock'
        }))
      }
    }
  ]
})
const input = createRequire(import.meta.url)(resolve('test/.out/narrete-input.cjs'))
const stopInput = await input.listenNarreteInput(
  (event) => observed.push(event),
  () => escapes++
)
const key = { keycode: 29, ctrlKey: true, altKey: false }
hook.emit('keydown', key)
hook.emit('mousedown', { button: 1, ctrlKey: true, altKey: false, x: 10, y: 20 })
hook.emit('keyup', key)
hook.emit('keyup', { ...key, ctrlKey: false })
hook.emit('keydown', { ...key, keycode: 56, altKey: true })
hook.emit('keydown', { ...key, keycode: 1 })
assert.deepEqual(
  observed.map((event) => event.type),
  ['modifiers', 'down', 'modifiers', 'modifiers', 'modifiers', 'modifiers']
)
assert.equal(
  observed[2].ctrlKey,
  true,
  'Releasing one Ctrl while another is held keeps capture armed'
)
assert.equal(observed[3].ctrlKey, false)
assert.equal(observed[4].altKey, true)
assert.equal(escapes, 1)
stopInput()
assert.equal(starts, 1)
assert.equal(hookStops, 1)
assert.deepEqual(hook.eventNames(), [], 'Every temporary native listener is removed')
delete globalThis.__narreteInputMock
screen.getAllDisplays = () => [
  {
    id: 1,
    bounds: { x: -1500, y: 0, width: 1500, height: 750 },
    size: { width: 1500, height: 750 },
    scaleFactor: 2
  },
  {
    id: 2,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    size: { width: 1920, height: 1080 },
    scaleFactor: 1
  }
]
screen.getCursorScreenPoint = () => point
screen.screenToDipPoint = (point) => point
globalThis.__narreteMocks = {
  input: {
    listenNarreteInput: async (p, e) => {
      pointer = p
      escape = e
      return () => {
        pointer = null
        stops++
      }
    }
  },
  composition: {
    composeNarrete: async (regions) => {
      composed = regions
      if (holdComposition)
        await new Promise((resolve) => {
          releaseComposition = resolve
        })
      if (compositionFailure) throw Error('Too large')
      return {
        dataUrl: 'data:image/png;base64,YnJpZWY=',
        mediaType: 'image/png',
        name: 'Narrete.png'
      }
    }
  },
  electron: {
    BrowserWindow: Window,
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    powerMonitor,
    screen,
    desktopCapturer: {
      getSources: async () => {
        snapshots++
        if (failCapture) throw Error('Denied')
        return [
          { display_id: '1', thumbnail: image },
          { display_id: '2', thumbnail: image }
        ]
      }
    },
    systemPreferences: { getMediaAccessStatus: () => 'granted' }
  },
  repo: {
    getSettings: () => ({ narreteEnabled: enabled, language: 'en' }),
    getChat: (id) => (id === 'original' ? { id } : null),
    setNarreteEnabled: (value) => ({ narreteEnabled: (enabled = value) })
  }
}
await build({
  entryPoints: ['src/main/services/narrete.ts'],
  outfile: 'test/.out/narrete-service.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  plugins: [
    {
      name: 'boundaries',
      setup(plugin) {
        plugin.onResolve(
          { filter: /^electron$|^\.\.\/db\/repo$|^\.\/narrete-image$|^\.\/narrete-input$/ },
          (args) => ({
            path:
              args.path === 'electron'
                ? 'electron'
                : args.path.endsWith('repo')
                  ? 'repo'
                  : args.path.endsWith('input')
                    ? 'input'
                    : 'composition',
            namespace: 'mock'
          })
        )
        plugin.onLoad({ filter: /.*/, namespace: 'mock' }, (args) => ({
          contents: `module.exports = globalThis.__narreteMocks.${args.path}`
        }))
      }
    }
  ]
})
const service = createRequire(import.meta.url)(resolve('test/.out/narrete-service.cjs'))
const owner = new Window()
process.env.ELECTRON_RENDERER_URL = 'http://localhost:3101'
service.setNarreteWindow(owner)
service.registerNarreteIpc()
const event = (window) => ({
  sender: window.webContents,
  senderFrame: window.webContents.mainFrame
})
const invoke = (window, name, ...args) => handlers.get('narrete:' + name)(event(window), ...args)
const modifiers = (ctrlKey, altKey = false) => pointer({ type: 'modifiers', ctrlKey, altKey })
const press = (event) => {
  modifiers(event.ctrlKey, event.altKey)
  pointer(event)
}
const gesture = (from, to, ctrlKey = true) => {
  point = to
  press({ type: 'down', button: 1, altKey: false, ctrlKey, ...from })
  pointer({ type: 'move', button: 1, altKey: false, ctrlKey, ...to })
  pointer({ type: 'up', button: 1, altKey: false, ctrlKey, ...to })
  modifiers(false)
}
const selection = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }
try {
  assert.equal((await invoke(owner, 'start', 'disabled', 'original')).ok, false)
  handlers.get('settings:setNarreteEnabled')(event(owner), true)
  const pending = invoke(owner, 'start', 'one', 'original')
  await until(() => !!pointer)
  const [left, right] = overlays
  assert.equal(snapshots, 0, 'No screenshot on entering armed mode')
  assert(left.ignoring && right.ignoring && !left.focused && !right.focused)
  modifiers(true)
  assert(!left.ignoring && !right.ignoring, 'Ctrl intercepts on every display before mouse-down')
  assert(!left.focusable && !right.focusable, 'Capture arming cannot steal keyboard focus')
  assert.equal(left.raises, 1, 'Arming raises capture above other always-on-top windows')
  assert.equal(right.raises, 1)
  modifiers(false)
  assert(left.ignoring && right.ignoring, 'Releasing Ctrl restores ordinary desktop input')
  assert.equal(left.options.transparent, true)
  assert.equal('dataUrl' in invoke(left, 'state'), false)
  assert.equal(service.isNarreteVoiceSender(event(left)), false)
  assert.throws(() => invoke(owner, 'state'))
  gesture({ x: -1350, y: 150 }, { x: -1340, y: 160 })
  gesture({ x: -1350, y: 150 }, { x: -900, y: 170 })
  gesture({ x: -1350, y: 150 }, { x: -900, y: 450 }, false)
  const down = { type: 'down', button: 1, altKey: false, ctrlKey: true, x: -1350, y: 150 }
  const move = { type: 'move', button: 1, altKey: false, ctrlKey: true, x: -900, y: 450 }
  const up = { ...move, type: 'up' }
  // Ctrl must be down at mouse-down and remain held until mouse-up.
  press({ ...down, ctrlKey: false })
  modifiers(true)
  assert(left.ignoring && right.ignoring, 'Ctrl halfway through ordinary dragging cannot intercept')
  pointer(move)
  pointer(up)
  press(down)
  pointer({ ...move, ctrlKey: false })
  pointer(up)
  press(down)
  pointer(move)
  pointer({ ...up, ctrlKey: false })
  // Re-pressing Ctrl without moving cannot revive an abandoned selection.
  press(down)
  pointer(move)
  modifiers(false)
  assert.equal(left.ignoring, false, 'Cancelled capture retains intercepted press until mouse-up')
  modifiers(true)
  pointer(up)
  assert.equal(left.lastEvent.channel, 'narrete:drag')
  assert.equal(left.lastEvent.state, null, 'Ctrl release clears the selection outline')
  press({ ...down, button: 2 })
  pointer(move)
  pointer({ ...up, button: 2 })
  modifiers(false)
  assert(left.ignoring && right.ignoring)
  press(down)
  pointer(move)
  pointer({ ...down, button: 2 })
  pointer({ ...up, button: 2 })
  modifiers(false)
  assert(!left.ignoring, 'Releasing another button cannot unlock an ongoing capture press')
  pointer({ ...up, ctrlKey: false })
  assert(left.ignoring)
  press(down)
  pointer(move)
  modifiers(true, true)
  modifiers(true)
  pointer(up)
  modifiers(false)
  await wait(140)
  assert.equal(
    snapshots,
    0,
    'Normal dragging, small Ctrl-drags, wrong button and interrupted Ctrl never capture'
  )
  gesture({ x: -1350, y: 150 }, { x: -900, y: 450 })
  await until(() => service.narreteVoiceWindow() === left)
  assert.equal(snapshots, 1)
  const preview = invoke(left, 'state').previewDataUrl
  assert.equal(preview, 'data:image/jpeg;base64,' + Buffer.from('cropped').toString('base64'))
  assert.equal(
    invoke(right, 'state').previewDataUrl,
    null,
    'Only selected display receives preview'
  )
  assert.deepEqual(crop, { x: 300, y: 300, width: 900, height: 601 })
  assert.equal(encodings, 1, 'Crop is encoded when capture completes')
  assert.equal(left.focusable, true)
  assert.equal(
    'dataUrl' in invoke(left, 'state'),
    false,
    'Full screenshot stays in main, never rendered'
  )
  assert.equal(left.ignoring, true, 'Captured display remains click-through outside the widget')
  await invoke(left, 'layout', invoke(left, 'state').revision, [
    { x: 200, y: 200, width: 380, height: 200 }
  ])
  point = { x: -1200, y: 300 }
  await wait(30)
  assert.equal(left.ignoring, false, 'Widget receives pointer input')
  point = { x: -900, y: 450 }
  await wait(30)
  assert.equal(left.ignoring, true, 'Desktop receives pointer input outside widget')
  assert.equal(left.focusable, true, 'Moving the pointer outside does not interrupt typing')
  assert.equal(service.isNarreteVoiceSender(event(left), 'original'), true)
  assert.equal(service.isNarreteVoiceSender(event(left), 'other'), false)
  assert.equal((await invoke(right, 'refresh', 'Foreign', selection)).ok, false)
  assert.equal((await invoke(left, 'refresh', 'First', selection)).ok, true)
  assert.equal(snapshots, 1, 'Add & next never screenshots')
  assert.equal(encodings, 1, 'Add & next reuses preview without recropping or re-encoding')
  assert.equal(invoke(right, 'state').regions[0].dataUrl, preview)
  assert.equal(invoke(left, 'state').previewDataUrl, null, 'Next clears current preview')
  assert.equal(invoke(right, 'state').regions.length, 1)
  assert.equal('dataUrl' in invoke(right, 'state'), false)
  assert.equal(left.focusable, false)
  assert.equal((await invoke(left, 'refresh', 'Duplicate', selection)).ok, false)
  assert.deepEqual(crop, { x: 300, y: 300, width: 900, height: 601 })
  failCapture = true
  gesture({ x: 100, y: 100 }, { x: 500, y: 400 })
  await until(() => right.lastEvent?.state?.error === 'captureFailed')
  assert.equal(invoke(right, 'state').regions.length, 1)
  failCapture = false
  failCrop = true
  gesture({ x: 100, y: 100 }, { x: 500, y: 400 })
  await wait(140)
  assert.equal(service.narreteVoiceWindow(), null, 'Failed crop cannot open an empty preview')
  assert.equal(invoke(right, 'state').previewDataUrl, null)
  failCrop = false
  gesture({ x: 100, y: 100 }, { x: 500, y: 400 })
  await until(() => service.narreteVoiceWindow() === right)
  await invoke(right, 'refresh', 'Keep note')
  assert.equal(invoke(right, 'state').previewDataUrl, null, 'Reselect discards previous crop')
  assert.equal(invoke(left, 'state').note, 'Keep note')
  assert.equal((await invoke(left, 'submit', null, '')).ok, false, 'Pending note cannot disappear')
  gesture({ x: 100, y: 100 }, { x: 500, y: 400 })
  await until(() => service.narreteVoiceWindow() === right)
  await invoke(right, 'refresh', 'Second', selection)
  const revision = invoke(right, 'state').revision
  await invoke(right, 'layout', revision, [{ x: 100, y: 100, width: 500, height: 400 }])
  const before = snapshots
  gesture({ x: 110, y: 110 }, { x: 500, y: 400 })
  await wait(140)
  assert.equal(snapshots, before, 'Toolbar gestures never select')
  compositionFailure = true
  assert.equal((await invoke(right, 'submit', null, '')).error, 'sendFailed')
  assert(service.isNarreteCapturing())
  compositionFailure = false
  assert.equal((await invoke(right, 'submit', null, '')).ok, true)
  const result = await pending
  assert.equal(result.text, '1. First\n\n2. Second')
  assert.equal(result.image.name, 'Narrete.png')
  assert.equal(stops, 1)
  assert(left.destroyed && right.destroyed)
  const long = invoke(owner, 'start', 'long', 'original')
  await until(() => !!pointer)
  const last = overlays.at(-1)
  for (let index = 0; index < 12; index++) {
    gesture({ x: 100, y: 100 }, { x: index === 0 ? 1800 : 500, y: 400 })
    await until(() => service.narreteVoiceWindow() === last)
    if (index === 0) {
      assert.deepEqual(resized, { width: 1536 }, 'Large preview is bounded before crossing IPC')
      assert.equal(
        invoke(last, 'state').previewDataUrl,
        'data:image/jpeg;base64,' + Buffer.from('resized').toString('base64')
      )
    }
    await invoke(last, 'refresh', `Item ${index + 1}`, selection)
  }
  holdComposition = true
  const completing = invoke(last, 'submit', null, '')
  await until(() => !!releaseComposition)
  escape()
  assert.equal((await long).error, 'cancelled')
  assert.equal((await completing).error, 'cancelled')
  releaseComposition()
  holdComposition = false
  assert.equal(composed.length, 12)
  const locked = invoke(owner, 'start', 'lock', 'original')
  await until(() => !!pointer)
  powerMonitor.emit('lock-screen')
  assert.equal((await locked).error, 'cancelled')
  assert.equal(pointer, null)
  const unfocused = invoke(owner, 'start', 'unfocused', 'original')
  await until(() => !!pointer)
  gesture({ x: 100, y: 100 }, { x: 500, y: 400 })
  await until(() => !!service.narreteVoiceWindow())
  service.narreteVoiceWindow().blur()
  escape()
  assert.equal(
    (await unfocused).error,
    'cancelled',
    'Global Escape works after switching away from note'
  )
  console.log(
    'NARRETE SERVICE OK: Ctrl-left-drag only, modifier-release cancellation, normal dragging untouched, threshold, cross-monitor capture, draft payload, 12 regions and input cleanup'
  )
} finally {
  if (service.isNarreteCapturing()) await invoke(overlays.at(-1), 'cancel')
  delete globalThis.__narreteMocks
}
