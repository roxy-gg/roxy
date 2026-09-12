import { useEffect, useLayoutEffect, useState } from 'react'
import {
  Check,
  ChevronRight,
  CornerUpLeft,
  FolderOpen,
  Hammer,
  ListTree,
  Loader2,
  Repeat,
  RotateCw,
  Settings,
  Square
} from 'lucide-react'
import type { Chat } from '@shared/types'
import { useRoxyStore } from '../lib/store'
import { useTranslation, Trans } from 'react-i18next'
import { formatInterval } from '@shared/format'
import { cn } from '../lib/cn'
import { CanvasTranscript } from '../canvas/CanvasTranscript'
import { Composer } from './Composer'
import { LoopDetailsPane } from './LoopDetailsPane'
import { SessionInfo } from './SessionInfo'
import { WorkstreamStrip } from './WorkstreamStrip'
import { QueuedMessage } from './QueuedMessage'
import { UsageMeter } from './UsageMeter'
import {
  Queue,
  QueueList,
  QueueSection,
  QueueSectionContent,
  QueueSectionLabel,
  QueueSectionTrigger
} from './Queue'
import { Button } from './ui'
import roxy from '../assets/roxy.png'

/**
 * The transcript renders to a CANVAS, not to the DOM.
 *
 * The DOM version's cost grew with how much conversation EXISTED rather than
 * with how much of it you could see. A single agent turn can carry dozens of
 * tool cards, each with its own borders, its own scroll container and a
 * syntax-highlighted body living in a shadow root, and every streamed token
 * re-rendered the live turn and re-laid out the page around it. It needed a hard
 * 30-message window just to stay usable -- which is why an ordinary session
 * showed "showing the last 30 of N" while its own content did not even fill the
 * viewport.
 *
 * The canvas renderer is retained-mode: layout runs when content actually
 * changes, paint touches only the blocks the viewport intersects, and a settled
 * message's layout is cached by REFERENCE (its parts array never changes once
 * written to SQLite) so a streaming turn never re-measures the history above it.
 *
 * Large histories retain a height index for every message, but only nearby
 * parts are measured into scene nodes. This includes long single-turn agent
 * transcripts: opening a session must not re-layout thousands of old steps.
 *
 * The renderer lives in src/renderer/src/canvas/ -- text measurement, the
 * markdown and syntax-highlighting layers, the tool-card layouts, and the
 * painter.
 */

export function ChatView(): JSX.Element {
  const { t } = useTranslation()
  const messages = useRoxyStore((s) => s.messages)
  const messagesChatId = useRoxyStore((s) => s.messagesChatId)
  const messagesError = useRoxyStore((s) => s.messagesError)
  const streaming = useRoxyStore((s) =>
    s.activeChatId ? (s.streamingChats[s.activeChatId] ?? null) : null
  )
  const sending = useRoxyStore((s) => (s.activeChatId ? !!s.sendingChats[s.activeChatId] : false))
  const submit = useRoxyStore((s) => s.submit)
  const stop = useRoxyStore((s) => s.stop)
  const queue = useRoxyStore((s) => s.queue)
  const newSession = useRoxyStore((s) => s.newSession)
  const selectChat = useRoxyStore((s) => s.selectChat)
  const activeChatId = useRoxyStore((s) => s.activeChatId)
  const chats = useRoxyStore((s) => s.chats)
  const loops = useRoxyStore((s) => s.loops)
  // Subscribe to the STORED array, not a defaulted copy. A selector returning
  // `?? []` builds a new array every call, so zustand's Object.is check never
  // matches and the component re-renders forever ("getSnapshot should be
  // cached" -> "Maximum update depth exceeded"). undefined is a stable value;
  // the empty-array default belongs below, outside the subscription.
  const runningTasks = useRoxyStore((s) =>
    s.activeChatId ? s.runningTasks[s.activeChatId] : undefined
  )
  const backgroundTaskCount = runningTasks?.length ?? 0
  // A subagent working in ITS OWN session. Tracked separately from `sending`
  // (which is per-chat local-send state): nobody "sent" this turn from the UI —
  // the parent agent delegated it — so the only signal is the live run itself.
  const subagentRunning = useRoxyStore((s) =>
    s.activeChatId ? !!s.runningSubagents[s.activeChatId] : false
  )
  const [subagentSeconds, setSubagentSeconds] = useState(0)
  useEffect(() => {
    setSubagentSeconds(0)
    if (!subagentRunning) return
    const startedAt = Date.now()
    const clock = setInterval(
      () => setSubagentSeconds(Math.floor((Date.now() - startedAt) / 1000)),
      1000
    )
    return () => clearInterval(clock)
  }, [activeChatId, subagentRunning])
  const cancelSubagent = useRoxyStore((s) => s.cancelSubagent)
  const cancelBackgroundTask = useRoxyStore((s) => s.cancelBackgroundTask)
  const cancelToolCall = useRoxyStore((s) => s.cancelToolCall)

  const hasContent = messages.length > 0 || (streaming !== null && streaming.length > 0)
  // Wait for history even when live tokens are available, so arrival paints the complete tail once.
  const loading = !messagesError && messagesChatId !== activeChatId
  const isEmpty = !hasContent && !loading
  const [loopPaneOpen, setLoopPaneOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)

  // The keyed canvas owns bottom-first arrival and resize anchoring. Queue changes must not re-pin it.
  useLayoutEffect(() => {
    setInfoOpen(false)
  }, [activeChatId])
  const activeChat = chats.find((c) => c.id === activeChatId)
  const isSub = activeChat?.kind === 'sub'
  const parentChat = activeChat?.parentId
    ? chats.find((c) => c.id === activeChat.parentId)
    : undefined
  const activeLoop = loops.find((l) => l.chatId === activeChatId)
  const sessionTasks = activeChat?.tasks ?? []
  const tasksDone = sessionTasks.filter((t) => t.status === 'completed').length
  // Any session can carry a description + checklist: the `general` subagent has
  // the metadata tool too, and its plan is exactly what you open its session to
  // read. Gate on having something to show, not on the session's kind.
  const hasSessionInfo = !!activeChat?.description?.trim() || sessionTasks.length > 0

  // No workspace open — prompt to open a folder to start a session.
  if (!activeChat) {
    return (
      <div className="flex h-full min-w-0 flex-1 flex-col bg-bg">
        <div className="titlebar reserve-controls-right h-12 shrink-0" />
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
          <img
            src={roxy}
            alt="Roxy"
            className="h-16 w-16 rounded-2xl object-cover shadow-lg ring-1 ring-border"
          />
          <h1 className="mt-5 text-xl font-semibold">{t('chat.emptyTitle')}</h1>
          <p className="mt-1.5 max-w-xs text-sm text-text-muted">{t('chat.emptyBody')}</p>
          <Button variant="primary" className="mt-5" onClick={newSession}>
            <FolderOpen className="h-4 w-4" /> {t('chat.openFolder')}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col bg-bg">
      <header className="titlebar reserve-controls-right flex h-12 shrink-0 items-center justify-between gap-3 px-4">
        {activeLoop ? (
          <div className="flex min-w-0 items-center gap-2">
            <Repeat className="h-4 w-4 shrink-0 text-text-muted" />
            <span className="shrink-0 text-sm font-medium">{activeChat.title}</span>
            <span className="truncate text-xs text-text-subtle">
              {t('chat.loopEvery', { interval: formatInterval(activeLoop.intervalMinutes) })}
              {activeLoop.enabled ? t('chat.loopRunning') : t('chat.loopPaused')}
            </span>
          </div>
        ) : (
          <div className="flex min-w-0 items-center gap-2">
            {isSub ? (
              <Hammer className="h-4 w-4 shrink-0 text-text-muted" />
            ) : (
              <FolderOpen className="h-4 w-4 shrink-0 text-text-muted" />
            )}
            <span className="shrink-0 text-sm font-medium">{activeChat.title}</span>
            {/* A delegate's session is only legible in context — who sent it, and
                a way back. The folder path is the parent's business. */}
            {isSub ? (
              parentChat && (
                <button
                  onClick={() => void selectChat(parentChat.id)}
                  title={t('chat.backTo', { title: parentChat.title })}
                  className="flex min-w-0 items-center gap-1 truncate text-xs text-text-subtle transition-colors hover:text-text"
                >
                  <CornerUpLeft className="h-3 w-3 shrink-0" />
                  <span className="truncate">{parentChat.title}</span>
                </button>
              )
            ) : (
              <WorkspacePath chat={activeChat} />
            )}
            {subagentRunning && activeChatId && (
              // Clickable, because this used to be the one running thing in the
              // app with no way to stop it: a subagent's turn is driven by its
              // parent, so the composer's Stop was deliberately withheld here
              // (it had no request of its own to abort) and the session was
              // simply uninterruptible from its own view.
              <button
                onClick={() => void cancelSubagent(activeChatId)}
                title={t('chat.cancelSubagent')}
                className="press-scale group flex shrink-0 items-center gap-1 sq sq-md rounded-md bg-accent/10 px-1.5 py-0.5 text-[11px] text-accent transition-colors hover:bg-accent/20"
              >
                <Loader2 className="h-3 w-3 animate-spin group-hover:hidden" />
                <Square className="hidden h-2.5 w-2.5 fill-current group-hover:block" />
                <span className="group-hover:hidden">{t('chat.working')}</span>
                {subagentSeconds > 0 && (
                  <span className="font-mono tabular-nums text-accent/70 group-hover:hidden">
                    {subagentSeconds}s
                  </span>
                )}
                <span className="hidden group-hover:inline">{t('chat.cancel')}</span>
              </button>
            )}
            {hasSessionInfo && (
              <button
                onClick={() => setInfoOpen((o) => !o)}
                title={t('chat.descriptionAndTasks')}
                className={cn(
                  'flex shrink-0 items-center gap-1 sq sq-md rounded-md px-1.5 py-0.5 text-[11px] transition-colors',
                  infoOpen
                    ? 'bg-elevated text-text'
                    : 'text-text-muted hover:bg-white/5 hover:text-text'
                )}
              >
                <ListTree className="h-3.5 w-3.5" />
                {sessionTasks.length > 0 && (
                  <span className="tabular-nums">
                    {tasksDone}/{sessionTasks.length}
                  </span>
                )}
                <ChevronRight
                  className={cn(
                    'h-3 w-3 transition-transform duration-200 ease-out-quart',
                    infoOpen && 'rotate-90'
                  )}
                />
              </button>
            )}
            {backgroundTaskCount > 0 && activeChatId && (
              // Detached tasks were cancellable in main from day one
              // (`tasks:cancel`) but nothing ever called it — this badge counted
              // them and offered no way out. Cancels them all: they're detached
              // by definition, so "stop the thing I didn't ask for" is the whole
              // interaction, and per-task control lives on the task card.
              <button
                onClick={() => {
                  for (const t of runningTasks ?? []) {
                    void cancelBackgroundTask(activeChatId, t.jobId)
                  }
                }}
                title={t('chat.cancelBackground', { count: backgroundTaskCount })}
                className="press-scale group flex shrink-0 items-center gap-1 sq sq-md rounded-md bg-accent/10 px-1.5 py-0.5 text-[11px] text-accent transition-colors hover:bg-accent/20"
              >
                <Loader2 className="h-3 w-3 animate-spin group-hover:hidden" />
                <Square className="hidden h-2.5 w-2.5 fill-current group-hover:block" />
                <span className="tabular-nums">{backgroundTaskCount}</span>
              </button>
            )}
          </div>
        )}
        <div className="flex shrink-0 items-center gap-2">
          {activeLoop && (
            <button
              onClick={() => setLoopPaneOpen((o) => !o)}
              title={t('chat.loopSettings')}
              className={cn(
                'press-scale flex h-7 shrink-0 items-center gap-1.5 sq sq-lg rounded-lg px-2 text-xs',
                loopPaneOpen
                  ? 'bg-elevated text-text'
                  : 'text-text-muted hover:bg-white/5 hover:text-text'
              )}
            >
              <Settings className="h-3.5 w-3.5" /> {t('chat.settings')}
            </button>
          )}
          <UsageMeter />
        </div>
      </header>

      {infoOpen && <SessionInfo chat={activeChat} />}

      {messagesError ? (
        // A failed load used to be indistinguishable from an empty session:
        // silent, blank, and with no way back other than clicking away and
        // returning. Name it and make it recoverable.
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="max-w-xs text-sm text-text-muted">{t('chat.loadFailed')}</p>
          <Button variant="ghost" onClick={() => void selectChat(activeChat.id)}>
            <RotateCw className="h-4 w-4" /> {t('common.retry')}
          </Button>
        </div>
      ) : loading ? (
        // Deliberately blank: a transcript read is a local SQLite query, so it
        // resolves within a frame or two and a spinner would be a flash of
        // chrome rather than information. This branch exists to stop the EMPTY
        // state (and its loop copy) from claiming the session has no messages
        // before we know that.
        <div className="min-h-0 flex-1" />
      ) : isEmpty ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
          {activeLoop ? (
            <p className="max-w-xs text-sm text-text-muted">
              <Trans
                i18nKey="chat.loopEmpty"
                values={{
                  title: activeChat.title,
                  interval: formatInterval(activeLoop.intervalMinutes)
                }}
                components={{ strong: <span className="font-medium text-text" /> }}
              />
            </p>
          ) : (
            <p className="text-sm text-text-muted"></p>
          )}
        </div>
      ) : (
        <CanvasTranscript
          messages={messages}
          streaming={streaming}
          chatId={activeChatId}
          onCancelSubagent={(subChatId) => void cancelSubagent(subChatId)}
          onCancelTool={(callId) => void cancelToolCall(callId)}
        />
      )}
      {/* The transcript used to end on a hard clip: the scrollport edge sliced
          text mid-glyph, straight into the composer’s flat gutter, and the two
          together read as a black bar cutting the pane in half. This is a
          gradient of the pane’s own background laid over the last 24px of the
          scroller, so lines dissolve into the composer instead of being cut.

          Pulled back up by its own height (-mt-6) so it costs no layout — the
          scroller keeps every pixel of flex-1 — and inert to the pointer, so
          scrolling and text selection still work underneath it. The matching
          pb-6 on the message column is what keeps the last line legible: at
          max scroll it ends above the gradient instead of under it.

          The mr-2.5 is the scrollbar gutter (10px, see ::-webkit-scrollbar
          in main.css). The bar occupies the scroller’s right edge, so a
          full-width fade would paint over its last 24px and wash out the
          thumb exactly when you drag it to the end. */}
      <div
        aria-hidden
        className="pointer-events-none relative z-10 -mt-6 mr-2.5 h-6 shrink-0 bg-gradient-to-b from-transparent to-bg"
      />

      {queue.length > 0 && (
        <div className="bg-bg px-4 pt-2">
          <div className="mx-auto max-w-3xl">
            <Queue>
              <QueueSection defaultOpen>
                <QueueSectionTrigger>
                  <QueueSectionLabel
                    label={t('chat.queued')}
                    count={queue.length}
                    icon={<ListTree className="h-3.5 w-3.5 text-text-subtle" />}
                  />
                  {sending && (
                    <span className="ml-auto text-[10px] text-text-subtle">
                      {t('chat.runsAfterReply')}
                    </span>
                  )}
                </QueueSectionTrigger>
                <QueueSectionContent>
                  <QueueList>
                    {queue.map((item, i) => (
                      <QueuedMessage key={item.id} item={item} index={i} total={queue.length} />
                    ))}
                  </QueueList>
                </QueueSectionContent>
              </QueueSection>
            </Queue>
          </div>
        </div>
      )}

      {/* A subagent's session can now be stopped from its own composer: the Stop
          cancels the DELEGATE (there is no local request here to abort), which
          is what the button visibly means in this view. */}
      <Composer
        onSend={submit}
        sending={sending || subagentRunning}
        onStop={
          subagentRunning && activeChatId ? () => void cancelSubagent(activeChatId) : () => stop()
        }
      />

      <WorkstreamStrip />

      {loopPaneOpen && activeLoop && (
        <LoopDetailsPane
          loop={activeLoop}
          chat={activeChat}
          onClose={() => setLoopPaneOpen(false)}
        />
      )}
    </div>
  )
}

/**
 * The folder this session's agent actually runs in, click to copy.
 *
 * Shows `worktreePath` in preference to `workspacePath`. Those differ for every
 * workstream: the project folder is the repo you opened, but the agent's cwd is
 * an isolated checkout under `worktrees/`. Showing the project path meant the
 * header named a directory the session was NOT editing — actively misleading
 * when several workstreams are open and you are trying to work out which
 * checkout a dev server or an editor tab belongs to.
 *
 * Copying is the point: these paths are long, truncated by the header, and
 * mostly wanted for pasting into a terminal. Selecting truncated text by hand
 * is fiddly, so the whole thing is one click.
 */
function WorkspacePath({ chat }: { chat: Chat }): JSX.Element | null {
  const { t } = useTranslation()
  const path = chat.worktreePath ?? chat.workspacePath
  const [copied, setCopied] = useState(0)

  // Keyed on the click COUNT, not a boolean: clicking again while the
  // confirmation is still up restarts the window, instead of the first click's
  // timer cutting the second one short.
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(0), 1200)
    return () => clearTimeout(t)
  }, [copied])

  if (!path) return null

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(path)
      setCopied((n) => n + 1)
    } catch {
      // Clipboard can be denied; the path stays readable in the tooltip.
    }
  }

  // For a multi-repo session this path is a COMPOSITE root: not a checkout
  // itself, but the folder holding one per repo. It is still the right thing to
  // copy (it is what you open in an editor to see the whole workstream), but
  // the tooltip has to say so - on its own it names a directory that contains
  // none of the code directly and is not even a git repository.
  const repos = chat.repos ?? []
  const detail =
    repos.length > 1 ? t('chat.pathContains', { names: repos.map((r) => r.name).join(', ') }) : ''

  return (
    <button
      onClick={() => void copy()}
      // The label is truncated, so the tooltip carries the full path.
      title={t('chat.pathTooltip', { path, detail })}
      className="press-scale relative flex min-w-0 items-center sq sq-md rounded-md px-1 py-0.5 text-xs text-text-subtle hover:bg-white/5 hover:text-text-muted"
    >
      {/* The path fades rather than unmounting, so the button keeps its width
          and nothing in the header shifts while the confirmation shows. */}
      <span
        className={cn(
          'truncate transition-opacity duration-150 ease-out-quart',
          copied && 'opacity-0'
        )}
      >
        {path}
      </span>
      {/* Confirmation sits ON TOP of the path, left-aligned to it, so it reads
          as the same object changing state. Fires often enough that a moving
          toast would be noise -- this is the smallest thing that still answers
          "did that work?". */}
      <span
        aria-live="polite"
        className={cn(
          'absolute inset-y-0 left-1 flex items-center gap-1 text-success transition-[opacity,transform] duration-150 ease-out-quart',
          copied ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-0.5 opacity-0'
        )}
      >
        <Check className="h-3 w-3 shrink-0" />
        {t('chat.copied')}
      </span>
    </button>
  )
}
