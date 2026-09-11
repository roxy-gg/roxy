import type { ToolResult } from '../../shared/types'
import type { BotJobInput } from '../../shared/bots'
import type { ToolContext } from './tools'
import * as bots from '../db/bots'
import * as repo from '../db/repo'
import { getDb } from '../db/database'
import { enqueuePrompt, notifyAutomation, notifyBots } from '../services/automation'
import { claimTurn, sessionBusy, stopTurn, resumeQueue } from '../services/turn-state'
import { emitSessionsUpdated } from '../services/session-events'
import { cancelSessionBackgroundJobs } from '../services/background-tasks'
import { endSubagentRuns } from '../services/subagent-stream'
import { killSessionBackground } from './tools'
import { disposeSession } from '../services/browser'
import { removeWorktreeForChat } from '../services/worktree'

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

export async function runBotTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const action = text(input.action)
  const id = text(input.id)
  const source = ctx.sessionId
  const running = source
    ? (getDb()
        .prepare(`SELECT hops FROM queue WHERE chat_id = ? AND state = 'running'`)
        .get(repo.rootSessionId(source)) as { hops: number } | undefined)
    : undefined
  const hops = (running?.hops ?? 0) + 1
  let result: unknown
  switch (name) {
    case 'project_list':
      result = repo.listProjectOrder().map((path) => ({
        path,
        sessions: repo.listChats().filter((c) => c.kind === 'main' && c.workspacePath === path)
          .length
      }))
      break
    case 'bot_manage': {
      if (action === 'list') result = bots.listBots()
      else if (action === 'read') {
        const bot = bots.getBot(id)
        if (!bot) throw new Error('Bot not found')
        result = {
          ...bot,
          messages: repo.listMessages(bot.chatId).slice(-50),
          jobs: bots.listJobs(bot.id)
        }
      } else if (action === 'create')
        result = bots.createBot(text(input.username), text(input.instructions))
      else if (action === 'update')
        result = bots.updateBot(id, {
          ...(input.username !== undefined ? { username: text(input.username) } : {}),
          ...(input.instructions !== undefined ? { instructions: text(input.instructions) } : {})
        })
      else if (action === 'delete') {
        const bot = bots.getBot(id)
        if (!bot) throw new Error('Bot not found')
        if (bot.chatId === source || sessionBusy(bot.chatId))
          throw new Error('Stop the bot before deleting it; a bot cannot delete itself mid-turn')
        cancelSessionBackgroundJobs(bot.chatId)
        endSubagentRuns(bot.chatId)
        killSessionBackground(bot.chatId)
        disposeSession(bot.chatId)
        bots.removeBot(id)
        result = { deleted: id }
      } else throw new Error('Unknown bot action')
      notifyBots()
      break
    }
    case 'bot_schedule': {
      if (action === 'list') result = bots.listJobs(id ? (bots.getBot(id)?.id ?? id) : undefined)
      else if (action === 'delete') {
        const job = bots.listJobs().find((entry) => entry.id === id)
        bots.removeJob(id)
        const bot = job && bots.getBot(job.botId)
        if (bot) notifyAutomation(bot.chatId)
        result = { deleted: id }
      } else if (action === 'create' || action === 'update') {
        const old = action === 'update' ? bots.listJobs().find((job) => job.id === id) : undefined
        if (action === 'update' && !old) throw new Error('Schedule not found')
        const ref = text(input.bot) || old?.botId
        const bot = ref ? bots.getBot(ref) : source ? bots.chatBot(source) : undefined
        if (!bot) throw new Error('Name the bot to schedule')
        result = bots.saveJob(
          {
            botId: bot.id,
            name: text(input.name) || old?.name || '',
            prompt: text(input.prompt) || old?.prompt || '',
            schedule: (input.schedule ?? old?.schedule) as BotJobInput['schedule'],
            enabled: input.enabled === undefined ? old?.enabled : !!input.enabled,
            remainingRuns:
              input.remaining_runs === undefined
                ? old?.remainingRuns
                : (input.remaining_runs as number | null)
          },
          old?.id
        )
      } else throw new Error('Unknown schedule action')
      notifyBots()
      break
    }
    case 'bot_invoke': {
      const bot = bots.getBot(text(input.bot))
      if (!bot) throw new Error('Bot not found; use bot_manage list')
      if (bot.chatId === source) throw new Error('Use queue_manage to queue work for yourself')
      result = enqueuePrompt(bot.chatId, text(input.prompt), undefined, {
        sourceChatId: source,
        replyToChatId: source,
        hops,
        continueReply: true
      })
      break
    }
    case 'session_manage': {
      if (action === 'list') {
        result = repo
          .listChats()
          .filter((c) => c.kind === 'main' && (!input.project || c.workspacePath === input.project))
          .map((c) => ({ ...c, running: sessionBusy(c.id) }))
      } else if (action === 'create') {
        const project = text(input.project)
        if (!repo.listProjectOrder().includes(project))
          throw new Error('Choose an existing project from project_list')
        result = repo.createChat({
          title: text(input.title) || 'New session',
          workspacePath: project,
          ...(repo.getSettings().autoWorkstream ? { worktree: { mode: 'new' as const } } : {})
        })
      } else {
        const chat = repo.getChat(id)
        if (!chat || chat.kind !== 'main') throw new Error('Project session not found')
        if (action === 'read')
          result = {
            ...chat,
            messages: repo.listMessages(id).slice(-100),
            queue: repo.listQueue(id),
            running: sessionBusy(id)
          }
        else if (action === 'update') {
          repo.setChatMetadata(id, {
            ...(input.title !== undefined ? { title: text(input.title) } : {}),
            ...(input.description !== undefined ? { description: text(input.description) } : {})
          })
          result = repo.getChat(id)
        } else if (action === 'delete') {
          if (id === source || sessionBusy(id))
            throw new Error('Stop the session before deleting it')
          cancelSessionBackgroundJobs(id)
          endSubagentRuns(id)
          killSessionBackground(id)
          disposeSession(id)
          const release = claimTurn(id, new AbortController())!
          try {
            await removeWorktreeForChat(id)
            repo.removeChat(id)
          } finally {
            release()
          }
          result = { deleted: id }
        } else if (action === 'send') {
          result = enqueuePrompt(id, text(input.prompt), undefined, {
            sourceChatId: source,
            replyToChatId: source,
            hops,
            continueReply: id !== source
          })
        } else if (action === 'stop') {
          stopTurn(id)
          result = { stopped: id }
        } else throw new Error('Unknown session action')
      }
      emitSessionsUpdated({ reason: 'metadata', sessionIds: id ? [id] : [] })
      break
    }
    case 'queue_manage': {
      const chatId = text(input.session) || source || ''
      if (action === 'list') {
        if (!repo.getChat(chatId)) throw new Error('Session not found')
        result = repo.listQueue(chatId)
      } else if (action === 'create')
        result = enqueuePrompt(chatId, text(input.prompt), undefined, {
          sourceChatId: source,
          hops,
          notBefore: input.not_before as number | undefined
        })
      else {
        const row = getDb().prepare('SELECT chat_id, state FROM queue WHERE id = ?').get(id) as
          | { chat_id: string; state: string }
          | undefined
        if (!row) throw new Error('Queued message not found')
        if (action === 'read') result = repo.listQueue(row.chat_id).find((item) => item.id === id)
        else {
          if (row.state === 'running')
            throw new Error(
              'This message is running; stop its session before editing or deleting it'
            )
          if (action === 'delete') {
            repo.removeQueueItem(id)
            result = { deleted: id }
          } else if (action === 'update') {
            const old = repo.listQueue(row.chat_id).find((item) => item.id === id)!
            const prompt = input.prompt === undefined ? old.content : text(input.prompt)
            if (!prompt.trim()) throw new Error('A prompt is required')
            if (
              input.not_before !== undefined &&
              (!Number.isSafeInteger(input.not_before) || Number(input.not_before) < 0)
            )
              throw new Error('Invalid not_before timestamp')
            repo.updateQueueItem(id, prompt, old.images)
            resumeQueue(row.chat_id)
            if (input.not_before !== undefined)
              getDb()
                .prepare('UPDATE queue SET not_before = ? WHERE id = ?')
                .run(input.not_before, id)
            result = repo.listQueue(row.chat_id).find((item) => item.id === id)
          } else throw new Error('Unknown queue action')
          notifyAutomation(row.chat_id)
        }
      }
      break
    }
    default:
      throw new Error('Unknown bot tool')
  }
  return { ok: true, output: JSON.stringify(result, null, 2) }
}
