import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { FileDiff, Loader2, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { REVIEW_COMMITS } from '@shared/api'
import type { ReviewCommit, ReviewFile, ReviewScope, ReviewTarget } from '@shared/api'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { GIT_POLL_MS } from '../lib/polling'
import { ReviewFileRow } from './ReviewFileRow'

const SCOPES: ReviewScope[] = ['session', 'unstaged', 'staged', 'branch', 'commit']

export function ReviewPane({
  sessionId,
  className,
  action
}: {
  sessionId: string | null
  className?: string
  action?: ReactNode
}): JSX.Element {
  const { t } = useTranslation()
  const [scope, setScope] = useState<ReviewScope>('session')
  const [commitKey, setCommitKey] = useState('')
  const [files, setFiles] = useState<ReviewFile[] | null>(null)
  const [commits, setCommits] = useState<ReviewCommit[] | null>(null)
  const [commitsError, setCommitsError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const loadSeq = useRef(0)
  const selectedCommit = useMemo(
    () => commits?.find((candidate) => commitKeyOf(candidate) === commitKey),
    [commits, commitKey]
  )
  const target = useMemo<ReviewTarget | null>(
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
      if (seq === loadSeq.current) {
        setFiles(next)
        setError(null)
      }
    } catch {
      if (seq === loadSeq.current) {
        setError(t('review.loadFailed'))
        setFiles((current) => current ?? [])
      }
    }
  }, [target, t])

  useEffect(() => {
    setFiles(null)
    void load()
    const timer = setInterval(() => void load(), GIT_POLL_MS)
    return () => clearInterval(timer)
  }, [load])

  useEffect(() => {
    if (scope !== 'commit' || commits || !sessionId) return
    let alive = true
    void api.review
      .commits(sessionId, undefined, REVIEW_COMMITS)
      .then((next) => {
        if (!alive) return
        setCommits(next)
        setCommitsError(false)
      })
      .catch(() => {
        if (!alive) return
        setCommits([])
        setCommitsError(true)
      })
    return () => {
      alive = false
    }
  }, [scope, commits, sessionId, t])

  useEffect(() => {
    setCommits(null)
    setCommitsError(false)
    setCommitKey('')
  }, [sessionId])

  const bulk = async (
    fn: (target: ReviewTarget, files: string[]) => Promise<{ ok: boolean; error?: string }>
  ): Promise<void> => {
    if (!target) return
    setBusy(true)
    setError(null)
    try {
      const result = await fn(target, [])
      if (!result.ok) setError(t('review.updateFailed'))
      await load()
    } catch {
      setError(t('review.updateFailed'))
    } finally {
      setBusy(false)
    }
  }

  const additions = files?.reduce((count, file) => count + file.additions, 0) ?? 0
  const deletions = files?.reduce((count, file) => count + file.deletions, 0) ?? 0

  return (
    <div className={cn('flex min-h-0 flex-col bg-surface text-text', className)}>
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-2.5 py-2">
        {SCOPES.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => {
              if (id === scope) return
              setFiles(null)
              setScope(id)
              setError(null)
            }}
            title={t(`review.scope.${id}Hint`)}
            className={cn(
              'press-scale rounded-md px-2 py-1 text-xs transition',
              scope === id
                ? 'bg-surface-2 text-text'
                : 'text-text-muted hover:bg-surface-2/60 hover:text-text'
            )}
          >
            {t(`review.scope.${id}`)}
          </button>
        ))}
        <span className="ml-1 flex items-center gap-1.5 text-xs tabular-nums">
          {additions > 0 && <span className="text-success">+{additions}</span>}
          {deletions > 0 && <span className="text-danger">-{deletions}</span>}
          {!!files?.length && (
            <span className="text-text-subtle">{t('review.files', { count: files.length })}</span>
          )}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {(scope === 'unstaged' || scope === 'staged') && !!files?.length && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void bulk(scope === 'staged' ? api.review.unstage : api.review.stage)}
              className="press-scale rounded-md px-2 py-1 text-xs text-text-muted transition hover:bg-surface-2 hover:text-text disabled:opacity-40"
            >
              {t(scope === 'staged' ? 'review.unstageAll' : 'review.stageAll')}
            </button>
          )}
          <button
            type="button"
            onClick={() => void load()}
            title={t('review.refresh')}
            className="press-scale flex h-7 w-7 items-center justify-center rounded-lg text-text-muted transition hover:bg-surface-2 hover:text-text"
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
              setFiles(null)
              setCommitKey(event.target.value)
            }}
            className="w-full rounded-md border border-border bg-surface-2 px-2 py-1 text-xs text-text outline-none"
          >
            <option value="">{t('review.pickCommitPlaceholder')}</option>
            {commits?.map((commit) => (
              <option key={commitKeyOf(commit)} value={commitKeyOf(commit)}>
                {commit.repo ? `${commit.repo} / ` : ''}
                {commit.sha.slice(0, 7)} / {commit.subject}
              </option>
            ))}
          </select>
          {commitsError && <p className="pt-1.5 text-xs text-danger">{t('review.loadFailed')}</p>}
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
            <FileDiff className="h-4 w-4" /> {t('review.noSession')}
          </Empty>
        ) : !files ? (
          <Empty>
            <Loader2 className="h-4 w-4 animate-spin" /> {t('review.reading')}
          </Empty>
        ) : !files.length ? (
          <Empty>
            <FileDiff className="h-4 w-4" /> {t(emptyKey(scope, selectedCommit?.sha))}
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

function emptyKey(scope: ReviewScope, commit: string | undefined) {
  if (scope === 'commit')
    return commit ? ('review.emptyCommit' as const) : ('review.pickCommit' as const)
  if (scope === 'session') return 'review.emptySession' as const
  if (scope === 'staged') return 'review.emptyStaged' as const
  if (scope === 'branch') return 'review.emptyBranch' as const
  return 'review.emptyUnstaged' as const
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
