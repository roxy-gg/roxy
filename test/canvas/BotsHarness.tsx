import { useEffect, useState } from 'react'
import { HashRouter } from 'react-router-dom'
import type { Bot, BotJob, BotJobInput } from '../../src/shared/bots'
import type { Chat, Message, QueueItem } from '../../src/shared/types'
import { useRoxyStore } from '../../src/renderer/src/lib/store'
import { Sidebar } from '../../src/renderer/src/components/Sidebar'
import { ChatView } from '../../src/renderer/src/components/ChatView'

const baseChat: Chat = {
  id: 'project-chat',
  title: 'Project session',
  kind: 'main',
  providerId: null,
  model: null,
  agentId: null,
  reasoningEffort: null,
  contextLimit: null,
  workspacePath: null,
  worktreePath: null,
  repos: null,
  worktreePending: null,
  branch: null,
  devPort: null,
  parentId: null,
  contextSummary: null,
  contextSummaryAt: null,
  description: null,
  tasks: [],
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0
}
const bots: Bot[] = []
const chats: Chat[] = [baseChat]
const jobs: BotJob[] = []
let queue: QueueItem[] = []
let messages: Message[] = []
const changed = new Set<() => void>()
const notify = (): void => {
  for (const callback of changed) callback()
}

/** In-memory IPC stand-in only. UI and store are the production implementations. */
Object.assign(window.roxy, {
  bots: {
    list: async () => [...bots],
    create: async (username: string) => {
      if (bots.some((bot) => bot.username === username.toLowerCase()))
        throw new Error('Username already exists')
      const bot = {
        id: crypto.randomUUID(),
        username: username.toLowerCase(),
        instructions: '',
        chatId: crypto.randomUUID(),
        createdAt: Date.now()
      }
      bots.push(bot)
      chats.push({ ...baseChat, id: bot.chatId, kind: 'bot', title: bot.username })
      notify()
      return bot
    },
    update: async (id: string, patch: Partial<Bot>) => {
      const bot = bots.find((bot) => bot.id === id)!
      Object.assign(bot, patch)
      notify()
      return bot
    },
    remove: async (id: string) => {
      const bot = bots.find((bot) => bot.id === id)!
      bots.splice(bots.indexOf(bot), 1)
      chats.splice(
        chats.findIndex((chat) => chat.id === bot.chatId),
        1
      )
      notify()
    },
    jobs: async (botId: string) => jobs.filter((job) => job.botId === botId),
    saveJob: async (input: BotJobInput, id?: string) => {
      const job: BotJob = {
        ...input,
        id: id ?? crypto.randomUUID(),
        enabled: input.enabled ?? true,
        remainingRuns: input.remainingRuns ?? null,
        nextRunAt: Date.now() + 3600000,
        lastRunAt: null,
        createdAt: Date.now()
      }
      const index = jobs.findIndex((row) => row.id === id)
      if (index < 0) jobs.push(job)
      else jobs[index] = job
      notify()
      return job
    },
    removeJob: async (id: string) => {
      jobs.splice(
        jobs.findIndex((job) => job.id === id),
        1
      )
      notify()
    },
    onChanged: (callback: () => void) => {
      changed.add(callback)
      return () => changed.delete(callback)
    }
  },
  automation: { wake: async () => {} },
  chats: { list: async () => [...chats] },
  projects: { listOrder: async () => [] },
  messages: { list: async (id: string) => messages.filter((message) => message.chatId === id) },
  queue: {
    list: async (chatId: string) => queue.filter((item) => item.chatId === chatId),
    add: async (chatId: string, content: string, images?: QueueItem['images']) => {
      const item: QueueItem = {
        id: crypto.randomUUID(),
        chatId,
        content,
        images,
        createdAt: Date.now(),
        state: 'pending'
      }
      queue.push(item)
      return item
    },
    update: async (id: string, content: string, images?: QueueItem['images']) => {
      queue = queue.map((item) =>
        item.id === id ? { ...item, content, images, state: 'pending', error: undefined } : item
      )
    },
    remove: async (id: string) => {
      queue = queue.filter((item) => item.id !== id)
    },
    reorder: async () => {}
  },
  subagents: { setViewed: async () => {} },
  models: { pinned: async () => [], hidden: async () => [] },
  skills: { list: async () => [] },
  mcp: { list: async () => [] },
  updates: {
    getState: async () => ({ version: 'test', packaged: false, state: { status: 'idle' } }),
    onStatus: () => () => {}
  },
  llm: {
    start: async () => {
      throw new Error('Bot prompt incorrectly used local llm.start')
    },
    abortSession: async () => {}
  }
})

export function BotsHarness(): JSX.Element {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    useRoxyStore.setState({
      chats: [...chats],
      bots: [...bots],
      activeChatId: baseChat.id,
      messagesChatId: baseChat.id,
      gitAvailable: false
    })
    setReady(true)
  }, [])
  if (!ready) return <></>
  return (
    <HashRouter>
      <div className="bar">
        <button
          id="failed"
          onClick={() => {
            queue = queue.map((item) => ({
              ...item,
              state: 'failed',
              error: 'Provider unavailable. Edit this message to retry.'
            }))
            void useRoxyStore.getState().refreshQueue()
          }}
        >
          Fail queued items
        </button>
        <button
          id="answer"
          onClick={() => {
            const state = useRoxyStore.getState(),
              bot = state.bots.find((bot) => bot.chatId === state.activeChatId) ?? state.bots[0]
            if (!bot || !state.activeChatId) return
            messages = [
              ...messages,
              {
                id: crypto.randomUUID(),
                chatId: state.activeChatId,
                role: 'assistant',
                botId: bot.id,
                botUsername: bot.username,
                content: 'Ready to help.',
                parts: [{ type: 'text', text: 'Ready to help.' }],
                createdAt: Date.now()
              }
            ]
            void state.selectChat(state.activeChatId)
          }}
        >
          Bot response fixture
        </button>
      </div>
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <ChatView />
      </div>
    </HashRouter>
  )
}
