import assert from 'node:assert/strict'
import { botUsername, nextBotRun, type Bot } from '../src/shared/bots'
import { MENTION, isKnownMention } from '../src/shared/mentions'
import { reconstructTurn } from '../src/shared/tool-history'
import type { Message } from '../src/shared/types'

const bot: Bot = {
  id: 'bot-1',
  username: 'reviewer',
  instructions: '',
  chatId: 'chat-1',
  createdAt: 0
}
assert.equal(botUsername(' @Reviewer '), 'reviewer')
for (const name of ['roxy', 'x', '1bot', 'bad name', 'a'.repeat(33)]) {
  assert.throws(() => botUsername(name))
}
for (const text of [
  ' @Reviewer, check this',
  'Hola @reviewer',
  'Buenos dias, @reviewer!',
  '@reviewer hola',
  'Necesito ayuda, @reviewer.',
  'Hey\n@reviewer: revisa esto',
  '\u00bf@reviewer estas?',
  'Hola,@reviewer',
  '(@reviewer)',
  'Bonjour @reviewer',
  'Ask @reviewer later',
  '@reviewer y @REVIEWER'
])
  assert.ok(
    [...text.matchAll(MENTION)].some((match) => isKnownMention(match[0], [bot.username])),
    text
  )
for (const text of [
  'Hola',
  'reviewer',
  'user@reviewer.com',
  'https://example.com/@reviewer',
  '@modelcontextprotocol/sdk',
  '@reviewer/sdk',
  '@reviewer-other',
  '@reviewer_other',
  '@unknown',
  '@reviewer.example',
  '@' + 'a'.repeat(40)
])
  assert.ok(
    ![...text.matchAll(MENTION)].some((match) => isKnownMention(match[0], [bot.username])),
    text
  )
assert.equal(isKnownMention('@ROXY', []), true)
assert.equal(isKnownMention('@reviewer', []), false)

const now = Date.parse('2026-09-08T12:00:00Z')
assert.equal(nextBotRun({ kind: 'interval', minutes: 5 }, now), now + 300_000)
for (const minutes of [0, -1, NaN, Infinity, 525601]) {
  assert.throws(() => nextBotRun({ kind: 'interval', minutes }, now))
}
assert.equal(
  nextBotRun({ kind: 'cron', expression: '*/15 * * * *', timezone: 'UTC' }, now),
  now + 900_000
)
assert.equal(
  nextBotRun({ kind: 'cron', expression: '0 9 * * *', timezone: 'America/New_York' }, now),
  now + 3_600_000
)
assert.throws(() => nextBotRun({ kind: 'cron', expression: '* * * * * *', timezone: 'UTC' }, now))
assert.throws(() =>
  nextBotRun({ kind: 'cron', expression: '* * * * *', timezone: 'Not/A_Zone' }, now)
)
assert.equal(
  nextBotRun({ kind: 'timestamps', timestamps: [now + 2000, now, now + 1000, now + 1000] }, now),
  now + 1000
)
assert.equal(nextBotRun({ kind: 'timestamps', timestamps: [now] }, now), null)
assert.throws(() => nextBotRun({ kind: 'timestamps', timestamps: [] }, now))
assert.throws(() => nextBotRun({ kind: 'timestamps', timestamps: [NaN] }, now))
// A speaker marker labels OTHER voices. Marking a bot's own past replies taught
// it to type the tag itself, and to answer its own words as a colleague's - so the
// rebuild has to be told who is about to speak, which for a guest invited into
// a shared session is not the bot that owns that session.
const reply: Message = {
  id: 'm1',
  chatId: 'chat-1',
  role: 'assistant',
  content: 'Done.',
  parts: [{ type: 'text', text: 'Done.' }],
  createdAt: 1,
  botUsername: 'helper'
}
assert.equal(reconstructTurn(reply, { id: 'helper-id', username: 'helper' })[0].content, 'Done.')
assert.equal(reconstructTurn(reply, bot)[0].content, '[@helper]\nDone.')
assert.equal(reconstructTurn(reply)[0].content, '[@helper]\nDone.')
const renamed = { ...reply, botId: bot.id }
assert.equal(reconstructTurn(renamed, bot)[0].content, 'Done.')
assert.equal(reconstructTurn(renamed, bot)[0].role, 'assistant')
assert.equal(reconstructTurn({ ...reply, role: 'user' }, bot)[0].content, '[@helper]\nDone.')
const host: Message = {
  ...reply,
  botUsername: undefined,
  parts: [
    { type: 'text', text: 'I am Roxy.' },
    {
      type: 'tool',
      tool: 'write',
      callId: 'host-write',
      input: { path: 'file' },
      state: 'done',
      output: 'Written.'
    },
    { type: 'text', text: 'Now ask the reviewer.' }
  ]
}
const other = reconstructTurn(host, bot)
assert.equal(other.length, 1)
assert.equal(other[0].role, 'user')
assert.match(other[0].content, /^\[@Roxy\]/)
assert.ok(other[0].content.includes('Written.'))
assert.ok(!other[0].toolCalls)
assert.ok(
  reconstructTurn(host).some((turn) => turn.toolCalls?.length),
  'Roxy retains its own native tool history'
)
console.log('BOT SHARED OK')
