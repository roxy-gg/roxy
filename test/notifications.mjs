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
  // `activate` registers the window before its renderer subscribes: hold the click.
  native.showTurnToast('Roxy', 'checkout', 'Response ready.', 'early')
  notification.events.click()
  assert.equal(activated.length, 0, 'a loading window is not pushed to')
  assert.equal(native.takePendingActivation(), 'early', 'click before bootstrap is held for it')
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
    bots: { list: async () => [] },
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
    const pruneComposerDrafts = (drafts) => drafts;
    const botsSubscribed = true, automationSubscribed = true, llmDeltaSubscribed = true,
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

// Completion decisions in the store: the queue head, Stop, and in-flight races.
const extract = (pattern, name) => {
  const code = store.match(pattern)?.[0]
  assert.ok(code, `${name} found`)
  return code
}
const decisionCode = transformSync(
  [
    extract(
      /^function applyAutomationDelta\(payload: RemoteDelta\): void \{[\s\S]*?\n\}\n/m,
      'applyAutomationDelta'
    ),
    extract(/^async function notifyIfSessionIdle\([\s\S]*?\n\}\n/m, 'notifyIfSessionIdle')
  ].join('\n'),
  { loader: 'ts' }
).code
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}
function decisions({ queue = [], settings = { notifyOnComplete: true }, stopChats = {} } = {}) {
  const notified = []
  const warnings = []
  const h = { queue, onQueueList: null }
  let state = {
    settings,
    chats: [{ id: 'c1', kind: 'main' }],
    stopChats: { ...stopChats },
    sendingChats: {},
    runningAutomation: {},
    automationSpeakers: {},
    async refreshChats() {},
    refreshUsage() {}
  }
  const useRoxyStore = {
    getState: () => state,
    setState(update) {
      const patch = typeof update === 'function' ? update(state) : update
      if (patch !== state) state = { ...state, ...patch }
    }
  }
  const api = {
    queue: {
      async list() {
        await h.onQueueList?.()
        if (h.queue instanceof Error) throw h.queue
        return h.queue
      }
    }
  }
  const fns = new Function(
    'useRoxyStore',
    'api',
    'notifyTurnComplete',
    'console',
    `
    let automationRevision = 0;
    const automationRevisions = new Map();
    const automationTurnRevisions = new Map();
    const applyRemoteDelta = () => {};
    const mirrorAutomationChat = async () => {};
    ${decisionCode}
    return { applyAutomationDelta, notifyIfSessionIdle };
  `
  )(useRoxyStore, api, (_settings, chat) => notified.push(chat.id), {
    warn: (...args) => warnings.push(args)
  })
  const turn = (turnState) =>
    fns.applyAutomationDelta({ sessionId: 'c1', kind: 'turn', state: turnState })
  return { ...fns, h, turn, notified, warnings, state: () => state }
}
const pending = { state: 'pending', notBefore: 0 }
{
  const d = decisions()
  d.turn('running')
  d.turn('idle')
  await flush()
  assert.deepEqual(d.notified, ['c1'], 'an idle session notifies once')
}
for (const [label, head] of [
  ['a due pending head', pending],
  ['a running head', { state: 'running' }]
]) {
  const d = decisions({ queue: [head] })
  d.turn('running')
  d.turn('idle')
  await flush()
  assert.equal(d.notified.length, 0, `${label} means more work is next`)
}
for (const [label, head] of [
  ['a failed head blocks the FIFO', { state: 'failed', error: 'boom' }],
  ['a future head is not next', { state: 'pending', notBefore: Date.now() + 60_000 }]
]) {
  const d = decisions({ queue: [head, pending] })
  d.turn('running')
  d.turn('idle')
  await flush()
  assert.deepEqual(d.notified, ['c1'], label)
}
{
  const d = decisions({ queue: [{ state: 'failed', error: 'Stopped.' }] })
  d.turn('running')
  d.turn('idle')
  await flush()
  assert.equal(d.notified.length, 0, 'a turn stopped in main (phone, bot tool) stays silent')
  await d.notifyIfSessionIdle('c1')
  assert.deepEqual(d.notified, ['c1'], 'a stale stopped item does not silence a direct send')
}
{
  const d = decisions()
  d.turn('running')
  d.state().stopChats.c1 = true
  d.turn('idle')
  assert.equal(d.state().stopChats.c1, undefined, 'the Stop is consumed at turn end')
  await flush()
  assert.equal(d.notified.length, 0, 'a stopped automation turn stays silent')
}
{
  const d = decisions({ stopChats: { c1: true } })
  d.turn('running')
  assert.equal(d.state().stopChats.c1, undefined, 'a new turn clears a leftover Stop')
  d.turn('idle')
  await flush()
  assert.deepEqual(d.notified, ['c1'], 'a leftover Stop does not silence the next turn')
}
{
  const d = decisions()
  d.turn('running')
  d.h.onQueueList = () => {
    d.h.onQueueList = null
    d.turn('running')
  }
  d.turn('idle')
  await flush()
  assert.equal(d.notified.length, 0, 'a turn that starts mid-check makes this completion stale')
  d.turn('idle')
  await flush()
  assert.deepEqual(d.notified, ['c1'], 'the later turn announces itself, once')
}
{
  // A whole turn can start AND end while the first check is in flight: nothing
  // is running by the time it reads state again, so only the revision tells.
  const d = decisions()
  d.turn('running')
  d.h.onQueueList = () => {
    d.h.onQueueList = null
    d.turn('running')
    d.turn('idle')
  }
  d.turn('idle')
  await flush()
  assert.deepEqual(d.notified, ['c1'], 'back-to-back turns notify once, not twice')
}
{
  const d = decisions({ settings: { notifyOnComplete: false } })
  d.turn('running')
  d.turn('idle')
  await flush()
  assert.equal(d.notified.length, 0, 'the setting turns it off')
}
{
  const d = decisions({ queue: new Error('IPC unavailable') })
  d.turn('running')
  d.turn('idle')
  await flush()
  assert.equal(d.notified.length, 0, 'an unreadable queue does not notify')
  assert.equal(d.warnings.length, 1, 'an unreadable queue is logged')
}

console.log('Notification presentation and activation checks passed')
