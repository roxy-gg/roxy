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
import { runSessionTurn } from '../src/main/services/session-turn'

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

  // Independent sessions and bots start immediately, with no global concurrency cap.
  hold = true
  const parallel = [
    ...Array.from({ length: 6 }, (_, n) => repo.createChat({ title: `Parallel ${n}` })),
    repo.getChat(bot.chatId)!,
    repo.getChat(guest.chatId)!
  ]
  for (const chat of parallel) {
    assert.equal(enqueuePrompt(chat.id, `Parallel ${chat.id}`).state, 'starting')
    assert.equal(deliveryQueue(chat.id)[0].waitReason, undefined)
    assert.ok(!isVisibleQueueItem(deliveryQueue(chat.id)[0]))
  }
  assert.equal(automationSnapshot().length, parallel.length)
  await until(() => replies.length === parallel.length, 'all independent turns start')
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
  repo.setFreshWorkstream(true)
  const freshBlocked = repo.createChat({
    title: 'Fresh mode requires a remote',
    workspacePath: root,
    worktree: { mode: 'new' }
  })
  const beforeFresh = requests.length
  const freshTurn = await runSessionTurn(
    {
      sessionId: freshBlocked.id,
      requestId: 'fresh-workstream-fixture',
      providerId: provider.id,
      model: 'fixture-model',
      messages: [{ role: 'user', content: 'Do not run against local code' }]
    },
    () => {},
    new AbortController().signal
  )
  assert.equal(freshTurn.ok, false, 'fresh mode blocks a turn without a reachable remote')
  assert.match(freshTurn.error!, /fresh remote workstream/)
  assert.equal(requests.length, beforeFresh, 'blocked worktree must not make a model request')
  assert.ok(repo.getChat(freshBlocked.id)?.worktreePending, 'blocked turn remains retryable')
  assert.equal(repo.getChat(freshBlocked.id)?.worktreePath, null)
  repo.setFreshWorkstream(false)
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

  // Failed attempts live on their prompt and do not block fresh user work.
  fail = true
  const failed = enqueuePrompt(project.id, 'Failure fixture', images)
  await idle(project.id)
  const failureItem = repo.listQueue(project.id).find((q) => q.id === failed.id)!
  assert.equal(failureItem.state, 'failed')
  assert.ok(failureItem.messageId)
  assert.ok(failureItem.responseMessageId)
  assert.ok(!isVisibleQueueItem(failureItem))
  fail = false
  const behind = enqueuePrompt(project.id, 'Behind failed user')
  await idle(project.id)
  assert.ok(!repo.listQueue(project.id).some((q) => q.id === behind.id))
  const laterReply = repo.listMessages(project.id).at(-1)!.id
  repo.setChatSummary(project.id, 'summary includes failed response', Date.now())
  const retry = await runTool('queue_manage', { action: 'update', id: failed.id }, context)
  assert.ok(retry.ok, retry.output)
  await idle(project.id)
  assert.ok(
    !repo.listMessages(project.id).some((m) => m.id === failureItem.responseMessageId),
    'retry removes its old response'
  )
  assert.ok(
    repo.listMessages(project.id).some((m) => m.id === laterReply),
    'retry keeps later replies'
  )
  assert.equal(repo.getChat(project.id)?.contextSummary, null)
  assert.equal(
    repo.listMessages(project.id).filter((m) => m.content === 'Failure fixture').length,
    1,
    'unchanged retry reuses its prompt'
  )
  assert.deepEqual(
    repo
      .listMessages(project.id)
      .find((m) => m.id === failureItem.messageId)
      ?.parts.filter((part) => part.type === 'image')
      .map(({ type: _type, ...image }) => image),
    images
  )

  fail = true
  const editedFailure = enqueuePrompt(project.id, 'Edit failed prompt', images)
  await idle(project.id)
  const editItem = repo.listQueue(project.id).find((q) => q.id === editedFailure.id)!
  const releaseRetry = claimTurn(project.id, new AbortController())!
  assert.throws(
    () => repo.updateQueueItem(editItem.id, 'Cannot edit while running', images),
    /Stop the session/
  )
  assert.ok(
    repo.listMessages(project.id).some((message) => message.id === editItem.responseMessageId)
  )
  releaseRetry()
  repo.updateQueueItem(editItem.id, 'Corrected failed prompt', images)
  assert.equal(
    repo.listMessages(project.id).find((message) => message.id === editItem.messageId)?.content,
    'Corrected failed prompt'
  )
  assert.ok(
    !repo.listMessages(project.id).some((message) => message.id === editItem.responseMessageId)
  )
  fail = false
  wakeAutomation()
  await idle(project.id)

  const reportSession = repo.createChat({ title: 'Task report retry guard' })
  const report = repo.addMessage({
    chatId: reportSession.id,
    role: 'assistant',
    content: 'Task report',
    parts: [
      {
        type: 'tool',
        id: 'report',
        tool: 'task',
        input: '{}',
        state: 'done',
        output: 'Saved report',
        resultFor: 'launch'
      }
    ]
  })
  const reportQueue = repo.enqueue(reportSession.id, 'Continue task report')
  getDb()
    .prepare("UPDATE queue SET state = 'failed', message_id = ? WHERE id = ?")
    .run(report.id, reportQueue.id)
  assert.throws(
    () => repo.updateQueueItem(reportQueue.id, 'Replace report'),
    /saved task report cannot be edited/
  )
  assert.deepEqual(repo.listMessages(reportSession.id)[0].parts, report.parts)
  repo.updateQueueItem(reportQueue.id, reportQueue.content)
  assert.deepEqual(repo.listMessages(reportSession.id)[0].parts, report.parts)
  repo.removeQueueItem(reportQueue.id)
  assert.deepEqual(repo.listMessages(reportSession.id)[0].parts, report.parts)

  fail = true
  const deleteSession = repo.createChat({ title: 'Delete failed prompt fixture' })
  const deleteRequest = enqueuePrompt(deleteSession.id, 'Delete this failed prompt', images)
  await idle(deleteSession.id)
  const deleteItem = repo.listQueue(deleteSession.id)[0]
  assert.ok(deleteItem.messageId)
  assert.ok(deleteItem.responseMessageId)
  const unrelated = repo.addMessage({
    chatId: deleteSession.id,
    role: 'assistant',
    content: 'Keep this unrelated reply'
  })
  repo.setChatSummary(deleteSession.id, 'Contains deleted prompt', Date.now())
  const releaseDelete = claimTurn(deleteSession.id, new AbortController())!
  assert.throws(() => repo.removeQueueItem(deleteItem.id), /Stop the session/)
  assert.ok(repo.listQueue(deleteSession.id).some((item) => item.id === deleteItem.id))
  releaseDelete()
  repo.removeQueueItem(deleteRequest.id)
  assert.equal(repo.listQueue(deleteSession.id).length, 0)
  assert.deepEqual(
    repo.listMessages(deleteSession.id).map((message) => message.id),
    [unrelated.id]
  )
  assert.equal(repo.getChat(deleteSession.id)?.contextSummary, null)
  closeDb()
  assert.deepEqual(
    repo.listMessages(deleteSession.id).map((message) => message.id),
    [unrelated.id]
  )
  fail = false
  enqueuePrompt(deleteSession.id, 'Next prompt after deletion')
  await idle(deleteSession.id)
  assert.ok(!JSON.stringify(requests.at(-1)).includes('Delete this failed prompt'))
  assert.ok(!JSON.stringify(requests.at(-1)).includes('Contains deleted prompt'))

  const setupFailure = repo.createChat({ title: 'Missing provider fixture' })
  repo.setChatConfig(setupFailure.id, {
    providerId: 'disconnected-provider',
    model: 'fixture',
    agentId: 'build',
    reasoningEffort: 'medium',
    contextLimit: null
  })
  const setupItem = enqueuePrompt(setupFailure.id, 'Setup failure prompt')
  await idle(setupFailure.id)
  assert.ok(repo.listQueue(setupFailure.id)[0].messageId)
  assert.equal(
    repo.listMessages(setupFailure.id).filter((message) => message.role === 'user').length,
    1
  )
  assert.ok(!isVisibleQueueItem(repo.listQueue(setupFailure.id)[0]))
  repo.removeQueueItem(setupItem.id)
  assert.equal(repo.listMessages(setupFailure.id).length, 0)

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
    fail = true
    const failedUI = enqueuePrompt(project.id, 'UI failure fixture', images)
    await idle(project.id)
    const failedUIItem = repo.listQueue(project.id).find((item) => item.id === failedUI.id)!
    await win.webContents.executeJavaScript(`window.delivery.select(${JSON.stringify(project.id)})`)
    const canvasAction = async (
      type: 'edit-prompt' | 'resend-prompt' | 'delete-prompt',
      queueId = failedUI.id
    ): Promise<void> => {
      await win.webContents.executeJavaScript(`(async () => {
        for (let i = 0; i < 300; i++) {
          const probe = window.__canvasTranscript;
          const region = probe?.scene().blocks.flatMap(b => b.regions).find(r => r.action.type === ${JSON.stringify(type)} && r.action.queueId === ${JSON.stringify(queueId)});
          const el = document.querySelector('[data-canvas-surface]');
          if (region && el) {
            el.scrollTop = Math.max(0, region.y - 100);
            await new Promise(resolve => requestAnimationFrame(resolve));
            const rect = el.getBoundingClientRect();
            const options = { bubbles: true, button: 0, pointerId: 1, isPrimary: true, pointerType: 'touch', clientX: rect.x + region.x + region.w / 2, clientY: rect.y + region.y - el.scrollTop + region.h / 2 };
            el.dispatchEvent(new PointerEvent('pointerdown', options));
            el.dispatchEvent(new PointerEvent('pointerup', options));
            return;
          }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        const probe=window.__canvasTranscript;
        throw new Error('Missing inline failed-prompt action: '+JSON.stringify({ blocks:probe?.scene().blocks.map(b=>({id:b.id, regions:b.regions.map(r=>r.action)})), body:document.body.innerText.slice(-1200) }));
      })()`)
    }
    await canvasAction('edit-prompt')
    assert.ok(
      await win.webContents.executeJavaScript(`(async () => {
      for(let i=0;i<100;i++) { if(document.querySelector('dialog[open] textarea')) return true; await new Promise(r=>setTimeout(r,10)); } return false;
    })()`)
    )
    assert.equal(
      await win.webContents.executeJavaScript(`!!document.querySelector('[data-waiting-queue]')`),
      false
    )
    assert.equal(
      await win.webContents.executeJavaScript(
        `document.querySelector('dialog[open] textarea').value`
      ),
      'UI failure fixture'
    )
    await win.webContents.executeJavaScript(
      `document.querySelector('dialog[open]').dispatchEvent(new Event('cancel'))`
    )
    win.setSize(390, 844)
    await win.webContents.executeJavaScript(`new Promise(resolve => setTimeout(resolve,100))`)
    await canvasAction('edit-prompt')
    assert.ok(
      await win.webContents.executeJavaScript(`(async () => {
      for(let i=0;i<100;i++) {
        const dialog=document.querySelector('dialog[open]');
        if(dialog) { const rect=dialog.getBoundingClientRect(); const fits=rect.left>=0 && rect.right<=innerWidth && dialog.scrollWidth<=dialog.clientWidth+1; if(!fits) throw new Error('Narrow dialog overflow '+JSON.stringify({left:rect.left,right:rect.right,width:innerWidth,scroll:dialog.scrollWidth,client:dialog.clientWidth,html:dialog.outerHTML})); return fits; }
        await new Promise(r=>setTimeout(r,10));
      } return false;
    })()`),
      'inline retry editor fits narrow window'
    )
    await win.webContents.executeJavaScript(
      `document.querySelector('dialog[open]').dispatchEvent(new Event('cancel'))`
    )
    fail = false
    await canvasAction('resend-prompt')
    await idle(project.id)
    assert.ok(
      !repo
        .listMessages(project.id)
        .some((message) => message.id === failedUIItem.responseMessageId)
    )
    assert.deepEqual(
      repo
        .listMessages(project.id)
        .find((message) => message.id === failedUIItem.messageId)
        ?.parts.filter((part) => part.type === 'image')
        .map(({ type: _type, ...image }) => image),
      images,
      'canvas resend preserves images'
    )
    assert.ok(
      await win.webContents.executeJavaScript(`(async () => {
      for(let i=0;i<200;i++) {
        const probe=window.__canvasTranscript;
        if(probe && !probe.scene().blocks.some(block => block.id === ${JSON.stringify(failedUIItem.responseMessageId)})) return true;
        await new Promise(r=>setTimeout(r,10));
      } return false;
    })()`),
      'deleted response does not return from renderer optimism'
    )
    win.setSize(390, 844)
    fail = true
    await win.webContents.executeJavaScript(`window.delivery.send('Delete from canvas fixture')`)
    await idle(project.id)
    const deletedUI = repo
      .listQueue(project.id)
      .find((item) => item.content === 'Delete from canvas fixture')!
    assert.ok(deletedUI?.messageId)
    await canvasAction('delete-prompt', deletedUI.id)
    assert.ok(
      await win.webContents.executeJavaScript(`(async () => {
        for (let i=0; i<200; i++) {
          const probe=window.__canvasTranscript;
          if (probe && !probe.scene().blocks.some(block => [${JSON.stringify(deletedUI.messageId)}, ${JSON.stringify(deletedUI.responseMessageId)}].includes(block.id)) && !document.querySelector('[data-prompt-id="${deletedUI.messageId}"]')) return true;
          await new Promise(resolve=>setTimeout(resolve,10));
        } return false;
      })()`),
      'canvas delete removes prompt, response and prompt-history marker'
    )
    assert.ok(!repo.listQueue(project.id).some((item) => item.id === deletedUI.id))
    assert.ok(
      !repo
        .listMessages(project.id)
        .some(
          (message) =>
            message.id === deletedUI.messageId || message.id === deletedUI.responseMessageId
        )
    )
    await win.loadURL(process.env.DELIVERY_UI_URL)
    await win.webContents.executeJavaScript(`window.delivery.select(${JSON.stringify(project.id)})`)
    assert.ok(
      await win.webContents.executeJavaScript(
        `!JSON.stringify(window.__canvasTranscript.scene()).includes('Delete from canvas fixture')`
      )
    )
    fail = false
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
