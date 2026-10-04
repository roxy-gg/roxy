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
import { buildSync, transformSync } from 'esbuild'

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
const copilot = { id: 'copilot-account-a', seedId: 'github-copilot', accountNumber: 1 }
const model = (id) => ({ id, name: id, reasoning: false, toolCall: true })
let providers = [copilot]
let list = async () => ({ models: [model('enabled')] })
let calls = 0
let needsReauthentication = false
const state = {
  providers,
  modelCatalog: {},
  modelsTried: {},
  modelErrors: {},
  modelsLoading: {},
  copilotNeedsReauthentication: {}
}
const bridge = {
  copilot: { needsReauthentication: async () => needsReauthentication },
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
  state.modelCatalog[copilot.id][0]?.id === 'enabled' &&
    state.modelsLoading[copilot.id] === false &&
    state.modelErrors[copilot.id] === undefined
)
list = async () => ({ models: [model('new-model')] })
await state.ensureModels(copilot.id)
check(
  'model cache: a previous success does not freeze Copilot availability',
  state.modelCatalog[copilot.id][0]?.id === 'new-model' && calls === 2
)
list = async () => ({ models: [] })
await state.ensureModels(copilot.id)
check(
  'model cache: an empty account list replaces the old success',
  state.modelCatalog[copilot.id].length === 0 && state.modelsTried[copilot.id]
)
list = async () => ({ models: [model('enabled-again')] })
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
  'model cache: IPC failure clears stale Copilot models and finishes loading',
  state.modelCatalog[copilot.id].length === 0 &&
    state.modelsTried[copilot.id] &&
    state.modelErrors[copilot.id] === 'unavailable' &&
    state.modelsLoading[copilot.id] === false
)

state.modelCatalog.openai = [model('custom')]
needsReauthentication = true
list = async () => ({ models: [] })
await state.ensureModels(copilot.id)
check(
  'Copilot: terminal auth failure offers reconnect even with an empty model list',
  state.copilotNeedsReauthentication[copilot.id]
)
needsReauthentication = false
await state.ensureModels(copilot.id)
check(
  'Copilot: policy and network failures do not ask for another login',
  !state.copilotNeedsReauthentication[copilot.id]
)
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

console.log('store: queue reads cannot resurrect consumed work')
const refreshQueueAction = src.match(/^  refreshQueue: async \([^)]*\) => \{\n[\s\S]*?\n  \},/m)
if (!refreshQueueAction) throw new Error('Missing refreshQueue action')
const queueState = { activeChatId: 'delivery-chat', optimisticQueue: {}, queue: [] }
const staleQueue = deferred()
let queueReads = 0
const queueActions = new Function(
  'api',
  'get',
  'set',
  'queueLoads',
  `${transformSync(`const actions = {${refreshQueueAction[0]}}`, { loader: 'ts' }).code}\nreturn actions`
)(
  { queue: { list: () => (++queueReads === 1 ? staleQueue.promise : Promise.resolve([])) } },
  () => queueState,
  (patch) => Object.assign(queueState, typeof patch === 'function' ? patch(queueState) : patch),
  new Map()
)
const staleRead = queueActions.refreshQueue()
await queueActions.refreshQueue()
staleQueue.resolve([{ id: 'already-consumed', state: 'pending' }])
await staleRead
check(
  'queue: late pending snapshot cannot replace a newer empty queue',
  queueState.queue.length === 0
)
check(
  'queue: admission does not invent optimistic waiting or append a stale add result',
  !src
    .slice(src.indexOf('async function enqueuePrompt('), src.indexOf('const streamPublishers'))
    .includes("state: 'pending'")
)

const oldAccount = deferred()
list = () => oldAccount.promise
const oldRequest = state.ensureModels(copilot.id)
await Promise.resolve()
const newAccount = deferred()
list = () => newAccount.promise
const reconnect = state.refreshProviders()
await new Promise(setImmediate)
oldAccount.resolve({ models: [model('wrong-account')] })
await oldRequest
check(
  'model cache: reconnect discards an old account response without stopping the new load',
  state.modelCatalog[copilot.id] === undefined &&
    !state.modelsTried[copilot.id] &&
    state.modelsLoading[copilot.id] === true &&
    state.modelErrors[copilot.id] === undefined
)
const beforeCoalesced = calls
const coalesced = state.ensureModels(copilot.id)
await Promise.resolve()
check(
  'model cache: an old completion cannot delete the new in-flight request',
  calls === beforeCoalesced
)
newAccount.resolve({ models: [model('right-account')] })
await Promise.all([reconnect, coalesced])
check(
  'model cache: reconnect publishes only the new account',
  state.modelCatalog[copilot.id][0]?.id === 'right-account'
)
check(
  'model cache: reconnect leaves other providers intact',
  state.modelCatalog.openai[0]?.id === 'custom'
)
check(
  'Copilot: reconnect clears the recovery action',
  !state.copilotNeedsReauthentication[copilot.id]
)

const disconnecting = deferred()
list = () => disconnecting.promise
const disconnectedRequest = state.ensureModels(copilot.id)
await Promise.resolve()
providers = []
await state.refreshProviders()
disconnecting.resolve({ models: [model('disconnected-account')] })
await disconnectedRequest
const beforeDisconnected = calls
await state.ensureModels(copilot.id)
check(
  'model cache: disconnect cannot repopulate the catalog or loading state',
  state.modelCatalog[copilot.id] === undefined &&
    !state.modelsTried[copilot.id] &&
    state.modelsLoading[copilot.id] === undefined &&
    state.modelErrors[copilot.id] === undefined
)
check('model cache: disconnected providers are not fetched', calls === beforeDisconnected)

const otherCopilot = { id: 'copilot-account-b', seedId: 'github-copilot', accountNumber: 2 }
providers = [copilot, otherCopilot]
const authReads = []
bridge.copilot.needsReauthentication = async (id) => {
  authReads.push(id)
  return id === copilot.id
}
list = async (id) => ({ models: [model(`model-${id}`)] })
await state.refreshProviders()
check(
  'Copilot: discovery and reauthentication are scoped to UUID connections',
  authReads.includes(copilot.id) &&
    authReads.includes(otherCopilot.id) &&
    state.copilotNeedsReauthentication[copilot.id] === true &&
    state.copilotNeedsReauthentication[otherCopilot.id] === false &&
    state.modelCatalog[otherCopilot.id][0].id === `model-${otherCopilot.id}`
)

console.log('store: structured catalog failures and retries')
const roxyA = { id: 'roxy-account-a', seedId: 'roxy' }
const roxyB = { id: 'roxy-account-b', seedId: 'roxy' }
providers = [roxyA, roxyB]
await state.refreshProviders()
const initialA = deferred()
list = (id) => (id === roxyA.id ? initialA.promise : Promise.resolve({ models: [model('team-b')] }))
const loadingA = state.ensureModels(roxyA.id)
check(
  'catalog: loading is set synchronously on first request',
  state.modelsLoading[roxyA.id] === true
)
await state.ensureModels(roxyB.id)
initialA.resolve({ models: [], error: 'authentication' })
await loadingA
check(
  'catalog: authentication failure is scoped to one account and ends loading',
  state.modelErrors[roxyA.id] === 'authentication' &&
    state.modelsLoading[roxyA.id] === false &&
    state.modelsTried[roxyA.id] &&
    state.modelCatalog[roxyB.id][0]?.id === 'team-b' &&
    state.modelErrors[roxyB.id] === undefined &&
    state.modelsLoading[roxyB.id] === false
)
const retryA = deferred()
list = () => retryA.promise
const retryRequest = state.ensureModels(roxyA.id)
check(
  'catalog: retry clears the error immediately and starts loading again',
  state.modelErrors[roxyA.id] === undefined && state.modelsLoading[roxyA.id] === true
)
const beforeRetryCoalesced = calls
const retryCoalesced = state.ensureModels(roxyA.id)
await Promise.resolve()
check('catalog: concurrent retries share one request', calls === beforeRetryCoalesced + 1)
retryA.resolve({ models: [], error: 'unavailable' })
await Promise.all([retryRequest, retryCoalesced])
check(
  'catalog: subscription/network failure remains retryable without affecting siblings',
  state.modelErrors[roxyA.id] === 'unavailable' &&
    !state.modelsLoading[roxyA.id] &&
    state.modelCatalog[roxyB.id][0]?.id === 'team-b'
)
list = async () => ({ models: [] })
await state.ensureModels(roxyA.id)
check(
  'catalog: successful empty catalog clears a previous error',
  state.modelErrors[roxyA.id] === undefined &&
    !state.modelsLoading[roxyA.id] &&
    state.modelCatalog[roxyA.id].length === 0
)
list = async () => {
  throw new Error('secret transport detail')
}
await state.ensureModels(roxyA.id)
check(
  'catalog: rejected IPC is a safe unavailable code',
  state.modelErrors[roxyA.id] === 'unavailable' && !state.modelsLoading[roxyA.id]
)
list = async () => ({ models: [model('team-a-recovered')] })
await state.ensureModels(roxyA.id)
check(
  'catalog: successful retry clears errors and caches recovered models',
  state.modelErrors[roxyA.id] === undefined &&
    !state.modelsLoading[roxyA.id] &&
    state.modelCatalog[roxyA.id][0]?.id === 'team-a-recovered'
)
await state.refreshProviders()
const staleFailure = deferred()
list = () => staleFailure.promise
const staleRequest = state.ensureModels(roxyA.id)
await Promise.resolve()
state.modelErrors[roxyB.id] = 'authentication'
await state.refreshProviders()
check(
  'catalog: refresh clears invalidated errors and loading flags',
  state.modelErrors[roxyB.id] === undefined && state.modelsLoading[roxyA.id] === undefined
)
const fresh = deferred()
list = () => fresh.promise
const freshRequest = state.ensureModels(roxyA.id)
staleFailure.resolve({ models: [], error: 'authentication' })
await staleRequest
check(
  'catalog: stale failure cannot publish an error or finish a newer load',
  state.modelErrors[roxyA.id] === undefined && state.modelsLoading[roxyA.id] === true
)
fresh.resolve({ models: [model('fresh-account')] })
await freshRequest
check(
  'catalog: only the current account request publishes models and finishes loading',
  state.modelCatalog[roxyA.id][0]?.id === 'fresh-account' && !state.modelsLoading[roxyA.id]
)

// Use the real fold, not a fake seed counter: discarding snapshot parts after
// ANY racing token used to pass this guard while losing the whole prefix.
const partsModule = { exports: {} }
new Function(
  'module',
  'exports',
  buildSync({
    entryPoints: ['src/shared/parts.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false
  }).outputFiles[0].text
)(partsModule, partsModule.exports)
const { PartsFold, restorePartsSnapshot, taskPreview } = partsModule.exports
const messagesModule = { exports: {} }
new Function(
  'module',
  'exports',
  buildSync({
    entryPoints: ['src/renderer/src/lib/optimistic-messages.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false
  }).outputFiles[0].text
)(messagesModule, messagesModule.exports)
const { visibleMessages, remainingOptimisticMessages } = messagesModule.exports
const publisherModule = { exports: {} }
new Function(
  'module',
  'exports',
  buildSync({
    entryPoints: ['src/renderer/src/lib/stream-publisher.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false
  }).outputFiles[0].text
)(publisherModule, publisherModule.exports)
let frameId = 0
const frames = new Map()
globalThis.requestAnimationFrame = (callback) => {
  frames.set(++frameId, callback)
  return frameId
}
globalThis.cancelAnimationFrame = (id) => frames.delete(id)
const flushFrames = () => {
  for (const callback of [...frames.values()]) callback()
}
console.log('store: reload snapshots preserve prefixes, live tails and speakers')
const snapshotBody = src.match(/\.then\(\(running\) => \{\n([\s\S]*?)\n {8}\}\)\n {8}\.catch/)?.[1]
check('snapshot handler found', snapshotBody !== undefined)
const runSnapshot = (deltas, phase) => {
  const state = {
    runningAutomation: {},
    startingAutomation: {},
    automationSpeakers: {},
    activityStartedAt: {},
    activeChatId: null,
    sendingChats: {}
  }
  const turns = new Map()
  const body = transformSync(`async function apply(running) {${snapshotBody}}`, {
    loader: 'ts'
  }).code
  new Function(
    'running',
    'deltas',
    'set',
    'get',
    'restorePartsSnapshot',
    'remoteTurns',
    'publishStream',
    `${body}
return apply(running)`
  )(
    [
      {
        sessionId: 'chat-1',
        sequence: 5,
        phase,
        activityStartedAt: 100,
        parts: [
          { type: 'text', text: 'prefix' },
          {
            type: 'tool',
            tool: 'task',
            callId: 'task-1',
            subChatId: 'sub-1',
            state: 'running',
            children: [{ type: 'tool', tool: 'read', callId: 'read-1', state: 'running' }]
          },
          {
            type: 'tool',
            tool: 'task',
            callId: 'task-2',
            subChatId: 'sub-2',
            state: 'running',
            children: [{ type: 'tool', tool: 'read', callId: 'read-1', state: 'running' }]
          }
        ],
        botId: 'bot-1',
        botUsername: 'helper'
      }
    ],
    deltas,
    (patch) => Object.assign(state, typeof patch === 'function' ? patch(state) : patch),
    () => state,
    restorePartsSnapshot,
    turns,
    () => {}
  )
  return { state, turns }
}
const snapshotDeltas = [
  {
    sessionId: 'chat-1',
    sequence: 4,
    kind: 'event',
    event: { type: 'text', delta: 'already included' }
  },
  {
    sessionId: 'chat-1',
    sequence: 6,
    kind: 'event',
    event: {
      type: 'tool-child',
      callId: 'task-1',
      event: { type: 'tool-end', callId: 'read-1', ok: true, output: 'file contents' }
    }
  },
  {
    sessionId: 'chat-1',
    sequence: 7,
    kind: 'event',
    event: { type: 'tool-child', callId: 'task-1', event: { type: 'text', delta: 'report' } }
  },
  {
    sessionId: 'chat-1',
    sequence: 8,
    kind: 'event',
    event: {
      type: 'tool-child',
      callId: 'task-2',
      event: { type: 'tool-end', callId: 'read-1', ok: true, output: 'second file contents' }
    }
  },
  { sessionId: 'other-chat', sequence: 9, kind: 'turn', state: 'idle' }
]
const raced = runSnapshot(snapshotDeltas)
check(
  'a racing token does not erase who is speaking',
  raced.state.automationSpeakers['chat-1']?.botUsername === 'helper'
)
check(
  'a racing child delta keeps both foreground task cards and preceding transcript',
  raced.turns.get('chat-1')?.parts[0].text === 'prefix' &&
    raced.turns.get('chat-1')?.parts.length === 3
)
check(
  'only the unseen tail is replayed, with child call indexes restored',
  raced.turns.get('chat-1')?.parts[1].children[0].state === 'done' &&
    raced.turns.get('chat-1')?.parts[1].children[1].text === 'report' &&
    raced.turns.get('chat-1')?.parts[2].children[0].output === 'second file contents'
)
for (let split = 0; split <= snapshotDeltas.length; split++) {
  const restored = runSnapshot(snapshotDeltas.slice(0, split))
  const fold = restored.turns.get('chat-1')
  for (const delta of snapshotDeltas.slice(split)) {
    if (delta.sessionId === 'chat-1' && delta.sequence > 5 && delta.kind === 'event')
      fold.apply(delta.event)
  }
  check(
    `two foreground tasks survive catch-up timing ${split}/${snapshotDeltas.length}`,
    JSON.stringify(fold.parts) === JSON.stringify(raced.turns.get('chat-1').parts)
  )
}
const superseded = runSnapshot([{ sessionId: 'chat-1', sequence: 9, kind: 'turn', state: 'idle' }])
check(
  'a newer turn transition still wins over the snapshot',
  superseded.state.automationSpeakers['chat-1'] === undefined
)
// The ordinary case: nothing raced, so both identity and parts are adopted.
const clean = runSnapshot([])
check(
  'an unraced snapshot restores the speaker and the stream',
  clean.state.automationSpeakers['chat-1']?.botUsername === 'helper' && clean.turns.size === 1
)
const phaseRace = runSnapshot(
  [
    { sessionId: 'chat-1', sequence: 6, kind: 'phase', phase: 'running' },
    {
      sessionId: 'chat-1',
      sequence: 7,
      kind: 'event',
      event: { type: 'text', delta: ' live tail' }
    }
  ],
  'starting'
)
check(
  'starting-to-running phase cannot discard a snapshot prefix or restore stale starting status',
  phaseRace.turns.get('chat-1')?.parts[0].text === 'prefix' &&
    phaseRace.turns.get('chat-1')?.parts.at(-1).text === ' live tail' &&
    phaseRace.state.startingAutomation['chat-1'] === false
)
check(
  'a starting snapshot restores preparation status',
  runSnapshot([], 'starting').state.startingAutomation['chat-1'] === true
)
const oldPhase = runSnapshot(
  [{ sessionId: 'chat-1', sequence: 4, kind: 'phase', phase: 'starting' }],
  'running'
)
check(
  'a phase already covered by the snapshot cannot override it',
  oldPhase.state.startingAutomation['chat-1'] === false
)

console.log('store: subagent hydration and offscreen completion')
const subagentCode = [
  src.match(/function rememberMessage\([\s\S]*?\n\}/)?.[0],
  src.match(/async function loadTranscript\([\s\S]*?\n\}/)?.[0],
  src.match(/function applyAutomationDelta\([\s\S]*?\n\}/)?.[0],
  src.match(/function applyRemoteDelta\([\s\S]*?\n\}/)?.[0],
  src.match(/function publishStream\([\s\S]*?\n\}/)?.[0],
  src.match(/function applySubagentDelta\([\s\S]*?\n\}/)?.[0],
  src.match(/async function hydrateSubagent\([\s\S]*?\n\}/)?.[0]
].join('\n')
const subagentState = {
  activeChatId: 'parent',
  messagesChatId: 'parent',
  messages: [],
  optimisticMessages: {},
  optimisticQueue: {},
  sendingChats: {},
  runningAutomation: {},
  automationSpeakers: {},
  runningSubagents: {},
  streamingChats: {},
  subagentPreviews: {},
  activityStartedAt: {},
  refreshChats: async () => {
    subagentRefreshes++
  },
  refreshUsage: async () => {}
}
let subagentRefreshes = 0
const subagentSet = (patch) =>
  Object.assign(subagentState, typeof patch === 'function' ? patch(subagentState) : patch)
let snapshotRequest = deferred()
let readMessages = async () => []
const taskUpdateAction = src.match(
  /^  handleTaskUpdate: async \(update\) => \{[\s\S]*?\n  \}/m
)?.[0]
const subagentFns = new Function(
  'useRoxyStore',
  'api',
  'PartsFold',
  'restorePartsSnapshot',
  'createStreamPublisher',
  'taskPreview',
  'markActivity',
  'clearActivity',
  'visibleMessages',
  'remainingOptimisticMessages',
  'isToolStart',
  transformSync(
    `
    let subagentRevision = 0
    const subagentRunRevisions = new Map()
    const subagentHydrations = new Map()
    const subagentTurns = new Map()
    const streamPublishers = new Map()
    const transcriptLoads = new Map()
    const queueLoads = new Map()
    const remoteTurns = new Map()
    let automationSnapshotEvents = null
    let taskRevision = 0
    const taskRevisions = new Map()
    const get = useRoxyStore.getState, set = useRoxyStore.setState
    ${subagentCode}
    const actions = {${taskUpdateAction}}
    return { apply: applySubagentDelta, hydrate: hydrateSubagent, turns: subagentTurns,
      load: loadTranscript, remember: rememberMessage, automate: applyAutomationDelta,
      updateTask: actions.handleTaskUpdate }
  `,
    { loader: 'ts' }
  ).code
)(
  { getState: () => subagentState, setState: subagentSet },
  {
    subagents: { snapshot: () => snapshotRequest.promise },
    messages: { list: (...args) => readMessages(...args) },
    queue: { list: async () => [] }
  },
  PartsFold,
  restorePartsSnapshot,
  publisherModule.exports.createStreamPublisher,
  taskPreview,
  () => {},
  () => {},
  visibleMessages,
  remainingOptimisticMessages,
  (event) => event.type === 'tool-start'
)
subagentFns.apply({ subChatId: 'sub-1', sequence: 1, kind: 'run', state: 'running' })
check(
  'subagent start refreshes the sidebar for automation and local turns',
  subagentRefreshes === 1
)
const hydration = subagentFns.hydrate('sub-1')
subagentFns.apply({
  subChatId: 'sub-1',
  sequence: 8,
  kind: 'event',
  event: { type: 'text', delta: ' tail' }
})
snapshotRequest.resolve({
  sequence: 7,
  activityStartedAt: 100,
  parts: [{ type: 'text', text: 'complete prefix' }]
})
await hydration
flushFrames()
check(
  'a partial local fold does not discard the snapshot prefix',
  subagentState.streamingChats['sub-1'][0].text === 'complete prefix tail'
)
subagentFns.apply({ subChatId: 'sub-1', sequence: 9, kind: 'run', state: 'completed' })
check(
  'offscreen completion removes stale bubbles and running flags',
  !subagentState.streamingChats['sub-1'] &&
    !subagentState.runningSubagents['sub-1'] &&
    !subagentState.subagentPreviews['sub-1']
)

snapshotRequest = deferred()
subagentFns.apply({ subChatId: 'sub-2', sequence: 10, kind: 'run', state: 'running' })
const lateHydration = subagentFns.hydrate('sub-2')
subagentFns.apply({ subChatId: 'sub-2', sequence: 12, kind: 'run', state: 'completed' })
snapshotRequest.resolve({
  sequence: 11,
  activityStartedAt: 100,
  parts: [{ type: 'text', text: 'stale running snapshot' }]
})
await lateHydration
check(
  'a snapshot resolving after completion cannot resurrect the run',
  !subagentFns.turns.has('sub-2') &&
    !subagentState.runningSubagents['sub-2'] &&
    !subagentState.streamingChats['sub-2'] &&
    !subagentState.subagentPreviews['sub-2']
)

subagentFns.apply({ subChatId: 'detached-review', sequence: 13, kind: 'run', state: 'running' })
subagentFns.apply({
  subChatId: 'detached-review',
  sequence: 14,
  kind: 'event',
  event: {
    type: 'tool-start',
    callId: 'inspect',
    tool: 'read',
    title: 'src/shared/parts.ts'
  }
})
flushFrames()
check(
  'without reloading, an offscreen detached task publishes progress into the parent preview',
  subagentState.activeChatId === 'parent' &&
    !subagentState.streamingChats.parent &&
    subagentState.runningSubagents['detached-review'] &&
    subagentState.subagentPreviews['detached-review'][0].state === 'running'
)
subagentFns.apply({
  subChatId: 'detached-review',
  sequence: 15,
  kind: 'event',
  event: {
    type: 'tool-end',
    callId: 'inspect',
    ok: true,
    output: 'inspection complete'
  }
})
flushFrames()
check(
  'a completed child tool is visible without falsely completing the detached review',
  subagentState.subagentPreviews['detached-review'][0].state === 'done' &&
    subagentState.runningSubagents['detached-review']
)
subagentFns.apply({
  subChatId: 'detached-review',
  sequence: 16,
  kind: 'event',
  event: { type: 'text', delta: 'Final report' }
})
subagentFns.apply({ subChatId: 'detached-review', sequence: 17, kind: 'run', state: 'completed' })
flushFrames()
check(
  'completion clears pending preview frames as well as the running indicator',
  !subagentState.subagentPreviews['detached-review'] &&
    !subagentState.runningSubagents['detached-review'] &&
    !subagentState.streamingChats['detached-review'] &&
    frames.size === 0
)

console.log('store: completed transcript survives delayed task refreshes')
const userRow = {
  id: 'user',
  chatId: 'parent',
  role: 'user',
  createdAt: 1,
  content: 'Original request',
  parts: [{ type: 'text', text: 'Original request' }]
}
const resultRow = {
  id: 'result',
  chatId: 'parent',
  role: 'assistant',
  createdAt: 2,
  content: '',
  parts: [{ type: 'tool', tool: 'task', state: 'done', output: 'Background report' }]
}
const parentRow = {
  id: 'parent-answer',
  chatId: 'parent',
  role: 'assistant',
  createdAt: 3,
  content: 'Full parent reply',
  parts: [
    { type: 'text', text: 'Full parent reply' },
    { type: 'tool', tool: 'read', callId: 'parent-read', state: 'done', output: 'All parent work' }
  ]
}
subagentState.messages = [userRow]
subagentState.runningTasks = {}
const staleMessages = deferred()
const taskLoadStarted = deferred()
readMessages = () => {
  taskLoadStarted.resolve()
  return staleMessages.promise
}
const taskLoad = subagentFns.updateTask({
  jobId: 'result-job',
  sessionId: 'parent',
  state: 'completed'
})
await taskLoadStarted.promise
subagentFns.remember(parentRow)
staleMessages.resolve([userRow, resultRow])
await taskLoad
check(
  'a background refresh begun before parent persistence cannot erase the saved parent reply',
  visibleMessages(subagentState.messages, subagentState.optimisticMessages.parent).some(
    (row) => row === parentRow
  )
)
const oldLoad = deferred(),
  newLoad = deferred()
readMessages = () => oldLoad.promise
const olderRead = subagentFns.load('parent')
readMessages = () => newLoad.promise
const newerRead = subagentFns.load('parent')
newLoad.resolve([userRow, resultRow, parentRow])
await newerRead
oldLoad.resolve([userRow, resultRow])
await olderRead
check(
  'an older read cannot erase a confirmed reply after the overlay retires',
  subagentState.messages.at(-1) === parentRow && !subagentState.optimisticMessages.parent
)

let terminalRead = deferred()
readMessages = () => terminalRead.promise
subagentFns.automate({
  sessionId: 'parent',
  sequence: 20,
  kind: 'turn',
  state: 'running',
  botId: 'guest',
  botUsername: 'helper'
})
subagentFns.automate({
  sessionId: 'parent',
  sequence: 21,
  kind: 'event',
  event: { type: 'text', delta: 'Second full answer' }
})
flushFrames()
const nextRow = {
  ...parentRow,
  id: 'next-answer',
  createdAt: 4,
  botId: 'guest',
  botUsername: 'helper',
  parts: [{ type: 'text', text: 'Second full answer' }]
}
subagentFns.automate({
  sessionId: 'parent',
  sequence: 22,
  kind: 'turn',
  state: 'idle',
  message: nextRow
})
check(
  'automation idle replaces the live bubble with the full saved reply before its read resolves',
  !subagentState.streamingChats.parent &&
    !subagentState.runningAutomation.parent &&
    visibleMessages(subagentState.messages, subagentState.optimisticMessages.parent).at(-1) ===
      nextRow
)
terminalRead.resolve(Promise.reject(new Error('temporary read failure')))
await new Promise(setImmediate)
check(
  'failed reconciliation cannot hide the finished automation transcript',
  visibleMessages(subagentState.messages, subagentState.optimisticMessages.parent).at(-1) ===
    nextRow && !subagentState.messagesError
)

subagentState.activeChatId = 'retained-sub'
subagentState.messagesChatId = 'retained-sub'
subagentState.messages = [{ ...userRow, chatId: 'retained-sub' }]
terminalRead = deferred()
readMessages = () => terminalRead.promise
subagentFns.apply({ subChatId: 'retained-sub', sequence: 23, kind: 'run', state: 'running' })
subagentFns.apply({
  subChatId: 'retained-sub',
  sequence: 24,
  kind: 'event',
  event: { type: 'text', delta: 'Full child transcript' }
})
flushFrames()
const childRow = {
  ...parentRow,
  chatId: 'retained-sub',
  id: 'retained-child',
  parts: [{ type: 'text', text: 'Full child transcript' }]
}
subagentFns.apply({
  subChatId: 'retained-sub',
  sequence: 25,
  kind: 'run',
  state: 'completed',
  message: childRow
})
check(
  'child completion retains the full transcript without a blank frame',
  !subagentState.streamingChats['retained-sub'] &&
    visibleMessages(subagentState.messages, subagentState.optimisticMessages['retained-sub']).at(
      -1
    ) === childRow
)
terminalRead.resolve([{ ...userRow, chatId: 'retained-sub' }, childRow])
await new Promise(setImmediate)
check(
  'child transcript reconciliation deduplicates, rather than dropping, the saved answer',
  subagentState.messages.length === 2 && !subagentState.optimisticMessages['retained-sub']
)

console.log('store: cancellation never lies about task completion')
for (const name of ['cancelSubagent', 'cancelBackgroundTask']) {
  const action = src.match(
    new RegExp(`^  ${name}: async \\([^)]*\\) => \\{\\n[\\s\\S]*?\\n  \\},`, 'm')
  )?.[0]
  check(`${name}: cancellation handler found`, !!action)
  let request = deferred()
  let stateWrites = 0
  const cancel = new Function(
    'api',
    'set',
    transformSync(`const actions = {${action}}; return actions.${name}`, { loader: 'ts' }).code
  )(
    { subagents: { cancel: () => request.promise }, tasks: { cancel: () => request.promise } },
    () => {
      stateWrites++
    }
  )
  const pending = cancel('parent-or-sub', 'job')
  check(`${name}: pending cancellation keeps real running state`, stateWrites === 0)
  request.resolve(Promise.reject(new Error('IPC unavailable')))
  await pending.catch(() => {})
  check(`${name}: failed cancellation does not hide unfinished work`, stateWrites === 0)
  request = deferred()
  const accepted = cancel('parent-or-sub', 'job')
  request.resolve(true)
  await accepted
  check(`${name}: accepted cancellation still waits for the terminal event`, stateWrites === 0)
}

console.log('store: window recreation restores running tasks without reviving completed work')
const taskBootstrap = src.match(/^    if \(!taskUpdateSubscribed\) \{[\s\S]*?^    \}/m)?.[0]
const subagentBootstrap = src.match(/^    if \(!subagentDeltaSubscribed\) \{[\s\S]*?^    \}/m)?.[0]
check('task and subagent restore handlers found', !!taskBootstrap && !!subagentBootstrap)
const taskList = deferred()
const subagentList = deferred()
let taskListener
let subagentListener
const restored = {
  runningSubagents: {},
  activityStartedAt: {},
  tasks: [],
  refreshChats: async () => {}
}
const hydrated = []
const taskRevisions = new Map()
const subagentRunRevisions = new Map()
const restoreState = (patch) =>
  Object.assign(restored, typeof patch === 'function' ? patch(restored) : patch)
new Function(
  'api',
  'get',
  'set',
  'taskRevisions',
  'subagentRunRevisions',
  'hydrateSubagent',
  transformSync(
    `
    let taskUpdateSubscribed = false, subagentDeltaSubscribed = false
    let taskRevision = 0, subagentRevision = 0
    function applySubagentDelta(update) {
      subagentRunRevisions.set(update.subChatId, ++subagentRevision)
    }
    ${taskBootstrap}
    ${subagentBootstrap}
  `,
    { loader: 'ts' }
  ).code
)(
  {
    tasks: {
      onUpdate: (cb) => {
        taskListener = cb
      },
      listRunning: () => taskList.promise
    },
    subagents: {
      onDelta: (cb) => {
        subagentListener = cb
      },
      listRunning: () => subagentList.promise
    }
  },
  () => ({
    ...restored,
    handleTaskUpdate: (update) => {
      taskRevisions.set(update.jobId, 1)
      if (update.state === 'running') restored.tasks.push(update)
    }
  }),
  restoreState,
  taskRevisions,
  subagentRunRevisions,
  (id) => {
    hydrated.push(id)
  }
)
taskListener({ jobId: 'finished', state: 'completed' })
subagentListener({ subChatId: 'finished-sub', kind: 'run', state: 'completed' })
taskList.resolve([
  { jobId: 'finished', state: 'running' },
  { jobId: 'running', state: 'running' }
])
subagentList.resolve([
  { subChatId: 'finished-sub', activityStartedAt: 10 },
  { subChatId: 'running-sub', activityStartedAt: 20 }
])
await taskList.promise
await subagentList.promise
check(
  'a fresh window restores background task badges',
  restored.tasks.length === 1 && restored.tasks[0].jobId === 'running'
)
check(
  'late listRunning responses cannot restore finished subagents',
  !restored.runningSubagents['finished-sub'] && restored.runningSubagents['running-sub']
)
check(
  'running children hydrate even while the parent is on screen',
  hydrated.length === 1 && hydrated[0] === 'running-sub'
)

const app = readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8').replace(
  /\r\n/g,
  '\n'
)
const refreshEffect = app.match(
  /useEffect\(\(\) => \{\n(    const copilots = providers.filter[\s\S]*?)\n  \}, \[ready, providers, ensureModels\]\)/
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
  'providers',
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
  effect(true, [], ensure, fakeWindow, fakeDocument) === undefined && !tick
)
const dispose = effect(true, [copilot, otherCopilot], ensure, fakeWindow, fakeDocument)
tick()
windowEvents.get('focus')()
windowEvents.get('online')()
documentEvents.get('visibilitychange')()
check(
  'model refresh: mount, timer, focus, online and visibility refresh every account',
  refreshCalls === 10
)
fakeDocument.visibilityState = 'hidden'
tick()
check('model refresh: hidden windows do not poll', refreshCalls === 10)
dispose()
check(
  'model refresh: disconnect/unmount removes the timer and listeners',
  !tick && !windowEvents.size && !documentEvents.size
)

// A removed account pin is NOT permission to send history to the first other
// account. Execute compaction's real resolver with a surviving sibling account.
console.log('store: pinned account isolation')
const compactAction = src.match(/^  compactConversation: async \([^)]*\) => \{\n[\s\S]*?\n  \},/m)
if (!compactAction) throw new Error('Missing compactConversation action')
const compactCompiled = transformSync(`const actions = {${compactAction[0]}}`, {
  loader: 'ts'
}).code
const sibling = {
  id: 'account-b',
  seedId: 'github-copilot',
  accountNumber: 2,
  hasCredential: true,
  auth: 'oauth'
}
let compactions = 0
let catalogRequests = 0
const compactState = {
  activeChatId: 'pinned-chat',
  chats: [{ id: 'pinned-chat', providerId: 'missing-account-a', model: 'private-model' }],
  settings: {},
  providers: [sibling],
  compactingChats: {},
  optimisticMessages: {},
  modelCatalog: {},
  ensureModels: async () => {
    catalogRequests++
  },
  refreshChats: async () => {}
}
const compactActions = new Function(
  'api',
  'set',
  'get',
  'asChatId',
  'resolveSessionConfig',
  'resolveProviderModel',
  'remainingOptimisticMessages',
  'loadTranscript',
  `${compactCompiled}\nreturn actions`
)(
  {
    context: {
      compact: async () => {
        compactions++
      }
    },
    messages: { list: async () => [] }
  },
  (patch) => Object.assign(compactState, typeof patch === 'function' ? patch(compactState) : patch),
  () => compactState,
  asChatId,
  (chat) => chat,
  (_provider, _models, selected) => selected || 'sibling-default',
  (stored, pending) => pending.filter((item) => !stored.some((saved) => saved.id === item.id)),
  async () => {}
)
await compactActions.compactConversation('pinned-chat')
check(
  'compaction: missing pinned account does not fetch or send through a surviving account',
  compactions === 0 && catalogRequests === 0
)
compactState.chats[0].providerId = sibling.id
compactions = catalogRequests = 0
await compactActions.compactConversation('pinned-chat')
check(
  'compaction: an existing pinned account still works',
  compactions === 1 && catalogRequests === 1
)

console.log('composer: drafts stay with their chat')
const composer = readFileSync(
  new URL('../src/renderer/src/components/Composer.tsx', import.meta.url),
  'utf8'
).replace(/\r\n/g, '\n')
const chatView = readFileSync(
  new URL('../src/renderer/src/components/ChatView.tsx', import.meta.url),
  'utf8'
).replace(/\r\n/g, '\n')
check(
  'ChatView identifies the composer with the active chat',
  /<Composer\s+[\s\S]*?chatId=\{activeChat\.id\}/.test(chatView)
)
check(
  'Composer reads text and images from the active chat draft',
  /useRoxyStore\(\(s\) => s\.composerDrafts\[chatId\]\)/.test(composer) &&
    /const value = draft\?\.value \?\? ''/.test(composer) &&
    /const images = draft\?\.images \?\? \[\]/.test(composer)
)
check(
  'Composer updates only the draft belonging to its chat',
  /updateComposerDraft\(state\.composerDrafts, state\.chats, chatId, update\)/.test(composer)
)
check(
  'failed sends atomically restore text and attachments to the originating chat',
  /restoreComposerDraft\([\s\S]*?state\.chats,[\s\S]*?chatId,[\s\S]*?text,[\s\S]*?snapshotImages/.test(
    composer
  )
)
check(
  'the store initializes per-chat drafts',
  /composerDrafts: ComposerDrafts/.test(src) && /composerDrafts: \{\}/.test(src)
)
check(
  'authoritative chat loads prune deleted drafts',
  (src.match(/pruneComposerDrafts\([^,]+, chats\)/g) ?? []).length === 2
)
check(
  'deleting chats and bots removes their drafts immediately',
  (src.match(/delete composerDrafts\[(?:id|bot\.chatId)\]/g) ?? []).length === 2
)

console.log(failures === 0 ? '\nSTORE GUARD OK' : `\nSTORE GUARD FAILED \u2014 ${failures} failing`)
process.exit(failures === 0 ? 0 : 1)
