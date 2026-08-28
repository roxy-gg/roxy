import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { ChevronRight, Loader2, RotateCcw } from 'lucide-react'
import type { GitReviewScope, ReviewDiff, ReviewFile, ReviewTarget } from '@shared/api'
import { api } from '../lib/api'
import { cn } from '../lib/cn'

// Shiki is heavy and a review can be opened just to scan the file list, so the
// highlighter only ships once a file is actually expanded.
const FileDiffView = lazy(() => import('../components/FileDiffView'))

/** One expandable file row and its stage/unstage/revert controls. */
export function ReviewFileRow({
  file,
  scope,
  target,
  onChanged
}: {
  file: ReviewFile
  scope: GitReviewScope
  target: ReviewTarget | null
  onChanged: () => Promise<void>
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [diff, setDiff] = useState<ReviewDiff | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Revert is armed by a first click and fires on the second. */
  const [confirmRevert, setConfirmRevert] = useState(false)

  const rowTarget = useMemo<ReviewTarget | null>(
    () => (target ? { ...target, repo: file.repo ?? target.repo } : null),
    [target, file.repo]
  )
  // A rename is one visual row but two Git paths. Every mutation has to move
  // both halves or it leaves a staged deletion/addition behind.
  const paths = useMemo(
    () => (file.oldPath ? [file.path, file.oldPath] : [file.path]),
    [file.path, file.oldPath]
  )

  useEffect(() => {
    setDiff(null)
    setError(null)
    setConfirmRevert(false)
  }, [rowTarget, file.binary, file.path])

  useEffect(() => {
    if (!open || diff || file.binary || !rowTarget) return
    let alive = true
    void api.review
      .diff(rowTarget, file.path)
      .then((next) => {
        if (!alive) return
        if (next) setDiff(next)
        else setError('Could not read this file')
      })
      .catch(() => alive && setError('Could not read this file'))
    return () => {
      alive = false
    }
  }, [open, diff, file.binary, file.path, rowTarget])

  const act = async (fn: () => Promise<{ ok: boolean; error?: string }>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await fn()
      if (!result.ok) return setError(result.error ?? 'Failed')
      // Staging moves a file out of this view entirely, so the row it was
      // rendered in is gone - hence a reload rather than a local update.
      await onChanged()
    } catch {
      setError('Could not update this file')
    } finally {
      setBusy(false)
    }
  }

  // Staging is meaningless in a historical view, and reverting a commit's
  // files would silently discard work that is not even on screen.
  const canAct = (scope === 'unstaged' || scope === 'staged') && !!rowTarget

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
              'h-3.5 w-3.5 shrink-0 text-text-subtle transition-transform duration-200 ease-out-quart',
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
            <span className="shrink-0 truncate text-[10px] text-text-subtle">← {file.oldPath}</span>
          )}
        </button>

        <span className="flex shrink-0 items-center gap-1.5 text-[11px] tabular-nums">
          {file.additions > 0 && <span className="text-success">+{file.additions}</span>}
          {file.deletions > 0 && <span className="text-danger">-{file.deletions}</span>}
        </span>

        {canAct && (
          // Hidden until hover: these are per-file controls on rows you mostly
          // just read, and a permanent pair on every line becomes visual noise.
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
                  {scope === 'staged' ? 'Unstage' : 'Stage'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    // Two clicks, because this is the only control here that
                    // destroys work and git cannot bring an untracked file back.
                    if (!confirmRevert) return setConfirmRevert(true)
                    setConfirmRevert(false)
                    void act(() => api.review.revert(rowTarget, paths))
                  }}
                  onBlur={() => setConfirmRevert(false)}
                  title="Discard this file's changes"
                  className={cn(
                    'flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition',
                    confirmRevert
                      ? 'bg-danger/15 text-danger'
                      : 'text-text-subtle hover:bg-surface-2 hover:text-danger'
                  )}
                >
                  <RotateCcw className="h-3 w-3" />
                  {confirmRevert && 'Sure?'}
                </button>
              </>
            )}
          </span>
        )}
      </div>

      {open && (
        <div className="border-t border-border/50 bg-bg/40 px-2.5 py-2">
          {file.binary || diff?.binary ? (
            <p className="px-1 py-2 text-xs text-text-subtle">
              Binary or very large file — not shown.
            </p>
          ) : error ? (
            <p className="px-1 py-2 text-xs text-danger">{error}</p>
          ) : !diff ? (
            <p className="flex items-center gap-2 px-1 py-2 text-xs text-text-subtle">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading diff…
            </p>
          ) : (
            <Suspense
              fallback={<p className="px-1 py-2 text-xs text-text-subtle">Highlighting…</p>}
            >
              <FileDiffView path={diff.path} before={diff.before} after={diff.after} />
            </Suspense>
          )}
        </div>
      )}
      {!open && error && <p className="px-3 pb-2 text-xs text-danger">{error}</p>}
    </div>
  )
}

/** A single letter for what happened to a file, coloured like the diff itself. */
function StatusMark({ status }: { status: ReviewFile['status'] }): JSX.Element {
  const map = {
    added: { ch: 'A', cls: 'text-success' },
    untracked: { ch: 'U', cls: 'text-success' },
    modified: { ch: 'M', cls: 'text-warning' },
    deleted: { ch: 'D', cls: 'text-danger' },
    renamed: { ch: 'R', cls: 'text-text-muted' },
    copied: { ch: 'C', cls: 'text-text-muted' }
  }[status]
  return (
    <span className={cn('w-3 shrink-0 text-center text-[11px] font-medium', map.cls)}>
      {map.ch}
    </span>
  )
}
