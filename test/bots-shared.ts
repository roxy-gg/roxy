import assert from 'node:assert/strict'
import { botUsername, mentionedBot, nextBotRun, type Bot } from '../src/shared/bots'

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
console.log('BOT SHARED OK')
