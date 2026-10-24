import { useEffect, useState } from 'react'
import { HashRouter } from 'react-router-dom'
import type { Bot, BotJob, BotJobInput } from '../../src/shared/bots'
import type { Chat, Message, MessagePart, QueueItem } from '../../src/shared/types'
import { useRoxyStore } from '../../src/renderer/src/lib/store'
import Chat from '../../src/renderer/src/routes/Chat'

const workspaceFixture = new URLSearchParams(location.search).has('workspace')
const baseChat: Chat = {
  id: 'project-chat',
  title: workspaceFixture ? 'Git Changes and File Explorer' : 'Project session',
  kind: 'main',
  providerId: null,
  model: null,
  agentId: null,
  reasoningEffort: null,
  contextLimit: null,
  workspacePath: workspaceFixture ? '/projects/roxy' : null,
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
    reorder: async (ids: string[]) => {
      const rank = new Map(ids.map((id, index) => [id, index]))
      bots.sort((a, b) => (rank.get(a.id) ?? ids.length) - (rank.get(b.id) ?? ids.length))
      notify()
    },
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

// Production ChatView renders batch children as independent main-column cards.
;(
  window as unknown as {
    __taskFixture: (phase: 'running' | 'completed') => void
  }
).__taskFixture = (phase) => {
  const state = useRoxyStore.getState()
  const chatId = state.activeChatId!
  const owner = state.bots.find((bot) => bot.chatId === chatId)
  const author = owner ? { botId: owner.id, botUsername: owner.username } : {}
  const card: Extract<MessagePart, { type: 'tool' }> = {
    type: 'tool',
    tool: 'task',
    callId: 'fixture-launch',
    subChatId: 'fixture-sub',
    state: phase === 'running' ? 'running' : 'done',
    title: 'Explore: provider research',
    input: { description: 'provider research' },
    output: phase === 'completed' ? 'Research complete.' : undefined,
    children: [{ type: 'text', text: 'Live delegate progress is visible here.' }]
  }
  const children = card.children!
  const batch: Extract<MessagePart, { type: 'tool' }> = {
    type: 'tool',
    tool: 'task',
    callId: 'fixture-batch',
    state: phase === 'running' ? 'running' : 'done',
    title: 'Investigate subtasks',
    input: { tasks: [{ description: 'provider research', prompt: 'Investigate providers' }] },
    children: [card]
  }
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
      parts: [batch],
      ...author
    }
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
    streamingChats: phase === 'running' ? { [chatId]: [batch] } : {},
    sendingChats: phase === 'running' ? { [chatId]: true } : {},
    runningAutomation: {},
    subagentPreviews: phase === 'running' ? { 'fixture-sub': children } : {},
    runningSubagents: phase === 'running' ? { 'fixture-sub': true } : {}
  })
}

if (workspaceFixture) {
  const files = new Map<string, { content: string; revision: string }>()
  const changes = [
    {
      path: 'src/renderer/src/components/ChatView.tsx',
      status: 'modified',
      additions: 36,
      deletions: 12
    },
    {
      path: 'src/renderer/src/components/WorkspaceInspector.tsx',
      status: 'added',
      additions: 72,
      deletions: 0
    },
    {
      path: 'src/main/services/workspace-inspector.ts',
      status: 'added',
      additions: 18,
      deletions: 0
    },
    { path: 'src/renderer/src/assets/main.css', status: 'modified', additions: 0, deletions: 21 }
  ] as const
  const before =
    'export function ChatView() {\n  return (\n    <main className="conversation">\n      <Transcript />\n      <Composer />\n    </main>\n  )\n}\n'
  const after =
    'export function ChatView() {\n  const [inspectorOpen, setInspectorOpen] = useState(false)\n\n  return (\n    <main className="conversation">\n      <WorkspaceSummary onClick={() => setInspectorOpen(!inspectorOpen)} />\n      <Transcript />\n      <Composer />\n      {inspectorOpen && <WorkspaceInspector />}\n    </main>\n  )\n}\n'
  Object.assign(window.roxy, {
    workspace: {
      inspect: async () => ({
        roots: [
          {
            id: 'roxy',
            name: 'roxy',
            branch: 'roxy/git-changes-and-file-explorer',
            isRepo: true,
            unavailable: false,
            partial: false,
            changes
          }
        ]
      }),
      list: async (_sessionId: string, _rootId: string, directory: string) => {
        const paths = [
          'src/renderer/src/components/ChatView.tsx',
          'src/renderer/src/components/WorkspaceInspector.tsx',
          'src/renderer/src/assets/main.css',
          'src/main/services/workspace-inspector.ts',
          '.github/workflows/build.yml',
          'docs/README.md',
          'script/dev.mjs',
          'test/workspace-inspector.ts',
          'AGENTS.md',
          'README.md',
          '.env',
          '.env.local',
          '.env.staging.local',
          '.gitignore',
          '.prettierrc',
          'app.js',
          'app.ts',
          'app.tsx',
          'app.jsx',
          'main.rs',
          'UPPER.TS',
          'module.mts',
          'module.cts',
          'types.d.ts',
          'config.jsonc',
          'notes.markdown',
          'unknown.extension',
          'unknown',
          'photo.png',
          'photo.jpeg',
          'clip.mp4',
          'sound.wav',
          'document.pdf',
          'broken.png',
          'package.json',
          'tsconfig.json'
        ]
        const children = new Map<string, { name: string; path: string; kind: string }>()
        for (const path of paths) {
          if (directory && !path.startsWith(directory + '/')) continue
          const tail = directory ? path.slice(directory.length + 1) : path
          const name = tail.split('/')[0]
          children.set(name, {
            name,
            path: directory ? directory + '/' + name : name,
            kind: tail.includes('/') ? 'directory' : 'file'
          })
        }
        return {
          ok: true,
          partial: false,
          entries: [...children.values()].sort(
            (a, b) =>
              Number(b.kind === 'directory') - Number(a.kind === 'directory') ||
              a.name.localeCompare(b.name)
          )
        }
      },
      read: async (_sessionId: string, _rootId: string, file: string, comparison: boolean) => {
        if (!files.has(file))
          files.set(file, {
            content: file.endsWith('.json')
              ? '{\n  "name": "roxy",\n  "version": "1.0.21"\n}\n'
              : after,
            revision: 'initial'
          })
        const document = files.get(file)!
        return {
          ok: true,
          before: comparison ? before : '',
          after: document.content,
          revision: document.revision
        }
      },
      preview: async (_sessionId: string, _rootId: string, file: string) => {
        const { workspaceMedia } = await import('../../src/shared/workspace-inspector')
        const media = workspaceMedia(file)!
        let blob: Blob
        if (file === 'broken.png') blob = new Blob(['invalid'], { type: media.mime })
        else if (media.kind === 'image') {
          const canvas = document.createElement('canvas')
          canvas.width = 2400
          canvas.height = 1800
          const context = canvas.getContext('2d')!
          context.fillStyle = '#23536a'
          context.fillRect(0, 0, canvas.width, canvas.height)
          context.fillStyle = '#e8c890'
          context.fillRect(300, 300, 1800, 1200)
          blob = await new Promise<Blob>((resolve) =>
            canvas.toBlob((value) => resolve(value!), media.mime)
          )
        } else if (media.kind === 'audio') {
          const bytes = new ArrayBuffer(44 + 16000)
          const view = new DataView(bytes)
          const text = (at: number, value: string): void => {
            for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i))
          }
          text(0, 'RIFF')
          view.setUint32(4, bytes.byteLength - 8, true)
          text(8, 'WAVEfmt ')
          view.setUint32(16, 16, true)
          view.setUint16(20, 1, true)
          view.setUint16(22, 1, true)
          view.setUint32(24, 8000, true)
          view.setUint32(28, 16000, true)
          view.setUint16(32, 2, true)
          view.setUint16(34, 16, true)
          text(36, 'data')
          view.setUint32(40, 16000, true)
          blob = new Blob([bytes], { type: media.mime })
        } else if (media.kind === 'video') {
          blob = await fetch(new URL('../fixtures/background.mp4', import.meta.url)).then(
            (response) => response.blob()
          )
        } else blob = new Blob(['%PDF-1.4\n%%EOF'], { type: media.mime })
        return { ok: true, ...media, url: URL.createObjectURL(blob), size: blob.size }
      },
      write: async (
        _sessionId: string,
        _rootId: string,
        file: string,
        content: string,
        expected: string
      ) => {
        if (files.get(file)?.revision !== expected) return { ok: false, reason: 'changed' }
        const revision = crypto.randomUUID()
        files.set(file, { content, revision })
        return { ok: true, revision }
      },
      confirmDiscard: async () => true
    },
    git: {
      available: async () => true,
      status: async () => ({
        isRepo: true,
        root: '/projects/roxy',
        branch: 'roxy/git-changes-and-file-explorer',
        dirty: true,
        changed: 4,
        ahead: 0,
        behind: 0,
        hasUpstream: false,
        defaultBranch: 'main'
      }),
      projectRepos: async () => ({ layout: 'single', roots: ['/projects/roxy'] })
    },
    forge: { status: async () => null },
    services: { list: async () => [] },
    context: { instructions: async () => [] }
  })
  messages = [
    {
      id: 'workspace-user',
      chatId: baseChat.id,
      role: 'user',
      createdAt: 1,
      content:
        'Add a compact Git summary and a file explorer, but keep the conversation front and center.',
      parts: [
        {
          type: 'text',
          text: 'Add a compact Git summary and a file explorer, but keep the conversation front and center.'
        }
      ]
    },
    {
      id: 'workspace-assistant',
      chatId: baseChat.id,
      role: 'assistant',
      createdAt: 2,
      content: 'The workspace inspector stays out of your way until you need it.',
      parts: [
        {
          type: 'text',
          text: 'The workspace inspector stays out of your way until you need it.\n\nClick the **+126 -33** in the titlebar to review changes, or switch to **Files** to explore the project. Each changed file opens a read-only diff.\n\nThe conversation remains the main workspace. Nothing is staged, edited, or committed from the inspector.'
        }
      ]
    }
  ]
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
      gitAvailable: workspaceFixture,
      messages: workspaceFixture ? messages : [],
      usageStats: workspaceFixture
        ? ({ providers: [], updatedAt: Date.now() } as unknown as ReturnType<
            typeof useRoxyStore.getState
          >['usageStats'])
        : null
    })
    if (workspaceFixture) {
      useRoxyStore.setState((state) => ({
        providers: state.providers.map((provider) => ({ ...provider, auth: 'api-key' }))
      }))
    }
    setReady(true)
  }, [])
  if (!ready) return <></>
  return (
    <HashRouter>
      <div className="bar" style={workspaceFixture ? { display: 'none' } : undefined}>
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
      <div id="main-sidebar-harness" className="flex min-h-0 flex-1">
        <Chat />
      </div>
    </HashRouter>
  )
}
