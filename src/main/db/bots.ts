import { randomUUID } from 'node:crypto'
import { botUsername, nextBotRun, type Bot, type BotJob, type BotJobInput } from '../../shared/bots'
import { getDb } from './database'
import * as repo from './repo'

const BOT_COLUMNS = 'id, username, instructions, chat_id AS chatId, created_at AS createdAt'
const JOB_COLUMNS = `id, bot_id AS botId, name, prompt, schedule, enabled,
  next_run_at AS nextRunAt, last_run_at AS lastRunAt, remaining_runs AS remainingRuns, created_at AS createdAt`

export function listBots(): Bot[] {
  return getDb().prepare(`SELECT ${BOT_COLUMNS} FROM bots ORDER BY created_at, id`).all() as Bot[]
}

export function getBot(id: string): Bot | undefined {
  return getDb()
    .prepare(`SELECT ${BOT_COLUMNS} FROM bots WHERE id = ? OR username = ?`)
    .get(id, id.replace(/^@/, '')) as Bot | undefined
}

export function chatBot(chatId: string): Bot | undefined {
  return getDb().prepare(`SELECT ${BOT_COLUMNS} FROM bots WHERE chat_id = ?`).get(chatId) as
    | Bot
    | undefined
}

/** Recent contributions, not a second transcript or evidence of task completion. */
export function botActivity(
  bot: Bot,
  currentChatId = bot.chatId
): {
  sessionId: string
  title: string
  messageId: string
  createdAt: number
  text: string
}[] {
  return getDb()
    .prepare(
      `SELECT m.chat_id AS sessionId, substr(c.title, 1, 120) AS title,
        m.id AS messageId, m.created_at AS createdAt,
        substr((SELECT group_concat(json_extract(p.value, '$.text'), char(10))
          FROM json_each(CASE WHEN json_valid(m.parts) THEN m.parts ELSE '[]' END) p WHERE json_extract(p.value, '$.type') = 'text'), 1, 1000) AS text
       FROM messages m JOIN chats c ON c.id = m.chat_id
       WHERE m.bot_id = ? AND m.role = 'assistant' AND m.chat_id != ? AND m.chat_id != ?
         AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(m.parts) THEN m.parts ELSE '[]' END) p
           WHERE json_extract(p.value, '$.type') = 'text'
             AND length(trim(json_extract(p.value, '$.text'))) > 0)
       ORDER BY m.created_at DESC, m.rowid DESC LIMIT 4`
    )
    .all(bot.id, bot.chatId, currentChatId) as ReturnType<typeof botActivity>
}

/**
 * A free handle, so a bot can exist BEFORE it has a name.
 *
 * Naming was the one thing creation demanded up front, and it is the thing a
 * user can least answer before talking to the bot: the name usually falls out
 * of the role ("you are Creators"). So a nameless bot opens as `bot`, `bot-2`,
 * ... and renames itself once the conversation says who it is.
 */
function freeUsername(): string {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? 'bot' : `bot-${n}`
    if (!getBot(candidate)) return candidate
  }
}

export function createBot(username = '', instructions = ''): Bot {
  if (typeof username !== 'string' || typeof instructions !== 'string')
    throw new Error('Bot username and instructions must be text')
  username = username.trim() ? botUsername(username) : freeUsername()
  if (getBot(username)) throw new Error('That bot username is already taken')
  return getDb().transaction(() => {
    const chat = repo.createChat({ title: username, kind: 'bot' })
    const bot: Bot = {
      id: randomUUID(),
      username,
      instructions,
      chatId: chat.id,
      createdAt: Date.now()
    }
    getDb()
      .prepare(
        'INSERT INTO bots(id, username, instructions, chat_id, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(bot.id, bot.username, bot.instructions, bot.chatId, bot.createdAt)
    return bot
  })()
}

export function updateBot(id: string, patch: { username?: string; instructions?: string }): Bot {
  const bot = getBot(id)
  if (!bot) throw new Error('Bot not found')
  const username = patch.username === undefined ? bot.username : botUsername(patch.username)
  const other = getBot(username)
  if (other && other.id !== bot.id) throw new Error('That bot username is already taken')
  if (patch.instructions !== undefined && typeof patch.instructions !== 'string')
    throw new Error('Instructions must be text')
  return getDb().transaction(() => {
    getDb()
      .prepare('UPDATE bots SET username = ?, instructions = ? WHERE id = ?')
      .run(username, patch.instructions ?? bot.instructions, bot.id)
    if (username !== bot.username) repo.renameChat(bot.chatId, username)
    return getBot(bot.id)!
  })()
}

export function removeBot(id: string): void {
  const bot = getBot(id)
  if (!bot) throw new Error('Bot not found')
  repo.removeChat(bot.chatId)
}

export function listJobs(botId?: string): BotJob[] {
  const rows = (
    botId
      ? getDb()
          .prepare(`SELECT ${JOB_COLUMNS} FROM bot_jobs WHERE bot_id = ? ORDER BY created_at, id`)
          .all(botId)
      : getDb().prepare(`SELECT ${JOB_COLUMNS} FROM bot_jobs ORDER BY created_at, id`).all()
  ) as (Omit<BotJob, 'schedule' | 'enabled'> & { schedule: string; enabled: number })[]
  return rows.map((row) => ({ ...row, schedule: JSON.parse(row.schedule), enabled: !!row.enabled }))
}

export function saveJob(input: BotJobInput, id?: string): BotJob {
  const bot = getBot(input.botId)
  if (!bot) throw new Error('Bot not found')
  const old = id ? listJobs(bot.id).find((job) => job.id === id) : undefined
  if (id && !old) throw new Error('Schedule not found for this bot')
  if (!input.name?.trim() || !input.prompt?.trim())
    throw new Error('A schedule needs a name and prompt')
  const remainingRuns =
    input.remainingRuns === undefined ? (old?.remainingRuns ?? null) : input.remainingRuns
  if (
    remainingRuns !== null &&
    (!Number.isSafeInteger(remainingRuns) ||
      remainingRuns < 0 ||
      (remainingRuns === 0 && input.enabled !== false))
  ) {
    throw new Error('Run count must be a positive whole number, or null for unlimited')
  }
  const now = Date.now()
  const enabled = input.enabled ?? old?.enabled ?? true
  const computedNext = nextBotRun(input.schedule, now)
  const next =
    old?.enabled && enabled && JSON.stringify(old.schedule) === JSON.stringify(input.schedule)
      ? old.nextRunAt
      : computedNext
  if (enabled && next === null) throw new Error('This schedule has no future runs')
  const job: BotJob = {
    id: id ?? randomUUID(),
    botId: bot.id,
    name: input.name.trim(),
    prompt: input.prompt,
    schedule: input.schedule,
    enabled,
    nextRunAt: next,
    lastRunAt: old?.lastRunAt ?? null,
    remainingRuns,
    createdAt: old?.createdAt ?? now
  }
  getDb()
    .prepare(
      `INSERT INTO bot_jobs(id, bot_id, name, prompt, schedule, enabled, next_run_at, last_run_at, remaining_runs, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, prompt = excluded.prompt, schedule = excluded.schedule,
      enabled = excluded.enabled, next_run_at = excluded.next_run_at, remaining_runs = excluded.remaining_runs`
    )
    .run(
      job.id,
      job.botId,
      job.name,
      job.prompt,
      JSON.stringify(job.schedule),
      Number(job.enabled),
      job.nextRunAt,
      job.lastRunAt,
      job.remainingRuns,
      job.createdAt
    )
  return job
}

export function removeJob(id: string): void {
  getDb().transaction(() => {
    getDb().prepare(`DELETE FROM queue WHERE schedule_id = ? AND state = 'pending'`).run(id)
    getDb().prepare('DELETE FROM bot_jobs WHERE id = ?').run(id)
  })()
}

/** Advance and enqueue in one transaction: a crash cannot consume a beat without a delivery. */
export function enqueueDueJobs(now = Date.now()): string[] {
  return getDb().transaction(() => {
    const chats = new Set<string>()
    for (const job of listJobs()) {
      if (!job.enabled || job.nextRunAt === null || job.nextRunAt > now) continue
      const bot = getBot(job.botId)
      if (!bot) continue
      const queued = getDb()
        .prepare('SELECT COUNT(*) AS n FROM queue WHERE chat_id = ?')
        .get(bot.chatId) as { n: number }
      if (queued.n >= 100) continue
      const next = nextBotRun(
        job.schedule,
        job.schedule.kind === 'timestamps' ? job.nextRunAt : now
      )
      const remaining = job.remainingRuns === null ? null : job.remainingRuns - 1
      const item = repo.enqueue(bot.chatId, job.prompt)
      getDb().prepare('UPDATE queue SET schedule_id = ? WHERE id = ?').run(job.id, item.id)
      getDb()
        .prepare(
          'UPDATE bot_jobs SET last_run_at = ?, next_run_at = ?, remaining_runs = ?, enabled = ? WHERE id = ?'
        )
        .run(now, next, remaining, Number(next !== null && remaining !== 0), job.id)
      chats.add(bot.chatId)
    }
    return [...chats]
  })()
}
