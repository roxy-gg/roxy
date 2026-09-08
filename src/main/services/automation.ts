/** Main-process queue owner. Claims are durable; renderer windows only mirror turns. */
import { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import type { QueueImage, QueueItem, MessagePart } from '../../shared/types'
import type { ChatMessage, RemoteDelta } from '../../shared/api'
import { CHANNELS } from '../../shared/ipc'
import { mentionedBot } from '../../shared/bots'
import { PartsFold, partsToContent } from '../../shared/parts'
import { reconstructTurn } from '../../shared/tool-history'
import { pruneToolMessages, KEEP_RECENT_TOKENS } from '../../shared/context'
import {
  resolveSessionConfig,
  contextBudgetFor,
  clampReasoningEffort
} from '../../shared/session-config'
import { pickDefaultModel } from '../../shared/models'
import * as repo from '../db/repo'
import * as bots from '../db/bots'
import { getDb } from '../db/database'
import { listModels } from './models'
import { compactChat } from './compaction'
import { subagentSnapshot } from './subagent-stream'
import { runSessionTurn } from './session-turn'
import { claimTurn, sessionBusy, queuePaused, resumeQueue } from './turn-state'
import {
  relayLocalTurnStart,
  relayLocalTurnEvent,
  relayLocalTurnEnd,
  notifyQueueChanged,
  notifyTranscriptChanged
} from './remote'

let timer: ReturnType<typeof setInterval> | null = null
const live = new Map<string, PartsFold>()

export function notifyAutomation(chatId: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed()) win.webContents.send(CHANNELS.automationChanged, chatId)
    } catch {
      /* window teardown */
    }
  }
  notifyQueueChanged()
}

export function notifyBots(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed()) win.webContents.send(CHANNELS.botsChanged)
    } catch {
      /* window teardown */
    }
  }
}

function emit(delta: RemoteDelta): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed()) win.webContents.send(CHANNELS.automationDelta, delta)
    } catch {
      /* window teardown */
    }
  }
}

export function automationSnapshot(): { sessionId: string; parts: MessagePart[] }[] {
  return [...live].map(([sessionId, fold]) => ({ sessionId, parts: fold.parts }))
}

export function enqueuePrompt(
  chatId: string,
  content: string,
  images?: QueueImage[],
  options: {
    sourceChatId?: string
    replyToChatId?: string
    notBefore?: number
    hops?: number
    continueReply?: boolean
  } = {}
): QueueItem {
  if (!repo.getChat(chatId)) throw new Error('Session not found')
  if (typeof content !== 'string' || (!content.trim() && !images?.length))
    throw new Error('A prompt is required')
  if (
    options.hops !== undefined &&
    (!Number.isSafeInteger(options.hops) || options.hops > 8 || options.hops < 0)
  ) {
    throw new Error('Handoff limit reached. Ask the user before starting another chain.')
  }
  if (
    options.notBefore !== undefined &&
    (!Number.isSafeInteger(options.notBefore) || options.notBefore < 0)
  ) {
    throw new Error('not_before must be an epoch timestamp in milliseconds')
  }
  const count = getDb()
    .prepare('SELECT COUNT(*) AS n FROM queue WHERE chat_id = ?')
    .get(chatId) as { n: number }
  if (count.n >= 100) throw new Error('This session already has 100 queued messages')
  const item = getDb().transaction(() => {
    const item = repo.enqueue(chatId, content.trim(), images)
    getDb()
      .prepare(
        'UPDATE queue SET source_chat_id = ?, reply_to_chat_id = ?, hops = ?, not_before = ?, continue_reply = ? WHERE id = ?'
      )
      .run(
        options.sourceChatId ?? null,
        options.replyToChatId ?? null,
        options.hops ?? 0,
        options.notBefore ?? 0,
        Number(!!options.continueReply),
        item.id
      )
    return item
  })()
  if (!options.sourceChatId) resumeQueue(chatId)
  notifyAutomation(chatId)
  // Drain on the next event-loop pass, after callers have persisted their own tool result.
  if (timer)
    setImmediate(() => {
      if (timer) wakeAutomation()
    })
  return repo.listQueue(chatId).find((entry) => entry.id === item.id)!
}

export function startAutomation(): void {
  if (timer) return
  // Never replay uncertain tool side effects automatically after a crash.
  getDb()
    .prepare(
      `UPDATE queue SET state = 'failed', error = 'Interrupted by app shutdown. Edit this message to retry.' WHERE state = 'running'`
    )
    .run()
  timer = setInterval(wakeAutomation, 1000)
  wakeAutomation()
}

export function stopAutomation(): void {
  if (timer) clearInterval(timer)
  timer = null
}

export function wakeAutomation(): void {
  try {
    const scheduled = bots.enqueueDueJobs()
    if (scheduled.length) notifyBots()
    for (const id of scheduled) notifyAutomation(id)
    const rows = getDb()
      .prepare(`SELECT DISTINCT chat_id FROM queue WHERE state = 'pending'`)
      .all() as { chat_id: string }[]
    for (const { chat_id: chatId } of rows) {
      if (live.size >= 4) break
      if (sessionBusy(chatId) || queuePaused(chatId) || subagentSnapshot(chatId) !== null) continue
      const item = repo.listQueue(chatId)[0]
      if (!item || item.state !== 'pending' || (item.notBefore ?? 0) > Date.now()) continue
      const target = mentionedBot(item.content, bots.listBots())
      if (target && target.chatId !== chatId) {
        try {
          getDb().transaction(() => {
            const source = repo.getChat(chatId)
            const context = repo
              .listMessages(chatId)
              .slice(-8)
              .map((m) => `${m.role}: ${m.content}`)
              .join('\n')
              .slice(-24000)
            const prompt = item.content.replace(/^\s*@[a-z][a-z0-9_-]*[\s,:]*/i, '') || 'Hello'
            enqueuePrompt(
              target.chatId,
              `Request from session ${chatId} (${source?.title ?? ''}).\n\n${prompt}\n\n<source_context>\n${context}\n</source_context>`,
              item.images,
              { sourceChatId: chatId, replyToChatId: chatId, hops: (item.hops ?? 0) + 1 }
            )
            repo.addMessage({
              chatId,
              role: 'user',
              content: item.content,
              parts: [
                { type: 'text', text: item.content },
                ...(item.images ?? []).map((image) => ({ type: 'image' as const, ...image }))
              ]
            })
            repo.removeQueueItem(item.id)
          })()
        } catch (error) {
          getDb()
            .prepare(`UPDATE queue SET state = 'failed', error = ? WHERE id = ?`)
            .run(String(error), item.id)
        }
        notifyAutomation(chatId)
        notifyTranscriptChanged(chatId)
        continue
      }
      void deliver(item).catch((error) => console.error('[bots] delivery failed', error))
    }
  } catch (error) {
    console.error('[bots] scheduler failed', error)
  }
}

function history(chatId: string, budget: number, outputReserve: number): ChatMessage[] {
  const since = repo.getChat(chatId)?.contextSummaryAt ?? 0
  const groups = repo
    .listMessages(chatId)
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.createdAt > since)
    .map(reconstructTurn)
    .filter((g) => g.length)
  const pruned = pruneToolMessages(groups.flat(), { keepRecentTokens: KEEP_RECENT_TOKENS })
  let index = 0
  const rebuilt = groups.map((g) => g.map(() => pruned[index++]))
  const cap = Math.max(2000, budget - outputReserve - 6000)
  const kept: ChatMessage[][] = []
  let used = 0
  for (let i = rebuilt.length - 1; i >= 0; i--) {
    const tokens = rebuilt[i].reduce(
      (sum, m) =>
        sum +
        Math.ceil((m.content.length + JSON.stringify(m.toolCalls ?? []).length) / 4) +
        (m.images?.length ?? 0) * 800,
      0
    )
    if (kept.length && used + tokens > cap) break
    kept.unshift(rebuilt[i])
    used += tokens
  }
  const flat = kept.flat()
  while (flat.length && flat[0].role !== 'user') flat.shift()
  if (flat.at(-1)?.role !== 'user')
    flat.push({ role: 'user', content: 'Continue with the pending request.' })
  return flat
}

async function deliver(item: QueueItem): Promise<void> {
  const controller = new AbortController()
  const release = claimTurn(item.chatId, controller)
  if (!release) return
  const claimed = getDb()
    .prepare(`UPDATE queue SET state = 'running', error = NULL WHERE id = ? AND state = 'pending'`)
    .run(item.id)
  if (!claimed.changes) {
    release()
    return
  }
  const fold = new PartsFold()
  live.set(item.chatId, fold)
  emit({ sessionId: item.chatId, kind: 'turn', state: 'running' })
  const relay = relayLocalTurnStart(item.chatId)
  try {
    const config = resolveSessionConfig(repo.getChat(item.chatId), repo.getSettings())
    const providers = repo.listConnectedProviders().filter((p) => p.enabled)
    const provider = config.providerId
      ? providers.find((p) => p.id === config.providerId)
      : providers[0]
    if (!provider)
      throw new Error(
        'Connect the provider selected for this session, then edit the queued message to retry.'
      )
    const catalog = await listModels(provider.id).catch(() => [])
    const model =
      (config.providerId === provider.id ? config.model : null) ||
      provider.defaultModel ||
      pickDefaultModel(catalog)
    if (!model) throw new Error('Select a model for this session, then retry.')
    if (controller.signal.aborted) throw new Error('Stopped.')
    const previous = getDb().prepare('SELECT message_id FROM queue WHERE id = ?').get(item.id) as
      | { message_id: string | null }
      | undefined
    if (!previous) return
    if (!previous.message_id)
      getDb().transaction(() => {
        const message = repo.addMessage({
          chatId: item.chatId,
          role: 'user',
          content: item.content,
          parts: [
            { type: 'text', text: item.content },
            ...(item.images ?? []).map((image) => ({ type: 'image' as const, ...image }))
          ]
        })
        getDb().prepare('UPDATE queue SET message_id = ? WHERE id = ?').run(message.id, item.id)
      })()
    notifyAutomation(item.chatId)
    notifyTranscriptChanged(item.chatId)
    const info = catalog.find((m) => m.id === model)
    const budget = contextBudgetFor(config.contextLimit, info?.contextLimit ?? 128000)
    const chat = repo.getChat(item.chatId)
    const estimated = repo
      .listMessages(item.chatId)
      .filter((m) => m.createdAt > (chat?.contextSummaryAt ?? 0))
      .reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0)
    if (estimated > budget * 0.8)
      await compactChat(item.chatId, provider.id, model, controller.signal)
    if (controller.signal.aborted) throw new Error('Stopped.')
    const result = await runSessionTurn(
      {
        requestId: randomUUID(),
        sessionId: item.chatId,
        providerId: provider.id,
        model,
        messages: history(item.chatId, budget, info?.outputLimit ?? 4096),
        agentId: config.agentId,
        reasoning: info?.reasoning,
        reasoningEffort: clampReasoningEffort(config.reasoningEffort, info?.reasoningEfforts),
        contextLimit: budget
      },
      (event) => {
        fold.apply(event)
        emit({ sessionId: item.chatId, kind: 'event', event })
        if (relay) relayLocalTurnEvent(relay, event)
      },
      controller.signal
    )
    const bot = bots.chatBot(item.chatId)
    const parts = fold.parts
    getDb().transaction(() => {
      if (!repo.getChat(item.chatId)) return
      if (parts.length)
        repo.addMessage({
          chatId: item.chatId,
          role: 'assistant',
          content: partsToContent(parts),
          parts,
          botId: bot?.id,
          botUsername: bot?.username
        })
      if (!result.ok) throw new Error(result.error ?? 'Model request failed')
      if (
        item.replyToChatId &&
        item.replyToChatId !== item.chatId &&
        repo.getChat(item.replyToChatId)
      ) {
        // A reply is a transcript result, not a new prompt: never trigger a reply loop.
        const text = parts
          .filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text')
          .map((p) => p.text)
          .join('\n')
        repo.addMessage({
          chatId: item.replyToChatId,
          role: 'assistant',
          content: text || partsToContent(parts),
          botId: bot?.id,
          botUsername: bot?.username
        })
        const continuation = getDb()
          .prepare('SELECT continue_reply FROM queue WHERE id = ?')
          .get(item.id) as { continue_reply: number } | undefined
        const pending = getDb()
          .prepare('SELECT COUNT(*) AS n FROM queue WHERE chat_id = ?')
          .get(item.replyToChatId) as { n: number }
        if (continuation?.continue_reply && (item.hops ?? 0) < 8 && pending.n < 100) {
          enqueuePrompt(
            item.replyToChatId,
            `Your delegated request to ${bot ? `@${bot.username}` : `session ${item.chatId}`} completed. Continue the original task if needed, or report the result. Do not reflexively invoke the sender again.\n\n<result>\n${text || partsToContent(parts)}\n</result>`,
            undefined,
            { sourceChatId: item.chatId, hops: (item.hops ?? 0) + 1 }
          )
        }
      }
      getDb().prepare('DELETE FROM queue WHERE id = ?').run(item.id)
    })()
    if (bot) notifyBots()
    if (item.replyToChatId) {
      notifyAutomation(item.replyToChatId)
      notifyTranscriptChanged(item.replyToChatId)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    getDb()
      .prepare(`UPDATE queue SET state = 'failed', error = ? WHERE id = ?`)
      .run(message, item.id)
    if (
      item.replyToChatId &&
      item.replyToChatId !== item.chatId &&
      repo.getChat(item.replyToChatId)
    ) {
      const bot = bots.chatBot(item.chatId)
      repo.addMessage({
        chatId: item.replyToChatId,
        role: 'assistant',
        content: `The delegated request could not finish: ${message}\nThe request remains in ${bot ? `@${bot.username}'s` : "the target session's"} queue for retry or removal.`,
        botId: bot?.id,
        botUsername: bot?.username
      })
      notifyAutomation(item.replyToChatId)
      notifyTranscriptChanged(item.replyToChatId)
    }
    if (fold.parts.length && repo.getChat(item.chatId)) {
      const bot = bots.chatBot(item.chatId)
      repo.addMessage({
        chatId: item.chatId,
        role: 'assistant',
        content: partsToContent(fold.parts),
        parts: fold.parts,
        botId: bot?.id,
        botUsername: bot?.username
      })
    }
  } finally {
    live.delete(item.chatId)
    release()
    if (relay) relayLocalTurnEnd(relay)
    notifyTranscriptChanged(item.chatId)
    notifyAutomation(item.chatId)
    emit({ sessionId: item.chatId, kind: 'turn', state: 'idle' })
  }
}
