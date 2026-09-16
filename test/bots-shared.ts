import assert from 'node:assert/strict'
import { botUsername, mentionedBot, nextBotRun, type Bot } from '../src/shared/bots'
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
assert.equal(mentionedBot(' @Reviewer, check this', [bot]), bot)
assert.equal(mentionedBot('Ask @reviewer later', [bot]), undefined)
assert.equal(mentionedBot('@reviewer-other check this', [bot]), undefined)
assert.equal(mentionedBot('@unknown hello', [bot]), undefined)

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
assert.equal(reconstructTurn(reply, 'helper')[0].content, 'Done.')
assert.equal(reconstructTurn(reply, 'reviewer')[0].content, '[@helper]\nDone.')
assert.equal(reconstructTurn(reply)[0].content, '[@helper]\nDone.')
console.log('BOT SHARED OK')
