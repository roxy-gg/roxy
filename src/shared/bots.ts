import { CronExpressionParser } from 'cron-parser'

export type BotSchedule =
  | { kind: 'interval'; minutes: number }
  | { kind: 'cron'; expression: string; timezone: string }
  | { kind: 'timestamps'; timestamps: number[] }

export interface Bot {
  id: string
  username: string
  instructions: string
  chatId: string
  createdAt: number
}

export interface BotJob {
  id: string
  botId: string
  name: string
  prompt: string
  schedule: BotSchedule
  enabled: boolean
  nextRunAt: number | null
  lastRunAt: number | null
  remainingRuns: number | null
  createdAt: number
}

export interface BotJobInput {
  botId: string
  name: string
  prompt: string
  schedule: BotSchedule
  enabled?: boolean
  remainingRuns?: number | null
}

export function botUsername(value: string): string {
  const name = value.trim().replace(/^@/, '').toLowerCase()
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(name) || name === 'roxy') {
    throw new Error(
      'Use 2-32 letters, numbers, underscores or hyphens, starting with a letter. Roxy is reserved.'
    )
  }
  return name
}

/** Only a leading mention addresses a bot; prose about @someone is not a handoff. */
export function mentionedBot(text: string, bots: Bot[]): Bot | undefined {
  const name = /^\s*@([a-z][a-z0-9_-]{1,31})(?=$|[\s,:])/i.exec(text)?.[1].toLowerCase()
  return bots.find((bot) => bot.username === name)
}

/** Strictly after `after`. Missed interval/cron beats coalesce rather than flooding the queue. */
export function nextBotRun(schedule: BotSchedule, after: number): number | null {
  if (!Number.isFinite(after)) throw new Error('Invalid schedule time')
  if (!schedule || typeof schedule !== 'object') throw new Error('A schedule is required')
  switch (schedule.kind) {
    case 'interval':
      if (!Number.isFinite(schedule.minutes) || schedule.minutes < 1 || schedule.minutes > 525600) {
        throw new Error('Interval must be between 1 and 525600 minutes')
      }
      return after + schedule.minutes * 60_000
    case 'cron':
      if (schedule.expression.trim().split(/\s+/).length !== 5) {
        throw new Error('Use a five-field cron expression (minute hour day month weekday)')
      }
      if (!schedule.timezone) throw new Error('A cron timezone is required')
      new Intl.DateTimeFormat('en', { timeZone: schedule.timezone }).format(after)
      return CronExpressionParser.parse(schedule.expression, {
        currentDate: after,
        tz: schedule.timezone
      })
        .next()
        .getTime()
    case 'timestamps': {
      if (
        !Array.isArray(schedule.timestamps) ||
        !schedule.timestamps.length ||
        schedule.timestamps.some((time) => !Number.isSafeInteger(time) || time <= 0)
      ) {
        throw new Error('Provide at least one valid timestamp in epoch milliseconds')
      }
      return (
        [...new Set(schedule.timestamps)].sort((a, b) => a - b).find((time) => time > after) ?? null
      )
    }
    default:
      throw new Error('Unknown schedule kind')
  }
}
