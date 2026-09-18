/** Main-process queue owner. Claims are durable; renderer windows only mirror turns. */
import { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import type { QueueImage, QueueItem, MessagePart } from '../../shared/types'
import type { ChatMessage, RemoteDelta } from '../../shared/api'
import { CHANNELS } from '../../shared/ipc'
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
const speakers = new Map<string, { botId: string; botUsername: string }>()

/**
 * How far a request may be handed on before it needs a human again.
 *
 * Every route that passes work to another bot counts against this one budget:
 * an explicit `bot_invoke` and a reply nudge. One shared budget prevents
 * bots from volleying a message between themselves indefinitely.
 */
const MAX_HOPS = 8

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

export function automationSnapshot(): {
  sessionId: string
  parts: MessagePart[]
  botId?: string
  botUsername?: string
}[] {
  return [...live].map(([sessionId, fold]) => ({
    sessionId,
    parts: fold.parts,
    ...speakers.get(sessionId)
  }))
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
    /** Set when the prompt is machine-generated on a bot's behalf, so the
     *  transcript attributes it to that bot instead of to the user. */
    botId?: string
    botUsername?: string
    /** Bot that should ANSWER this prompt, when it isn't the session's own bot. */
    asBotId?: string
    recipientId?: string
  } = {}
): QueueItem {
  if (!repo.getChat(chatId)) throw new Error('Session not found')
  if (typeof content !== 'string' || (!content.trim() && !images?.length))
    throw new Error('A prompt is required')
  // Only explicit machine handoffs choose a responder. User text always goes
  // to the session owner, who interprets intent and may call bot_invoke.
  const recipientId = options.sourceChatId ? (options.recipientId ?? options.asBotId) : undefined
  if (recipientId !== undefined && recipientId !== 'roxy' && !bots.getBot(recipientId))
    throw new Error('The invited bot no longer exists')
  if (
    options.hops !== undefined &&
    (!Number.isSafeInteger(options.hops) || options.hops > MAX_HOPS || options.hops < 0)
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
        'UPDATE queue SET source_chat_id = ?, reply_to_chat_id = ?, hops = ?, not_before = ?, continue_reply = ?, bot_id = ?, bot_username = ?, as_bot_id = ?, recipient_id = ? WHERE id = ?'
      )
      .run(
        options.sourceChatId ?? null,
        options.replyToChatId ?? null,
        options.hops ?? 0,
        options.notBefore ?? 0,
        Number(!!options.continueReply),
        options.botId ?? null,
        options.botUsername ?? null,
        options.sourceChatId ? (options.asBotId ?? null) : null,
        recipientId ?? null,
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
      void deliver(item).catch((error) => console.error('[bots] delivery failed', error))
    }
  } catch (error) {
    console.error('[bots] scheduler failed', error)
  }
}

/**
 * Rebuild this session's transcript for the bot about to speak.
 *
 * `speaker` is that bot, which is NOT always the session's own bot: a guest
 * invited in through `bot_invoke` answers here while belonging elsewhere.
 * Deriving it from the chat marked the guest's own past replies as someone
 * else's, so it read its own words in the third person ("[@sub] ...") and
 * answered them as if a colleague had written them.
 */
function history(
  chatId: string,
  budget: number,
  outputReserve: number,
  speaker?: ReturnType<typeof bots.getBot>,
  asHost = false
): ChatMessage[] {
  const since = repo.getChat(chatId)?.contextSummaryAt ?? 0
  const self = asHost ? undefined : (speaker ?? bots.chatBot(chatId))
  const groups = repo
    .listMessages(chatId)
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.createdAt > since)
    .map((m) => reconstructTurn(m, self))
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

/**
 * Restate a handoff's assignment as its final user message, even when history kept it.
 *
 * The prompt a guest is invited with is persisted as `assistant` (an agent, not
 * the user, wrote it), and the leading-edge normalization above drops messages
 * until the window starts on a user turn. A guest runs on ITS OWN, possibly much
 * narrower, context budget, so that window can close over exactly the delegation
 * being delivered: the bot then arrived to "Continue with the pending request."
 * and no request. Even without trimming, a generic continue asks the guest to
 * continue the host's behavior instead of accepting its own assignment.
 */
function withRequest(messages: ChatMessage[], request: string, assignee?: string): ChatMessage[] {
  const text = request.trim()
  if (!text) return messages
  if (!assignee && messages.some((m) => m.content.includes(text))) return messages
  // A handoff is a NEW request to its recipient, including work returned to
  // Roxy. Never leave it continuing the previous participant's tool history.
  const restated = {
    role: 'user' as const,
    content: assignee
      ? `This turn is assigned to you, @${assignee}. The preceding assistant messages include other participants' work, not actions you performed. Carry out the following request yourself and answer here. Do not wait for or invoke @${assignee}: that is you.\n\n${text}`
      : text
  }
  // Replace the placeholder rather than trail it: they say the same thing, and
  // the real request is the better last word.
  return messages.at(-1)?.content === 'Continue with the pending request.'
    ? [...messages.slice(0, -1), restated]
    : [...messages, restated]
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
  let bot: ReturnType<typeof bots.getBot>
  const relay = relayLocalTurnStart(item.chatId)
  try {
    // Read persisted handoff metadata before choosing the speaker and config.
    const previous = getDb()
      .prepare(
        'SELECT message_id, bot_id, bot_username, as_bot_id, recipient_id FROM queue WHERE id = ?'
      )
      .get(item.id) as
      | {
          message_id: string | null
          bot_id: string | null
          bot_username: string | null
          as_bot_id: string | null
          recipient_id: string | null
        }
      | undefined
    if (!previous) return
    // A guest answers with ITS OWN model, mode, thinking effort, and context
    // budget. Inheriting the host session's config silently downgraded the
    // specialist you configured: a reviewer pinned to a strong model at high
    // effort answered on whatever the host happened to be set to, which is not
    // the bot you called. Everything else stays the host's — transcript,
    // workspace, queue.
    // Older releases auto-routed user messages by mention. Even an unmigrated
    // or restored row must not turn that stale destination into a tool handoff.
    const asHost = !!item.sourceChatId && previous.recipient_id === 'roxy'
    const targetId =
      item.sourceChatId && !asHost ? (previous.recipient_id ?? previous.as_bot_id) : undefined
    const target = targetId ? bots.getBot(targetId) : undefined
    if (targetId && !target) throw new Error('The invited bot no longer exists')
    const guest = target?.chatId !== item.chatId ? target : undefined
    bot = asHost ? undefined : (target ?? bots.chatBot(item.chatId))
    const speaker = bot ? { botId: bot.id, botUsername: bot.username } : undefined
    if (speaker) speakers.set(item.chatId, speaker)
    emit({ sessionId: item.chatId, kind: 'turn', state: 'running', ...speaker })
    const config = resolveSessionConfig(
      asHost && bots.chatBot(item.chatId) ? undefined : repo.getChat(guest?.chatId ?? item.chatId),
      repo.getSettings()
    )
    const owner = guest ? `@${guest.username}` : 'this session'
    const providers = repo.listConnectedProviders().filter((p) => p.enabled)
    const provider = config.providerId
      ? providers.find((p) => p.id === config.providerId)
      : providers[0]
    if (!provider)
      throw new Error(
        `Connect the provider selected for ${owner}, then edit the queued message to retry.`
      )
    const catalog = await listModels(provider.id).catch(() => [])
    const model =
      (config.providerId === provider.id ? config.model : null) ||
      provider.defaultModel ||
      pickDefaultModel(catalog)
    if (!model) throw new Error(`Select a model for ${owner}, then retry.`)
    if (controller.signal.aborted) throw new Error('Stopped.')
    if (!previous.message_id)
      getDb().transaction(() => {
        const message = repo.addMessage({
          chatId: item.chatId,
          // A prompt this session's own agent wrote (asking a guest bot for help)
          // is not something the user said — attributing it to the user made the
          // request show up as "You", and attributing it to the guest made the
          // guest appear to ask itself.
          role: item.sourceChatId === item.chatId ? 'assistant' : 'user',
          ...(previous.bot_id ? { botId: previous.bot_id } : {}),
          ...(previous.bot_username ? { botUsername: previous.bot_username } : {}),
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
    // Compaction is permanent and belongs to the session, so a GUEST never
    // triggers it: a visitor on a small window would otherwise summarize away
    // the host's history on its way through. It just gets the narrower window.
    if (!guest && !(asHost && bots.chatBot(item.chatId)) && estimated > budget * 0.8)
      await compactChat(item.chatId, provider.id, model, controller.signal)
    if (controller.signal.aborted) throw new Error('Stopped.')
    const result = await runSessionTurn(
      {
        requestId: randomUUID(),
        sessionId: item.chatId,
        providerId: provider.id,
        model,
        messages: withRequest(
          history(item.chatId, budget, info?.outputLimit ?? 4096, guest, asHost),
          item.content,
          guest?.username ?? (previous.bot_id && !bot ? 'Roxy' : undefined)
        ),
        agentId: config.agentId,
        reasoning: info?.reasoning,
        reasoningEffort: clampReasoningEffort(config.reasoningEffort, info?.reasoningEfforts),
        contextLimit: budget,
        ...(guest ? { asBotId: guest.id } : {}),
        asHost
      },
      (event) => {
        fold.apply(event)
        emit({ sessionId: item.chatId, kind: 'event', event })
        if (relay) relayLocalTurnEvent(relay, event)
      },
      controller.signal
    )
    // Whoever spoke this turn owns the reply: the invited bot in a shared
    // session, otherwise the session's own bot.
    const parts = fold.parts
    if (bot) bot = bots.getBot(bot.id) ?? bot
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
        if (continuation?.continue_reply && (item.hops ?? 0) < MAX_HOPS && pending.n < 100) {
          // The reply was just persisted to this transcript, so the nudge must
          // NOT repeat it: quoting it again produced a second copy of the whole
          // answer, attributed to "You" because a queued prompt is a user turn.
          enqueuePrompt(
            item.replyToChatId,
            `${bot ? `@${bot.username}` : `Session ${item.chatId}`} answered above. Continue the original task if needed, or report the result. Do not reflexively invoke the sender again.`,
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
    speakers.delete(item.chatId)
    release()
    if (relay) relayLocalTurnEnd(relay)
    notifyTranscriptChanged(item.chatId)
    notifyAutomation(item.chatId)
    emit({ sessionId: item.chatId, kind: 'turn', state: 'idle' })
  }
}
