import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { FileDiff, Loader2, RefreshCw } from 'lucide-react'
import type { GitReviewScope, ReviewCommit, ReviewFile, ReviewTarget } from '@shared/api'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { GIT_POLL_MS } from '../lib/polling'
import { ReviewFileRow } from './ReviewFileRow'

/** Scopes in the order the picker lists them. */
const SCOPES: { id: GitReviewScope; label: string; hint: string }[] = [
  { id: 'unstaged', label: 'Uncommitted', hint: 'Edited but not staged' },
  { id: 'staged', label: 'Staged', hint: "What's in the index" },
  { id: 'branch', label: 'Branch', hint: 'Everything on this branch' },
  { id: 'commit', label: 'Commit', hint: 'A single commit' }
]

/**
 * A store-free review surface for the browser window's separate renderer.
 * Everything it needs is session-keyed and arrives through `api.review.*`.
 */
export function ReviewPane({
  sessionId,
  className,
  action
}: {
  /** Whose changes to show. Null renders the "no session" state. */
  sessionId: string | null
  className?: string
  /** A close button (or anything else) for the pane's header. */
  action?: ReactNode
}): JSX.Element {
  const [scope, setScope] = useState<GitReviewScope>('unstaged')
  const [commitKey, setCommitKey] = useState('')
  const [files, setFiles] = useState<ReviewFile[] | null>(null)
  const [commits, setCommits] = useState<ReviewCommit[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const loadSeq = useRef(0)

  const selectedCommit = useMemo(
    () => commits?.find((candidate) => commitKeyOf(candidate) === commitKey),
    [commits, commitKey]
  )

  const target: ReviewTarget | null = useMemo(
    () =>
      sessionId
        ? {
            sessionId,
            scope,
            commit: selectedCommit?.sha,
            repo: scope === 'commit' ? selectedCommit?.repo : undefined
          }
        : null,
    [sessionId, scope, selectedCommit]
  )

  const load = useCallback(async (): Promise<void> => {
    const seq = ++loadSeq.current
    if (!target) return setFiles([])
    if (target.scope === 'commit' && !target.commit) return setFiles([])

    try {
      const next = await api.review.files(target)
      if (seq === loadSeq.current) setFiles(next)
    } catch {
      // Keep the last list through a transient failure; the poll retries.
      if (seq === loadSeq.current) {
        setError('Could not read changes')
        setFiles((current) => current ?? [])
      }
    }
  }, [target])

  useEffect(() => {
    setFiles(null)
    void load()
    const timer = setInterval(() => void load(), GIT_POLL_MS)
    return () => clearInterval(timer)
  }, [load])

  // `git log` is only needed when the commit picker is visible.
  useEffect(() => {
    if (scope !== 'commit' || commits || !sessionId) return
    let alive = true
    void api.review
      .commits(sessionId, undefined, 30)
      .then((next) => alive && setCommits(next))
      .catch(() => alive && setCommits([]))
    return () => {
      alive = false
    }
  }, [scope, commits, sessionId])

  useEffect(() => {
    setCommits(null)
    setCommitKey('')
  }, [sessionId])

  const bulk = async (
    fn: (t: ReviewTarget, files: string[]) => Promise<{ ok: boolean; error?: string }>
  ): Promise<void> => {
    if (!target) return
    setBusy(true)
    setError(null)
    try {
      // An empty list means everything: one Git call per repository.
      const result = await fn(target, [])
      if (!result.ok) setError(result.error ?? 'Failed')
      await load()
    } catch {
      setError('Could not update changes')
    } finally {
      setBusy(false)
    }
  }

  const additions = files?.reduce((n, file) => n + file.additions, 0) ?? 0
  const deletions = files?.reduce((n, file) => n + file.deletions, 0) ?? 0

  return (
    <div className={cn('flex min-h-0 flex-col bg-surface text-text', className)}>
      <div className="titlebar reserve-controls-right flex shrink-0 items-center gap-1 border-b border-border px-2.5 py-2">
        {SCOPES.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => {
              if (item.id === scope) return
              // Never show one scope's files under another scope's heading.
              setFiles(null)
              setScope(item.id)
              setError(null)
            }}
            title={item.hint}
            className={cn(
              '[-webkit-app-region:no-drag] press-scale rounded-md px-2 py-1 text-xs transition',
              scope === item.id
                ? 'bg-surface-2 text-text'
                : 'text-text-muted hover:bg-surface-2/60 hover:text-text'
            )}
          >
            {item.label}
          </button>
        ))}

        <span className="ml-2 flex items-center gap-1.5 text-xs tabular-nums">
          {additions > 0 && <span className="text-success">+{additions}</span>}
          {deletions > 0 && <span className="text-danger">-{deletions}</span>}
          {!!files?.length && (
            <span className="text-text-subtle">
              {files.length} file{files.length === 1 ? '' : 's'}
            </span>
          )}
        </span>

        <div className="[-webkit-app-region:no-drag] ml-auto flex items-center gap-1">
          {(scope === 'unstaged' || scope === 'staged') && !!files?.length && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void bulk(scope === 'staged' ? api.review.unstage : api.review.stage)}
              className="[-webkit-app-region:no-drag] press-scale rounded-md px-2 py-1 text-xs text-text-muted transition hover:bg-surface-2 hover:text-text disabled:opacity-40"
            >
              {scope === 'staged' ? 'Unstage all' : 'Stage all'}
            </button>
          )}
          <button
            type="button"
            onClick={() => void load()}
            title="Refresh"
            className="[-webkit-app-region:no-drag] press-scale flex h-7 w-7 items-center justify-center sq sq-lg rounded-lg text-text-muted transition hover:bg-surface-2 hover:text-text"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          {action}
        </div>
      </div>

      {scope === 'commit' && (
        <div className="shrink-0 border-b border-border px-2.5 py-2">
          <select
            value={commitKey}
            onChange={(event) => {
              if (event.target.value === commitKey) return
              setFiles(null)
              setCommitKey(event.target.value)
            }}
            className="w-full rounded-md border border-border bg-surface-2 px-2 py-1 text-xs text-text outline-none"
          >
            <option value="">Pick a commit…</option>
            {commits?.map((commit) => (
              <option key={commitKeyOf(commit)} value={commitKeyOf(commit)}>
                {commit.repo ? `${commit.repo} · ` : ''}
                {commit.sha.slice(0, 7)} · {commit.subject}
              </option>
            ))}
          </select>
        </div>
      )}

      {error && (
        <p className="shrink-0 border-b border-border bg-danger/10 px-3 py-1.5 text-xs text-danger">
          {error}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!sessionId ? (
          <Empty>
            <FileDiff className="h-4 w-4" /> Open this from a session to review its changes
          </Empty>
        ) : !files ? (
          <Empty>
            <Loader2 className="h-4 w-4 animate-spin" /> Reading changes…
          </Empty>
        ) : !files.length ? (
          <Empty>
            <FileDiff className="h-4 w-4" /> {emptyLabel(scope, selectedCommit?.sha)}
          </Empty>
        ) : (
          files.map((file) => (
            <ReviewFileRow
              key={`${scope}:${selectedCommit?.sha ?? ''}:${file.repo ?? ''}:${file.path}`}
              file={file}
              scope={scope}
              target={target}
              onChanged={load}
            />
          ))
        )}
      </div>
    </div>
  )
}

function emptyLabel(scope: GitReviewScope, commit: string | undefined): string {
  if (scope === 'commit') return commit ? 'That commit changed nothing' : 'Pick a commit'
  if (scope === 'staged') return 'Nothing staged'
  if (scope === 'branch') return 'This branch matches its base'
  return 'No uncommitted changes'
}

function commitKeyOf(commit: ReviewCommit): string {
  return `${commit.repo ?? ''}:${commit.sha}`
}

function Empty({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="flex items-center justify-center gap-2 px-4 py-12 text-xs text-text-subtle">
      {children}
    </div>
  )
}
