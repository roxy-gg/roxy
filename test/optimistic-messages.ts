import assert from 'node:assert/strict'
import type { Message } from '../src/shared/types'
import type { MessagePart } from '../src/shared/types'
import type { TaskUpdate } from '../src/shared/api'
import { taskTranscript } from '../src/renderer/src/lib/task-transcript'
import { taskPreview, CHILD_OUTPUT_CAP, MAX_CHILD_PARTS } from '../src/shared/parts'
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

const task: Extract<MessagePart, { type: 'tool' }> = {
  type: 'tool',
  tool: 'task',
  state: 'done',
  callId: 'launch',
  subChatId: 'sub',
  input: { description: 'Research', background: true },
  output: 'Started',
  title: 'Explore: Research'
}
const launch: Message = {
  ...message('launch-row', 1, [task]),
  role: 'assistant',
  botId: 'guest',
  botUsername: 'helper'
}
const progress: MessagePart[] = [
  { type: 'tool', tool: 'read', callId: 'child-read', state: 'running' }
]
const running: TaskUpdate[] = [
  {
    jobId: 'job',
    subChatId: 'sub',
    sessionId: 'chat',
    description: 'Research',
    subagentType: 'explore',
    state: 'running',
    startedAt: 1
  }
]
const active = taskTranscript([launch], null, { sub: progress }, running)
const activeCard = active.messages[0].parts[0] as typeof task
assert.equal(
  activeCard.state,
  'running',
  'a detached task stays visibly running after its parent ends'
)
assert.equal(activeCard.children, progress)
assert.equal(activeCard.subChatId, 'sub', 'the running card retains its per-task cancel target')
assert.equal(active.messages[0].botId, 'guest')
assert.equal(task.state, 'done', 'projection never mutates replayable history')
const live = taskTranscript([], [task], { sub: progress }, running)
assert.equal((live.streaming?.[0] as typeof task).state, 'running')

const finished: Message = {
  ...message('report-row', 3, [
    {
      ...task,
      callId: 'report',
      resultFor: 'launch',
      state: 'done',
      output: 'Final report',
      children: progress
    }
  ]),
  role: 'assistant',
  botId: 'guest',
  botUsername: 'helper'
}
const completed = taskTranscript([launch, finished], null, {})
assert.equal(
  completed.messages.length,
  1,
  'a linked completion replaces the launch, not another assistant bubble'
)
assert.equal((completed.messages[0].parts[0] as typeof task).output, 'Final report')
assert.equal((completed.messages[0].parts[0] as typeof task).title, task.title)
const whileStreaming = taskTranscript([finished], [task], {})
assert.equal(
  whileStreaming.messages.length,
  0,
  'an early report attaches to the still-streaming parent too'
)
assert.equal((whileStreaming.streaming?.[0] as typeof task).output, 'Final report')
assert.equal(
  taskTranscript([finished], null, {}).messages[0],
  finished,
  'a missing launch never hides a report'
)
const legacy = message('legacy', 4, [{ ...task, callId: undefined, subChatId: undefined }])
assert.equal(taskTranscript([legacy], null, {}).messages[0], legacy)
const cancelled = {
  ...finished,
  parts: [{ ...(finished.parts[0] as typeof task), state: 'error' as const, output: 'Cancelled' }]
}
assert.equal(
  (taskTranscript([launch, cancelled], null, {}).messages[0].parts[0] as typeof task).state,
  'error'
)
const capped = taskPreview(
  Array.from({ length: MAX_CHILD_PARTS + 1 }, () => ({
    ...task,
    output: 'x'.repeat(CHILD_OUTPUT_CAP * 4) + 'TAIL'
  }))
)
assert.equal(capped.length, MAX_CHILD_PARTS)
assert.ok((capped[0] as typeof task).output!.length <= CHILD_OUTPUT_CAP + 200)
assert.ok((capped[0] as typeof task).output!.endsWith('TAIL'))
console.log(
  'task transcript: live progress, launch attachment, cancellation, authorship and bounds OK'
)

const settled = taskTranscript([launch, finished], null, {}).messages[0].parts
const unrelatedToken = taskTranscript(
  [launch, finished],
  [{ type: 'text', text: 'unrelated token' }],
  { otherSub: progress },
  running
)
assert.equal(
  unrelatedToken.messages[0].parts,
  settled,
  'unrelated deltas retain settled task layout cache keys'
)
const fork = { ...launch, id: 'fork-row', chatId: 'fork' }
assert.equal(
  taskTranscript([fork], null, { sub: progress }, running).messages[0],
  fork,
  'a fork never inherits running controls for the original conversation'
)
