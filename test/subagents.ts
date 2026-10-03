import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { app, BrowserWindow } from 'electron'
import * as repo from '../src/main/db/repo'
import * as bots from '../src/main/db/bots'
import { closeDb, getDb } from '../src/main/db/database'
import { enqueuePrompt, wakeAutomation, automationSnapshot } from '../src/main/services/automation'
import { claimTurn, resumeQueue, sessionBusy, stopTurn } from '../src/main/services/turn-state'
import {
  listRunningBackgroundJobs,
  cancelSessionBackgroundJobs
} from '../src/main/services/background-tasks'
import {
  cancelSubagentRun,
  listRunningSubagents,
  subagentSnapshot
} from '../src/main/services/subagent-stream'
import { BACKGROUND_TASK_CONTINUATION } from '../src/shared/parallel'
import { runSessionTurn } from '../src/main/services/session-turn'
import { PartsFold, partsToContent } from '../src/shared/parts'
import type { ChatMessage } from '../src/shared/api'
import type { AutomationDelta, SubagentDelta } from '../src/shared/api'
import { CHANNELS } from '../src/shared/ipc'

const temp = mkdtempSync(path.join(tmpdir(), 'roxy-subagents-'))
app.setPath('userData', temp)
process.env.ROXY_TRACK_DISABLE = '1'
process.env.ROXY_SKILLS = '0'
process.env.ROXY_MCP = '0'
app.on('window-all-closed', () => undefined)

interface Request {
  model: string
  messages: ChatMessage[]
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function response(content: string | Record<string, unknown>): Response {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ delta: typeof content === 'string' ? { content } : content }] })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } }
  )
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 5))
  assert.ok(predicate(), label)
}

async function main(): Promise<void> {
  const win = new BrowserWindow({ show: false })
  let terminalEvents = 0
  const terminalErrors: unknown[] = []
  win.webContents.send = (channel: string, payload: AutomationDelta | SubagentDelta): void => {
    if (
      (channel === CHANNELS.automationDelta || channel === CHANNELS.subagentDelta) &&
      payload.kind !== 'event' &&
      payload.state !== 'running'
    ) {
      try {
        assert.ok(payload.message, 'Completed run lost its persisted transcript')
        const message = payload.message
        assert.deepEqual(
          repo.listMessages(message.chatId).find((row) => row.id === message.id),
          JSON.parse(JSON.stringify(message)),
          'terminal events carry exactly the full already-persisted reply'
        )
      } catch (error) {
        terminalErrors.push(error)
      }
      terminalEvents++
    }
  }
  const originalFetch = globalThis.fetch
  let transport: (body: Request, signal?: AbortSignal | null) => Promise<Response>
  globalThis.fetch = (async (url, init) => {
    if (String(url).includes('models.dev'))
      return new Response(
        JSON.stringify({
          openai: {
            models: {
              'parent-model': {
                id: 'parent-model',
                name: 'Parent',
                tool_call: true,
                limit: { context: 128000, output: 4096 }
              },
              'guest-model': {
                id: 'guest-model',
                name: 'Guest',
                tool_call: true,
                limit: { context: 128000, output: 4096 }
              }
            }
          }
        }),
        { headers: { 'content-type': 'application/json' } }
      )
    assert.ok(String(url).includes('subagent-test.invalid'), `Unexpected network: ${url}`)
    return transport(JSON.parse(String(init?.body)), init?.signal)
  }) as typeof fetch
  try {
    const provider = repo.connectProvider({
      id: 'openai',
      apiKey: 'test-only',
      baseURL: 'https://subagent-test.invalid/v1',
      defaultModel: 'parent-model'
    })
    repo.setActiveProvider(provider.id, 'parent-model')
    const guest = bots.createBot(
      'delegate-owner',
      'Finish the assigned request using delegated research.'
    )
    repo.setChatConfig(guest.chatId, {
      providerId: provider.id,
      model: 'guest-model',
      agentId: 'build'
    })

    for (const scenario of [
      'foreground',
      'mid-turn',
      'after-turn',
      'host-private',
      'cancel-child',
      'stop-parent',
      'child-error'
    ] as const) {
      const chat =
        scenario === 'host-private'
          ? repo.getChat(guest.chatId)!
          : repo.createChat({ title: scenario, workspacePath: app.getPath('userData') })
      repo.setChatConfig(chat.id, {
        providerId: provider.id,
        model: scenario === 'host-private' ? 'guest-model' : 'parent-model',
        agentId: 'build'
      })
      const count = scenario === 'after-turn' || scenario === 'foreground' ? 2 : 1
      const children = Array.from({ length: count }, () => deferred<Response>())
      const started = new Set<number>()
      const parentGate = deferred<Response>()
      const parentRequests: Request[] = []
      const childSignals: AbortSignal[] = []
      transport = async (body, signal) => {
        const index = children.findIndex((_child, i) =>
          body.messages.some(
            (message) => message.role === 'user' && message.content === `child-${scenario}-${i}`
          )
        )
        if (index >= 0) {
          if (scenario === 'foreground' && body.messages.at(-1)?.role === 'user')
            return response({
              content: `Research ${index} started.`,
              tool_calls: [
                {
                  index: 0,
                  id: 'inspect',
                  type: 'function',
                  function: {
                    name: 'list',
                    arguments: JSON.stringify({ path: '.' })
                  }
                }
              ]
            })
          started.add(index)
          if (signal) childSignals.push(signal)
          return new Promise<Response>((resolve, reject) => {
            const abort = (): void => reject(new Error('Stopped.'))
            if (signal?.aborted) return abort()
            signal?.addEventListener('abort', abort, { once: true })
            void children[index].promise.then((reply) => {
              signal?.removeEventListener('abort', abort)
              resolve(reply)
            })
          })
        }
        parentRequests.push(body)
        if (parentRequests.length === 1)
          return response({
            tool_calls: children.map((_child, i) => ({
              index: i,
              id: `launch-${scenario}-${i}`,
              type: 'function',
              function: {
                name: 'task',
                arguments: JSON.stringify({
                  description: `Research ${i}`,
                  prompt: `child-${scenario}-${i}`,
                  subagent_type: 'explore',
                  background: scenario !== 'foreground'
                })
              }
            }))
          })
        if (parentRequests.length === 2 && scenario === 'mid-turn') return parentGate.promise
        if (parentRequests.length === 2 && scenario === 'stop-parent')
          return new Promise<Response>((_resolve, reject) => {
            const abort = (): void => reject(new Error('Stopped.'))
            if (signal?.aborted) abort()
            else signal?.addEventListener('abort', abort, { once: true })
          })
        return response(`Parent response ${parentRequests.length}.`)
      }
      enqueuePrompt(
        chat.id,
        `Finish ${scenario}`,
        undefined,
        scenario === 'after-turn'
          ? { sourceChatId: chat.id, asBotId: guest.id, recipientId: guest.id, fromUser: true }
          : scenario === 'host-private'
            ? { sourceChatId: chat.id, recipientId: 'roxy', fromUser: true }
            : {}
      )
      wakeAutomation()
      await waitFor(() => started.size === count, `${scenario}: children started`)
      const subs = listRunningSubagents().filter((run) => run.parentChatId === chat.id)
      assert.equal(subs.length, count)
      const snapshot = automationSnapshot().find((run) => run.sessionId === chat.id)
      if (snapshot) {
        assert.ok(snapshot.sequence > 0)
        assert.equal(
          snapshot.parts.filter((part) => part.type === 'tool' && part.tool === 'task').length,
          count
        )
      }
      assert.ok(subagentSnapshot(subs[0].subChatId))

      if (scenario === 'foreground') {
        assert.equal(parentRequests.length, 1, 'foreground parent waits for the report')
        assert.equal(listRunningBackgroundJobs(chat.id).length, 0)
        assert.ok(snapshot, 'the parent remains live while both delegates work')
        const cards = snapshot.parts.filter((part) => part.type === 'tool' && part.tool === 'task')
        assert.ok(
          cards.every(
            (part) =>
              part.type === 'tool' &&
              part.state === 'running' &&
              part.children?.some(
                (child) => child.type === 'tool' && child.tool === 'list' && child.state === 'done'
              )
          ),
          'both foreground delegates stream nested progress into the parent before completing'
        )
      } else {
        await waitFor(() => parentRequests.length === 2, `${scenario}: parent kept working`)
        assert.equal(listRunningBackgroundJobs(chat.id).length, count)
      }
      if (!['foreground', 'mid-turn', 'stop-parent'].includes(scenario))
        await waitFor(() => !sessionBusy(chat.id), `${scenario}: launching turn settled`)

      if (scenario === 'foreground') {
        children[1].resolve(response('REPORT-foreground-1'))
        const second = subs.find((run) => run.description === 'Research 1')!
        await waitFor(
          () => !listRunningSubagents().some((run) => run.subChatId === second.subChatId),
          'second foreground delegate finished first'
        )
        assert.equal(
          parentRequests.length,
          1,
          'finishing one delegate does not prematurely resume the parent'
        )
        const partial = automationSnapshot().find((run) => run.sessionId === chat.id)!
        const cards = partial.parts.filter((part) => part.type === 'tool' && part.tool === 'task')
        assert.equal(cards[0].type === 'tool' && cards[0].state, 'running')
        assert.equal(cards[1].type === 'tool' && cards[1].state, 'done')
        children[0].resolve(response('REPORT-foreground-0'))
      } else if (scenario === 'cancel-child') {
        assert.ok(cancelSubagentRun(subs[0].subChatId))
      } else if (scenario === 'stop-parent') {
        stopTurn(chat.id)
        cancelSessionBackgroundJobs(chat.id)
      } else {
        if (scenario === 'after-turn') bots.updateBot(guest.id, { username: 'renamed-owner' })
        for (let i = 0; i < children.length; i++)
          children[i].resolve(
            scenario === 'child-error'
              ? new Response(
                  JSON.stringify({
                    error: { message: 'Delegate failed: payment required', type: 'billing_error' }
                  }),
                  { status: 402 }
                )
              : response(`REPORT-${scenario}-${i}`)
          )
      }
      await waitFor(
        () => !listRunningSubagents().some((run) => run.parentChatId === chat.id),
        `${scenario}: children settled`
      )
      await waitFor(
        () => listRunningBackgroundJobs(chat.id).length === 0,
        `${scenario}: background jobs settled`
      )
      if (scenario === 'mid-turn') {
        assert.equal(
          parentRequests.length,
          2,
          'completion does not interrupt an in-flight response'
        )
        assert.equal(
          repo.listQueue(chat.id).length,
          1,
          'no duplicate continuation while parent can consume it'
        )
        parentGate.resolve(response('Independent work finished.'))
      }
      await waitFor(() => !sessionBusy(chat.id), `${scenario}: parent settled`)
      if (scenario === 'foreground' || scenario === 'mid-turn') {
        assert.equal(parentRequests.length, scenario === 'foreground' ? 2 : 3)
        const final = JSON.stringify(parentRequests.at(-1)!.messages)
        for (let i = 0; i < count; i++)
          assert.equal(
            final.split(`REPORT-${scenario}-${i}`).length - 1,
            1,
            'parent gets every report exactly once'
          )
        if (scenario === 'foreground')
          assert.ok(
            final.indexOf('REPORT-foreground-0') < final.indexOf('REPORT-foreground-1'),
            'reverse completion preserves the original tool-result order'
          )
        if (scenario === 'mid-turn')
          assert.ok(
            repo
              .listMessages(chat.id)
              .at(-1)
              ?.content.includes('Independent work finished.\n\nParent response 3.'),
            'mid-response continuation does not join two paragraphs without a boundary'
          )
        assert.equal(repo.listQueue(chat.id).length, 0)
      } else if (scenario === 'cancel-child' || scenario === 'stop-parent') {
        assert.ok(childSignals.every((signal) => signal.aborted))
        assert.ok(!repo.listQueue(chat.id).some((item) => item.state === 'pending'))
        const before = parentRequests.length
        wakeAutomation()
        assert.equal(parentRequests.length, before, 'cancelled work cannot restart the parent')
      } else {
        const pending = repo.listQueue(chat.id)
        assert.equal(pending.length, 1, 'completed siblings coalesce into one continuation')
        assert.equal(pending[0].content, BACKGROUND_TASK_CONTINUATION)
        const recipient = getDb()
          .prepare('SELECT recipient_id FROM queue WHERE id = ?')
          .get(pending[0].id) as { recipient_id: string }
        assert.equal(recipient.recipient_id, scenario === 'after-turn' ? guest.id : 'roxy')
        const reports = repo
          .listMessages(chat.id)
          .filter((message) => message.parts.some((part) => part.type === 'tool' && part.resultFor))
        assert.equal(reports.length, count)
        assert.equal(reports[0].botId, scenario === 'after-turn' ? guest.id : undefined)
        assert.equal(reports[0].botUsername, scenario === 'after-turn' ? 'delegate-owner' : 'roxy')
        assert.ok(
          reports.every((message) =>
            message.parts.some((part) => part.type === 'tool' && part.subChatId && part.children)
          )
        )
        const release = claimTurn(chat.id, new AbortController())!
        wakeAutomation()
        assert.equal(parentRequests.length, 2, 'continuation waits for turn ownership to release')
        release()
        stopTurn(chat.id)
        wakeAutomation()
        assert.equal(
          parentRequests.length,
          2,
          'Stop also blocks a continuation that was already queued'
        )
        resumeQueue(chat.id)
        wakeAutomation()
        await waitFor(
          () => !sessionBusy(chat.id) && parentRequests.length === 3,
          `${scenario}: automatic continuation ran`
        )
        assert.equal(repo.listQueue(chat.id).length, 0)
        assert.equal(
          parentRequests[2].model,
          scenario === 'after-turn' ? 'guest-model' : 'parent-model'
        )
        assert.ok(
          JSON.stringify(parentRequests[2].messages).includes(
            scenario === 'child-error' ? 'Delegate failed' : `REPORT-${scenario}-0`
          )
        )
        assert.equal(
          repo.listMessages(chat.id).filter((message) => message.role === 'user').length,
          1,
          'continuation does not invent another user prompt'
        )
        if (scenario === 'after-turn')
          assert.equal(repo.listMessages(chat.id).at(-1)?.botUsername, 'renamed-owner')
        if (scenario === 'host-private')
          assert.equal(repo.listMessages(chat.id).at(-1)?.botUsername, 'roxy')
      }
      assert.equal(repo.listSubchats(chat.id).length, count, 'completion keeps every child session')
      const childHistory = subs.map((run) => repo.listMessages(run.subChatId))
      assert.ok(
        childHistory.every((messages) => messages.length === 2),
        'each child keeps its prompt and full assistant transcript'
      )
      const parentHistory = repo.listMessages(chat.id)
      transport = async () => response('Later follow-up')
      resumeQueue(chat.id)
      for (const item of repo.listQueue(chat.id)) repo.removeQueueItem(item.id)
      enqueuePrompt(chat.id, 'Follow up without deleting earlier work')
      wakeAutomation()
      await waitFor(() => !sessionBusy(chat.id), `${scenario}: follow-up settled`)
      assert.deepEqual(
        repo.listMessages(chat.id).slice(0, parentHistory.length),
        parentHistory,
        'a follow-up keeps every earlier parent message unchanged'
      )
      for (let i = 0; i < subs.length; i++)
        assert.deepEqual(
          repo.listMessages(subs[i].subChatId),
          childHistory[i],
          'subagent transcripts survive later parent turns'
        )
      for (const item of repo.listQueue(chat.id)) repo.removeQueueItem(item.id)
      console.log(`  OK ${scenario}`)
    }

    for (const mode of ['sequential-batch', 'sequential-chain'] as const) {
      const chat = repo.createChat({ title: mode, workspacePath: temp })
      const children = Array.from({ length: 3 }, () => deferred<Response>())
      const started: number[] = []
      const requests: Request[] = []
      transport = async (body) => {
        const child = children.findIndex((_child, i) =>
          body.messages.some(
            (message) => message.role === 'user' && message.content === `${mode}-child-${i}`
          )
        )
        if (child >= 0) {
          started.push(child)
          return children[child].promise
        }
        requests.push(body)
        const step = requests.length - 1
        const next =
          mode === 'sequential-batch' ? (step === 0 ? [0, 1, 2] : []) : step < 3 ? [step] : []
        if (next.length)
          return response({
            content: `Parent step ${step}.`,
            tool_calls: next.map((i, index) => ({
              index,
              id: `${mode}-call-${i}`,
              type: 'function',
              function: {
                name: 'task',
                arguments: JSON.stringify({
                  description: `Joined task ${i}`,
                  prompt: `${mode}-child-${i}`,
                  subagent_type: 'general',
                  ...(i === 1 ? { background: false } : {})
                })
              }
            }))
          })
        return response('All joined tasks complete.')
      }
      enqueuePrompt(chat.id, 'Complete three sequential tasks in this conversation')
      wakeAutomation()
      for (let i = 0; i < children.length; i++) {
        await waitFor(() => started.length === i + 1, `${mode}: child ${i} started`)
        assert.deepEqual(
          started,
          Array.from({ length: i + 1 }, (_value, index) => index),
          'write-capable tasks start strictly in order'
        )
        assert.equal(
          listRunningSubagents().filter((run) => run.parentChatId === chat.id).length,
          1,
          'only one joined writer is running at a time'
        )
        assert.equal(
          listRunningBackgroundJobs(chat.id).length,
          0,
          'omitted or false background never creates an asynchronous completion job'
        )
        assert.equal(
          requests.length,
          mode === 'sequential-batch' ? 1 : i + 1,
          'the parent cannot take another model step before its requested results arrive'
        )
        children[i].resolve(response(`JOINED-RESULT-${i}`))
      }
      await waitFor(() => !sessionBusy(chat.id), `${mode}: parent finished`)
      assert.equal(requests.length, mode === 'sequential-batch' ? 2 : 4)
      const finalInput = JSON.stringify(requests.at(-1)!.messages)
      for (let i = 0; i < children.length; i++) {
        assert.equal(
          finalInput.split(`JOINED-RESULT-${i}`).length - 1,
          1,
          'each joined output is delivered to the parent exactly once'
        )
      }
      const messages = repo.listMessages(chat.id)
      assert.equal(
        messages.length,
        2,
        'one user prompt and one complete parent reply, not one reply per task'
      )
      assert.equal(
        messages[1].parts.filter((part) => part.type === 'tool' && part.tool === 'task').length,
        3
      )
      assert.ok(
        messages[1].parts.every((part) => part.type !== 'tool' || !part.resultFor),
        'joined tasks never manufacture Background done report rows'
      )
      assert.ok(messages[1].content.endsWith('All joined tasks complete.'))
      assert.equal(
        repo.listSubchats(chat.id).length,
        3,
        'all three full child histories are retained'
      )
      assert.equal(repo.listQueue(chat.id).length, 0, 'no detached follow-up is left behind')
      console.log(`  OK ${mode}: ordered results in one parent reply`)
    }

    for (const boundary of ['before-report', 'after-report', 'trim-window'] as const) {
      const chat = repo.createChat({ title: `Report after ${boundary}`, workspacePath: temp })
      repo.setChatConfig(chat.id, {
        providerId: provider.id,
        model: 'parent-model',
        contextLimit: 16000,
        agentId: 'build'
      })
      const child = deferred<Response>()
      let steps = 0
      let received: Request | undefined
      transport = async (body) => {
        if (body.messages.at(-1)?.content === 'compaction-child') return child.promise
        received = body
        if (++steps === 1)
          return response({
            tool_calls: [
              {
                index: 0,
                id: 'compaction-launch',
                type: 'function',
                function: {
                  name: 'task',
                  arguments: JSON.stringify({
                    description: 'Keep fresh report',
                    prompt: 'compaction-child',
                    subagent_type: 'explore',
                    background: true
                  })
                }
              }
            ]
          })
        return response('Parent complete')
      }
      enqueuePrompt(chat.id, 'Original request')
      wakeAutomation()
      await waitFor(() => !sessionBusy(chat.id), `${boundary}: launch finished`)
      if (boundary === 'before-report') {
        repo.setChatSummary(
          chat.id,
          'Original request summarized',
          repo.listMessages(chat.id).at(-1)!.createdAt
        )
        await new Promise((resolve) => setTimeout(resolve, 2))
      }
      child.resolve(response(`REQUIRED-${boundary}`))
      await waitFor(
        () => !listRunningBackgroundJobs(chat.id).length,
        `${boundary}: report finished`
      )
      if (boundary === 'after-report')
        repo.setChatSummary(
          chat.id,
          'Original request summarized',
          repo.listMessages(chat.id).at(-1)!.createdAt
        )
      if (boundary === 'trim-window')
        repo.addMessage({ chatId: chat.id, role: 'assistant', content: 'x'.repeat(35000) })
      wakeAutomation()
      await waitFor(() => !sessionBusy(chat.id), `${boundary}: resumed`)
      assert.equal(steps, 3)
      const sent = JSON.stringify(received!.messages)
      assert.equal(
        sent.split(`REQUIRED-${boundary}`).length - 1,
        1,
        'a bounded continuation receives its required report exactly once despite compaction or trimming'
      )
      assert.ok(received!.messages.at(-1)?.content.includes(`REQUIRED-${boundary}`))
      console.log(`  OK report survives ${boundary}`)
    }

    const renameChat = repo.createChat({ title: 'Reports across rename', workspacePath: temp })
    const renameBot = bots.createBot('before-rename', 'Use both reports.')
    repo.setChatConfig(renameBot.chatId, {
      providerId: provider.id,
      model: 'parent-model',
      agentId: 'build'
    })
    const renameChildren = [deferred<Response>(), deferred<Response>()]
    let launchIndex = 0
    let renamePhase: 'launch' | 'resume' = 'launch'
    let renamedRequest: Request | undefined
    transport = async (body) => {
      const child = renameChildren.findIndex(
        (_child, i) => body.messages.at(-1)?.content === `rename-child-${i}`
      )
      if (child >= 0) return renameChildren[child].promise
      if (renamePhase === 'resume') {
        renamedRequest = body
        return response('Combined review')
      }
      if (body.messages.at(-1)?.role === 'user') {
        const i = launchIndex++
        return response({
          tool_calls: [
            {
              index: 0,
              id: `rename-launch-${i}`,
              type: 'function',
              function: {
                name: 'task',
                arguments: JSON.stringify({
                  description: `Rename report ${i}`,
                  prompt: `rename-child-${i}`,
                  subagent_type: 'explore',
                  background: true
                })
              }
            }
          ]
        })
      }
      return response('Independent work')
    }
    for (let i = 0; i < 2; i++) {
      enqueuePrompt(renameChat.id, `Start report ${i}`, undefined, {
        sourceChatId: renameChat.id,
        asBotId: renameBot.id,
        recipientId: renameBot.id,
        fromUser: true
      })
      wakeAutomation()
      await waitFor(() => !sessionBusy(renameChat.id), `rename launch ${i} settled`)
      if (i === 0) bots.updateBot(renameBot.id, { username: 'after-rename' })
    }
    for (let i = 0; i < 2; i++) renameChildren[i].resolve(response(`RENAMED-REPORT-${i}`))
    await waitFor(() => !listRunningBackgroundJobs(renameChat.id).length, 'renamed reports settled')
    assert.equal(
      repo.listQueue(renameChat.id).length,
      1,
      'a rename never creates two continuations for the same actor'
    )
    renamePhase = 'resume'
    wakeAutomation()
    await waitFor(() => !sessionBusy(renameChat.id), 'renamed continuation finished')
    for (let i = 0; i < 2; i++)
      assert.equal(
        JSON.stringify(renamedRequest!.messages).split(`RENAMED-REPORT-${i}`).length - 1,
        1
      )
    console.log('  OK renamed actor consumes both reports once')
    // The desktop retains ownership after the harness returns, until the
    // renderer persists its answer. A late result must wait for that release.
    const direct = repo.createChat({
      title: 'Direct desktop turn',
      workspacePath: app.getPath('userData')
    })
    const directChild = deferred<Response>()
    let directSteps = 0
    transport = async (body) => {
      if (body.messages.at(-1)?.content === 'direct-child') return directChild.promise
      if (++directSteps === 1)
        return response({
          tool_calls: [
            {
              index: 0,
              id: 'direct-launch',
              type: 'function',
              function: {
                name: 'task',
                arguments: JSON.stringify({
                  description: 'Direct child',
                  prompt: 'direct-child',
                  subagent_type: 'explore',
                  background: true
                })
              }
            }
          ]
        })
      return response('Direct turn response.')
    }
    const directUser = repo.addMessage({
      chatId: direct.id,
      role: 'user',
      content: 'Finish the direct request'
    })
    const controller = new AbortController()
    const releaseDirect = claimTurn(direct.id, controller)!
    const fold = new PartsFold()
    const directResult = await runSessionTurn(
      {
        requestId: 'direct-test',
        sessionId: direct.id,
        providerId: provider.id,
        model: 'parent-model',
        messages: [{ role: 'user', content: directUser.content }]
      },
      (event) => fold.apply(event),
      controller.signal
    )
    assert.ok(directResult.ok, directResult.error)
    assert.equal(directSteps, 2)
    directChild.resolve(response('DIRECT-REPORT'))
    await waitFor(() => !listRunningBackgroundJobs(direct.id).length, 'direct child settled')
    wakeAutomation()
    assert.equal(
      directSteps,
      2,
      'the queue waits for desktop persistence, not just the harness return'
    )
    repo.addMessage({
      chatId: direct.id,
      role: 'assistant',
      content: partsToContent(fold.parts),
      parts: fold.parts
    })
    releaseDirect()
    wakeAutomation()
    await waitFor(() => !sessionBusy(direct.id), 'direct continuation settled')
    assert.equal(directSteps, 3)
    assert.equal(repo.listQueue(direct.id).length, 0)
    console.log('  OK direct desktop persistence barrier')

    // Continuation nudges reuse an assistant result's id, not an editable user
    // bubble. Queue edits/removal must never overwrite or delete that report.
    const editChat = repo.createChat({ title: 'Edit continuation' })
    const report = repo.addMessage({
      chatId: editChat.id,
      role: 'assistant',
      content: 'Keep this report'
    })
    const editable = enqueuePrompt(editChat.id, BACKGROUND_TASK_CONTINUATION, undefined, {
      sourceChatId: editChat.id,
      recipientId: 'roxy',
      messageId: report.id
    })
    repo.updateQueueItem(editable.id, 'Continue differently')
    assert.deepEqual(
      repo.listMessages(editChat.id),
      [report],
      'editing a nudge preserves the task result'
    )
    repo.removeQueueItem(editable.id)
    assert.deepEqual(
      repo.listMessages(editChat.id),
      [report],
      'removing a nudge preserves the task result'
    )

    for (const tool of ['session_manage', 'bot_invoke'] as const) {
      const parent = repo.createChat({
        title: `General ${tool}`,
        workspacePath: app.getPath('userData')
      })
      const target = repo.createChat({
        title: 'Slow target',
        workspacePath: app.getPath('userData')
      })
      const peer = bots.createBot(`peer-${tool.replace('_', '-')}`, 'Answer the assigned request.')
      const releaseTarget = claimTurn(target.id, new AbortController())!
      let childSteps = 0
      let parentSteps = 0
      transport = async (body) => {
        const child = body.messages.some(
          (message) => message.role === 'user' && message.content === 'general-child'
        )
        if (child && ++childSteps === 1)
          return response({
            tool_calls: [
              {
                index: 0,
                id: 'child-handoff',
                type: 'function',
                function: {
                  name: tool,
                  arguments: JSON.stringify(
                    tool === 'session_manage'
                      ? { action: 'send', id: target.id, prompt: 'Late cross-session answer' }
                      : { bot: peer.id, prompt: 'Late peer answer' }
                  )
                }
              }
            ]
          })
        if (child) return response('Delegated follow-up queued.')
        if (++parentSteps === 1)
          return response({
            tool_calls: [
              {
                index: 0,
                id: 'general-launch',
                type: 'function',
                function: {
                  name: 'task',
                  arguments: JSON.stringify({
                    description: 'General handoff',
                    prompt: 'general-child',
                    subagent_type: 'general'
                  })
                }
              }
            ]
          })
        return response('HANDOFF-ANSWER')
      }
      enqueuePrompt(parent.id, 'Coordinate the general delegate', undefined, {
        sourceChatId: parent.id,
        asBotId: guest.id,
        recipientId: guest.id,
        fromUser: true
      })
      wakeAutomation()
      await waitFor(() => !sessionBusy(parent.id), `${tool}: parent settled`)
      assert.equal(childSteps, 2)
      const completedChild = repo.listSubchats(parent.id)[0]
      assert.ok(completedChild, 'the completed child transcript is retained')
      assert.equal(repo.listMessages(completedChild.id).length, 2)
      // Even explicit deletion of a finished child must not orphan a queued reply.
      repo.removeChat(completedChild.id)
      if (tool === 'session_manage') {
        const request = repo.listQueue(target.id)[0]
        assert.equal(request.replyToChatId, parent.id, 'late reply addresses the durable parent')
        releaseTarget()
        wakeAutomation()
        await waitFor(() => !sessionBusy(target.id), 'target settled')
        const continuation = repo.listQueue(parent.id)[0]
        assert.equal(
          continuation.asBotId,
          guest.id,
          'subagent return resumes its launching guest, not the host'
        )
      } else {
        releaseTarget()
        const handoff = repo.listQueue(parent.id)[0]
        assert.equal(
          handoff.asBotId,
          peer.id,
          'a subagent invites a peer into the main conversation'
        )
        assert.equal(handoff.botId, guest.id)
      }
      wakeAutomation()
      await waitFor(() => !sessionBusy(parent.id), `${tool}: continuation settled`)
      assert.equal(repo.listQueue(parent.id).length, 0)
      assert.equal(
        repo.listMessages(parent.id).at(-1)?.botId,
        tool === 'session_manage' ? guest.id : peer.id
      )
      assert.equal(repo.listMessages(parent.id).at(-1)?.content, 'HANDOFF-ANSWER')
      console.log(`  OK general ${tool} survives explicit child deletion`)
    }
    const retained = repo
      .listChats()
      .filter((chat) => chat.kind === 'sub')
      .map((chat) => ({ chat, messages: repo.listMessages(chat.id) }))
    assert.ok(retained.length > 5, 'completed delegates are present before reopening the database')
    closeDb()
    for (const { chat, messages } of retained) {
      assert.deepEqual(repo.getChat(chat.id), chat, 'completed session survives an app restart')
      assert.deepEqual(
        repo.listMessages(chat.id),
        messages,
        'full child history survives an app restart'
      )
    }
    console.log('  OK completed sessions survive database reopen')
  } finally {
    globalThis.fetch = originalFetch
    win.destroy()
    closeDb()
    await rm(temp, { recursive: true, force: true }).catch(() => {})
  }
  assert.ok(terminalEvents > 20, 'terminal IPC payloads were verified for parent and child runs')
  assert.deepEqual(
    terminalErrors,
    [],
    'every terminal IPC reply was already persisted and complete'
  )
  console.log('SUBAGENT RUNTIME OK')
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
