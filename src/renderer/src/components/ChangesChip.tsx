import { FileDiff } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { GIT_POLL_MS } from '../lib/polling'

export interface ReviewCounts {
  files: number
  additions: number
  deletions: number
}

/** Store-free review entry point. Its polling state cannot re-render the transcript. */
export function ChangesChip({
  sessionId,
  open,
  onToggle,
  onCounts
}: {
  sessionId: string | null
  open: boolean
  onToggle: () => void
  onCounts?: (counts: ReviewCounts | null) => void
}): JSX.Element | null {
  const { t } = useTranslation()
  const [snapshot, setSnapshot] = useState<{
    sessionId: string
    counts: ReviewCounts
  } | null>(null)
  const counts = snapshot?.sessionId === sessionId ? snapshot.counts : null

  useEffect(() => {
    if (!sessionId) {
      setSnapshot(null)
      onCounts?.(null)
      return
    }
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    if (open) return () => undefined
    const load = async (): Promise<void> => {
      try {
        const [unstaged, staged] = await Promise.all([
          api.review.files({ sessionId, scope: 'unstaged' }),
          api.review.files({ sessionId, scope: 'staged' })
        ])
        if (!alive) return
        const byFile = new Map<string, (typeof unstaged)[number]>()
        for (const file of [...unstaged, ...staged]) {
          byFile.set(`${file.repo ?? ''}:${file.path}`, file)
        }
        const next = [...byFile.values()].reduce<ReviewCounts>(
          (total, file) => ({
            files: total.files + 1,
            additions: total.additions + file.additions,
            deletions: total.deletions + file.deletions
          }),
          { files: 0, additions: 0, deletions: 0 }
        )
        setSnapshot({ sessionId, counts: next })
        onCounts?.(next)
      } catch {
        // Keep the last honest count through a transient Git failure.
      } finally {
        if (alive) timer = setTimeout(() => void load(), GIT_POLL_MS)
      }
    }
    void load()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [sessionId, open, onCounts])

  if (!sessionId) return null

  return (
    <button
      type="button"
      onClick={onToggle}
      title={t('review.chipTitle')}
      className={cn(
        '[-webkit-app-region:no-drag] press-scale flex h-7 items-center gap-1.5 sq sq-lg sq-ring rounded-lg border px-2 text-xs tabular-nums transition-colors',
        open
          ? 'border-border-strong [--sq-ring:var(--color-border-strong)] bg-elevated text-text'
          : 'border-border bg-surface text-text-muted hover:border-border-strong hover:text-text'
      )}
    >
      <FileDiff className="h-3.5 w-3.5" />
      {!!counts?.additions && <span className="text-success">+{counts.additions}</span>}
      {!!counts?.deletions && <span className="text-danger">-{counts.deletions}</span>}
      {counts && counts.additions === 0 && counts.deletions === 0 ? (
        <span className="text-text-subtle">{t('review.files', { count: counts.files })}</span>
      ) : null}
    </button>
  )
}
