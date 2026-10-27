import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { transformSync } from 'esbuild'

// Run the real entry point with Electron mocked so macOS activation is testable on CI.
const code = transformSync(readFileSync('src/main/index.ts', 'utf8'), {
  loader: 'ts',
  format: 'cjs'
}).code

for (const platform of ['darwin', 'win32', 'linux']) {
  const windows = []
  let ready
  let toastWindow
  let voiceWindow
  let capturing = false
  const app = new EventEmitter()
  app.whenReady = () => ({ then: (callback) => (ready = callback) })
  app.setAppUserModelId = () => {}
  app.dock = { setIcon() {} }
  class BrowserWindow extends EventEmitter {
    static getAllWindows() {
      return windows.filter((window) => !window.destroyed)
    }
    constructor() {
      super()
      this.destroyed = false
      this.minimized = false
      this.calls = []
      this.webContents = { setWindowOpenHandler() {} }
      windows.push(this)
    }
    isDestroyed() {
      return this.destroyed
    }
    isMinimized() {
      return this.minimized
    }
    restore() {
      this.minimized = false
      this.calls.push('restore')
    }
    show() {
      this.calls.push('show')
    }
    focus() {
      this.calls.push('focus')
    }
    loadFile() {}
    close() {
      this.destroyed = true
      this.emit('closed')
    }
  }
  const noop = () => {}
  const unused = new Proxy({}, { get: () => noop })
  const dependencies = {
    electron: { app, BrowserWindow, protocol: unused },
    path: { join: (...parts) => parts.join('/') },
    '@electron-toolkit/utils': { is: { dev: false }, optimizer: unused },
    './db/repo': { listConnectedProviders: () => [], getSettings: () => ({}) },
    './services/themes': { resolveThemeById: async () => ({}) },
    './services/notifications': {
      setToastIcon: noop,
      setWindowFactory: noop,
      setToastWindow: (window) => (toastWindow = window)
    },
    './services/voice': { setVoiceWindow: (window) => (voiceWindow = window) },
    './services/narrete': { setNarreteWindow: noop, isNarreteCapturing: () => capturing }
  }
  new Function('require', 'process', '__dirname', code)(
    (name) => dependencies[name] ?? unused,
    { platform, env: {} },
    '/roxy/main'
  )
  ready()
  const main = windows[0]
  main.emit('ready-to-show')
  main.calls.length = 0
  const browser = new BrowserWindow()

  if (platform === 'darwin') {
    assert.equal(app.listenerCount('did-become-active'), 1)
    app.emit('did-become-active')
    assert.deepEqual(main.calls.splice(0), ['show', 'focus'], 'app switch raises Roxy')
    assert.deepEqual(browser.calls, [], 'activation never raises the agent browser')
    main.minimized = true
    app.emit('did-become-active')
    assert.deepEqual(main.calls.splice(0), ['restore', 'show', 'focus'])
  } else {
    assert.equal(app.listenerCount('did-become-active'), 0, 'macOS-only focus policy')
  }

  capturing = true
  app.emit('activate')
  if (platform === 'darwin') app.emit('did-become-active')
  assert.deepEqual(main.calls.splice(0), [], 'Capture overlay is not covered by app activation')
  capturing = false
  app.emit('activate')
  assert.deepEqual(main.calls.splice(0), ['show', 'focus'], 'Dock activation raises Roxy')
  assert.equal(windows.length, 2, 'reuse the existing main window')
  main.close()
  app.emit(platform === 'darwin' ? 'did-become-active' : 'activate')
  const reopened = windows[2]
  assert.ok(reopened, 'reopen Roxy even when an agent browser remains open')
  assert.equal(toastWindow, reopened, 'notifications follow the recreated main window')
  assert.equal(voiceWindow, reopened, 'voice follows the recreated main window')
  assert.deepEqual(reopened.calls, [], 'new window waits until ready before being shown')
  reopened.emit('ready-to-show')
  assert.deepEqual(reopened.calls.splice(0), ['show'])
  app.emit('activate')
  assert.equal(windows.length, 3, 'activation events do not create duplicate windows')
  assert.deepEqual(reopened.calls.splice(0), ['show', 'focus'])

  // A browser can still be focused explicitly; there is no window-focus redirect.
  browser.focus()
  app.emit('browser-window-focus', {}, browser)
  assert.deepEqual(reopened.calls, [])
  assert.deepEqual(browser.calls, ['focus'])
}

console.log('Window activation checks passed: main-window priority, restore and reopen')
