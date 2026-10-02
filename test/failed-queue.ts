import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import { getDb, closeDb } from '../src/main/db/database'
import * as repo from '../src/main/db/repo'
import { enqueuePrompt, wakeAutomation } from '../src/main/services/automation'
import { queueBlocker } from '../src/shared/queue'

app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'roxy-failed-queue-')))
app.whenReady().then(() => {
  try {
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
    console.log('FAILED QUEUE REGRESSION OK')
    closeDb()
    app.exit(0)
  } catch (error) {
    console.error(error)
    closeDb()
    app.exit(1)
  }
})
