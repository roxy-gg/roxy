import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Copy,
  Folder,
  FolderOpen,
  GitBranch,
  GitCompareArrows,
  Loader2,
  PanelRight,
  Pencil
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Chat } from '@shared/types'
import type {
  InspectionResult,
  WorkspaceChange,
  WorkspaceEntry,
  WorkspaceRoot,
  WorkspaceSnapshot
} from '@shared/workspace-inspector'
import { statusKeyForSession } from '@shared/workstream'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { useRoxyStore } from '../lib/store'
import { DiffViewer } from './diff/DiffViewer'
import { FileIcon } from './FileIcon'
const FileEditor = lazy(() => import('./FileEditor'))

export function useWorkspaceInspection(
  chat: Chat | undefined,
  open: boolean
): {
  snapshot: WorkspaceSnapshot | null
  failed: boolean
} {
  const chats = useRoxyStore((state) => state.chats)
  let owner = chat
  const seen = new Set<string>()
  while (owner?.kind === 'sub' && owner.parentId && !seen.has(owner.id)) {
    seen.add(owner.id)
    owner = chats.find((candidate) => candidate.id === owner?.parentId)
  }
  const key = owner ? statusKeyForSession(owner) : null
  const status = useRoxyStore((state) => (key ? state.gitStatus[key] : undefined))
  const [snapshot, setSnapshot] = useState<{ scope: string; value: WorkspaceSnapshot } | null>(null)
  const [failed, setFailed] = useState(false)
  const [revision, setRevision] = useState(0)
  const sessionId = owner?.kind !== 'bot' && owner?.workspacePath ? owner.id : null
  const closedStatus = open ? undefined : status
  const scope = JSON.stringify([sessionId, owner?.workspacePath, owner?.worktreePath, owner?.repos])

  // Open inspectors also refresh non-Git folders and retry transient failures quietly.
  useEffect(() => {
    if (!sessionId || !open) return
    const refresh = (): void => {
      if (document.visibilityState === 'visible') setRevision((value) => value + 1)
    }
    const timer = setInterval(refresh, 5000)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [sessionId, open])

  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    void api.workspace
      .inspect(sessionId)
      .then((value) => {
        if (!cancelled) {
          setSnapshot({ scope, value })
          setFailed(false)
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, scope, closedStatus, revision, open])
  return {
    snapshot: snapshot?.scope === scope ? snapshot.value : null,
    failed
  }
}

function totals(snapshot: WorkspaceSnapshot | null): {
  additions: number
  deletions: number
  count: number
  partial: boolean
  unavailable: boolean
} {
  const roots = snapshot?.roots ?? []
  const changes = roots.flatMap((root) => root.changes)
  return {
    additions: changes.reduce((sum, change) => sum + (change.additions ?? 0), 0),
    deletions: changes.reduce((sum, change) => sum + (change.deletions ?? 0), 0),
    count: changes.length,
    partial: roots.some((root) => root.partial),
    unavailable: roots.some((root) => root.unavailable)
  }
}

export function WorkspaceSummary({
  snapshot,
  failed,
  open,
  onToggle
}: {
  snapshot: WorkspaceSnapshot | null
  failed: boolean
  open: boolean
  onToggle: () => void
}): JSX.Element {
  const { t } = useTranslation()
  const summary = totals(snapshot)
  const isRepo = snapshot?.roots.some((root) => root.isRepo)
  const showTotals = isRepo && (summary.additions > 0 || summary.deletions > 0)
  return (
    <button
      type="button"
      data-workspace-toggle
      aria-label={t('inspector.open')}
      aria-expanded={open}
      aria-controls="workspace-inspector"
      title={
        failed || summary.unavailable
          ? t('inspector.unavailable')
          : showTotals
            ? t('inspector.summary', { additions: summary.additions, deletions: summary.deletions })
            : t('inspector.open')
      }
      onClick={onToggle}
      className={cn(
        'press-scale flex h-7 shrink-0 items-center gap-2 sq sq-lg rounded-lg px-2 text-xs hover:bg-white/5',
        open ? 'bg-elevated text-text' : 'text-text-muted'
      )}
    >
      {failed || summary.unavailable ? (
        <GitCompareArrows className="h-3.5 w-3.5 text-text-subtle" />
      ) : showTotals ? (
        <span className="flex items-center gap-1.5 font-mono text-[11px] tabular-nums">
          <span className={summary.count ? 'text-success' : 'text-text-subtle'}>
            +{summary.additions.toLocaleString()}
          </span>
          <span className={summary.count ? 'text-danger' : 'text-text-subtle'}>
            -{summary.deletions.toLocaleString()}
          </span>
          {summary.partial && <span className="text-text-subtle">*</span>}
        </span>
      ) : null}
      <PanelRight className="h-3.5 w-3.5" />
    </button>
  )
}

export type WorkspaceSelection = { rootId: string; path: string; comparison: boolean }
const STATUS = {
  added: { letter: 'A', color: 'text-success' },
  modified: { letter: 'M', color: 'text-warning' },
  deleted: { letter: 'D', color: 'text-danger' },
  conflict: { letter: '!', color: 'text-danger' }
} as const

function ChangeRow({
  change,
  onSelect
}: {
  change: WorkspaceChange
  onSelect: () => void
}): JSX.Element {
  const { t } = useTranslation()
  const slash = change.path.lastIndexOf('/')
  const state = STATUS[change.status]
  return (
    <button
      type="button"
      onClick={onSelect}
      title={change.path}
      className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-white/5 focus-visible:outline-accent"
    >
      <FileIcon path={change.path} />
      <span className="min-w-0 flex-1 truncate">
        <span className="text-text">{change.path.slice(slash + 1)}</span>
        {slash >= 0 && (
          <span className="ml-1.5 text-[10px] text-text-subtle">{change.path.slice(0, slash)}</span>
        )}
      </span>
      {change.additions !== null && change.deletions !== null && (
        <span className="flex shrink-0 gap-1.5 font-mono text-[10px] tabular-nums">
          <span className="text-success">+{change.additions}</span>
          <span className="text-danger">-{change.deletions}</span>
        </span>
      )}
      <span
        title={t(`inspector.${change.status}`)}
        className={cn('w-3 shrink-0 text-center font-mono text-[10px]', state.color)}
      >
        {state.letter}
      </span>
    </button>
  )
}

function Directory({
  sessionId,
  root,
  directory = '',
  depth = 0,
  onSelect
}: {
  sessionId: string
  root: WorkspaceRoot
  directory?: string
  depth?: number
  onSelect: (selection: WorkspaceSelection) => void
}): JSX.Element {
  const { t } = useTranslation()
  const [result, setResult] = useState<InspectionResult<{
    entries: WorkspaceEntry[]
    partial: boolean
  }> | null>(null)
  useEffect(() => {
    let cancelled = false
    void api.workspace
      .list(sessionId, root.id, directory)
      .then((value) => {
        if (!cancelled) setResult(value)
      })
      .catch(() => {
        if (!cancelled) setResult({ ok: false, reason: 'unavailable' })
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, root, directory])
  if (!result)
    return <div className="px-3 py-2 text-[11px] text-text-subtle">{t('inspector.loading')}</div>
  if (!result.ok)
    return (
      <div role="status" className="px-3 py-2 text-[11px] text-text-subtle">
        {t(`inspector.${result.reason}`)}
      </div>
    )
  return (
    <>
      {result.entries.map((entry) =>
        entry.kind === 'directory' ? (
          <DirectoryBranch key={entry.path} {...{ sessionId, root, depth, entry, onSelect }} />
        ) : (
          <button
            type="button"
            key={entry.path}
            disabled={entry.kind === 'link'}
            title={entry.path}
            onClick={() => onSelect({ rootId: root.id, path: entry.path, comparison: false })}
            className="flex h-7 w-full items-center gap-2 rounded-md pr-2 text-left text-xs hover:bg-white/5 disabled:opacity-40"
            style={{ paddingLeft: 24 + depth * 14 }}
          >
            <FileIcon path={entry.name} />
            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            {root.changes.some((change) => change.path === entry.path) && (
              <span className="h-1 w-1 shrink-0 rounded-full bg-success" />
            )}
          </button>
        )
      )}
      {result.partial && (
        <p className="p-3 text-[11px] text-text-subtle">{t('inspector.partial')}</p>
      )}
      {!result.entries.length && (
        <p className="px-3 py-2 text-[11px] text-text-subtle">{t('inspector.emptyFolder')}</p>
      )}
    </>
  )
}

function DirectoryBranch({
  sessionId,
  root,
  depth,
  entry,
  onSelect
}: {
  sessionId: string
  root: WorkspaceRoot
  depth: number
  entry: WorkspaceEntry
  onSelect: (selection: WorkspaceSelection) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const changed = root.changes.some((change) => change.path.startsWith(entry.path + '/'))
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={entry.path}
        className="flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left text-xs hover:bg-white/5"
        style={{ paddingLeft: 6 + depth * 14 }}
      >
        <ChevronRight className={cn('h-3 w-3 shrink-0 text-text-subtle', open && 'rotate-90')} />
        {open ? (
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-text-muted" />
        ) : (
          <Folder className="h-3.5 w-3.5 shrink-0 text-text-muted" />
        )}
        <span className={cn('min-w-0 flex-1 truncate', changed && 'text-warning')}>
          {entry.name}
        </span>
      </button>
      {open && (
        <Directory {...{ sessionId, root, onSelect }} directory={entry.path} depth={depth + 1} />
      )}
    </>
  )
}

export function WorkspaceFileCanvas({
  sessionId,
  selection,
  snapshot,
  onBack,
  onEdit
}: {
  sessionId: string
  selection: WorkspaceSelection
  snapshot: WorkspaceSnapshot | null
  onBack: () => void
  onEdit: () => void
}): JSX.Element {
  const { t } = useTranslation()
  const [result, setResult] = useState<InspectionResult<{ before: string; after: string }> | null>(
    null
  )
  const [copied, setCopied] = useState(false)
  const refreshComparison = useRef<(() => void) | null>(null)
  const host = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(400)
  useEffect(() => {
    const node = host.current
    if (!node) return
    node.parentElement?.querySelector<HTMLButtonElement>('button')?.focus()
    const observer = new ResizeObserver(([entry]) =>
      setHeight(Math.max(160, entry.contentRect.height))
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!selection.comparison) return
    let cancelled = false
    let reading = false
    const refresh = (): void => {
      // Polling must not cancel a slow first read or queue overlapping Git processes.
      if (reading) return
      reading = true
      void api.workspace
        .read(sessionId, selection.rootId, selection.path, true)
        .then((value) => {
          if (!cancelled) setResult(value)
        })
        .catch(() => {
          if (!cancelled) setResult({ ok: false, reason: 'unavailable' })
        })
        .finally(() => {
          reading = false
        })
    }
    setResult(null)
    refreshComparison.current = refresh
    refresh()
    return () => {
      cancelled = true
      refreshComparison.current = null
    }
  }, [sessionId, selection.rootId, selection.path, selection.comparison])
  useEffect(() => {
    refreshComparison.current?.()
  }, [snapshot])
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1200)
    return () => clearTimeout(timer)
  }, [copied])
  if (!selection.comparison)
    return (
      <Suspense
        fallback={
          <div
            data-workspace-canvas
            className="absolute inset-0 z-20 bg-bg p-4 text-xs text-text-subtle"
          >
            {t('inspector.loading')}
          </div>
        }
      >
        <FileEditor {...{ sessionId, selection, snapshot, onBack }} />
      </Suspense>
    )
  return (
    <div
      data-workspace-canvas
      className="absolute inset-0 z-20 flex min-h-0 min-w-0 flex-col bg-bg"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.stopPropagation()
          onBack()
        }
      }}
    >
      <div className="workspace-file-toolbar titlebar reserve-controls-right flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        <button
          type="button"
          onClick={onBack}
          title={t('inspector.backToChat')}
          aria-label={t('inspector.backToChat')}
          className="press-scale rounded p-1 text-text-muted hover:bg-white/5 hover:text-text"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <FileIcon path={selection.path} />
        <span title={selection.path} className="min-w-0 flex-1 truncate font-mono text-[11px]">
          {selection.path}
        </span>
        {result?.ok && (
          <button
            type="button"
            title={t('inspector.edit')}
            aria-label={t('inspector.edit')}
            onClick={onEdit}
            className="press-scale shrink-0 rounded p-1 text-text-muted hover:bg-white/5"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        )}
        {result?.ok && (
          <button
            type="button"
            title={t('inspector.copy')}
            aria-label={t('inspector.copy')}
            onClick={() =>
              void navigator.clipboard
                .writeText(result.after)
                .then(() => setCopied(true))
                .catch(() => {})
            }
            className="press-scale rounded p-1 text-text-muted hover:bg-white/5"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-success" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </button>
        )}
      </div>
      <div ref={host} className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {!result ? (
          <p className="p-4 text-xs text-text-subtle">{t('inspector.loading')}</p>
        ) : !result.ok ? (
          <p role="status" className="p-4 text-xs text-text-muted">
            {t(`inspector.${result.reason}`)}
          </p>
        ) : (
          <DiffViewer
            path={selection.path}
            before={result.before}
            after={result.after}
            height={height}
          />
        )}
      </div>
    </div>
  )
}

export function WorkspaceInspector({
  sessionId,
  snapshot,
  failed,
  onSelect,
  onClose
}: {
  sessionId: string
  snapshot: WorkspaceSnapshot | null
  failed: boolean
  onSelect: (selection: WorkspaceSelection) => void
  onClose: () => void
}): JSX.Element {
  const { t } = useTranslation()
  const [tab, setTab] = useState<'changes' | 'files'>('files')
  const panel = useRef<HTMLElement>(null)
  const summary = totals(snapshot)
  const defaultWidth =
    document.documentElement.dataset.platform === 'win32' ||
    document.documentElement.dataset.platform === 'linux'
      ? 380
      : 340
  const [preferredWidth, setPreferredWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem('roxy.inspector.width'))
      if (Number.isFinite(saved) && saved >= 320 && saved <= 640) return saved
    } catch {
      /* Resizing also works without persistence. */
    }
    return defaultWidth
  })
  const [availableWidth, setAvailableWidth] = useState(640)
  const minWidth = Math.min(320, availableWidth)
  const maxWidth = Math.min(640, availableWidth)
  const width = Math.max(minWidth, Math.min(maxWidth, preferredWidth))
  const drag = useRef<{ x: number; width: number; cursor: string; userSelect: string } | null>(null)
  const stopResize = (): void => {
    if (!drag.current) return
    document.body.style.cursor = drag.current.cursor
    document.body.style.userSelect = drag.current.userSelect
    drag.current = null
  }
  const resize = (value: number): void => {
    const next = Math.max(minWidth, Math.min(maxWidth, value))
    setPreferredWidth(next)
    try {
      localStorage.setItem('roxy.inspector.width', String(next))
    } catch {
      /* Keep the in-memory preference. */
    }
  }
  useLayoutEffect(() => {
    const host = panel.current?.parentElement
    if (!host) return
    const measure = (): void => {
      const available = host.clientWidth
      setAvailableWidth(Math.max(1, available - (available >= 960 ? 420 : 0)))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    window.addEventListener('blur', stopResize)
    return () => {
      window.removeEventListener('blur', stopResize)
      stopResize()
    }
  }, [])
  useEffect(() => {
    panel.current?.focus()
    return () => {
      document.querySelector<HTMLButtonElement>('[data-workspace-toggle]')?.focus()
    }
  }, [])
  return (
    <aside
      ref={panel}
      tabIndex={-1}
      id="workspace-inspector"
      aria-label={t('inspector.open')}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.stopPropagation()
          onClose()
        }
      }}
      style={{ width }}
      className="workspace-inspector absolute inset-y-0 right-0 z-30 flex max-w-full shrink-0 flex-col border-l border-border bg-bg shadow-[-12px_0_32px_#00000018] outline-none"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('inspector.resizeHandle')}
        aria-controls="workspace-inspector"
        aria-valuemin={minWidth}
        aria-valuemax={maxWidth}
        aria-valuenow={width}
        tabIndex={0}
        title={t('inspector.resizeHandle')}
        onPointerDown={(event) => {
          if (event.button !== 0 || !event.isPrimary) return
          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
          drag.current = {
            x: event.clientX,
            width,
            cursor: document.body.style.cursor,
            userSelect: document.body.style.userSelect
          }
          document.body.style.cursor = 'col-resize'
          document.body.style.userSelect = 'none'
        }}
        onPointerMove={(event) => {
          if (drag.current) resize(drag.current.width + drag.current.x - event.clientX)
        }}
        onPointerUp={(event) => {
          stopResize()
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId)
        }}
        onPointerCancel={stopResize}
        onLostPointerCapture={stopResize}
        onDoubleClick={() => resize(defaultWidth)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault()
            resize(width + (event.key === 'ArrowLeft' ? 10 : -10))
          } else if (event.key === 'Home' || event.key === 'End') {
            event.preventDefault()
            resize(event.key === 'Home' ? minWidth : maxWidth)
          }
        }}
        className="workspace-resize-handle absolute inset-y-0 left-0 z-40 w-1 touch-none cursor-col-resize hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none"
      />
      <div className="workspace-toolbar titlebar reserve-controls-right flex h-12 shrink-0 items-center gap-1 border-b border-border px-2">
        <button
          type="button"
          aria-label={t('inspector.close')}
          title={t('inspector.close')}
          onClick={onClose}
          className="press-scale shrink-0 rounded p-1.5 text-text-subtle hover:bg-white/5 hover:text-text"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <div
          className="flex min-w-0 flex-1 gap-1"
          role="tablist"
          aria-label={t('inspector.open')}
          onKeyDown={(event) => {
            if (
              event.key !== 'ArrowLeft' &&
              event.key !== 'ArrowRight' &&
              event.key !== 'Home' &&
              event.key !== 'End'
            )
              return
            event.preventDefault()
            const next =
              event.key === 'Home'
                ? 'changes'
                : event.key === 'End'
                  ? 'files'
                  : tab === 'changes'
                    ? 'files'
                    : 'changes'
            setTab(next)
            panel.current?.querySelector<HTMLButtonElement>(`#inspector-tab-${next}`)?.focus()
          }}
        >
          {(['changes', 'files'] as const).map((value) => (
            <button
              type="button"
              role="tab"
              aria-selected={tab === value}
              key={value}
              id={`inspector-tab-${value}`}
              aria-controls="inspector-content"
              tabIndex={tab === value ? 0 : -1}
              onClick={() => {
                setTab(value)
              }}
              className={cn(
                'press-scale flex h-7 min-w-0 items-center gap-1 sq sq-md rounded-md px-1.5 text-xs',
                tab === value ? 'bg-elevated text-text' : 'text-text-subtle hover:text-text'
              )}
            >
              <span className="truncate">{t(`inspector.${value}`)}</span>
              {value === 'changes' && (
                <span className="text-[10px] tabular-nums text-text-subtle">{summary.count}</span>
              )}
            </button>
          ))}
        </div>
      </div>
      <div
        id="inspector-content"
        role="tabpanel"
        aria-labelledby={`inspector-tab-${tab}`}
        className="min-h-0 flex-1 overflow-auto px-2 py-2"
      >
        {!snapshot && !failed && (
          <div className="flex items-center gap-2 p-3 text-xs text-text-subtle">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t('inspector.loading')}
          </div>
        )}
        {failed && (
          <p role="status" className="p-3 text-xs text-text-subtle">
            {t('inspector.unavailable')}
          </p>
        )}
        {snapshot?.roots.map((root) => (
          <section key={root.id} className="mb-3">
            <div className="flex h-8 items-center gap-1.5 px-2 text-[10px] text-text-subtle">
              <ChevronRight className="h-3 w-3 rotate-90" />
              <span className="min-w-0 truncate font-semibold uppercase tracking-wider text-text-muted">
                {root.name}
              </span>
              {root.branch && (
                <span
                  title={root.branch}
                  className="ml-auto flex min-w-0 items-center gap-1 truncate"
                >
                  <GitBranch className="h-3 w-3 shrink-0" />
                  <span className="max-w-28 truncate">{root.branch}</span>
                </span>
              )}
            </div>
            {root.unavailable ? (
              <p className="p-3 text-xs text-text-subtle">{t('inspector.unavailable')}</p>
            ) : tab === 'files' ? (
              <Directory key={root.id} {...{ sessionId, root, onSelect }} />
            ) : (
              <>
                {root.changes.map((change) => (
                  <ChangeRow
                    key={change.path}
                    change={change}
                    onSelect={() =>
                      onSelect({ rootId: root.id, path: change.path, comparison: true })
                    }
                  />
                ))}
                {!root.changes.length && (
                  <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
                    <GitCompareArrows className="mb-1 h-5 w-5 text-text-subtle/60" />
                    <span className="text-xs text-text-muted">
                      {t(root.isRepo ? 'inspector.clean' : 'inspector.noGit')}
                    </span>
                    <span className="text-[11px] text-text-subtle">
                      {t(root.isRepo ? 'inspector.cleanBody' : 'inspector.noGitBody')}
                    </span>
                  </div>
                )}
                {root.partial && (
                  <p className="p-3 text-[11px] text-text-subtle">{t('inspector.partial')}</p>
                )}
              </>
            )}
          </section>
        ))}
      </div>
    </aside>
  )
}
