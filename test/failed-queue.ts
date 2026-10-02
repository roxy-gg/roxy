import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import { getDb, closeDb } from '../src/main/db/database'
import * as repo from '../src/main/db/repo'
import {
  enqueuePrompt,
  wakeAutomation,
  resolveQueueBlocker,
  notifyAutomation
} from '../src/main/services/automation'
import { sessionBusy, stopTurn } from '../src/main/services/turn-state'
import { invokeChip } from '../src/renderer/src/canvas/invoke-status'
import { queueBlocker } from '../src/shared/queue'

app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'roxy-failed-queue-')))
app.whenReady().then(async () => {
  const originalFetch = globalThis.fetch
  try {
    let calls = 0
    let hold = false
    globalThis.fetch = (async (_url, init) => {
      if (!init?.body)
        return new Response(JSON.stringify({ data: [{ id: 'queue-model' }] }), {
          headers: { 'content-type': 'application/json' }
        })
      calls++
      if (hold)
        return new Promise((_resolve, reject) =>
          init.signal?.addEventListener('abort', () => reject(new Error('Stopped.')), {
            once: true
          })
        )
      return new Response(
        'data: ' +
          JSON.stringify({
            choices: [{ delta: { content: 'Task complete' }, finish_reason: null }]
          }) +
          '\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } }
      )
    }) as typeof fetch
    const provider = repo.connectProvider({
      id: 'openai',
      apiKey: 'fixture-only',
      baseURL: 'https://queue-test.invalid/v1',
      defaultModel: 'queue-model'
    })
    repo.setActiveProvider(provider.id, 'queue-model')
    const source = repo.createChat({ title: 'Source' })
    const destination = repo.createChat({ title: 'Destination' })
    const a = enqueuePrompt(destination.id, 'A: interrupted task', undefined, {
      sourceChatId: source.id
    })
    // Deterministically reproduce the persisted result of an interrupted delivery.
    getDb().prepare("UPDATE queue SET state = 'failed', error = 'Stopped.' WHERE id = ?").run(a.id)
    const b = enqueuePrompt(destination.id, 'B: next task', undefined, {
      sourceChatId: source.id
    })
    assert.equal(b.delivery, 'waiting_behind_failure')
    assert.equal(b.blockedBy, a.id)
    wakeAutomation()
    wakeAutomation()
    const queue = repo.listQueue(destination.id)
    assert.equal(queue.find((item) => item.id === b.id)?.state, 'pending')
    assert.equal(queue[0].id, a.id)
    assert.equal(
      queueBlocker(queue)?.id,
      a.id,
      'Failed cross-session head must be exposed by the chat banner contract'
    )
    const receipt = repo.addMessage({
      chatId: source.id,
      role: 'assistant',
      content: '',
      parts: [
        {
          type: 'tool',
          callId: 'send-b',
          tool: 'session_manage',
          state: 'done',
          input: { action: 'send', id: destination.id },
          output: JSON.stringify(b)
        }
      ]
    })
    const tool = (): Extract<(typeof receipt.parts)[number], { type: 'tool' }> =>
      repo.listMessages(source.id).find((m) => m.id === receipt.id)!.parts[0] as Extract<
        (typeof receipt.parts)[number],
        { type: 'tool' }
      >
    notifyAutomation(destination.id)
    assert.equal(invokeChip(tool(), []).kind, 'blocked')
    const idle = async (): Promise<void> => {
      const deadline = Date.now() + 10000
      while (sessionBusy(destination.id) && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 10))
      assert.ok(!sessionBusy(destination.id), 'delivery did not settle')
    }
    stopTurn(destination.id)
    resolveQueueBlocker(a.id, 'discard')
    resolveQueueBlocker(a.id, 'discard')
    wakeAutomation()
    await idle()
    assert.equal(calls, 1, 'Discard must deliver B exactly once despite repeated wake/discard')
    assert.equal(repo.listQueue(destination.id).length, 0)
    assert.equal(repo.listMessages(destination.id).filter((m) => m.content === b.content).length, 1)
    assert.equal(invokeChip(tool(), []).kind, 'replied', 'completion requires explicit receipt')
    const retry = enqueuePrompt(destination.id, 'C: cancelled task', undefined, {
      sourceChatId: source.id
    })
    hold = true
    wakeAutomation()
    const deadline = Date.now() + 10000
    while (calls < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
    stopTurn(destination.id)
    await idle()
    assert.equal(repo.listQueue(destination.id)[0].state, 'cancelled')
    assert.equal(queueBlocker(repo.listQueue(destination.id))?.id, retry.id)
    assert.equal(repo.queueRetryRisk(retry.id), undefined, 'own partial work is not newer work')
    repo.addMessage({ chatId: destination.id, role: 'user', content: 'Newer work' })
    const token = repo.queueRetryRisk(retry.id)!
    assert.ok(token)
    assert.throws(() => resolveQueueBlocker(retry.id, 'retry'), /Later work/)
    assert.throws(() => repo.updateQueueItem(retry.id, retry.content), /Later work/)
    repo.addMessage({ chatId: destination.id, role: 'assistant', content: 'Newer answer' })
    assert.throws(() => resolveQueueBlocker(retry.id, 'retry', token), /Later work/)
    hold = false
    resolveQueueBlocker(retry.id, 'retry', repo.queueRetryRisk(retry.id))
    assert.throws(() => resolveQueueBlocker(retry.id, 'retry'), /no longer blocked/)
    wakeAutomation()
    await idle()
    assert.equal(calls, 3, 'Retry reexecutes once')
    assert.equal(
      repo.listMessages(destination.id).filter((m) => m.content === retry.content).length,
      1,
      'Retry must not duplicate prompt payload'
    )
    assert.equal(repo.listQueue(destination.id).length, 0)
    globalThis.fetch = originalFetch
    console.log('FAILED QUEUE REGRESSION OK')
    closeDb()
    app.exit(0)
  } catch (error) {
    globalThis.fetch = originalFetch
    console.error(error)
    closeDb()
    app.exit(1)
  }
})
