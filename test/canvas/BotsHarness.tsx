import { useEffect, useState } from 'react'
import { HashRouter } from 'react-router-dom'
import type { Bot, BotJob, BotJobInput } from '../../src/shared/bots'
import type { Chat, Message, MessagePart, QueueItem } from '../../src/shared/types'
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
    create: async (username?: string) => {
      // Lets the smoke prove a FAILED creation is reported. The button is the
      // only entry point now that the dialog is gone, so a silent failure
      // leaves the user with no bot and no reason why.
      const forced = (window as unknown as { __failNextCreate?: string }).__failNextCreate
      if (forced) {
        delete (window as unknown as { __failNextCreate?: string }).__failNextCreate
        throw new Error(forced)
      }
      // Mirrors main: with no name the bot still gets one, so it can be created
      // first and named later in the conversation.
      if (!username?.trim()) {
        for (let n = 1; ; n++) {
          const candidate = n === 1 ? 'bot' : `bot-${n}`
          if (!bots.some((bot) => bot.username === candidate)) {
            username = candidate
            break
          }
        }
      }
      if (bots.some((bot) => bot.username === username!.toLowerCase()))
        throw new Error('Username already exists')
      const bot = {
        id: crypto.randomUUID(),
        username: username!.toLowerCase(),
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
      const chat = chats.find((chat) => chat.id === bot.chatId)
      if (chat && patch.username) chat.title = patch.username
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
    runJob: async (id: string) => {
      const job = jobs.find((entry) => entry.id === id)
      const bot = bots.find((entry) => entry.id === job?.botId)
      if (!job || !bot) throw new Error('Schedule not found')
      return window.roxy.queue.add(bot.chatId, job.prompt)
    },
    onChanged: (callback: () => void) => {
      changed.add(callback)
      return () => changed.delete(callback)
    }
  },
  automation: { wake: async () => {} },
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
  subagents: {
    snapshot: async (id: string) => ({
      parts: useRoxyStore.getState().subagentPreviews[id] ?? [],
      sequence: 0,
      activityStartedAt: Date.now()
    }),
    cancel: async (id: string) => {
      window.__canvasTest.cancelled.push(id)
      return true
    }
  },
  tasks: {
    cancel: async (id: string) => {
      window.__canvasTest.cancelled.push(id)
    }
  },
  models: {
    pinned: async () => [],
    hidden: async () => [],
    list: async () => ({
      models: [
        {
          id: 'reasoning',
          name: 'Reasoning',
          reasoning: true,
          toolCall: true,
          reasoningEfforts: ['low', 'high']
        },
        { id: 'fast', name: 'Fast', reasoning: false, toolCall: true }
      ]
    }),
    recent: async () => []
  },
  providers: {
    list: async () => [
      {
        id: 'test-provider',
        seedId: 'test',
        name: 'Test provider',
        accountNumber: 1,
        wire: 'openai',
        auth: 'none',
        hasCredential: true,
        enabled: true,
        sortOrder: 0,
        createdAt: 0
      }
    ]
  },
  settings: {
    ...window.roxy.settings,
    setActiveProvider: async (providerId: string, model: string) => ({
      ...useRoxyStore.getState().settings,
      activeProviderId: providerId,
      activeModel: model
    }),
    setReasoningEffort: async (reasoningEffort: string) => ({
      ...useRoxyStore.getState().settings,
      reasoningEffort
    })
  },
  chats: {
    list: async () => [...chats],
    setConfig: async (id: string, patch: Partial<Chat>) => {
      const chat = chats.find((entry) => entry.id === id)!
      Object.assign(chat, patch)
      return { ...chat }
    }
  },
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

/**
 * Rename a bot the way the BOT does it — through the same IPC `bot_manage`
 * calls, not by poking the store. The sidebar and an open settings pane must
 * survive a profile that changes underneath them mid-conversation.
 */
;(window as unknown as { __renameBot: (from: string, to: string) => Promise<void> }).__renameBot =
  async (from, to) => {
    const bot = bots.find((bot) => bot.username === from)
    if (!bot) throw new Error(`No bot @${from}`)
    await window.roxy.bots.update(bot.id, { username: to })
    await useRoxyStore.getState().refreshBots()
    await useRoxyStore.getState().refreshChats()
  }
;(window as unknown as { __rerenderBotComposer: () => void }).__rerenderBotComposer = () => {
  const state = useRoxyStore.getState()
  if (!state.activeChatId) return
  useRoxyStore.setState({
    sendingChats: {
      ...state.sendingChats,
      [state.activeChatId]: !state.sendingChats[state.activeChatId]
    }
  })
}

// Production ChatView projects the saved launch + live delegate + late result.
;(
  window as unknown as {
    __taskFixture: (phase: 'running' | 'completed', continued?: boolean) => void
  }
).__taskFixture = (phase, continued = false) => {
  const state = useRoxyStore.getState()
  const chatId = state.activeChatId!
  const owner = state.bots.find((bot) => bot.chatId === chatId)
  const author = owner ? { botId: owner.id, botUsername: owner.username } : {}
  const card: Extract<MessagePart, { type: 'tool' }> = {
    type: 'tool',
    tool: 'task',
    callId: 'fixture-launch',
    subChatId: 'fixture-sub',
    state: 'done',
    title: 'Explore: provider research',
    input: { background: true },
    output: 'Started'
  }
  const children: MessagePart[] = [
    { type: 'text', text: 'Live delegate progress is visible here.' }
  ]
  const subChat = {
    ...baseChat,
    id: 'fixture-sub',
    title: 'Explore: provider research',
    kind: 'sub' as const,
    parentId: chatId
  }
  const subIndex = chats.findIndex((chat) => chat.id === subChat.id)
  if (subIndex < 0) chats.push(subChat)
  else chats[subIndex] = subChat
  messages = [
    {
      id: 'fixture-user',
      chatId,
      role: 'user',
      createdAt: 1,
      content: 'Research providers',
      parts: [{ type: 'text', text: 'Research providers' }]
    },
    {
      id: 'fixture-parent',
      chatId,
      role: 'assistant',
      createdAt: 2,
      content: '',
      parts: [card],
      ...author
    },
    ...(continued
      ? Array.from(
          { length: 12 },
          (_, i): Message => ({
            id: `fixture-followup-${i}`,
            chatId,
            role: i % 2 === 0 ? 'user' : 'assistant',
            createdAt: 3 + i,
            content: 'The parent conversation continued while the review was still running.',
            parts: [
              {
                type: 'text',
                text: 'The parent conversation continued while the review was still running.'
              }
            ],
            ...(i % 2 ? author : {})
          })
        )
      : []),
    ...(phase === 'completed'
      ? [
          {
            id: 'fixture-result',
            chatId,
            role: 'assistant' as const,
            createdAt: 20,
            content: '',
            parts: [
              {
                ...card,
                callId: 'fixture-result',
                resultFor: card.callId,
                output: 'Research complete.',
                children
              }
            ],
            ...author
          }
        ]
      : [])
  ]
  messages.push(
    {
      id: 'fixture-sub-user',
      chatId: 'fixture-sub',
      role: 'user',
      createdAt: 1,
      content: 'Investigate provider boundaries',
      parts: [{ type: 'text', text: 'Investigate provider boundaries' }]
    },
    ...(phase === 'completed'
      ? [
          {
            id: 'fixture-sub-answer',
            chatId: 'fixture-sub',
            role: 'assistant' as const,
            createdAt: 2,
            content: 'Full retained delegate transcript',
            parts: [
              ...children,
              { type: 'text' as const, text: 'Full retained delegate transcript' }
            ]
          }
        ]
      : [])
  )
  useRoxyStore.setState({
    chats: [...chats],
    messages: messages.filter((message) => message.chatId === chatId),
    messagesChatId: chatId,
    streamingChats: {},
    sendingChats: {},
    runningAutomation: {},
    subagentPreviews: phase === 'running' ? { 'fixture-sub': children } : {},
    runningSubagents: phase === 'running' ? { 'fixture-sub': true } : {},
    runningTasks:
      phase === 'running'
        ? {
            [chatId]: [
              {
                jobId: 'fixture-job',
                sessionId: chatId,
                subChatId: 'fixture-sub',
                description: 'provider research',
                subagentType: 'explore',
                state: 'running',
                startedAt: Date.now()
              }
            ]
          }
        : {}
  })
}

export function BotsHarness(): JSX.Element {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    useRoxyStore.setState({
      chats: [...chats],
      bots: [...bots],
      providers: [
        {
          id: 'test-provider',
          seedId: 'test',
          name: 'Test provider',
          accountNumber: 1,
          wire: 'openai',
          auth: 'none',
          hasCredential: true,
          enabled: true,
          sortOrder: 0,
          createdAt: 0
        }
      ],
      settings: {
        activeProviderId: 'test-provider',
        activeModel: 'reasoning',
        reasoningEffort: 'high'
      } as ReturnType<typeof useRoxyStore.getState>['settings'],
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
          id="busy"
          onClick={() => useRoxyStore.setState({ sendingChats: { 'project-chat': true } })}
        >
          Busy project fixture
        </button>
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
        <button
          id="image-handoff"
          onClick={() => {
            const state = useRoxyStore.getState()
            if (!state.activeChatId) return
            const parts = ['first.png', 'second.png'].map((name, index) => {
              const canvas = document.createElement('canvas')
              canvas.width = 640
              canvas.height = 360
              const ctx = canvas.getContext('2d')!
              ctx.fillStyle = index ? '#163c38' : '#222b45'
              ctx.fillRect(0, 0, 640, 360)
              ctx.fillStyle = '#ffffff'
              ctx.font = '28px sans-serif'
              ctx.fillText(`Forwarded screenshot ${index + 1}`, 40, 80)
              return {
                type: 'image' as const,
                dataUrl: canvas.toDataURL('image/png'),
                mediaType: 'image/png',
                name,
                forwarded: true
              }
            })
            messages = [
              ...messages,
              {
                id: crypto.randomUUID(),
                chatId: state.activeChatId,
                role: 'user',
                botUsername: 'image-sender',
                content: 'Fix the issues shown in these two screenshots.',
                parts: [
                  { type: 'text', text: 'Fix the issues shown in these two screenshots.' },
                  ...parts
                ],
                createdAt: Date.now()
              }
            ]
            void state.selectChat(state.activeChatId)
          }}
        >
          Image handoff fixture
        </button>
        <button
          id="requests"
          onClick={() => {
            const state = useRoxyStore.getState()
            const bot = state.bots[0]
            if (!bot || !state.activeChatId) return
            messages = [
              ...messages,
              {
                id: crypto.randomUUID(),
                chatId: state.activeChatId,
                role: 'user',
                botId: bot.id,
                botUsername: bot.username,
                content: 'Implement the avatar fixes in this project.',
                parts: [{ type: 'text', text: 'Implement the avatar fixes in this project.' }],
                createdAt: Date.now()
              },
              {
                id: crypto.randomUUID(),
                chatId: state.activeChatId,
                role: 'user',
                content: `Human request mentioning @${bot.username}.`,
                parts: [{ type: 'text', text: `Human request mentioning @${bot.username}.` }],
                createdAt: Date.now() + 1
              }
            ]
            void state.selectChat(state.activeChatId)
          }}
        >
          Bot and human requests fixture
        </button>
      </div>
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <ChatView />
      </div>
    </HashRouter>
  )
}
