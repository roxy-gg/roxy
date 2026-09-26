import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { transformSync } from 'esbuild'

// Run the actual modules with platform bridges mocked; no OS banners in CI.
function load(file, bindings) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/^import .* from .*\n/gm, '')
    .replace(/^export /gm, '')
  const code = transformSync(source, { loader: 'ts', target: 'es2022' }).code
  return new Function(
    ...Object.keys(bindings),
    `${code}\nreturn { ${file.includes('/main/') ? 'showTurnToast, setToastWindow, setToastIcon, setWindowFactory, takePendingActivation' : 'notifyTurnComplete, showCompletionNotification'} }`
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
  let closed
  let opened = 0
  const activated = []
  const icon = { isEmpty: () => false }
  const native = load('../src/main/services/notifications.ts', {
    process: { platform },
    app: { focus() {} },
    BrowserWindow: {},
    nativeImage: { createFromPath: () => icon },
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
  native.setToastIcon('C:\\Users\\Jair Escamilla\\Roxy & Friends\\icon.png')
  native.setWindowFactory(() => {
    opened++
  })
  native.setToastWindow({
    on(event, callback) {
      if (event === 'closed') closed = callback
    },
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
    assert.equal(notification.options.icon, icon)
    assert.equal(notification.options.body, 'checkout\nResponse ready.')
  }
  notification.events.click()
  assert.deepEqual(activated.pop(), ['activated', 'finished'])
  native.showTurnToast('Roxy', '', 'Response ready.', '')
  notification.events.click()
  assert.equal(activated.length, 0, 'preview without a chat only focuses the app')
  native.showTurnToast('Roxy & <app>', 'Project "A" & <B>', "Ready: 'session'", 'finished')
  if (platform === 'win32') {
    assert.ok(
      notification.options.toastXml.includes(
        'file:///C:/Users/Jair%20Escamilla/Roxy%20&amp;%20Friends/icon.png'
      )
    )
    assert.ok(
      notification.options.toastXml.includes(
        '<text hint-maxLines="1">Roxy &amp; &lt;app&gt;</text>'
      )
    )
    assert.ok(
      notification.options.toastXml.includes(
        '<text hint-maxLines="1">Project &quot;A&quot; &amp; &lt;B&gt;</text>'
      )
    )
    assert.ok(notification.options.toastXml.includes('<text>Ready: &apos;session&apos;</text>'))
  } else {
    assert.equal(notification.options.toastXml, undefined)
  }
  closed()
  notification.events.click()
  assert.equal(opened, 1)
  assert.equal(native.takePendingActivation(), 'finished')
  assert.equal(native.takePendingActivation(), null, 'pending click is consumed once')
  native.showTurnToast('Roxy', '', 'Response ready.', '')
  notification.events.click()
  assert.equal(opened, 2)
  assert.equal(
    native.takePendingActivation(),
    null,
    'chatless preview reopens without a pending id'
  )
}

// Execute bootstrap itself so its initial selection cannot race the pending click.
const store = readFileSync(
  new URL('../src/renderer/src/lib/store.ts', import.meta.url),
  'utf8'
).replace(/\r\n/g, '\n')
const bootstrap = store.match(/^  bootstrap: async \(\) => \{([\s\S]*?)\n  \},/m)?.[1]
assert.ok(bootstrap, 'store bootstrap found')
const bootstrapCode = transformSync(`async function bootstrap() {${bootstrap}}`, {
  loader: 'ts'
}).code
for (const pending of ['finished', 'deleted', null, 'failed', 'onboarding']) {
  const selections = []
  const warnings = []
  let listener
  let releasePending
  const chats = [
    { id: 'first', kind: 'main' },
    { id: 'finished', kind: 'main' }
  ]
  const state = {
    chats,
    activeChatId: null,
    refreshUsage() {},
    async refreshChats() {},
    async selectChat(id) {
      state.activeChatId = id
      selections.push(id)
    }
  }
  const window = { location: { hash: '#/settings' } }
  const api = {
    settings: {
      getAll: async () => ({ language: 'en', onboardingCompleted: pending !== 'onboarding' }),
      getTelemetry: async () => false
    },
    providers: { listConnected: async () => [] },
    chats: { list: async () => chats },
    loops: { list: async () => [] },
    projects: { listOrder: async () => [] },
    notifications: {
      onActivated(callback) {
        listener = callback
      },
      takePendingActivation() {
        assert.equal(typeof listener, 'function', 'subscribe before collecting pending clicks')
        return new Promise((resolve, reject) => {
          releasePending = () =>
            pending === 'failed'
              ? reject(new Error('IPC unavailable'))
              : resolve(pending === 'onboarding' ? 'finished' : pending)
        })
      }
    }
  }
  const run = new Function(
    'api',
    'get',
    'set',
    'window',
    'console',
    `
    let hiddenModelsLoaded = true, notifyActivatedSubscribed = false;
    const modelCatalogInflight = new Map();
    const applyLanguage = async () => {};
    const loopTickSubscribed = true, llmDeltaSubscribed = true,
      chatsUpdatedSubscribed = true, taskUpdateSubscribed = true,
      subagentDeltaSubscribed = true, remoteStateSubscribed = true, remoteDeltaSubscribed = true;
    ${bootstrapCode}
    return bootstrap();
  `
  )(
    api,
    () => state,
    (patch) => Object.assign(state, patch),
    window,
    {
      warn: (...args) => warnings.push(args)
    }
  )
  // Let settings load and bootstrap reach its deferred IPC query.
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(typeof releasePending, 'function')
  assert.deepEqual(selections, [], 'no initial selection while pending query is unresolved')
  releasePending()
  await run
  assert.deepEqual(selections, [pending === 'finished' ? 'finished' : 'first'])
  assert.equal(window.location.hash, pending === 'finished' ? '#/' : '#/settings')
  assert.equal(warnings.length, pending === 'failed' ? 1 : 0)
  for (const route of ['settings', 'themes', 'mcp', 'skills', 'integrations']) {
    window.location.hash = `#/${route}`
    listener('finished')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(window.location.hash, pending === 'onboarding' ? `#/${route}` : '#/')
  }
  window.location.hash = '#/settings'
  const count = selections.length
  listener('deleted')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(selections.length, count, 'deleted chat leaves selection untouched')
  assert.equal(window.location.hash, '#/settings')
}
console.log('Notification presentation and activation checks passed')
