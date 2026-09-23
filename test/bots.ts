import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { app, BrowserWindow } from 'electron'
import Database from 'better-sqlite3'
import { registerIpc } from '../src/main/ipc'
import { resolveSessionConfig } from '../src/shared/session-config'
import { HOST_USERNAME, isHostSpeaker } from '../src/shared/bots'
import { MIGRATIONS, repairSchema } from '../src/main/db/migrations'
import { getDb, closeDb } from '../src/main/db/database'
import * as repo from '../src/main/db/repo'
import * as bots from '../src/main/db/bots'
import { runTool } from '../src/main/harness/tools'
import { runAgentTurn, setPromptText } from '../src/main/harness/agent'
import { BOT_SYSTEM_PROMPT } from '../src/main/harness/bot-prompt'
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
app.on('window-all-closed', () => undefined)

async function main(): Promise<void> {
  const migrationDb = new Database(':memory:')
  migrationDb.pragma('foreign_keys = ON')
  for (const step of MIGRATIONS.slice(0, 23))
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
  for (const upgrade of MIGRATIONS.slice(23, 25))
    typeof upgrade === 'function'
      ? migrationDb.transaction(() => upgrade(migrationDb))()
      : migrationDb.exec(upgrade)
  migrationDb
    .prepare(
      `UPDATE queue SET recipient_id = 'stale', as_bot_id = 'stale', state = 'failed', error = 'Keep failure' WHERE id = 'one'`
    )
    .run()
  migrationDb
    .prepare(`UPDATE queue SET recipient_id = 'roxy', source_chat_id = 'one' WHERE id = 'two'`)
    .run()
  for (const upgrade of MIGRATIONS.slice(25))
    typeof upgrade === 'function' ? upgrade(migrationDb) : migrationDb.exec(upgrade)
  assert.deepEqual(
    migrationDb
      .prepare('SELECT recipient_id, as_bot_id, state, error FROM queue WHERE id = ?')
      .get('one'),
    {
      recipient_id: null,
      as_bot_id: null,
      state: 'failed',
      error: 'Keep failure'
    },
    'v26 clears stale user routing without retrying failed work'
  )
  assert.deepEqual(
    migrationDb.prepare('SELECT recipient_id, source_chat_id FROM queue WHERE id = ?').get('two'),
    {
      recipient_id: 'roxy',
      source_chat_id: 'one'
    },
    'v26 preserves explicit machine handoffs'
  )
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
  // A bot can exist before it is named: creation must never be the step that
  // blocks someone from simply starting to talk to it.
  const unnamed = bots.createBot()
  const unnamedToo = bots.createBot()
  assert.equal(unnamed.username, 'bot')
  assert.equal(unnamedToo.username, 'bot-2', 'generated handles do not collide')
  assert.equal(bots.getBot(unnamed.id)?.instructions, '', 'and it starts with no role')
  bots.removeBot(unnamed.id)
  bots.removeBot(unnamedToo.id)
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

  // Configuring yourself from the conversation: the whole point of a bot you can
  // just talk to. No id means ME, and it has to persist, not merely be agreed to.
  const selfCtx = { cwd: sessionCwd(bot.chatId), sessionId: bot.chatId, botId: bot.id }
  assert.ok(
    (
      await runTool(
        'bot_manage',
        { action: 'update', username: 'atlas', instructions: 'Watch the docs.' },
        selfCtx
      )
    ).ok
  )
  assert.equal(bots.getBot(bot.id)?.username, 'atlas')
  assert.equal(bots.getBot(bot.id)?.instructions, 'Watch the docs.')
  const jobsBefore = bots.listJobs(bot.id).length
  const selfJob = await runTool(
    'bot_schedule',
    {
      action: 'create',
      name: 'Hourly docs sweep',
      prompt: 'Check the docs for broken links.',
      schedule: { kind: 'interval', minutes: 60 }
    },
    selfCtx
  )
  assert.ok(selfJob.ok, selfJob.output)
  const jobsAfter = bots.listJobs(bot.id)
  assert.equal(jobsAfter.length, jobsBefore + 1, 'the routine belongs to the bot that asked')
  assert.equal(
    JSON.parse((await runTool('bot_schedule', { action: 'list' }, selfCtx)).output).length,
    jobsAfter.length,
    'listing with no filter shows my own schedules'
  )

  // A guest keeps its own identity inside someone else's chat. Deriving self from
  // the session instead let a visitor rename and schedule its HOST.
  const guest = bots.createBot('guest')
  const guestCtx = { cwd: sessionCwd(bot.chatId), sessionId: bot.chatId, botId: guest.id }
  assert.ok(
    (await runTool('bot_manage', { action: 'update', instructions: 'Guest role.' }, guestCtx)).ok
  )
  assert.equal(bots.getBot(guest.id)?.instructions, 'Guest role.')
  assert.equal(bots.getBot(bot.id)?.instructions, 'Watch the docs.', 'the host is untouched')
  assert.ok(
    (
      await runTool(
        'bot_schedule',
        {
          action: 'create',
          name: 'Guest routine',
          prompt: 'Guest work.',
          schedule: { kind: 'interval', minutes: 30 }
        },
        guestCtx
      )
    ).ok
  )
  assert.equal(bots.listJobs(guest.id).length, 1)
  assert.equal(
    bots.listJobs(bot.id).length,
    jobsAfter.length,
    'a guest cannot schedule work for its host'
  )

  // Roxy and subagents have no self: they must say which bot they mean rather
  // than silently configuring whoever owns the chat they are running in.
  assert.ok(
    !(await runTool('bot_manage', { action: 'update', instructions: 'No target.' }, ctx)).ok
  )
  assert.ok(
    !(
      await runTool(
        'bot_schedule',
        {
          action: 'create',
          name: 'Nobody',
          prompt: 'Nothing',
          schedule: { kind: 'interval', minutes: 15 }
        },
        { cwd: sessionCwd(bot.chatId), sessionId: bot.chatId }
      )
    ).ok,
    'without an acting bot the target must be named'
  )
  for (const job of bots.listJobs(bot.id)) bots.removeJob(job.id)
  bots.removeBot(guest.id)
  bots.updateBot(bot.id, { username: 'reviewer', instructions: 'Review PRs only when asked.' })

  // An invited bot answers in the session that called it, not in its own chat.
  const invoked = await runTool('bot_invoke', { bot: 'reviewer', prompt: 'Check this diff' }, ctx)
  assert.ok(invoked.ok, invoked.output)
  assert.equal(repo.listQueue(bot.chatId).length, 0)
  const queued = repo.listQueue(session.id)[0]
  assert.equal(queued.asBotId, bot.id)
  assert.equal(queued.replyToChatId, undefined)
  assert.equal(queued.hops, 1)
  assert.ok(
    (await runTool('queue_manage', { action: 'update', id: queued.id, prompt: 'Updated' }, ctx)).ok
  )
  assert.equal(repo.listQueue(session.id)[0].content, 'Updated')
  getDb().prepare(`UPDATE queue SET state = 'running' WHERE id = ?`).run(queued.id)
  assert.ok(!(await runTool('queue_manage', { action: 'delete', id: queued.id }, ctx)).ok)
  getDb().prepare(`UPDATE queue SET state = 'failed' WHERE id = ?`).run(queued.id)
  assert.ok((await runTool('queue_manage', { action: 'delete', id: queued.id }, ctx)).ok)
  assert.equal(repo.listQueue(session.id).length, 0)
  assert.throws(() => enqueuePrompt(bot.chatId, 'cycle', undefined, { hops: 9 }), /Handoff/)

  const reviewerCtx = { ...ctx, botId: bot.id }
  const wrongSend = await runTool(
    'session_manage',
    { action: 'send', sessionId: session.id, message: 'Apply the review findings.' },
    reviewerCtx
  )
  assert.ok(!wrongSend.ok)
  assert.match(wrongSend.output, /requires id/)
  assert.ok(!wrongSend.output.includes('Project session not found'))
  const missingPrompt = await runTool(
    'session_manage',
    { action: 'send', id: session.id, message: 'Apply the review findings.' },
    reviewerCtx
  )
  assert.ok(!missingPrompt.ok)
  assert.match(missingPrompt.output, /non-empty prompt/)
  assert.equal(repo.listQueue(session.id).length, 0)
  for (const name of ['roxy', 'Roxy', '@ROXY']) {
    const returned = await runTool(
      'bot_invoke',
      { bot: name, prompt: '@Roxy Apply the review findings.' },
      reviewerCtx
    )
    assert.ok(returned.ok, returned.output)
    const item = repo.listQueue(session.id)[0]
    assert.equal(item.content, '@Roxy Apply the review findings.')
    assert.equal(item.asBotId, undefined, 'the project host, not another bot, will answer')
    assert.equal(item.botId, bot.id, 'the reviewer owns the request')
    assert.equal(item.botUsername, 'reviewer')
    assert.equal(item.hops, 1)
    assert.equal(item.replyToChatId, undefined, 'no automatic reply loop')
    repo.removeQueueItem(item.id)
  }
  // Handing the thread BACK to the bot that owns this chat is delegation to
  // someone else whenever the speaker is a guest - or Roxy. Comparing against
  // the owner rejected the ordinary round trip and left no way to return work.
  const visitorCtx = { cwd: sessionCwd(bot.chatId), sessionId: bot.chatId }
  const handBack = await runTool(
    'bot_invoke',
    { bot: 'reviewer', prompt: 'Verify the fix in your own chat.' },
    visitorCtx
  )
  assert.ok(handBack.ok, handBack.output)
  const handedBack = repo.listQueue(bot.chatId)[0]
  assert.equal(handedBack.asBotId, bot.id, 'the owner answers next')
  assert.equal(handedBack.botUsername, HOST_USERNAME, 'and the visiting host signs the request')
  assert.equal(handedBack.botId, undefined, 'the host has no bot row')
  repo.removeQueueItem(handedBack.id)
  // The owner talking to itself is still the no-op the guard is for.
  const ownerToItself = await runTool(
    'bot_invoke',
    { bot: 'reviewer', prompt: 'Call myself' },
    { ...visitorCtx, botId: bot.id }
  )
  assert.ok(!ownerToItself.ok)
  assert.match(ownerToItself.output, /already executing this turn/)

  const selfHost = await runTool('bot_invoke', { bot: 'roxy', prompt: 'Call myself' }, ctx)
  assert.ok(!selfHost.ok)
  assert.match(selfHost.output, /You are Roxy/)
  const privateHost = await runTool(
    'bot_invoke',
    { bot: 'roxy', prompt: 'Guess the project' },
    selfCtx
  )
  assert.ok(privateHost.ok, privateHost.output)
  assert.equal(repo.listQueue(bot.chatId)[0].sourceChatId, bot.chatId)
  repo.removeQueueItem(repo.listQueue(bot.chatId)[0].id)
  assert.ok(
    !(await runTool('bot_invoke', { bot: 'roxy', prompt: '  ' }, reviewerCtx)).ok,
    'empty handoffs must not enqueue a bare mention'
  )
  const lastHop = enqueuePrompt(session.id, 'Last reviewer turn', undefined, { hops: 8 })
  getDb().prepare(`UPDATE queue SET state = 'running' WHERE id = ?`).run(lastHop.id)
  const cappedHost = await runTool(
    'bot_invoke',
    { bot: 'roxy', prompt: 'One hop too many' },
    reviewerCtx
  )
  assert.ok(!cappedHost.ok)
  assert.match(cappedHost.output, /Handoff limit/)
  assert.equal(repo.listQueue(session.id).length, 1)
  getDb().prepare(`UPDATE queue SET state = 'failed' WHERE id = ?`).run(lastHop.id)
  repo.removeQueueItem(lastHop.id)

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

  // A mention stays with Roxy; only the model's explicit tool can delegate.
  const mention = enqueuePrompt(session.id, 'Hola @reviewer, inspect this')
  assert.equal(mention.asBotId, undefined)
  wakeAutomation()
  const routed = repo.listQueue(session.id).find((item) => item.id === mention.id)!
  assert.equal(routed.asBotId, undefined)
  assert.equal(repo.listQueue(bot.chatId).length, 0)
  getDb().prepare(`UPDATE queue SET state = 'running' WHERE id = ?`).run(routed.id)
  startAutomation()
  stopAutomation()
  assert.equal(repo.listQueue(session.id)[0].state, 'failed')
  assert.match(repo.listQueue(session.id)[0].error!, /shutdown/)
  for (const item of repo.listQueue(session.id)) repo.removeQueueItem(item.id)

  // A mention inside a brief already addressed to a bot is NOT a redirect:
  // bot_invoke chose the responder, and telling it "then report to @reviewer"
  // used to hand the turn to @reviewer instead.
  const helper = bots.createBot('helper')
  for (const text of ['Hola @reviewer y @helper', 'Hola @unknown', 'Install @scope/package']) {
    const item = enqueuePrompt(session.id, text)
    assert.equal(item.asBotId, undefined)
    assert.equal(item.content, text)
    repo.removeQueueItem(item.id)
  }
  const pinned = enqueuePrompt(session.id, 'Hola @helper')
  bots.updateBot(helper.id, { username: 'helper-renamed' })
  repo.updateQueueItem(pinned.id, 'Ahora habla Roxy')
  assert.equal(repo.listQueue(session.id)[0].asBotId, undefined)
  repo.removeQueueItem(pinned.id)
  bots.updateBot(helper.id, { username: 'helper' })
  const addressed = enqueuePrompt(session.id, 'Do the work, then tell @reviewer', undefined, {
    sourceChatId: session.id,
    asBotId: helper.id
  })
  wakeAutomation()
  assert.equal(
    repo.listQueue(session.id).find((item) => item.id === addressed.id)!.asBotId,
    helper.id
  )
  for (const item of repo.listQueue(session.id)) repo.removeQueueItem(item.id)

  // A mention is not a handoff and does not spend a hop.
  const exhausted = enqueuePrompt(session.id, '@reviewer take over', undefined, {
    hops: 8
  })
  wakeAutomation()
  const stopped = repo.listQueue(session.id).find((item) => item.id === exhausted.id)!
  assert.equal(stopped.state, 'failed')
  assert.match(stopped.error!, /provider/)
  assert.equal(stopped.hops, 8)
  assert.equal(stopped.asBotId, undefined)
  for (const item of repo.listQueue(session.id)) repo.removeQueueItem(item.id)

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
  let identityUpdate: { username: string; instructions: string } | undefined
  const scriptedTools: ({ name: string; arguments: Record<string, unknown> } | null)[] = []
  const requests: {
    url: string
    model?: string
    reasoning_effort?: string
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
          },
          // A second provider, so "the guest brings its own config" is proven
          // across providers and not just across two ids on one endpoint.
          openrouter: {
            models: {
              'guest-model': {
                id: 'guest-model',
                name: 'Guest',
                tool_call: true,
                reasoning: true,
                limit: { context: 128000, output: 4096 }
              }
            }
          }
        }),
        { headers: { 'content-type': 'application/json' } }
      )
    if (String(url).includes('bot-test.invalid') || String(url).includes('guest-test.invalid')) {
      requests.push({ url: String(url), ...JSON.parse(String(init?.body)) })
      const scripted = scriptedTools.shift()
      if (scripted)
        return new Response(
          'data: ' +
            JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: `scripted-${requests.length}`,
                        type: 'function',
                        function: {
                          name: scripted.name,
                          arguments: JSON.stringify(scripted.arguments)
                        }
                      }
                    ]
                  },
                  finish_reason: 'tool_calls'
                }
              ]
            }) +
            '\n\ndata: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } }
        )
      if (identityUpdate) {
        const patch = identityUpdate
        identityUpdate = undefined
        return new Response(
          'data: ' +
            JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'identity-save',
                        type: 'function',
                        function: {
                          name: 'bot_manage',
                          arguments: JSON.stringify({ action: 'update', ...patch })
                        }
                      }
                    ]
                  },
                  finish_reason: 'tool_calls'
                }
              ]
            }) +
            '\n\ndata: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } }
        )
      }
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
    // Its own routines ride in the prompt: a bot asked to "make it every two
    // hours" has to edit THIS schedule instead of creating a second one.
    const workerJob = bots.saveJob({
      botId: worker.id,
      name: 'Morning sweep',
      prompt: 'Sweep the repo.',
      schedule: { kind: 'interval', minutes: 60 }
    })
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
    const workerSystem = String(requests[0].messages[0].content)
    assert.ok(
      workerSystem.includes(workerJob.id) && workerSystem.includes('every 60 minutes'),
      'a bot sees the schedules it already has, by id'
    )
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

    assert.ok(
      !JSON.stringify(requests[0].messages[0]).includes('<your-chat>'),
      'a bot in its own chat already has that history as messages'
    )

    // An invited bot answers inside the calling session — one shared transcript,
    // the request signed by the caller and the reply by the guest.
    const caller = bots.createBot('caller')
    // The WHOLE configuration travels with the guest, on a second provider so a
    // wrong resolution cannot accidentally pass: you invite the specialist you
    // tuned, not a copy of it running on the host session's settings.
    repo.connectProvider({
      id: 'openrouter',
      apiKey: 'test-only',
      baseURL: 'https://guest-test.invalid/v1',
      defaultModel: 'guest-model'
    })
    repo.setChatConfig(worker.chatId, {
      providerId: 'openrouter',
      model: 'guest-model',
      agentId: 'plan',
      reasoningEffort: 'high',
      // Deliberately narrower than the host's, which is the dangerous shape:
      // the visitor must live with a smaller window, never shrink the host to
      // fit it.
      contextLimit: 8000
    })
    repo.setChatConfig(caller.chatId, {
      providerId: 'openai',
      model: 'test-bot-model',
      agentId: 'build',
      reasoningEffort: 'low',
      contextLimit: 128000
    })
    // A compaction summary long enough to swamp the prompt on its own: the guest
    // memory block has to bound it, not pass it through.
    repo.setChatSummary(worker.chatId, 'S'.repeat(20000), 0)
    // A host transcript that overflows the GUEST's narrow window but fits its
    // own, so "the guest never compacts the host" is actually exercised.
    repo.addMessage({
      chatId: caller.chatId,
      role: 'user',
      content: `Host notes: ${'h'.repeat(40000)}`
    })
    // The host carries a compaction summary of its own, sized for ITS window.
    // The guest must neither inherit it whole nor rewrite it.
    repo.setChatSummary(caller.chatId, 'H'.repeat(20000), 0)
    const delegated = await runTool(
      'bot_invoke',
      { bot: worker.id, prompt: 'One bounded delegation' },
      {
        cwd: sessionCwd(caller.chatId),
        sessionId: caller.chatId,
        // As the harness does for a bot's own turn: the asker is stated, not
        // inferred from whoever owns the chat.
        botId: caller.id
      }
    )
    assert.ok(delegated.ok, delegated.output)
    wakeAutomation()
    const guestDeadline = Date.now() + 10000
    while (
      (sessionBusy(caller.chatId) || repo.listQueue(caller.chatId).length) &&
      Date.now() < guestDeadline
    )
      await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(repo.listQueue(caller.chatId).length, 0, 'guest turn did not settle')
    const shared = repo.listMessages(caller.chatId).slice(-2)
    // bot_invoke names its recipient explicitly, so the delegation reads as one
    // in the shared transcript rather than as an unaddressed instruction.
    assert.equal(shared[0].content, '@worker One bounded delegation')
    assert.equal(shared[0].botUsername, 'caller', 'the request belongs to the asking bot')
    assert.equal(shared[1].botUsername, 'worker', 'the reply belongs to the invited bot')
    assert.ok(
      JSON.stringify(requests.at(-1)?.messages[0]).includes('You are @worker'),
      'the guest speaks as itself'
    )
    const guestRequest = requests.at(-1)!
    assert.ok(
      guestRequest.url.includes('guest-test.invalid'),
      "the guest answers on its own provider, not the host session's"
    )
    assert.equal(guestRequest.model, 'guest-model', 'and on its own model')
    assert.equal(guestRequest.reasoning_effort, 'high', 'and at its own thinking effort')
    const guestSystem = JSON.stringify(guestRequest.messages[0])
    // Mode travels too, and it is enforced by the tool list, not just described:
    // a reviewer pinned to Plan stays read-only inside a Build session.
    assert.ok(
      !guestRequest.tools?.some((entry) => entry.function.name === 'write'),
      'a guest pinned to Plan cannot write in a Build session'
    )
    assert.ok(
      guestRequest.tools?.some((entry) => entry.function.name === 'read'),
      'but it still reads the host project it was invited to look at'
    )
    const hostConfig = resolveSessionConfig(repo.getChat(caller.chatId), repo.getSettings())
    assert.equal(hostConfig.model, 'test-bot-model', 'the host session keeps its own model')
    assert.equal(hostConfig.agentId, 'build', 'and its own mode')
    assert.equal(hostConfig.reasoningEffort, 'low', 'and its own effort')
    // Its private chat comes along as background, so the work the user did with
    // it privately does not stop at the door of the session it is invited into.
    assert.ok(guestSystem.includes('<your-chat>'), 'the guest brings its own chat as context')
    assert.ok(guestSystem.includes('Reviewed by the bot.'), 'including what it said there')
    // Bounded as a WHOLE. The block rides in the system message, which trimming
    // never drops, so an unbounded summary would push the host's transcript out
    // of the window: the guest would remember its chat and forget the project.
    const memory = String(guestRequest.messages[0].content).match(
      /<your-chat>[\s\S]*<\/your-chat>/
    )![0]
    assert.ok(
      memory.length < 7000,
      `the summary shares the block's budget instead of bypassing it (was ${memory.length})`
    )
    assert.ok(
      memory.includes('SSS') && !memory.includes('S'.repeat(4000)),
      'a huge summary is carried in truncated form, not whole'
    )
    // The delegation itself has to SURVIVE the guest’s narrower window. The
    // prompt is persisted as `assistant` (an agent wrote it, not the user), and
    // trimming drops leading non-user messages, so on a small budget the guest
    // used to arrive at "Continue with the pending request." having never been
    // told what the request was.
    const guestConvo = guestRequest.messages
    assert.ok(
      guestConvo.some((m) => String(m.content).includes('One bounded delegation')),
      'the guest is told what it was actually asked to do'
    )
    assert.equal(guestConvo.at(-1)?.role, 'user', 'and the window still ends on a user turn')
    // The HOST's summary was compacted to fit the HOST's window, and it rides in
    // the system message, which trimming never drops. Unbounded, it spends the
    // guest's much smaller budget before the transcript gets a word: the visitor
    // reads a recap of the session instead of the session.
    assert.ok(
      !guestSystem.includes('H'.repeat(8000)),
      "the host's summary is bounded to the guest's window, not passed through whole"
    )
    assert.ok(guestSystem.includes('HHH'), 'but it is still carried, in truncated form')
    // Compaction is permanent and belongs to the host, so a visiting bot on a
    // narrower window must never summarize the session it is passing through.
    // Truncating for the prompt is a VIEW: what is stored comes out untouched.
    assert.equal(
      repo.getChat(caller.chatId)?.contextSummary,
      'H'.repeat(20000),
      'a guest never compacts or rewrites the host session'
    )
    repo.setChatConfig(worker.chatId, {
      providerId: 'openai',
      model: 'test-bot-model',
      agentId: 'build',
      reasoningEffort: 'medium',
      contextLimit: null
    })
    repo.setChatSummary(worker.chatId, '', 0)
    repo.setChatSummary(caller.chatId, '', 0)

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
          enabled: false,
          remainingRuns: 2,
          schedule: { kind: 'cron', expression: '0 9 * * 1-5', timezone: 'UTC' }
        })})`
      )
      assert.equal(bridgeJob.schedule.kind, 'cron')
      const releaseForced = claimTurn(viaBridge.chatId, new AbortController())!
      const forced = await win.webContents.executeJavaScript(
        `window.roxy.bots.runJob(${JSON.stringify(bridgeJob.id)})`
      )
      assert.equal(forced.chatId, viaBridge.chatId)
      assert.equal(forced.content, 'Check')
      assert.equal(
        repo.listQueue(viaBridge.chatId).length,
        1,
        'force run queues once behind the active turn'
      )
      assert.deepEqual(
        bots.listJobs(viaBridge.id)[0],
        bridgeJob,
        'paused schedule and run limits remain unchanged'
      )
      releaseForced()
      const beforeForcedRequest = requests.length
      wakeAutomation()
      const forceDeadline = Date.now() + 10000
      while (sessionBusy(viaBridge.chatId) && Date.now() < forceDeadline)
        await new Promise((resolve) => setTimeout(resolve, 10))
      assert.equal(
        requests.length,
        beforeForcedRequest + 1,
        'forced schedule uses the real harness'
      )
      assert.equal(repo.listQueue(viaBridge.chatId).length, 0)
      assert.equal(repo.listMessages(viaBridge.chatId).at(-1)?.content, 'Reviewed by the bot.')
      assert.deepEqual(
        bots.listJobs(viaBridge.id)[0],
        bridgeJob,
        'test run does not consume the scheduled run'
      )
      await win.webContents.executeJavaScript(
        `window.roxy.bots.removeJob(${JSON.stringify(bridgeJob.id)})`
      )
      assert.equal(bots.listJobs(viaBridge.id).length, 0)
      const missingRun = await win.webContents.executeJavaScript(
        `window.roxy.bots.runJob(${JSON.stringify(bridgeJob.id)}).then(() => '', error => error.message)`
      )
      assert.match(missingRun, /Schedule not found/)
      assert.equal(repo.listQueue(viaBridge.chatId).length, 0, 'deleted schedule cannot be forced')
      await win.webContents.executeJavaScript(
        `window.roxy.bots.remove(${JSON.stringify(viaBridge.id)})`
      )
      assert.equal(bots.getBot(viaBridge.id), undefined)
      const local = repo.createChat({ title: 'Local IPC turn' })
      // A bare 4th argument cannot choose a responder through public IPC.
      const publicQueued = await win.webContents.executeJavaScript(
        `window.roxy.queue.add(${JSON.stringify(local.id)}, 'Install @unknown/package and ask @worker', undefined, ${JSON.stringify(worker.id)})`
      )
      assert.equal(publicQueued.asBotId, undefined)
      assert.ok(!('recipientId' in publicQueued))
      assert.deepEqual(
        getDb()
          .prepare('SELECT recipient_id, as_bot_id FROM queue WHERE id = ?')
          .get(publicQueued.id),
        {
          recipient_id: null,
          as_bot_id: null
        }
      )
      const publicUpdated = await win.webContents.executeJavaScript(
        `window.roxy.queue.update(${JSON.stringify(publicQueued.id)}, 'Hola @worker', undefined, ${JSON.stringify(worker.id)})`
      )
      assert.equal(publicUpdated.asBotId, undefined)
      assert.ok(!('recipientId' in publicUpdated))
      repo.removeQueueItem(publicQueued.id)
      // Explicit options (composer Send to @bot) do route — same contract as bot_invoke.
      const routed = await win.webContents.executeJavaScript(
        `window.roxy.queue.add(${JSON.stringify(local.id)}, 'Hola @worker, review this', undefined, ${JSON.stringify(
          {
            sourceChatId: local.id,
            asBotId: worker.id,
            recipientId: worker.id,
            fromUser: true
          }
        )})`
      )
      assert.equal(routed.asBotId, worker.id)
      assert.deepEqual(
        getDb()
          .prepare('SELECT recipient_id, as_bot_id, message_id FROM queue WHERE id = ?')
          .get(routed.id),
        {
          recipient_id: worker.id,
          as_bot_id: worker.id,
          message_id: repo.listMessages(local.id).at(-1)!.id
        }
      )
      assert.equal(repo.listMessages(local.id).at(-1)?.role, 'user')
      repo.removeQueueItem(routed.id)
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

    // This verifies prompt assembly and real tool persistence, not model judgment:
    // the transport deliberately supplies the identity tool call.
    setPromptText({
      default: readFileSync('resources/prompts/default.txt', 'utf8'),
      gemini: readFileSync('resources/prompts/gemini.txt', 'utf8')
    })
    const settle = async (chatId: string): Promise<void> => {
      const deadline = Date.now() + 10000
      while (sessionBusy(chatId) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10))
      assert.ok(!sessionBusy(chatId), 'turn did not settle')
    }
    const hostFirst = repo.createChat({
      title: 'Host interprets intent',
      workspacePath: app.getPath('userData')
    })
    // No model judgment is asserted: with no scripted tool, all these requests
    // stay host-owned, including restored v25 rows that still name a guest.
    for (const [content, staleRecipient, staleBot] of [
      ['Hola @worker', worker.id, worker.id],
      ['Implement first, then ask @worker', null, worker.id],
      ['What does @worker do?', 'deleted-bot', null],
      ['Install @unknown/package', null, null]
    ] as const) {
      const item = enqueuePrompt(hostFirst.id, content, undefined, {
        recipientId: worker.id,
        asBotId: worker.id
      })
      assert.equal(item.asBotId, undefined, 'user options cannot pick a guest')
      getDb()
        .prepare('UPDATE queue SET recipient_id = ?, as_bot_id = ? WHERE id = ?')
        .run(staleRecipient, staleBot, item.id)
      assert.equal(repo.listQueue(hostFirst.id)[0].asBotId, undefined)
      const before = requests.length
      wakeAutomation()
      await settle(hostFirst.id)
      assert.equal(requests.length, before + 1)
      assert.equal(repo.listQueue(hostFirst.id).length, 0)
      assert.ok(String(requests.at(-1)!.messages[0].content).startsWith('You are Roxy,'))
      assert.equal(repo.listMessages(hostFirst.id).at(-1)?.botId, undefined)
    }
    const hostRules = String(requests.at(-1)!.messages[0].content)
    assert.ok(hostRules.includes('silently call bot_invoke'))
    assert.ok(hostRules.includes('Respect temporal dependencies'))
    assert.ok(hostRules.includes('Answer questions ABOUT a bot yourself'))
    assert.ok(!hostRules.includes('User @mentions determine who answers'))

    // Scripted tool -> durable guest turn proves the execution path, NOT that
    // a real model will infer intent, timing, or silence correctly.
    scriptedTools.push({ name: 'bot_invoke', arguments: { bot: worker.id, prompt: 'Hola' } }, null)
    enqueuePrompt(hostFirst.id, 'Hola @worker')
    const beforeDelegation = requests.length
    wakeAutomation()
    await settle(hostFirst.id)
    assert.equal(requests.length, beforeDelegation + 2)
    assert.ok(String(requests[beforeDelegation].messages[0].content).startsWith('You are Roxy,'))
    const toolHandoff = repo.listQueue(hostFirst.id)[0]
    assert.equal(toolHandoff.asBotId, worker.id)
    assert.equal(toolHandoff.sourceChatId, hostFirst.id)
    assert.equal(toolHandoff.botId, undefined, 'Roxy authored the handoff')
    assert.equal(toolHandoff.hops, 1, 'only the explicit tool spends a hop')
    const hostToolMessage = repo.listMessages(hostFirst.id).at(-1)!
    assert.equal(hostToolMessage.botId, undefined)
    assert.ok(
      hostToolMessage.parts.some((part) => part.type === 'tool' && part.tool === 'bot_invoke')
    )
    wakeAutomation()
    await settle(hostFirst.id)
    assert.equal(repo.listQueue(hostFirst.id).length, 0)
    assert.equal(repo.listMessages(hostFirst.id).at(-2)?.role, 'assistant')
    assert.equal(repo.listMessages(hostFirst.id).at(-2)?.botId, undefined)
    assert.equal(repo.listMessages(hostFirst.id).at(-1)?.botId, worker.id)
    assert.ok(String(requests.at(-1)!.messages[0].content).includes('You are @worker'))

    const fresh = bots.createBot()
    const definition =
      'Eres un senior SWE y tu trabajo es revisar PRs de manera critica, ' +
      'con una tasklist de cambiar, modificar, eliminar o agregar. Al terminar llamas a @Roxy.'
    identityUpdate = { username: 'pr-reviewer', instructions: definition }
    const beforeIdentity = requests.length
    await runAgentTurn({
      providerId: 'openai',
      model: 'test-bot-model',
      cwd: sessionCwd(fresh.chatId),
      chatId: fresh.chatId,
      messages: [{ role: 'user', content: definition }],
      signal: new AbortController().signal,
      emit: () => {}
    })
    const identityRequest = requests[beforeIdentity]
    const identitySystem = String(identityRequest.messages[0].content)
    assert.ok(identitySystem.startsWith(BOT_SYSTEM_PROMPT.trim()))
    assert.ok(identitySystem.includes('Identity state: UNCONFIGURED'))
    assert.ok(!identitySystem.includes('You are Roxy, an AI coding agent'))
    assert.ok(identityRequest.tools?.some((tool) => tool.function.name === 'bot_manage'))
    assert.equal(requests.length, beforeIdentity + 2, 'save tool result returns to the model')
    assert.equal(bots.getBot(fresh.id)?.instructions, definition)
    assert.equal(bots.getBot(fresh.id)?.username, 'pr-reviewer')
    assert.equal(repo.getChat(fresh.chatId)?.title, 'pr-reviewer')
    assert.equal(bots.listJobs(fresh.id).length, 0, 'role definition creates no routine')
    assert.equal(repo.listQueue(fresh.chatId).length, 0, 'role definition starts no delegation')

    // A later turn with a different model gets the persisted role, not onboarding.
    await runAgentTurn({
      providerId: 'openai',
      model: 'gemini-test',
      cwd: sessionCwd(fresh.chatId),
      chatId: fresh.chatId,
      messages: [{ role: 'user', content: 'Hola' }],
      signal: new AbortController().signal,
      emit: () => {}
    })
    const laterSystem = String(requests.at(-1)!.messages[0].content)
    assert.ok(laterSystem.startsWith(BOT_SYSTEM_PROMPT.trim()))
    assert.ok(laterSystem.includes(definition))
    assert.ok(!laterSystem.includes('Identity state: UNCONFIGURED'))

    await runAgentTurn({
      providerId: 'openai',
      model: 'test-bot-model',
      cwd: sessionCwd(session.id),
      chatId: session.id,
      messages: [{ role: 'user', content: 'Hola' }],
      signal: new AbortController().signal,
      emit: () => {}
    })
    assert.ok(
      String(requests.at(-1)!.messages[0].content).startsWith('You are Roxy,'),
      'the host keeps its model-specific coding prompt'
    )
    bots.removeBot(fresh.id)

    // A full host history must still end with the guest's actual assignment,
    // rather than asking it to continue the host's orchestration.
    const handoff = repo.createChat({
      title: 'Guest cancellation',
      workspacePath: app.getPath('userData')
    })
    repo.addMessage({
      chatId: handoff.id,
      role: 'user',
      content: 'Prepare a PR and ask the reviewer.'
    })
    repo.addMessage({
      chatId: handoff.id,
      role: 'assistant',
      content: 'The PR is ready. I have invited the reviewer.'
    })
    holdReply = true
    const beforeGuest = requests.length
    await runTool(
      'bot_invoke',
      { bot: worker.id, prompt: 'Review the existing PR now.' },
      { cwd: sessionCwd(handoff.id), sessionId: handoff.id }
    )
    wakeAutomation()
    const liveDeadline = Date.now() + 10000
    while (requests.length === beforeGuest && Date.now() < liveDeadline)
      await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(requests.length, beforeGuest + 1)
    assert.match(
      String(requests.at(-1)!.messages.at(-1)!.content),
      /This turn is assigned to you, @worker/
    )
    assert.match(String(requests.at(-1)!.messages.at(-1)!.content), /Review the existing PR now/)
    const snapshot = automationSnapshot().find((run) => run.sessionId === handoff.id)!
    assert.equal(snapshot.botId, worker.id)
    assert.equal(snapshot.botUsername, 'worker', 'reloads preserve the live guest identity')
    snapshot.parts.push({ type: 'text', text: 'Partial review before cancellation.' })
    const selfInvoke = await runTool(
      'bot_invoke',
      { bot: worker.id, prompt: 'Wait for myself' },
      { cwd: sessionCwd(handoff.id), sessionId: handoff.id, botId: worker.id }
    )
    assert.ok(!selfInvoke.ok)
    assert.match(selfInvoke.output, /already executing this turn/)
    stopTurn(handoff.id)
    const cancelDeadline = Date.now() + 10000
    while (sessionBusy(handoff.id) && Date.now() < cancelDeadline)
      await new Promise((resolve) => setTimeout(resolve, 10))
    assert.ok(!sessionBusy(handoff.id))
    assert.equal(repo.listQueue(handoff.id)[0].state, 'failed')
    assert.equal(
      repo.listMessages(handoff.id).at(-1)?.botUsername,
      'worker',
      'cancelled guest output is not attributed to Roxy'
    )
    assert.ok(!automationSnapshot().some((run) => run.sessionId === handoff.id))
    holdReply = false

    // Real tool -> durable queue -> host harness -> filesystem, all isolated.
    // The scripted transport proves execution, not a live model's judgment.
    const roundtrip = repo.createChat({
      title: 'Review back to Roxy',
      workspacePath: app.getPath('userData')
    })
    repo.setChatConfig(roundtrip.id, {
      providerId: 'openai',
      model: 'test-bot-model',
      agentId: 'build',
      reasoningEffort: 'low'
    })
    repo.setChatConfig(worker.chatId, {
      providerId: 'openrouter',
      model: 'guest-model',
      agentId: 'build',
      reasoningEffort: 'high'
    })
    const fixPath = path.join(sessionCwd(roundtrip.id), 'handoff-fix.txt')
    const findings = '@helper is a reference, not the recipient. Apply the requested fix.'
    scriptedTools.push(
      { name: 'bot_invoke', arguments: { bot: '@Roxy', prompt: findings } },
      null,
      { name: 'write', arguments: { path: 'handoff-fix.txt', content: 'Fixed by Roxy.' } },
      null
    )
    repo.addMessage({ chatId: roundtrip.id, role: 'user', content: 'Review and return fixes.' })
    await runTool(
      'bot_invoke',
      { bot: worker.id, prompt: 'Review and give Roxy the implementation task.' },
      { cwd: sessionCwd(roundtrip.id), sessionId: roundtrip.id }
    )
    const beforeRoundtrip = requests.length
    wakeAutomation()
    const reviewDeadline = Date.now() + 10000
    while (sessionBusy(roundtrip.id) && Date.now() < reviewDeadline)
      await new Promise((resolve) => setTimeout(resolve, 10))
    assert.ok(!sessionBusy(roundtrip.id), 'reviewer finished')
    assert.equal(requests.length, beforeRoundtrip + 2)
    assert.ok(!existsSync(fixPath), 'the reviewer did not implement the fix')
    const hostItem = repo.listQueue(roundtrip.id)[0]
    assert.equal(hostItem.content, `@Roxy ${findings}`)
    assert.equal(hostItem.botUsername, 'worker')
    assert.equal(hostItem.asBotId, undefined)
    assert.equal(hostItem.hops, 2, 'returning to Roxy spends another hop')
    assert.equal(hostItem.state, 'pending')
    assert.equal(repo.listMessages(roundtrip.id).at(-1)?.botUsername, 'worker')

    // A busy session never runs the next actor concurrently.
    const releaseHost = claimTurn(roundtrip.id, new AbortController())!
    wakeAutomation()
    assert.equal(requests.length, beforeRoundtrip + 2)
    assert.equal(repo.listQueue(roundtrip.id)[0].state, 'pending')
    releaseHost()
    // Startup consumes the persisted return without needing a renderer nudge.
    startAutomation()
    const returnDeadline = Date.now() + 10000
    while (
      (sessionBusy(roundtrip.id) || repo.listQueue(roundtrip.id).length) &&
      Date.now() < returnDeadline
    )
      await new Promise((resolve) => setTimeout(resolve, 10))
    stopAutomation()
    assert.ok(!sessionBusy(roundtrip.id))
    assert.equal(repo.listQueue(roundtrip.id).length, 0, 'the handoff executed to completion')
    assert.equal(requests.length, beforeRoundtrip + 4)
    assert.equal(scriptedTools.length, 0)
    assert.equal(readFileSync(fixPath, 'utf8'), 'Fixed by Roxy.')
    const reviewRequest = requests[beforeRoundtrip]
    const hostRequest = requests[beforeRoundtrip + 2]
    assert.ok(reviewRequest.url.includes('guest-test.invalid'))
    assert.ok(hostRequest.url.includes('bot-test.invalid'), 'Roxy restores the project provider')
    assert.equal(hostRequest.model, 'test-bot-model')
    assert.equal(hostRequest.reasoning_effort, undefined, 'host model does not support reasoning')
    assert.equal(
      resolveSessionConfig(repo.getChat(roundtrip.id), repo.getSettings()).reasoningEffort,
      'low',
      'the guest effort never overwrites the host configuration'
    )
    assert.ok(String(hostRequest.messages[0].content).startsWith('You are Roxy,'))
    assert.ok(!String(hostRequest.messages[0].content).includes('<your-chat>'))
    assert.match(String(hostRequest.messages.at(-1)?.content), /assigned to you, @Roxy/)
    assert.ok(String(hostRequest.messages.at(-1)?.content).includes(findings))
    const returnedMessages = repo.listMessages(roundtrip.id).slice(-2)
    assert.equal(returnedMessages[0].botUsername, 'worker', 'the request keeps its author')
    assert.equal(returnedMessages[1].botUsername, undefined, 'the fix is attributed to Roxy')
    assert.ok(
      returnedMessages[1].parts.some((part) => part.type === 'tool' && part.tool === 'write')
    )
    wakeAutomation()
    assert.equal(requests.length, beforeRoundtrip + 4, 'completion does not call the bot again')

    // Returning work cannot silently upgrade a project pinned to Plan.
    repo.setChatConfig(roundtrip.id, { agentId: 'plan' })
    const planReturn = await runTool(
      'bot_invoke',
      { bot: 'roxy', prompt: 'Assess the remaining review findings.' },
      { cwd: sessionCwd(roundtrip.id), sessionId: roundtrip.id, botId: worker.id }
    )
    assert.ok(planReturn.ok, planReturn.output)
    wakeAutomation()
    const planDeadline = Date.now() + 10000
    while (sessionBusy(roundtrip.id) && Date.now() < planDeadline)
      await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(repo.listQueue(roundtrip.id).length, 0)
    assert.ok(!requests.at(-1)?.tools?.some((tool) => tool.function.name === 'write'))

    // A bot's work elsewhere is retrievable without copying another bot's
    // private chat, executing it again, or changing its standing instructions.
    const memoryBot = bots.createBot('memory-reviewer', 'Review only; never implement fixes.')
    const otherBot = bots.createBot('other-reviewer', 'A different specialist.')
    const memorySession = repo.createChat({
      title: 'Memory source',
      workspacePath: app.getPath('userData')
    })
    for (let i = 0; i < 6; i++) {
      repo.addMessage({
        chatId: memorySession.id,
        role: 'assistant',
        botId: memoryBot.id,
        botUsername: memoryBot.username,
        content: `Finding-${i}: ` + 'x'.repeat(2000)
      })
    }
    repo.addMessage({
      chatId: memorySession.id,
      role: 'assistant',
      botId: otherBot.id,
      botUsername: otherBot.username,
      content: 'OTHER_BOT_PRIVATE_FACT'
    })
    repo.addMessage({ chatId: otherBot.chatId, role: 'user', content: 'OTHER_BOT_PRIVATE_CHAT' })
    repo.addMessage({
      chatId: memoryBot.chatId,
      role: 'assistant',
      botId: memoryBot.id,
      botUsername: memoryBot.username,
      content: 'Own chat stays in its regular history.'
    })
    const recent = bots.botActivity(memoryBot)
    const malformed = repo.addMessage({
      chatId: memorySession.id,
      role: 'assistant',
      botId: memoryBot.id,
      botUsername: memoryBot.username,
      content: 'Malformed old record'
    })
    getDb().prepare('UPDATE messages SET parts = ? WHERE id = ?').run('{broken', malformed.id)
    assert.deepEqual(
      bots.botActivity(memoryBot),
      recent,
      'malformed optional history cannot block a turn'
    )
    assert.ok(
      getDb()
        .prepare('SELECT name FROM sqlite_master WHERE name = ?')
        .get('idx_messages_bot_activity')
    )
    assert.equal(recent.length, 4)
    assert.ok(recent[0].text.startsWith('Finding-5:'))
    assert.ok(
      recent.every((entry) => entry.text.length <= 1000 && entry.sessionId === memorySession.id)
    )
    assert.equal(bots.botActivity(memoryBot, memorySession.id).length, 0)
    assert.ok(!JSON.stringify(recent).includes('OTHER_BOT'))
    bots.updateBot(memoryBot.id, { username: 'renamed-reviewer' })
    assert.deepEqual(
      bots.botActivity(bots.getBot(memoryBot.id)!),
      recent,
      'renames preserve past contributions'
    )
    await runAgentTurn({
      providerId: 'openai',
      model: 'test-bot-model',
      cwd: sessionCwd(memoryBot.chatId),
      chatId: memoryBot.chatId,
      messages: [{ role: 'user', content: 'What did you review recently?' }],
      signal: new AbortController().signal,
      emit: () => {}
    })
    const memorySystem = String(requests.at(-1)!.messages[0].content)
    assert.ok(memorySystem.includes('<your-activity>'))
    assert.ok(memorySystem.includes('Finding-5:'))
    assert.ok(memorySystem.includes(memorySession.id))
    assert.ok(memorySystem.includes(memoryBot.instructions))
    assert.ok(!memorySystem.includes('OTHER_BOT_PRIVATE'))
    const activityBlock = memorySystem.split('<your-activity>')[1].split('</your-activity>')[0]
    assert.ok(activityBlock.length < 6000)
    assert.equal(repo.listQueue(memoryBot.chatId).length, 0)
    const selfRead = await runTool(
      'bot_manage',
      { action: 'read' },
      { ...ctx, botId: memoryBot.id }
    )
    assert.deepEqual(JSON.parse(selfRead.output).activity, recent)
    repo.addMessage({
      chatId: memoryBot.chatId,
      role: 'assistant',
      content: 'HOST_RETURNED_RESULT'
    })
    await runAgentTurn({
      providerId: 'openai',
      model: 'test-bot-model',
      cwd: sessionCwd(memorySession.id),
      chatId: memorySession.id,
      asBotId: memoryBot.id,
      messages: [{ role: 'user', content: 'Hello reviewer' }],
      signal: new AbortController().signal,
      emit: () => {}
    })
    assert.ok(String(requests.at(-1)!.messages[0].content).includes('Roxy: HOST_RETURNED_RESULT'))
    assert.ok(!String(requests.at(-1)!.messages[0].content).includes('You: HOST_RETURNED_RESULT'))

    identityUpdate = { username: 'final-reviewer', instructions: memoryBot.instructions }
    enqueuePrompt(memoryBot.chatId, 'Rename yourself to final-reviewer.')
    wakeAutomation()
    const renameDeadline = Date.now() + 10000
    while (sessionBusy(memoryBot.chatId) && Date.now() < renameDeadline)
      await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(repo.listQueue(memoryBot.chatId).length, 0)
    assert.equal(repo.listMessages(memoryBot.chatId).at(-1)?.botUsername, 'final-reviewer')
    assert.equal(repo.listMessages(memoryBot.chatId).at(-1)?.botId, memoryBot.id)
    const sent = await runTool(
      'session_manage',
      { action: 'send', id: memorySession.id, prompt: 'Review follow-up' },
      { cwd: sessionCwd(memoryBot.chatId), sessionId: memoryBot.chatId, botId: memoryBot.id }
    )
    assert.ok(sent.ok, sent.output)
    assert.equal(repo.listQueue(memorySession.id)[0].botId, memoryBot.id)
    assert.equal(repo.listQueue(memorySession.id)[0].botUsername, 'final-reviewer')
    for (const item of repo.listQueue(memorySession.id)) repo.removeQueueItem(item.id)
    // Delegating from ANOTHER bot's chat: the work is the guest's, so the answer
    // has to come back to the guest. Resuming the chat's owner handed the
    // continuation to a bot that never asked for it, with its identity and config.
    const visitor = bots.createBot('visitor', 'Visit and delegate.')
    const visitorSend = await runTool(
      'session_manage',
      { action: 'send', id: memorySession.id, prompt: 'Guest follow-up' },
      { cwd: sessionCwd(memoryBot.chatId), sessionId: memoryBot.chatId, botId: visitor.id }
    )
    assert.ok(visitorSend.ok, visitorSend.output)
    const guestHandoff = repo.listQueue(memorySession.id).at(-1)!
    assert.equal(guestHandoff.botId, visitor.id, "the request is the guest's, not the owner's")
    wakeAutomation()
    await settle(memorySession.id)
    const guestNudge = repo
      .listQueue(memoryBot.chatId)
      .find((q) => q.content.includes('answered above'))
    assert.ok(guestNudge, 'the delegating actor is nudged to continue')
    assert.equal(guestNudge?.asBotId, visitor.id, 'and it is the guest that resumes, not the owner')
    for (const item of repo.listQueue(memoryBot.chatId)) repo.removeQueueItem(item.id)
    for (const item of repo.listQueue(memorySession.id)) repo.removeQueueItem(item.id)
    bots.removeBot(visitor.id)
    repo.removeChat(memorySession.id)
    assert.equal(
      bots.botActivity(memoryBot).length,
      0,
      'deleted source sessions leave no copied memory'
    )
    // Private user turns stay with their owner, even with stale host/guest fields.
    repo.setChatConfig(memoryBot.chatId, {
      providerId: 'openrouter',
      model: 'guest-model',
      agentId: 'plan',
      reasoningEffort: 'high'
    })
    for (const recipient of ['roxy', worker.id]) {
      const privateUser = enqueuePrompt(memoryBot.chatId, 'Hola @roxy y @worker')
      getDb()
        .prepare('UPDATE queue SET recipient_id = ?, as_bot_id = ? WHERE id = ?')
        .run(recipient, worker.id, privateUser.id)
      wakeAutomation()
      await settle(memoryBot.chatId)
      assert.equal(repo.listQueue(memoryBot.chatId).length, 0)
      assert.ok(String(requests.at(-1)!.messages[0].content).includes('You are @final-reviewer'))
      assert.equal(requests.at(-1)!.model, 'guest-model')
      assert.equal(repo.listMessages(memoryBot.chatId).at(-1)?.botId, memoryBot.id)
    }
    // Only a tool may invite Roxy into that private conversation.
    const hostCall = await runTool(
      'bot_invoke',
      { bot: 'roxy', prompt: 'Answer here.' },
      {
        cwd: sessionCwd(memoryBot.chatId),
        sessionId: memoryBot.chatId,
        botId: memoryBot.id
      }
    )
    assert.ok(hostCall.ok, hostCall.output)
    wakeAutomation()
    const hostDeadline = Date.now() + 10000
    while (sessionBusy(memoryBot.chatId) && Date.now() < hostDeadline)
      await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(repo.listQueue(memoryBot.chatId).length, 0)
    const hostSystem = String(requests.at(-1)!.messages[0].content)
    assert.ok(hostSystem.includes('You are the host.'))
    assert.ok(!hostSystem.includes('You are @final-reviewer'))
    assert.equal(requests.at(-1)!.model, 'test-bot-model', 'private host uses app defaults')
    assert.equal(
      repo.getChat(memoryBot.chatId)?.model,
      'guest-model',
      'host does not overwrite private config'
    )
    // Roxy signs her reply HERE, where an unsigned assistant row already means
    // the bot that owns the chat: unsigned, her answer was drawn under
    // @final-reviewer's name and avatar, live and after a reload.
    const hostReply = repo.listMessages(memoryBot.chatId).at(-1)!
    assert.equal(hostReply.botId, undefined, 'the host has no bot row')
    assert.equal(hostReply.botUsername, HOST_USERNAME, 'and says so explicitly')
    assert.ok(isHostSpeaker(hostReply.botId, hostReply.botUsername))
    enqueuePrompt(memoryBot.chatId, 'Back to the owner')
    wakeAutomation()
    await settle(memoryBot.chatId)
    const ownerReply = repo.listMessages(memoryBot.chatId).at(-1)!
    assert.equal(ownerReply.botId, memoryBot.id, 'while the owner keeps its own name')
    assert.ok(!isHostSpeaker(ownerReply.botId, ownerReply.botUsername))

    // A host returning to a bot's private chat runs on the app defaults, and
    // the global MODE is part of them: resolveSessionConfig never inherits a
    // global agentId, so reusing it answered in Build while the app said Plan.
    repo.setChatConfig(memoryBot.chatId, { agentId: 'build' })
    repo.setActiveAgent('plan')
    const planned = await runTool(
      'bot_invoke',
      { bot: 'roxy', prompt: 'Plan the next step.' },
      { cwd: sessionCwd(memoryBot.chatId), sessionId: memoryBot.chatId, botId: memoryBot.id }
    )
    assert.ok(planned.ok, planned.output)
    wakeAutomation()
    await settle(memoryBot.chatId)
    assert.equal(repo.listQueue(memoryBot.chatId).length, 0)
    assert.ok(
      !requests.at(-1)?.tools?.some((tool) => tool.function.name === 'write'),
      'the global Plan mode reaches a host visiting a bot chat'
    )
    assert.ok(requests.at(-1)?.tools?.some((tool) => tool.function.name === 'read'))
    assert.equal(
      repo.getChat(memoryBot.chatId)?.agentId,
      'build',
      'and the visit does not repin the private chat'
    )
    // The owner still answers in the mode ITS chat is pinned to.
    enqueuePrompt(memoryBot.chatId, 'And now you.')
    wakeAutomation()
    await settle(memoryBot.chatId)
    assert.ok(
      requests.at(-1)?.tools?.some((tool) => tool.function.name === 'write'),
      'the global mode does not leak into the bot that owns the chat'
    )
    repo.setActiveAgent('build')
  } finally {
    stopAutomation()
    setPromptText({})
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
