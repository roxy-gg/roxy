import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { app, BrowserWindow } from 'electron'
import { getDb, closeDb } from '../src/main/db/database'
import * as repo from '../src/main/db/repo'
import * as bots from '../src/main/db/bots'
import { registerIpc } from '../src/main/ipc'
import { runTool } from '../src/main/harness/tools'
import { claimTurn, sessionBusy, stopTurn } from '../src/main/services/turn-state'
import { startSubagentRun } from '../src/main/services/subagent-stream'
import {
  enqueuePrompt,
  startAutomation,
  stopAutomation,
  automationSnapshot,
  deliveryQueue,
  wakeAutomation
} from '../src/main/services/automation'
import { isVisibleQueueItem, nextQueueItem } from '../src/shared/queue'
import { messageImages } from '../src/shared/attachments'

app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'roxy-delivery-')))
process.env.ROXY_TRACK_DISABLE = '1'
process.env.ROXY_SKILLS = '0'
process.env.ROXY_MCP = '0'
app.on('window-all-closed', () => undefined)

const requests: { messages: { role: string; content: unknown }[] }[] = []
let hold = false
let fail = false
const replies: (() => void)[] = []
const response = (): Response =>
  new Response(
    'data: ' +
      JSON.stringify({ choices: [{ delta: { content: 'Fixture answer' } }] }) +
      '\n\ndata: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } }
  )
globalThis.fetch = (async (url, init) => {
  if (String(url).includes('models.dev'))
    return new Response(
      JSON.stringify({
        openai: {
          models: {
            'fixture-model': {
              id: 'fixture-model',
              name: 'Fixture',
              tool_call: true,
              modalities: { input: ['text', 'image'] },
              limit: { context: 128000, output: 4096 }
            }
          }
        }
      })
    )
  assert.ok(String(url).includes('delivery.invalid'), `Unexpected network: ${url}`)
  requests.push(JSON.parse(String(init?.body)))
  if (fail) throw new Error('insufficient_quota')
  if (hold)
    return new Promise<Response>((resolve, reject) => {
      replies.push(() => resolve(response()))
      init?.signal?.addEventListener('abort', () => reject(new Error('Stopped.')), { once: true })
    })
  return response()
}) as typeof fetch

async function until(test: () => boolean, label: string): Promise<void> {
  // Event-loop turns, NOT the one-second scheduler: a missing release wake fails.
  for (let i = 0; i < 400; i++) {
    if (test()) return
    await new Promise(setImmediate)
  }
  assert.ok(test(), label)
}
const idle = (id: string): Promise<void> =>
  until(
    () => !sessionBusy(id) && !repo.listQueue(id).some((q) => q.state !== 'failed'),
    `settle ${id}`
  )
const images = [1, 2, 3].map((n) => ({
  dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
  mediaType: 'image/png',
  name: `fixture-${n}.png`
}))

async function main(): Promise<void> {
  const provider = repo.connectProvider({
    id: 'openai',
    apiKey: 'fixture',
    baseURL: 'https://delivery.invalid/v1',
    defaultModel: 'fixture-model'
  })
  repo.setActiveProvider(provider.id, 'fixture-model')
  const bot = bots.createBot('fixture-bot')
  const guest = bots.createBot('fixture-guest')
  const project = repo.createChat({
    title: 'Fixture project',
    workspacePath: app.getPath('userData')
  })
  const context = {
    cwd: app.getPath('userData'),
    sessionId: bot.chatId,
    botId: bot.id,
    signal: new AbortController().signal
  }
  registerIpc()
  // Suppress the periodic safety net: every lifecycle test must wake itself.
  const interval = globalThis.setInterval
  globalThis.setInterval = ((callback, delay, ...args) =>
    interval(callback, delay === 1000 ? 3600000 : delay, ...args)) as typeof setInterval
  startAutomation()
  globalThis.setInterval = interval

  for (const id of [bot.chatId, project.id]) {
    hold = true
    const before = requests.length
    const first = enqueuePrompt(id, 'First prompt', images)
    assert.equal(first.state, 'starting')
    assert.ok(!isVisibleQueueItem(first))
    assert.equal(automationSnapshot().filter((r) => r.sessionId === id).length, 1)
    assert.deepEqual(
      repo
        .listMessages(id)
        .at(-1)
        ?.parts.filter((p) => p.type === 'image')
        .map(({ type: _type, ...image }) => image),
      images
    )
    assert.throws(() => repo.removeQueueItem(first.id), /Stop/)
    assert.throws(() => repo.updateQueueItem(first.id, 'wrong'), /running/)
    const second = enqueuePrompt(id, 'Second prompt', images)
    assert.equal(second.state, 'pending')
    assert.equal(deliveryQueue(id).find((q) => q.id === second.id)?.waitReason, 'busy')
    await until(() => requests.length === before + 1 && replies.length > 0, 'first request starts')
    assert.equal(
      (JSON.stringify(requests.at(-1)?.messages.at(-1)).match(/data:image\/png/g) ?? []).length,
      3
    )
    assert.ok(
      !JSON.stringify(requests.at(-1)).includes('Second prompt'),
      'queued request is not in first context'
    )
    hold = false
    replies.shift()!()
    await idle(id)
    assert.equal(requests.length, before + 2)
    assert.equal(repo.listMessages(id).filter((m) => m.content === 'First prompt').length, 1)
    assert.equal(repo.listMessages(id).filter((m) => m.content === 'Second prompt').length, 1)
  }

  // No global busy flag: four targets run, the fifth waits and starts on release.
  hold = true
  const parallel = Array.from({ length: 5 }, (_, n) => repo.createChat({ title: `Parallel ${n}` }))
  for (const chat of parallel) enqueuePrompt(chat.id, `Parallel ${chat.id}`)
  assert.equal(automationSnapshot().length, 4)
  assert.equal(deliveryQueue(parallel[4].id)[0].waitReason, 'capacity')
  await until(() => replies.length === 4, 'four independent turns')
  hold = false
  replies.splice(0).forEach((reply) => reply())
  for (const chat of parallel) await idle(chat.id)

  // A synchronous claim write failure used to leak the in-memory reservation.
  const claimFailure = repo.createChat({ title: 'Claim failure fixture' })
  getDb().exec(`CREATE TEMP TRIGGER fail_delivery_claim BEFORE UPDATE OF state ON queue
    WHEN NEW.chat_id = '${claimFailure.id}' AND NEW.state = 'starting'
    BEGIN SELECT RAISE(FAIL, 'Fixture claim failure'); END`)
  enqueuePrompt(claimFailure.id, 'Recover claim')
  assert.ok(!sessionBusy(claimFailure.id), 'failed claim releases ownership')
  getDb().exec('DROP TRIGGER fail_delivery_claim')
  assert.equal(repo.listQueue(claimFailure.id)[0].state, 'failed')
  await runTool(
    'queue_manage',
    { action: 'update', id: repo.listQueue(claimFailure.id)[0].id },
    context
  )
  await idle(claimFailure.id)

  // New session -> lazy real git worktree -> first delegated turn.
  const root = mkdtempSync(path.join(tmpdir(), 'roxy-delivery-project-'))
  execFileSync('git', ['init', root], { stdio: 'ignore' })
  execFileSync(
    'git',
    [
      '-C',
      root,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'fixture'
    ],
    { stdio: 'ignore' }
  )
  repo.createChat({ title: 'Project registration', workspacePath: root })
  const created = await runTool(
    'session_manage',
    { action: 'create', project: root, title: 'New workstream fixture' },
    context
  )
  assert.ok(created.ok, created.output)
  const newSession = JSON.parse(created.output)
  assert.ok(newSession.worktreePending)
  const newSent = await runTool(
    'session_manage',
    { action: 'send', id: newSession.id, prompt: 'Initialize fixture' },
    context
  )
  assert.ok(newSent.ok, newSent.output)
  // Git is actual child-process I/O; unlike race tests it needs a wall-clock bound.
  const deadline = Date.now() + 15000
  while (
    (sessionBusy(newSession.id) || sessionBusy(bot.chatId) || repo.listQueue(bot.chatId).length) &&
    Date.now() < deadline
  )
    await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(repo.getChat(newSession.id)?.worktreePath, 'new session materializes its worktree')
  assert.equal(repo.listQueue(newSession.id).length, 0)

  const busyProjectRelease = claimTurn(project.id, new AbortController())!
  const busySent = await runTool(
    'session_manage',
    { action: 'send', id: project.id, prompt: 'Busy delegated fixture' },
    context
  )
  assert.ok(busySent.ok)
  assert.equal(JSON.parse(busySent.output).state, 'pending')
  busyProjectRelease()
  await idle(project.id)
  await idle(bot.chatId)

  // Same-chat bot handoffs cannot start until the source turn is persisted/released.
  const imageRefs = messageImages(
    repo.listMessages(bot.chatId).find((m) => m.content === 'First prompt')!
  ).map((image) => image.ref)
  for (const destination of [guest.id, 'roxy']) {
    const release = claimTurn(bot.chatId, new AbortController())!
    const before = requests.length
    const result = await runTool(
      'bot_invoke',
      { bot: destination, prompt: 'Handoff fixture', image_refs: imageRefs },
      context
    )
    assert.ok(result.ok, result.output)
    assert.equal(repo.listQueue(bot.chatId)[0].state, 'pending')
    await new Promise(setImmediate)
    assert.equal(requests.length, before)
    repo.addMessage({
      chatId: bot.chatId,
      role: 'assistant',
      content: 'Caller finished',
      botId: bot.id,
      botUsername: bot.username
    })
    release()
    await idle(bot.chatId)
    assert.equal(requests.length, before + 1)
    assert.ok(JSON.stringify(requests.at(-1)).includes('Caller finished'))
    assert.equal(
      (JSON.stringify(requests.at(-1)?.messages.at(-1)).match(/data:image\/png/g) ?? []).length,
      3,
      'handoff retains explicitly forwarded images after source release'
    )
    assert.ok(
      !result.output.includes('data:image/'),
      'tool acknowledgement never exposes image bytes'
    )
  }

  // A returned session result overlaps an active user turn: no overwrite or concurrent start.
  const sourceRelease = claimTurn(bot.chatId, new AbortController())!
  enqueuePrompt(bot.chatId, 'User before returned continuation', images)
  const sent = await runTool(
    'session_manage',
    { action: 'send', id: project.id, prompt: 'Return fixture', image_refs: imageRefs },
    context
  )
  assert.ok(sent.ok, sent.output)
  assert.equal(JSON.parse(sent.output).state, 'starting')
  assert.deepEqual(
    repo.listQueue(project.id)[0].images,
    images.map((image) => ({ ...image, forwarded: true }))
  )
  await idle(project.id)
  assert.equal(
    (JSON.stringify(requests.at(-1)?.messages.at(-1)).match(/data:image\/png/g) ?? []).length,
    3,
    'immediate project delivery carries all forwarded images'
  )
  assert.ok(sessionBusy(bot.chatId))
  assert.equal(repo.listQueue(bot.chatId).length, 2)
  assert.equal(repo.listQueue(bot.chatId)[0].content, 'User before returned continuation')
  const beforeReturn = requests.length
  sourceRelease()
  await idle(bot.chatId)
  assert.equal(requests.length, beforeReturn + 2)
  assert.equal(
    repo.listMessages(bot.chatId).filter((m) => m.content === 'User before returned continuation')
      .length,
    1
  )

  // A live sub-session is a reservation too; finishing it must wake its queue.
  const sub = repo.createChat({ title: 'Sub fixture', kind: 'sub', parentId: project.id })
  const run = startSubagentRun({
    subChatId: sub.id,
    parentChatId: project.id,
    description: 'fixture',
    subagentType: 'explore',
    background: true,
    cancel: () => {}
  })
  enqueuePrompt(sub.id, 'Follow sub')
  assert.equal(repo.listQueue(sub.id)[0].state, 'pending')
  run.finish('completed')
  await idle(sub.id)

  // Failed user heads retain FIFO; editing/deleting are deliberate recovery.
  fail = true
  const failed = enqueuePrompt(project.id, 'Failure fixture', images)
  await idle(project.id)
  fail = false
  const behind = enqueuePrompt(project.id, 'Behind failed user')
  assert.equal(behind.state, 'pending')
  assert.equal(deliveryQueue(project.id).find((q) => q.id === behind.id)?.waitReason, 'blocked')
  const retry = await runTool('queue_manage', { action: 'update', id: failed.id }, context)
  assert.ok(retry.ok, retry.output)
  await idle(project.id)
  assert.equal(
    repo.listMessages(project.id).filter((m) => m.content === 'Failure fixture').length,
    1,
    'unchanged retry reuses its prompt'
  )

  // Pending collaborator bubbles must not steal the request being started.
  const releaseContext = claimTurn(project.id, new AbortController())!
  enqueuePrompt(project.id, 'Current request')
  enqueuePrompt(project.id, 'Future collaborator request', images, {
    sourceChatId: project.id,
    fromUser: true,
    asBotId: guest.id
  })
  const beforeContext = requests.length
  releaseContext()
  await idle(project.id)
  assert.ok(!JSON.stringify(requests[beforeContext]).includes('Future collaborator request'))
  assert.ok(JSON.stringify(requests[beforeContext + 1]).includes('Future collaborator request'))

  // Provider failure of automation stays recoverable, but cannot lock out users.
  fail = true
  const machine = await runTool(
    'queue_manage',
    { action: 'create', session: bot.chatId, prompt: 'Machine failure' },
    context
  )
  assert.ok(machine.ok)
  const machineId = JSON.parse(machine.output).id
  await idle(bot.chatId)
  fail = false
  enqueuePrompt(bot.chatId, 'User bypass failure')
  await until(() => !sessionBusy(bot.chatId), 'user bypass failure settles')
  assert.equal(repo.listQueue(bot.chatId)[0].id, machineId)
  const blockedMachine = await runTool(
    'queue_manage',
    { action: 'create', session: bot.chatId, prompt: 'Machine behind failure' },
    context
  )
  assert.ok(blockedMachine.ok)
  assert.equal(JSON.parse(blockedMachine.output).state, 'pending')
  await runTool('queue_manage', { action: 'delete', id: machineId }, context)
  await idle(bot.chatId)

  const future = await runTool(
    'queue_manage',
    {
      action: 'create',
      session: project.id,
      prompt: 'Future machine work',
      image_refs: imageRefs,
      not_before: Date.now() + 60000
    },
    context
  )
  assert.ok(future.ok)
  const futureId = JSON.parse(future.output).id
  enqueuePrompt(project.id, 'User can pass hidden delay')
  await until(() => !sessionBusy(project.id), 'user bypass settles')
  assert.equal(repo.listQueue(project.id)[0].id, futureId)
  assert.equal(repo.listQueue(project.id)[0].state, 'pending')
  const advanced = await runTool(
    'queue_manage',
    { action: 'update', id: futureId, not_before: 0 },
    context
  )
  assert.ok(advanced.ok)
  await idle(project.id)
  assert.equal(
    (JSON.stringify(requests.at(-1)?.messages.at(-1)).match(/data:image\/png/g) ?? []).length,
    3,
    'delayed tool delivery retains forwarded images'
  )

  // Future USER heads block later work, even ordinary idle sends, until due.
  const due = Date.now() + 60000
  enqueuePrompt(project.id, 'Future user', images, { notBefore: due })
  enqueuePrompt(project.id, 'Behind future user')
  const beforeDue = requests.length
  wakeAutomation()
  await new Promise(setImmediate)
  assert.equal(requests.length, beforeDue)
  const now = Date.now
  Date.now = () => due
  wakeAutomation()
  await idle(project.id)
  Date.now = now
  assert.equal(requests.length, beforeDue + 2)

  // Stop pauses, including when a handoff is waiting; a new explicit send resumes.
  hold = true
  const stopped = enqueuePrompt(bot.chatId, 'Stop fixture')
  await until(() => replies.length === 1, 'stoppable model')
  stopTurn(bot.chatId)
  await idle(bot.chatId)
  assert.match(repo.listQueue(bot.chatId)[0].error!, /Stopped/)
  hold = false
  replies.length = 0
  await runTool('queue_manage', { action: 'delete', id: stopped.id }, context)
  enqueuePrompt(bot.chatId, 'Resume fixture')
  await idle(bot.chatId)

  // Persisted uncertainty is never replayed; pending work resumes on startup.
  stopAutomation()
  const uncertain = enqueuePrompt(project.id, 'Interrupted fixture', images)
  getDb().prepare("UPDATE queue SET state = 'starting' WHERE id = ?").run(uncertain.id)
  const pending = enqueuePrompt(bot.chatId, 'Restart pending', images)
  closeDb()
  globalThis.setInterval = ((callback, delay, ...args) =>
    interval(callback, delay === 1000 ? 3600000 : delay, ...args)) as typeof setInterval
  startAutomation()
  globalThis.setInterval = interval
  assert.equal(repo.listQueue(project.id)[0].state, 'failed')
  assert.deepEqual(repo.listQueue(project.id)[0].images, images)
  await idle(bot.chatId)
  assert.ok(!repo.listQueue(bot.chatId).some((q) => q.id === pending.id))
  await runTool('queue_manage', { action: 'delete', id: uncertain.id }, context)

  // Shared admission contract, including future user heads and claimed work.
  const row = { id: 'a', chatId: 'c', content: 'a', createdAt: 0, state: 'pending' as const }
  assert.equal(
    nextQueueItem(
      [
        { ...row, notBefore: 100 },
        { ...row, id: 'b' }
      ],
      99
    ),
    undefined
  )
  assert.equal(
    nextQueueItem([
      { ...row, state: 'starting' },
      { ...row, id: 'b' }
    ]),
    undefined
  )

  if (process.env.DELIVERY_UI_URL) {
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        preload: path.resolve('test/.out/bots-preload.cjs'),
        sandbox: false,
        contextIsolation: true,
        backgroundThrottling: false
      }
    })
    await win.loadURL(process.env.DELIVERY_UI_URL)
    for (const id of [bot.chatId, project.id]) {
      await win.webContents.executeJavaScript(`window.delivery.select(${JSON.stringify(id)})`)
      hold = true
      const before = requests.length
      await win.webContents.executeJavaScript(
        `window.delivery.observe(); window.delivery.send('UI idle fixture', ${JSON.stringify(images)})`
      )
      await until(() => requests.length === before + 1 && replies.length > 0, 'UI model start')
      assert.equal(
        await win.webContents.executeJavaScript('window.delivery.waitingPaints'),
        0,
        'idle send never renders waiting'
      )
      await win.loadURL(process.env.DELIVERY_UI_URL)
      await win.webContents.executeJavaScript(`window.delivery.select(${JSON.stringify(id)})`)
      assert.ok(
        await win.webContents.executeJavaScript(
          `!!document.querySelector('button[title="Stop"]') || !!document.querySelector('[role="status"]')`
        ),
        'reload restores starting activity'
      )
      await win.webContents.executeJavaScript(`window.delivery.send('UI busy fixture')`)
      assert.ok(
        await win.webContents.executeJavaScript(`window.delivery.waitForQueue('UI busy fixture')`)
      )
      hold = false
      replies.shift()!()
      await idle(id)
      assert.equal(repo.listMessages(id).filter((m) => m.content === 'UI idle fixture').length, 1)
      await win.webContents.executeJavaScript(`window.delivery.waitForEmptyQueue()`)
      await win.loadURL(process.env.DELIVERY_UI_URL)
      await win.webContents.executeJavaScript(`window.delivery.select(${JSON.stringify(id)})`)
    }
    win.setSize(390, 844)
    assert.ok(
      await win.webContents.executeJavaScript('document.documentElement.scrollWidth <= innerWidth')
    )
    win.destroy()
    console.log('DELIVERY UI OK (real IPC, database, harness; deterministic provider)')
  }
  stopAutomation()
  closeDb()
  console.log('DELIVERY RUNTIME OK')
}
app
  .whenReady()
  .then(main)
  .then(
    () => app.exit(0),
    (error) => {
      console.error(error)
      app.exit(1)
    }
  )
