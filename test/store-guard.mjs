/**
 * Regression guard: a store action shaped `(chatId?: string) => …` must survive
 * being handed a React SyntheticEvent.
 *
 * `onStop={stop}` compiled clean — TypeScript lets `(id?: string) => void` be
 * assigned to `() => void` — and React then called it with the click event,
 * which became the "session" to stop. That keyed state as "[object Object]",
 * matched no in-flight request, and threw "An object could not be cloned" when
 * it hit the IPC boundary, so the turn was never aborted and Stop looked stuck.
 *
 * Run: node test/store-guard.mjs
 */
import { globSync, readFileSync } from 'node:fs'
import { transformSync } from 'esbuild'

// Normalize CRLF up front: this repo checks out with Windows line endings and
// every multiline pattern below would otherwise silently never match.
const src = readFileSync(
  new URL('../src/renderer/src/lib/store.ts', import.meta.url),
  'utf8'
).replace(/\r\n/g, '\n')

let failures = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    console.log(`  \u2713 ${name}`)
  } else {
    failures++
    console.log(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ''}`)
  }
}

console.log('store: event-as-argument guards')

// 1. The guard exists and rejects non-strings.
check(
  'asChatId helper is present in the store',
  /const asChatId = \(value: unknown\): string \| undefined =>/.test(src)
)

const asChatId = (value) => (typeof value === 'string' ? value : undefined)
const fakeClickEvent = { nativeEvent: {}, target: {}, currentTarget: {}, type: 'click' }
check('a SyntheticEvent is rejected', asChatId(fakeClickEvent) === undefined)
check('a real chat id passes through', asChatId('chat_123') === 'chat_123')
check('undefined stays undefined', asChatId(undefined) === undefined)

// 2. Both at-risk actions route their argument through the guard. These are the
//    only two store actions with an optional FIRST parameter — i.e. the only two
//    a bare handler can poison. Match the IMPLEMENTATION (`name: (arg) => {` or
//    `name: async (arg) => {`), not the interface declaration above it.
for (const action of ['stop', 'compactConversation']) {
  const impl = new RegExp(
    `^  ${action}: (?:async )?\\([^)]*\\) => \\{\\n([\\s\\S]*?)\\n  \\},`,
    'm'
  )
  const body = src.match(impl)?.[1]
  check(`${action}: implementation found`, body !== undefined)
  check(
    `${action} funnels its argument through asChatId`,
    body !== undefined && body.includes('asChatId('),
    'an unguarded optional-id action can swallow a click event'
  )
}

// 3. No .tsx passes either action bare into a handler prop. This is the actual
//    call-site bug; the runtime guard is the safety net behind it.
//
//    The real bug lived in a TERNARY BRANCH (`onStop={cond ? () => … : stop}`),
//    so matching only `on…={stop}` missed it entirely — the first version of
//    this test passed against the unfixed code. Instead: capture the whole
//    handler expression, then look for the action name used as a BARE reference
//    (not `stop(`, not `.stop`, not `stopChats`) anywhere inside it.
const RISKY = ['stop', 'compactConversation']
const offenders = []
for (const file of globSync('src/renderer/src/**/*.tsx')) {
  const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  // Handler prop up to its balancing brace, tolerating newlines and one level
  // of nested braces (enough for the arrow bodies these expressions contain).
  for (const m of text.matchAll(/\bon[A-Z]\w*=\{((?:[^{}]|\{[^{}]*\})*)\}/g)) {
    const expr = m[1]
    for (const name of RISKY) {
      // Bare use: the identifier NOT followed by `(` and NOT preceded by `.`
      // or a word character. `() => stop()` is a call — safe. `: stop` is not.
      const bare = new RegExp(`(?<![.\\w])${name}(?!\\s*\\()(?![\\w])`)
      if (bare.test(expr)) {
        offenders.push(`${file}: on…={…${name}…}`)
      }
    }
  }
}
check(
  'no component passes stop/compactConversation bare to a handler',
  offenders.length === 0,
  offenders.join(', ')
)

// Execute the real model-cache actions with a fake bridge. This avoids loading
// the renderer's DOM, motion and Vite-only prompt imports into a Node test.
console.log('store: live Copilot catalogs')
const actions = ['ensureModels', 'refreshProviders'].map((name) => {
  const match = src.match(
    new RegExp(`^  ${name}: async \\([^)]*\\) => \\{\\n[\\s\\S]*?\\n  \\},`, 'm')
  )
  if (!match) throw new Error(`Missing store action: ${name}`)
  return match[0]
})
const compiled = transformSync(`const actions = {${actions.join('\n')}}`, { loader: 'ts' }).code
const copilot = { id: 'github-copilot' }
const model = (id) => ({ id, name: id, reasoning: false, toolCall: true })
let providers = [copilot]
let list = async () => [model('enabled')]
let calls = 0
const state = { providers, modelCatalog: {}, modelsTried: {} }
const bridge = {
  models: {
    list: (...args) => {
      calls++
      return list(...args)
    }
  },
  providers: { listConnected: async () => providers },
  settings: { getAll: async () => ({}) }
}
Object.assign(
  state,
  new Function('api', 'set', 'get', 'modelCatalogInflight', `${compiled}\nreturn actions`)(
    bridge,
    (patch) => Object.assign(state, typeof patch === 'function' ? patch(state) : patch),
    () => state,
    new Map()
  )
)
await Promise.all([state.ensureModels(copilot.id), state.ensureModels(copilot.id)])
check('model cache: concurrent requests share one IPC call', calls === 1)
check(
  'model cache: successful discovery publishes models',
  state.modelCatalog[copilot.id][0]?.id === 'enabled'
)
list = async () => [model('new-model')]
await state.ensureModels(copilot.id)
check(
  'model cache: a previous success does not freeze Copilot availability',
  state.modelCatalog[copilot.id][0]?.id === 'new-model' && calls === 2
)
list = async () => []
await state.ensureModels(copilot.id)
check(
  'model cache: an empty account list replaces the old success',
  state.modelCatalog[copilot.id].length === 0 && state.modelsTried[copilot.id]
)
list = async () => [model('enabled-again')]
await state.ensureModels(copilot.id)
check(
  'model cache: models can be reenabled after an empty list',
  state.modelCatalog[copilot.id][0]?.id === 'enabled-again'
)
list = async () => {
  throw new Error('IPC failure')
}
await state.ensureModels(copilot.id)
check(
  'model cache: IPC failure clears stale Copilot models',
  state.modelCatalog[copilot.id].length === 0 && state.modelsTried[copilot.id]
)

state.modelCatalog.openai = [model('custom')]
const beforeStatic = calls
await state.ensureModels('openai')
check('model cache: other providers retain their successful cache', calls === beforeStatic)

const deferred = () => {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const oldAccount = deferred()
list = () => oldAccount.promise
const oldRequest = state.ensureModels(copilot.id)
await Promise.resolve()
const newAccount = deferred()
list = () => newAccount.promise
const reconnect = state.refreshProviders()
await new Promise(setImmediate)
oldAccount.resolve([model('wrong-account')])
await oldRequest
check(
  'model cache: reconnect discards an old account response',
  state.modelCatalog[copilot.id] === undefined && !state.modelsTried[copilot.id]
)
const beforeCoalesced = calls
const coalesced = state.ensureModels(copilot.id)
await Promise.resolve()
check(
  'model cache: an old completion cannot delete the new in-flight request',
  calls === beforeCoalesced
)
newAccount.resolve([model('right-account')])
await Promise.all([reconnect, coalesced])
check(
  'model cache: reconnect publishes only the new account',
  state.modelCatalog[copilot.id][0]?.id === 'right-account'
)
check(
  'model cache: reconnect leaves other providers intact',
  state.modelCatalog.openai[0]?.id === 'custom'
)

const disconnecting = deferred()
list = () => disconnecting.promise
const disconnectedRequest = state.ensureModels(copilot.id)
await Promise.resolve()
providers = []
await state.refreshProviders()
disconnecting.resolve([model('disconnected-account')])
await disconnectedRequest
const beforeDisconnected = calls
await state.ensureModels(copilot.id)
check(
  'model cache: disconnect cannot repopulate the catalog',
  state.modelCatalog[copilot.id] === undefined && !state.modelsTried[copilot.id]
)
check('model cache: disconnected providers are not fetched', calls === beforeDisconnected)

const app = readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8').replace(
  /\r\n/g,
  '\n'
)
const refreshEffect = app.match(
  /useEffect\(\(\) => \{\n(    if \(!ready \|\| !copilotConnected\)[\s\S]*?)\n  \}, \[ready, copilotConnected, ensureModels\]\)/
)?.[1]
if (!refreshEffect) throw new Error('Missing app-level Copilot refresh lifecycle')
const windowEvents = new Map()
const documentEvents = new Map()
let tick
let refreshCalls = 0
const fakeWindow = {
  setInterval: (callback, ms) => {
    check('model refresh: uses a one-minute interval', ms === 60_000)
    tick = callback
    return 1
  },
  clearInterval: () => {
    tick = undefined
  },
  addEventListener: (event, callback) => windowEvents.set(event, callback),
  removeEventListener: (event) => windowEvents.delete(event)
}
const fakeDocument = {
  visibilityState: 'visible',
  addEventListener: (event, callback) => documentEvents.set(event, callback),
  removeEventListener: (event) => documentEvents.delete(event)
}
const effect = new Function(
  'ready',
  'copilotConnected',
  'ensureModels',
  'window',
  'document',
  `${transformSync(`function effect() {${refreshEffect}}`, { loader: 'ts' }).code}\nreturn effect()`
)
const ensure = () => {
  refreshCalls++
}
check(
  'model refresh: disconnected accounts never install a timer',
  effect(true, false, ensure, fakeWindow, fakeDocument) === undefined && !tick
)
const dispose = effect(true, true, ensure, fakeWindow, fakeDocument)
tick()
windowEvents.get('focus')()
windowEvents.get('online')()
documentEvents.get('visibilitychange')()
check('model refresh: mount, timer, focus, online and visibility all refresh', refreshCalls === 5)
fakeDocument.visibilityState = 'hidden'
tick()
check('model refresh: hidden windows do not poll', refreshCalls === 5)
dispose()
check(
  'model refresh: disconnect/unmount removes the timer and listeners',
  !tick && !windowEvents.size && !documentEvents.size
)

console.log(failures === 0 ? '\nSTORE GUARD OK' : `\nSTORE GUARD FAILED \u2014 ${failures} failing`)
process.exit(failures === 0 ? 0 : 1)
