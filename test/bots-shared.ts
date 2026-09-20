import assert from 'node:assert/strict'
import { HOST_USERNAME, botUsername, isHostSpeaker, nextBotRun, type Bot } from '../src/shared/bots'
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
  chatId: 'shared-1',
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
// The host answering inside a BOT's chat signs her rows, because there an
// unsigned assistant row already means "the bot that owns this chat".
assert.ok(isHostSpeaker(undefined, HOST_USERNAME))
assert.ok(isHostSpeaker(undefined, undefined) === false, 'unsigned is not a claim of authorship')
assert.ok(!isHostSpeaker('bot-1', HOST_USERNAME), 'a real bot row is never the host')
assert.throws(() => botUsername(HOST_USERNAME), 'the handle stays reserved')

const signedHost: Message = { ...host, chatId: bot.chatId, botUsername: HOST_USERNAME }
// To a bot, a signed host turn is still someone else talking - and is labelled
// Roxy, not @roxy, so it cannot be mistaken for a bot in the roster.
const seenByBot = reconstructTurn(signedHost, bot)
assert.equal(seenByBot.length, 1)
assert.equal(seenByBot[0].role, 'user')
assert.match(seenByBot[0].content, /^\[@Roxy\]\n/)
// To Roxy herself, it is her OWN history: replaying it as a foreign block would
// strip the tool calls she made in that chat and make her read her words as a
// colleague's.
assert.ok(
  reconstructTurn(signedHost).some((turn) => turn.toolCalls?.length),
  'the host replays her signed turn as her own'
)
assert.equal(reconstructTurn(signedHost)[0].role, 'assistant')

// Authorship was only written down once a chat could have more than one speaker.
// Every reply a bot gave before that is unsigned, and it is still ITS OWN: read
// as the host's, a bot's history came back as "[@Roxy]" quotes with the tool
// calls stripped out, so it answered its own past work as a colleague's.
const legacy: Message = {
  ...host,
  chatId: bot.chatId,
  botId: undefined,
  botUsername: undefined
}
const seenByOwner = reconstructTurn(legacy, bot)
assert.equal(seenByOwner[0].role, 'assistant', "an unsigned row in the bot's own chat is its own")
assert.ok(
  seenByOwner.some((turn) => turn.toolCalls?.length),
  'and keeps the native tool history that a foreign block would flatten'
)
assert.ok(!seenByOwner[0].content.startsWith('[@'), 'so it is never quoted back at itself')
// Elsewhere the same unsigned row is the host talking, and stays foreign.
assert.match(
  reconstructTurn({ ...legacy, chatId: 'someone-else' }, bot)[0].content,
  /^\[@Roxy\]/,
  'an unsigned row in a SHARED session is still the host'
)
// A signed row wins over the chat it sits in: renames and guests both rely on it.
assert.match(
  reconstructTurn({ ...legacy, botUsername: 'other' }, bot)[0].content,
  /^\[@other\]/,
  'an explicit author is never overridden by the chat'
)

console.log('BOT SHARED OK')
