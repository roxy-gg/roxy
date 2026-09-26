import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { transformSync } from 'esbuild'

// Run the actual modules with platform bridges mocked; no OS banners in CI.
function load(file, bindings) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8')
    .replace(/^import .* from .*\n/gm, '')
    .replace(/^export /gm, '')
  const code = transformSync(source, { loader: 'ts', target: 'es2022' }).code
  return new Function(
    ...Object.keys(bindings),
    `${code}\nreturn { ${file.includes('/main/') ? 'showTurnToast, setToastWindow' : 'notifyTurnComplete, showCompletionNotification'} }`
  )(...Object.values(bindings))
}

const catalog = JSON.parse(
  readFileSync(new URL('../src/renderer/src/locales/default.json', import.meta.url), 'utf8')
)
const calls = []
let focused = false
const renderer = load('../src/renderer/src/lib/notify.ts', {
  chime: 'chime.wav',
  NOTIFY_VOLUME: 0.7,
  Audio: class {
    async play() {}
  },
  document: { hasFocus: () => focused },
  i18n: {
    t: (key, params = {}) =>
      key
        .split('.')
        .reduce((o, k) => o[k], catalog)
        .replace(/{{(\w+)}}/g, (_, key) => params[key])
  },
  api: {
    notifications: {
      toast: async (...args) => {
        calls.push(args)
      }
    }
  }
})
const chat = {
  id: 'finished',
  title: 'Fix login',
  workspacePath: '/Users/me/checkout/',
  worktreePath: '/internal/random-slug'
}
renderer.notifyTurnComplete({ notifyOnComplete: true }, chat)
assert.deepEqual(calls.pop(), ['Roxy', 'checkout', 'Response ready: Fix login', 'finished'])
await renderer.showCompletionNotification({ ...chat, workspacePath: 'C:\\Projects\\Windows App\\' })
assert.equal(calls.pop()[1], 'Windows App')
renderer.notifyTurnComplete({ notifyOnComplete: false }, chat)
focused = true
renderer.notifyTurnComplete({ notifyOnComplete: true }, chat)
assert.equal(calls.length, 0)
await renderer.showCompletionNotification(chat)
assert.equal(calls.pop()[3], 'finished', 'explicit preview works while focused')
await renderer.showCompletionNotification({ ...chat, workspacePath: null })
assert.deepEqual(calls.pop(), ['Roxy', 'Fix login', 'Response ready.', 'finished'])
await renderer.showCompletionNotification()
assert.deepEqual(calls.pop(), ['Roxy', '', 'Response ready.', ''])

for (const platform of ['darwin', 'win32', 'linux']) {
  let notification
  const activated = []
  const native = load('../src/main/services/notifications.ts', {
    process: { platform },
    app: { focus() {} },
    BrowserWindow: {},
    nativeImage: {},
    CHANNELS: { notifyActivated: 'activated' },
    Notification: class {
      static isSupported() {
        return true
      }
      constructor(options) {
        this.options = options
        this.events = {}
        notification = this
      }
      on(event, callback) {
        this.events[event] = callback
      }
      show() {
        this.shown = true
      }
    }
  })
  native.setToastWindow({
    on() {},
    isDestroyed: () => false,
    isMinimized: () => false,
    show() {},
    focus() {},
    webContents: { send: (...args) => activated.push(args) }
  })
  native.showTurnToast('Roxy', 'checkout', 'Response ready.', 'finished')
  assert.equal(notification.shown, true)
  assert.equal(notification.options.title, 'Roxy')
  assert.equal(notification.options.silent, true)
  if (platform === 'darwin') {
    assert.equal(notification.options.subtitle, 'checkout')
    assert.equal(notification.options.body, 'Response ready.')
    assert.equal(notification.options.icon, undefined, 'no oversized attachment on macOS')
  } else {
    assert.equal(notification.options.body, 'checkout\nResponse ready.')
  }
  notification.events.click()
  assert.deepEqual(activated.pop(), ['activated', 'finished'])
  native.showTurnToast('Roxy', '', 'Response ready.', '')
  notification.events.click()
  assert.equal(activated.length, 0, 'preview without a chat only focuses the app')
}
console.log('Notification presentation and activation checks passed')
