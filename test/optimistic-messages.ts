import assert from 'node:assert/strict'
import type { Message } from '../src/shared/types'
import {
  remainingOptimisticMessages,
  visibleMessages,
  visibleQueue
} from '../src/renderer/src/lib/optimistic-messages'

const message = (id: string, createdAt: number, parts: Message['parts'] = []): Message => ({
  id,
  chatId: 'chat',
  role: 'user',
  content: '',
  parts,
  createdAt
})
const history = [message('old', 1)]
const pending = message('pending', 3, [
  { type: 'image', dataUrl: 'data:image/png;base64,AA==', mediaType: 'image/png', name: 'a.png' }
])
assert.deepEqual(
  visibleMessages(history, [pending]).map((m) => m.id),
  ['old', 'pending']
)
assert.deepEqual(visibleMessages(history, [pending])[1].parts, pending.parts)
assert.equal(visibleMessages(history, undefined), history)

// An old list response cannot hide a pending or already-acknowledged write.
const canonical = message('saved', 2, pending.parts)
assert.deepEqual(remainingOptimisticMessages(history, [canonical]), [canonical])
assert.deepEqual(
  visibleMessages(history, [canonical]).map((m) => m.id),
  ['old', 'saved']
)
assert.deepEqual(remainingOptimisticMessages([...history, canonical], [canonical]), [])
assert.deepEqual(
  visibleMessages([...history, canonical], [canonical]).map((m) => m.id),
  ['old', 'saved']
)

// Concurrent writes and assistant responses stay chronological, even if a stale
// list resolves after a later turn was persisted.
const later = message('later', 5)
assert.deepEqual(
  visibleMessages([history[0], message('assistant', 4)], [canonical, later]).map((m) => m.id),
  ['old', 'saved', 'assistant', 'later']
)
assert.deepEqual(remainingOptimisticMessages(history, [canonical, later]), [canonical, later])
const queued = {
  id: 'queue-id',
  chatId: 'chat',
  content: '',
  createdAt: 4,
  state: 'pending' as const,
  images: [{ dataUrl: 'data:image/png;base64,AA==', mediaType: 'image/png', name: 'a.png' }]
}
assert.deepEqual(visibleQueue([], [queued]), [queued])
assert.deepEqual(visibleQueue([queued], [queued]), [queued])
assert.equal(visibleQueue([queued], undefined)[0], queued)
console.log('optimistic messages: merge, attachments, stale loads, order and dedup OK')
