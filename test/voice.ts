import assert from 'node:assert/strict'
import { DEFAULT_VOICE, VOICE_MODELS, mergeVoiceDraft, normalizeVoice } from '../src/shared/voice'

for (const value of [
  undefined,
  null,
  false,
  '',
  {},
  { enabled: 'true' },
  { enabled: 1 },
  { enabled: true },
  { enabled: true, modelId: '../../model' }
]) {
  assert.equal(normalizeVoice(value).enabled, false)
}
assert.deepEqual(normalizeVoice(null), DEFAULT_VOICE)
assert.deepEqual(normalizeVoice({ hotkeys: [' Ctrl+Space ', 42, 'ignored'] }).hotkeys, [
  'Ctrl+Space',
  ''
])
assert.equal(normalizeVoice({ modelId: '../../model' }).modelId, null)
assert.equal(
  normalizeVoice({ microphone: { id: 'a', name: 'b', occurrence: -1 } }).microphone,
  null
)
assert.equal(
  normalizeVoice({ microphone: { id: 'a', name: 'b', occurrence: 1 } }).microphone?.id,
  'a'
)
assert.equal(normalizeVoice({ enabled: true, modelId: VOICE_MODELS[0].id }).enabled, true)
assert.equal(VOICE_MODELS.length, 2)
assert.deepEqual(
  VOICE_MODELS.map((model) => model.id),
  ['nemotron-streaming-3.5', 'parakeet-unified-en-streaming']
)
for (const model of VOICE_MODELS) {
  assert.match(model.id, /streaming/)
  assert.match(model.revision, /^[a-f0-9]{40}$/)
  assert.equal(model.files.length, 4)
  for (const file of model.files) {
    assert.match(file.sha256, /^[a-f0-9]{64}$/)
    assert(file.bytes > 0)
    assert(!file.name.includes('/'))
  }
}

let current = 'Existing draft'
const range = { start: current.length, text: '' }
for (const snapshot of ['hello', 'hello world', 'hello', 'hello world.']) {
  const result = mergeVoiceDraft(current, range, snapshot)!
  assert(result)
  current = result.value
  range.text = result.text
}
assert.equal(current, 'Existing draft hello world.')
assert.equal(
  mergeVoiceDraft(current + ' typed after', range, 'new words')?.value,
  'Existing draft new words typed after'
)
assert.equal(mergeVoiceDraft('Existing draft changed by user', range, 'replacement'), null)
assert.deepEqual(mergeVoiceDraft('', { start: 0, text: '' }, 'hello'), {
  value: 'hello',
  text: 'hello'
})
assert.equal(
  mergeVoiceDraft('before after', { start: 7, text: '' }, 'voice')?.value,
  'before voice after'
)
assert.equal(
  mergeVoiceDraft('hello voice after', { start: 6, text: 'voice ' }, '')?.value,
  'hello after'
)
assert.equal(
  mergeVoiceDraft('draft ', { start: 6, text: '' }, '\u4f60\u597d')?.value,
  'draft \u4f60\u597d'
)
assert.equal(mergeVoiceDraft('short', { start: 99, text: '' }, 'voice'), null)
console.log(
  'VOICE OK: default-off normalization, streaming catalog, revision snapshots, range conflicts and Unicode'
)
