/**
 * Renderer contract regression smoke. No production main/preload or real data.
 * Start: npx vite --config test/canvas/vite.config.mjs --port 3101
 * Run:   npx electron test/bots-ui.cjs
 */
const assert = require('node:assert/strict')
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const temp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'roxy-bots-contract-'))
app.setPath('userData', temp)
let win
const errors = []
const evaluate = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`, true)
const until = async (code) => {
  for (let i = 0; i < 100; i++) {
    if (await evaluate(code)) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw Error(`Timed out: ${code}`)
}

async function run() {
  win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 840,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  })
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) errors.push(message)
  })
  await win.loadURL('http://localhost:3101/?bots')
  await until(`return !!document.querySelector('button[title="New bot"]')`)
  const storeUrl =
    '/@fs/' + path.resolve(__dirname, '../src/renderer/src/lib/store.ts').replaceAll('\\', '/')
  await evaluate(`
    const { useRoxyStore: store } = await import(${JSON.stringify(storeUrl)})
    const api = window.roxy
    const base = store.getState().chats[0]
    const fixture = window.contract = {
      store, api, log: [], messages: [], queue: [], mode: 'success', locked: false,
      chats: [base, { ...base, id: 'bot-chat', title: 'helper', kind: 'bot' }, { ...base, id: 'finished-chat', title: 'Finished' }],
      bots: [{ id: 'helper-id', username: 'helper', instructions: '', chatId: 'bot-chat', createdAt: 1 }]
    }
    const f = fixture
    const noop = () => () => {}
    Object.assign(api, {
      settings: { getAll: async () => ({ language: 'en' }), getTelemetry: async () => false },
      providers: { listConnected: async () => [] },
      bots: { ...api.bots, list: async () => f.bots },
      chats: { list: async () => f.chats, onUpdated: noop },
      tasks: { onUpdate: noop },
      subagents: { setViewed: async () => {}, onDelta: noop, listRunning: async () => [] },
      remote: { status: async () => store.getState().remote, onState: noop, onDelta: noop },
      usage: { stats: async () => null },
      automation: {
        onDelta: (cb) => { f.delta = cb; return () => {} },
        onChanged: (cb) => { f.changed = cb; return () => {} },
        snapshot: () => new Promise((resolve) => { f.snapshot = resolve }),
        wake: async () => { f.log.push('wake'); if (f.locked) throw Error('Queue woke before release') }
      },
      queue: {
        list: async (id) => f.queue.filter((row) => row.chatId === id),
        add: async (chatId, content, images) => {
          const row = { id: crypto.randomUUID(), chatId, content, images, state: 'pending', createdAt: Date.now(), sortOrder: 0 }
          f.queue.push(row); f.changed(chatId); return row
        },
        update: async (id, content, images) => {
          f.queue = f.queue.map((row) => row.id === id ? { ...row, content, images, state: 'pending', error: undefined } : row)
        },
        remove: async (id) => { f.queue = f.queue.filter((row) => row.id !== id) },
        reorder: async () => {}
      },
      messages: {
        list: async (id) => f.messages.filter((row) => row.chatId === id),
        add: async (input) => {
          if (input.role === 'assistant') {
            f.log.push('persist:start')
            if (f.mode === 'persist-error') { f.log.push('persist:error'); throw Error('Persistence failed') }
            if (f.mode === 'hold') await new Promise((resolve) => { f.persist = resolve })
          }
          const row = { ...input, id: crypto.randomUUID(), createdAt: Date.now() }
          f.messages.push(row)
          if (input.role === 'assistant') f.log.push('persist:done')
          return row
        }
      },
      models: { ...api.models, list: async () => [], recent: async () => [] },
      llm: {
        onDelta: (cb) => { f.llmDelta = cb; return () => {} },
        start: async (input) => {
          if (f.locked) throw Error('Leaked direct lock')
          f.locked = true; f.requestId = input.requestId; f.log.push('start')
          f.llmDelta({ requestId: input.requestId, event: { type: 'text', delta: 'Direct reply' } })
          if (f.mode === 'stop') await new Promise((resolve) => { f.abort = resolve })
          if (f.mode === 'reject') throw Error('IPC request failed')
          return f.mode === 'failure' ? { ok: false, error: 'Model failure' } : { ok: true }
        },
        finish: async (id) => {
          if (id !== f.requestId) throw Error('Wrong request finished')
          f.log.push('finish'); f.locked = false
        },
        abort: async () => { f.abort?.() },
        abortSession: async () => { f.abort?.() }
      }
    })
    await store.getState().bootstrap()
    f.delta({ sessionId: 'finished-chat', kind: 'turn', state: 'idle' })
    f.snapshot([
      { sessionId: 'finished-chat', parts: [{ type: 'text', text: 'Stale snapshot' }] },
      { sessionId: 'project-chat', parts: [{ type: 'tool', callId: 'snapshot-tool', tool: 'bash', title: 'Snapshot tool', state: 'running' }] }
    ])
  `)
  await until(`return !!window.contract.store.getState().streamingChats['project-chat']`)
  assert.equal(
    await evaluate(`return !!contract.store.getState().runningAutomation['finished-chat']`),
    false,
    'Late snapshot must not resurrect a completed turn'
  )
  await evaluate(
    `contract.delta({ sessionId: 'project-chat', kind: 'event', event: { type: 'tool-end', callId: 'snapshot-tool', ok: true, output: 'done' } })`
  )
  await until(
    `return contract.store.getState().streamingChats['project-chat']?.[0]?.state === 'done'`
  )
  await evaluate(
    `await contract.store.getState().selectChat('bot-chat'); contract.delta({ sessionId: 'project-chat', kind: 'turn', state: 'idle' }); await contract.store.getState().selectChat('project-chat')`
  )
  assert.equal(
    await evaluate(`return !!contract.store.getState().streamingChats['project-chat']`),
    false,
    'Off-screen completion must clear the cached live bubble'
  )

  // Queue changes and bot routing use only main-owned queue APIs, never llm.start.
  await evaluate(
    `await contract.store.getState().submit('  @HeLpEr: inspect this'); await contract.store.getState().selectChat('bot-chat'); await contract.store.getState().submit('Bot prompt')`
  )
  assert.deepEqual(await evaluate(`return contract.queue.map((row) => row.chatId)`), [
    'project-chat',
    'bot-chat'
  ])
  assert.equal(await evaluate(`return contract.log.includes('start')`), false)
  await evaluate(
    `contract.queue = contract.queue.map((row) => row.chatId === 'bot-chat' ? { ...row, state: 'running' } : row); contract.changed('bot-chat'); contract.delta({ sessionId: 'bot-chat', kind: 'turn', state: 'running' })`
  )
  await until(`return !!document.querySelector('button[title="Edit message"]:disabled')`)
  await evaluate(
    `contract.queue = contract.queue.map((row) => ({ ...row, state: 'failed', error: 'Provider offline' })); contract.changed('bot-chat'); contract.delta({ sessionId: 'bot-chat', kind: 'turn', state: 'idle' })`
  )
  await until(
    `return document.body.textContent.includes('Provider offline') && !!document.querySelector('button[title="Edit and retry"]:not(:disabled)')`
  )
  await evaluate(`document.querySelector('button[title="Edit and retry"]').click()`)
  await until(
    `return [...document.querySelectorAll('button')].some((el) => el.textContent.trim() === 'Save & retry')`
  )
  await evaluate(
    `[...document.querySelectorAll('button')].find((el) => el.textContent.trim() === 'Save & retry').click()`
  )
  await until(`return contract.queue.find((row) => row.chatId === 'bot-chat').state === 'pending'`)

  await evaluate(`
    contract.queue = []
    await contract.store.getState().selectChat('project-chat')
    contract.store.setState({ providers: [{ id: 'test', name: 'Test', auth: 'none', wire: 'openai-chat', defaultModel: 'test', enabled: true, hasCredential: true, sortOrder: 0, createdAt: 0 }], modelCatalog: { test: [{ id: 'test', name: 'Test', contextLimit: 128000, outputLimit: 4096 }] } })
  `)
  for (const mode of ['hold', 'failure', 'reject', 'stop', 'persist-error', 'success']) {
    await evaluate(`
      contract.mode = ${JSON.stringify(mode)}; contract.log = []; contract.error = null; contract.settled = false
      void contract.store.getState().sendMessage('Local request').catch((error) => { contract.error = error.message }).finally(() => { contract.settled = true })
    `)
    if (mode === 'hold') {
      await until(`return !!contract.persist`)
      assert.equal(
        await evaluate(`return contract.locked && !contract.log.includes('finish')`),
        true,
        'Lock stays held until assistant persistence settles'
      )
      await evaluate(`contract.persist()`)
    }
    if (mode === 'stop') {
      await until(`return !!contract.abort`)
      await evaluate(`contract.store.getState().stop('project-chat')`)
    }
    await until(`return contract.settled`)
    const state = await evaluate(
      `return { log: contract.log, locked: contract.locked, sending: !!contract.store.getState().sendingChats['project-chat'], error: contract.error, reply: contract.messages.at(-1).content }`
    )
    assert.equal(state.locked, false, `${mode}: lock released`)
    assert.equal(state.sending, false, `${mode}: renderer send state cleared`)
    assert.equal(
      state.log.filter((entry) => entry === 'finish').length,
      1,
      `${mode}: finish called exactly once`
    )
    const persisted = state.log.indexOf(mode === 'persist-error' ? 'persist:error' : 'persist:done')
    assert.ok(
      persisted > 0 && persisted < state.log.indexOf('finish'),
      `${mode}: finish follows persistence`
    )
    if (mode === 'persist-error') assert.equal(state.error, 'Persistence failed')
    else assert.equal(state.error, null, `${mode}: send completes cleanly`)
    if (mode === 'stop') assert.match(state.reply, /stopped/)
    console.log(`  OK ${mode}: ${state.log.join(' -> ')}`)
  }
  assert.deepEqual(errors, [], errors.join('\n'))
  console.log(
    'BOTS CONTRACT UI OK — snapshot/live mirror, offscreen completion, bot routing, queue states/retry, direct persistence/release ordering'
  )
}

const timeout = setTimeout(() => {
  console.error('Bots contract smoke timed out')
  app.exit(1)
}, 60000)
app
  .whenReady()
  .then(run)
  .then(() => {
    clearTimeout(timeout)
    app.quit()
  })
  .catch((error) => {
    console.error(error.stack || error)
    console.error(errors)
    app.exit(1)
  })
