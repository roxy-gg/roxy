import { useEffect, useMemo, useState } from 'react'
import { ChevronRight, Loader2, RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ReviewDiff, ReviewFile, ReviewScope, ReviewTarget } from '@shared/api'
import { DiffViewer } from '../components/diff/DiffViewer'
import { api } from '../lib/api'
import { cn } from '../lib/cn'

export function ReviewFileRow({
  file,
  scope,
  target,
  onChanged
}: {
  file: ReviewFile
  scope: ReviewScope
  target: ReviewTarget | null
  onChanged: () => Promise<void>
}): JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [diff, setDiff] = useState<ReviewDiff | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmRevert, setConfirmRevert] = useState(false)
  const rowTarget = useMemo<ReviewTarget | null>(
    () => (target ? { ...target, repo: file.repo ?? target.repo, oldPath: file.oldPath } : null),
    [target, file.repo, file.oldPath]
  )
  const fingerprint = useMemo(
    () =>
      JSON.stringify([
        file.path,
        file.oldPath,
        file.additions,
        file.deletions,
        file.status,
        file.binary,
        rowTarget
      ]),
    [file, rowTarget]
  )
  const [diffFingerprint, setDiffFingerprint] = useState('')
  const visibleDiff = diffFingerprint === fingerprint ? diff : null
  const paths = useMemo(
    () => (file.status === 'renamed' && file.oldPath ? [file.path, file.oldPath] : [file.path]),
    [file.path, file.oldPath, file.status]
  )

  useEffect(() => {
    setDiff(null)
    setError(null)
    setConfirmRevert(false)
  }, [fingerprint])

  useEffect(() => {
    if (!open || visibleDiff || file.binary || !rowTarget) return
    let alive = true
    void api.review
      .diff(rowTarget, file.path)
      .then((next) => {
        if (!alive) return
        if (next) {
          setDiff(next)
          setDiffFingerprint(fingerprint)
        } else setError(t('review.diffReadFailed'))
      })
      .catch(() => alive && setError(t('review.diffReadFailed')))
    return () => {
      alive = false
    }
  }, [open, visibleDiff, file.binary, file.path, fingerprint, rowTarget, t])

  const act = async (fn: () => Promise<{ ok: boolean; error?: string }>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await fn()
      if (!result.ok) return setError(t('review.fileUpdateFailed'))
      await onChanged()
    } catch {
      setError(t('review.fileUpdateFailed'))
    } finally {
      setBusy(false)
    }
  }

  const canAct = (scope === 'unstaged' || scope === 'staged') && !!rowTarget
  const lineCount = visibleDiff
    ? Math.max(visibleDiff.before.split('\n').length, visibleDiff.after.split('\n').length)
    : 0
  const viewport = typeof window === 'undefined' ? 720 : window.innerHeight
  const diffHeight = Math.min(
    Math.max(240, 120 + lineCount * 18),
    Math.max(320, viewport - 220),
    760
  )

  return (
    <div className="border-b border-border/50 last:border-b-0">
      <div className="group flex items-center gap-2 px-2.5 py-2 transition hover:bg-surface-2/50">
        <button
          type="button"
          onClick={() => {
            if (open) {
              setDiff(null)
              setError(null)
            }
            setOpen(!open)
          }}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronRight
            className={cn(
              'h-3.5 w-3.5 shrink-0 text-text-subtle transition-transform',
              open && 'rotate-90'
            )}
          />
          <StatusMark status={file.status} />
          {file.repo && (
            <span className="shrink-0 rounded bg-surface-2 px-1 py-0.5 text-[10px] text-text-subtle">
              {file.repo}
            </span>
          )}
          <span className="truncate text-xs text-text-muted">{file.path}</span>
          {file.oldPath && (
            <span className="shrink-0 truncate text-[10px] text-text-subtle">
              &lt;- {file.oldPath}
            </span>
          )}
        </button>
        <span className="flex shrink-0 items-center gap-1.5 text-[11px] tabular-nums">
          {file.additions > 0 && <span className="text-success">+{file.additions}</span>}
          {file.deletions > 0 && <span className="text-danger">-{file.deletions}</span>}
        </span>
        {canAct && (
          <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition focus-within:opacity-100 group-hover:opacity-100">
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-text-subtle" />
            ) : (
              <>
                <button
                  type="button"
                  onClick={() =>
                    void act(() =>
                      scope === 'staged'
                        ? api.review.unstage(rowTarget, paths)
                        : api.review.stage(rowTarget, paths)
                    )
                  }
                  className="rounded px-1.5 py-0.5 text-[11px] text-text-subtle transition hover:bg-surface-2 hover:text-text"
                >
                  {t(scope === 'staged' ? 'review.unstage' : 'review.stage')}
                </button>
                {scope === 'unstaged' && (
                  <button
                    type="button"
                    onClick={() => {
                      if (!confirmRevert) return setConfirmRevert(true)
                      setConfirmRevert(false)
                      void act(() => api.review.revert(rowTarget, paths))
                    }}
                    onBlur={() => setConfirmRevert(false)}
                    title={t('review.discardFile')}
                    className={cn(
                      'flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition',
                      confirmRevert
                        ? 'bg-danger/15 text-danger'
                        : 'text-text-subtle hover:bg-surface-2 hover:text-danger'
                    )}
                  >
                    <RotateCcw className="h-3 w-3" />
                    {confirmRevert && t('review.revertConfirm')}
                  </button>
                )}
              </>
            )}
          </span>
        )}
      </div>
      {open && (
        <div className="border-t border-border/50 bg-bg/40 px-2.5 py-2">
          {file.binary || visibleDiff?.binary ? (
            <p className="px-1 py-2 text-xs text-text-subtle">{t('review.binary')}</p>
          ) : error ? (
            <p className="px-1 py-2 text-xs text-danger">{error}</p>
          ) : !visibleDiff ? (
            <p className="flex items-center gap-2 px-1 py-2 text-xs text-text-subtle">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t('review.loadingDiff')}
            </p>
          ) : (
            <DiffViewer
              path={visibleDiff.path}
              before={visibleDiff.before}
              after={visibleDiff.after}
              height={diffHeight}
            />
          )}
        </div>
      )}
      {!open && error && <p className="px-3 pb-2 text-xs text-danger">{error}</p>}
    </div>
  )
}

function StatusMark({ status }: { status: ReviewFile['status'] }): JSX.Element {
  const mark = {
    added: { character: 'A', className: 'text-success' },
    untracked: { character: 'U', className: 'text-success' },
    modified: { character: 'M', className: 'text-warning' },
    deleted: { character: 'D', className: 'text-danger' },
    renamed: { character: 'R', className: 'text-text-muted' },
    copied: { character: 'C', className: 'text-text-muted' }
  }[status]
  return (
    <span className={cn('w-3 shrink-0 text-center text-[11px] font-medium', mark.className)}>
      {mark.character}
    </span>
  )
}
