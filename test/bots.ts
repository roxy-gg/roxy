import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { app, BrowserWindow } from 'electron'
import Database from 'better-sqlite3'
import { registerIpc } from '../src/main/ipc'
import { MIGRATIONS, repairSchema } from '../src/main/db/migrations'
import { getDb, closeDb } from '../src/main/db/database'
import * as repo from '../src/main/db/repo'
import * as bots from '../src/main/db/bots'
import { runTool } from '../src/main/harness/tools'
import { sessionCwd } from '../src/main/services/workspace'
import { claimTurn, sessionBusy, stopTurn } from '../src/main/services/turn-state'
import {
  enqueuePrompt,
  wakeAutomation,
  automationSnapshot,
  startAutomation,
  stopAutomation
} from '../src/main/services/automation'

app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'roxy-bots-')))
process.env.ROXY_TRACK_DISABLE = '1'
process.env.ROXY_SKILLS = '0'
process.env.ROXY_MCP = '0'

async function main(): Promise<void> {
  const migrationDb = new Database(':memory:')
  migrationDb.pragma('foreign_keys = ON')
  for (const step of MIGRATIONS.slice(0, -1))
    typeof step === 'string' ? migrationDb.exec(step) : step(migrationDb)
  for (const [id, name, enabled] of [
    ['one', 'PR watcher', 1],
    ['two', 'PR watcher', 0]
  ] as const) {
    migrationDb
      .prepare(
        `INSERT INTO chats(id,title,kind,created_at,updated_at,workspace_path) VALUES (?,?,'loop',1,1,'/project')`
      )
      .run(id, name)
    migrationDb
      .prepare(
        `INSERT INTO loops(id,name,prompt,interval_minutes,enabled,chat_id,next_run_at,created_at) VALUES (?,?,'check',5,?,?,123,1)`
      )
      .run(id, name, enabled, id)
    migrationDb
      .prepare(
        `INSERT INTO messages(id,chat_id,role,content,created_at) VALUES (?,?,'user','old transcript',1)`
      )
      .run(id, id)
    migrationDb
      .prepare(
        `INSERT INTO queue(id,chat_id,content,created_at) VALUES (?,?,'queued before upgrade',1)`
      )
      .run(id, id)
  }
  const upgrade = MIGRATIONS.at(-1)!
  assert.equal(typeof upgrade, 'function')
  if (typeof upgrade === 'function') migrationDb.transaction(() => upgrade(migrationDb))()
  repairSchema(migrationDb)
  assert.deepEqual(migrationDb.prepare('SELECT username FROM bots ORDER BY username').all(), [
    { username: 'pr-watcher' },
    { username: 'pr-watcher-2' }
  ])
  assert.equal(
    (migrationDb.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n,
    2
  )
  assert.equal((migrationDb.prepare('SELECT COUNT(*) AS n FROM queue').get() as { n: number }).n, 2)
  assert.deepEqual(
    migrationDb.prepare('SELECT enabled,next_run_at FROM bot_jobs ORDER BY id').all(),
    [
      { enabled: 1, next_run_at: 123 },
      { enabled: 0, next_run_at: 123 }
    ]
  )
  assert.equal((migrationDb.prepare('SELECT COUNT(*) AS n FROM loops').get() as { n: number }).n, 0)
  migrationDb.close()

  const bot = bots.createBot('reviewer')
  assert.equal(repo.getChat(bot.chatId)?.kind, 'bot')
  assert.equal(repo.getChat(bot.chatId)?.workspacePath, null)
  assert.ok(sessionCwd(bot.chatId).endsWith(bot.chatId))
  assert.throws(() => bots.createBot('Reviewer'), /taken/)
  bots.updateBot(bot.id, { instructions: 'Review PRs only when asked.' })
  assert.equal(bots.getBot(bot.id)?.instructions, 'Review PRs only when asked.')
  const job = bots.saveJob({
    botId: bot.id,
    name: 'Check',
    prompt: 'Review',
    schedule: { kind: 'interval', minutes: 1 },
    remainingRuns: 2
  })
  assert.deepEqual(bots.enqueueDueJobs(job.nextRunAt! - 1), [])
  assert.deepEqual(bots.enqueueDueJobs(job.nextRunAt!), [bot.chatId])
  assert.deepEqual(bots.enqueueDueJobs(job.nextRunAt!), [])
  assert.equal(repo.listQueue(bot.chatId).length, 1)
  bots.enqueueDueJobs(job.nextRunAt! + 60000)
  assert.equal(bots.listJobs(bot.id)[0].enabled, false)
  assert.equal(bots.listJobs(bot.id)[0].remainingRuns, 0)
  for (const item of repo.listQueue(bot.chatId)) repo.removeQueueItem(item.id)
  const timestamps = bots.saveJob({
    botId: bot.id,
    name: 'Specific times',
    prompt: 'Run once',
    schedule: { kind: 'timestamps', timestamps: [Date.now() + 1000, Date.now() + 2000] }
  })
  bots.enqueueDueJobs(timestamps.nextRunAt!)
  const secondTime = bots.listJobs(bot.id).find((entry) => entry.id === timestamps.id)!.nextRunAt!
  assert.ok(secondTime > timestamps.nextRunAt!)
  bots.enqueueDueJobs(secondTime)
  assert.equal(repo.listQueue(bot.chatId).length, 2)
  bots.removeJob(timestamps.id)
  assert.equal(
    repo.listQueue(bot.chatId).length,
    0,
    'deleting a schedule cancels its pending beats'
  )

  const session = repo.createChat({ title: 'Project chat', workspacePath: app.getPath('userData') })
  const ctx = { cwd: sessionCwd(session.id), sessionId: session.id }
  const projects = await runTool('project_list', {}, ctx)
  assert.ok(projects.ok, projects.output)
  assert.ok(
    JSON.parse(projects.output).some(
      (project: { path: string }) => project.path === app.getPath('userData')
    )
  )
  assert.ok(
    (
      await runTool('session_manage', { action: 'list', project: app.getPath('userData') }, ctx)
    ).output.includes(session.id)
  )
  assert.ok(
    !(
      await runTool(
        'bot_manage',
        { action: 'delete', id: bot.id },
        { ...ctx, sessionId: bot.chatId }
      )
    ).ok
  )
  assert.ok(
    !(await runTool('loop_create', { name: 'old', prompt: 'old', interval_minutes: 1 }, ctx)).ok
  )
  const invoked = await runTool('bot_invoke', { bot: 'reviewer', prompt: 'Check this diff' }, ctx)
  assert.ok(invoked.ok, invoked.output)
  const queued = repo.listQueue(bot.chatId)[0]
  assert.equal(queued.replyToChatId, session.id)
  assert.equal(queued.hops, 1)
  assert.ok(
    (await runTool('queue_manage', { action: 'update', id: queued.id, prompt: 'Updated' }, ctx)).ok
  )
  assert.equal(repo.listQueue(bot.chatId)[0].content, 'Updated')
  getDb().prepare(`UPDATE queue SET state = 'running' WHERE id = ?`).run(queued.id)
  assert.ok(!(await runTool('queue_manage', { action: 'delete', id: queued.id }, ctx)).ok)
  getDb().prepare(`UPDATE queue SET state = 'failed' WHERE id = ?`).run(queued.id)
  assert.ok((await runTool('queue_manage', { action: 'delete', id: queued.id }, ctx)).ok)
  assert.equal(repo.listQueue(bot.chatId).length, 0)
  assert.throws(() => enqueuePrompt(bot.chatId, 'cycle', undefined, { hops: 9 }), /Handoff/)

  const controller = new AbortController()
  const release = claimTurn(bot.chatId, controller)!
  assert.ok(sessionBusy(bot.chatId))
  assert.equal(claimTurn(bot.chatId, new AbortController()), null)
  stopTurn(bot.chatId)
  assert.ok(controller.signal.aborted)
  release()
  assert.ok(!sessionBusy(bot.chatId))

  // Missing credentials must fail visibly and retain the delivery, not consume it.
  enqueuePrompt(bot.chatId, 'No provider')
  wakeAutomation()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(repo.listQueue(bot.chatId)[0].state, 'failed')
  assert.match(repo.listQueue(bot.chatId)[0].error!, /provider/)
  assert.equal(automationSnapshot().length, 0)
  repo.removeQueueItem(repo.listQueue(bot.chatId)[0].id)

  const mention = enqueuePrompt(session.id, '@reviewer inspect this')
  wakeAutomation()
  assert.ok(!repo.listQueue(session.id).some((item) => item.id === mention.id))
  assert.equal(repo.listQueue(bot.chatId)[0].replyToChatId, session.id)
  assert.ok(repo.listMessages(session.id).some((m) => m.content.startsWith('@reviewer')))
  const row = repo.listQueue(bot.chatId)[0]
  getDb().prepare(`UPDATE queue SET state = 'running' WHERE id = ?`).run(row.id)
  startAutomation()
  stopAutomation()
  assert.equal(repo.listQueue(bot.chatId)[0].state, 'failed')
  assert.match(repo.listQueue(bot.chatId)[0].error!, /shutdown/)

  repo.addMessage({
    chatId: session.id,
    role: 'assistant',
    content: 'Bot answer',
    botId: bot.id,
    botUsername: bot.username
  })
  bots.removeBot(bot.id)
  assert.equal(bots.listJobs().length, 0)
  assert.equal(repo.getChat(bot.chatId), undefined)
  assert.equal(repo.listMessages(session.id).at(-1)?.botUsername, 'reviewer')
  const fork = repo.forkChat(session.id)
  assert.equal(repo.listMessages(fork.id).at(-1)?.botUsername, 'reviewer')

  // Exercise the real harness and persistence against a local, deterministic model transport.
  const originalFetch = globalThis.fetch
  let holdReply = false
  const requests: {
    messages: { role: string; content: unknown }[]
    tools?: { function: { name: string } }[]
  }[] = []
  globalThis.fetch = (async (url, init) => {
    if (String(url).includes('models.dev'))
      return new Response(
        JSON.stringify({
          openai: {
            models: {
              'test-bot-model': {
                id: 'test-bot-model',
                name: 'Test',
                tool_call: true,
                limit: { context: 128000, output: 4096 }
              }
            }
          }
        }),
        { headers: { 'content-type': 'application/json' } }
      )
    if (String(url).includes('bot-test.invalid')) {
      requests.push(JSON.parse(String(init?.body)))
      if (holdReply)
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('Stopped.')), {
            once: true
          })
        })
      return new Response(
        'data: ' +
          JSON.stringify({
            choices: [{ delta: { content: 'Reviewed by the bot.' }, finish_reason: null }]
          }) +
          '\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } }
      )
    }
    throw new Error(`Unexpected network request: ${url}`)
  }) as typeof fetch
  try {
    repo.connectProvider({
      id: 'openai',
      apiKey: 'test-only',
      baseURL: 'https://bot-test.invalid/v1',
      defaultModel: 'test-bot-model'
    })
    repo.setActiveProvider('openai', 'test-bot-model')
    const worker = bots.createBot('worker', 'Review code when asked.')
    enqueuePrompt(worker.chatId, 'Please review', undefined, {
      sourceChatId: session.id,
      replyToChatId: session.id,
      hops: 1
    })
    enqueuePrompt(worker.chatId, 'Second request')
    wakeAutomation()
    wakeAutomation()
    const waitIdle = async (): Promise<void> => {
      const deadline = Date.now() + 10000
      while (sessionBusy(worker.chatId) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10))
      assert.ok(!sessionBusy(worker.chatId), 'turn did not settle')
    }
    await waitIdle()
    assert.equal(requests.length, 1, 'concurrent ticks must not duplicate delivery')
    assert.equal(repo.listQueue(worker.chatId).length, 1)
    assert.equal(repo.listMessages(worker.chatId).at(-1)?.content, 'Reviewed by the bot.')
    assert.equal(repo.listMessages(session.id).at(-1)?.botUsername, 'worker')
    assert.equal(requests[0].messages.at(-1)?.role, 'user')
    assert.ok(JSON.stringify(requests[0].messages[0]).includes('You are @worker'))
    for (const tool of [
      'read',
      'write',
      'bash',
      'browser_open',
      'task',
      'mcp',
      'bot_invoke',
      'session_manage',
      'queue_manage'
    ]) {
      assert.ok(
        requests[0].tools?.some((entry) => entry.function.name === tool),
        `missing harness tool ${tool}`
      )
    }
    wakeAutomation()
    await waitIdle()
    assert.equal(requests.length, 2)
    assert.equal(repo.listQueue(worker.chatId).length, 0)
    assert.equal(repo.listMessages(worker.chatId).filter((m) => m.role === 'assistant').length, 2)

    // Tool-invoked delegation resumes the caller once, without a reply-to loop.
    const caller = bots.createBot('caller')
    const delegated = await runTool(
      'bot_invoke',
      { bot: worker.id, prompt: 'One bounded delegation' },
      {
        cwd: sessionCwd(caller.chatId),
        sessionId: caller.chatId
      }
    )
    assert.ok(delegated.ok, delegated.output)
    wakeAutomation()
    await waitIdle()
    const continuation = repo.listQueue(caller.chatId)[0]
    assert.equal(continuation.hops, 2)
    assert.equal(continuation.replyToChatId, undefined)
    assert.ok(continuation.content.includes('Reviewed by the bot.'))
    repo.removeQueueItem(continuation.id)

    // Stop keeps the interrupted item and blocks its backlog until explicitly retried.
    holdReply = true
    enqueuePrompt(worker.chatId, 'Stop me')
    enqueuePrompt(worker.chatId, 'Do not run after stop')
    wakeAutomation()
    const deadline = Date.now() + 5000
    while (requests.length < 4 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10))
    stopTurn(worker.chatId)
    await waitIdle()
    const stopped = repo.listQueue(worker.chatId)[0]
    assert.equal(stopped.state, 'failed')
    assert.match(stopped.error!, /Stopped/)
    wakeAutomation()
    assert.equal(requests.length, 4)
    repo.updateQueueItem(stopped.id, 'Corrected retry')
    assert.equal(
      (
        getDb().prepare('SELECT message_id FROM queue WHERE id = ?').get(stopped.id) as {
          message_id: string | null
        }
      ).message_id,
      null
    )
    holdReply = false
    registerIpc()
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.resolve('test/.out/bots-preload.cjs'),
        contextIsolation: true,
        sandbox: false
      }
    })
    try {
      await win.loadURL('data:text/html,<title>Bot IPC test</title>')
      const viaBridge = await win.webContents.executeJavaScript(
        `window.roxy.bots.create('bridge-bot')`
      )
      assert.equal(viaBridge.username, 'bridge-bot')
      const bridgeList = await win.webContents.executeJavaScript('window.roxy.bots.list()')
      assert.ok(bridgeList.some((entry: { id: string }) => entry.id === viaBridge.id))
      await win.webContents.executeJavaScript(
        `window.roxy.bots.update(${JSON.stringify(viaBridge.id)}, { instructions: 'Updated through IPC' })`
      )
      assert.equal(bots.getBot(viaBridge.id)?.instructions, 'Updated through IPC')
      const bridgeJob = await win.webContents.executeJavaScript(
        `window.roxy.bots.saveJob(${JSON.stringify({
          botId: viaBridge.id,
          name: 'Bridge cron',
          prompt: 'Check',
          schedule: { kind: 'cron', expression: '0 9 * * 1-5', timezone: 'UTC' }
        })})`
      )
      assert.equal(bridgeJob.schedule.kind, 'cron')
      await win.webContents.executeJavaScript(
        `window.roxy.bots.removeJob(${JSON.stringify(bridgeJob.id)})`
      )
      assert.equal(bots.listJobs(viaBridge.id).length, 0)
      await win.webContents.executeJavaScript(
        `window.roxy.bots.remove(${JSON.stringify(viaBridge.id)})`
      )
      assert.equal(bots.getBot(viaBridge.id), undefined)
      const local = repo.createChat({ title: 'Local IPC turn' })
      repo.addMessage({ chatId: local.id, role: 'user', content: 'Direct turn' })
      const input = {
        requestId: 'test-local-lock',
        sessionId: local.id,
        providerId: 'openai',
        model: 'test-bot-model',
        messages: [{ role: 'user', content: 'Direct turn' }]
      }
      const result = await win.webContents.executeJavaScript(
        `window.roxy.llm.start(${JSON.stringify(input)})`
      )
      assert.ok(result.ok, result.error)
      assert.ok(sessionBusy(local.id), 'lock must cover renderer persistence')
      repo.addMessage({ chatId: local.id, role: 'assistant', content: 'Persisted direct answer' })
      await win.webContents.executeJavaScript(`window.roxy.llm.finish('test-local-lock')`)
      assert.ok(!sessionBusy(local.id), 'renderer ack releases the turn')
    } finally {
      win.destroy()
    }
  } finally {
    globalThis.fetch = originalFetch
  }
  closeDb()
  console.log('BOT RUNTIME OK')
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
