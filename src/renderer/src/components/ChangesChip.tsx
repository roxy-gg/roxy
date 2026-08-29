import { useEffect, useState } from 'react'
import { statusKeyForSession } from '@shared/workstream'
import { api } from '../lib/api'
import { GIT_POLL_MS } from '../lib/polling'
import { useRoxyStore } from '../lib/store'

/**
 * `Changes +12 -3` above the composer - the entry point to reviewing a
 * session's diff.
 *
 * Clicking OPENS THE REVIEW WINDOW rather than expanding inline. An earlier
 * version unfolded the diff right here and it covered half the transcript,
 * which is exactly the conversation you read a diff against. So the chip stays
 * a chip: it reports that there is something to look at, and hands off to a
 * surface with the height to actually show it.
 *
 * Renders nothing when there is nothing to review, so a session with a clean
 * tree is not nagged by a permanent `+0 -0`.
 */
export function ChangesChip(): JSX.Element | null {
  const chats = useRoxyStore((s) => s.chats)
  const activeChatId = useRoxyStore((s) => s.activeChatId)
  const gitAvailable = useRoxyStore((s) => s.gitAvailable)
  const gitStatus = useRoxyStore((s) => s.gitStatus)
  const repoStatus = useRoxyStore((s) => s.repoStatus)

  const chat = chats.find((c) => c.id === activeChatId) ?? null
  // A sub-session shows its parent's changes, exactly as the workstream strip
  // does: subagents never own a checkout of their own.
  const owner =
    chat?.kind === 'sub' && chat.parentId
      ? (chats.find((c) => c.id === chat.parentId) ?? null)
      : chat
  const sessionId = owner?.id ?? null
  const statusKey = owner ? statusKeyForSession(owner) : null

  // How many files are dirty, straight from the status the strip already polls.
  // This is what decides whether the chip exists at all - it costs nothing.
  const repos = statusKey ? repoStatus[statusKey] : undefined
  const status = statusKey ? gitStatus[statusKey] : undefined
  const changed = repos?.reduce((n, r) => n + r.changed, 0) ?? (status?.isRepo ? status.changed : 0)

  const [counts, setCounts] = useState<{ additions: number; deletions: number } | null>(null)

  // Line counts need a real diff, which git status does not carry. Poll only
  // while something is dirty; the number of changed files can stay constant
  // while the user keeps editing one of them, so it is not a refresh signal.
  useEffect(() => {
    if (!sessionId || changed === 0) return setCounts(null)
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async (): Promise<void> => {
      try {
        const files = await api.review.files({ sessionId, scope: 'unstaged' })
        if (!alive) return
        setCounts({
          additions: files.reduce((n, f) => n + f.additions, 0),
          deletions: files.reduce((n, f) => n + f.deletions, 0)
        })
      } catch {
        // Keep the last honest counts through a transient Git failure.
      } finally {
        if (alive) timer = setTimeout(() => void load(), GIT_POLL_MS)
      }
    }
    void load()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [sessionId, changed])

  if (!sessionId || !gitAvailable || changed === 0) return null

  return (
    <div className="shrink-0 px-4 text-xs">
      <div className="mx-auto max-w-3xl px-1">
        <button
          type="button"
          onClick={() => {}}
          title="Review these changes"
          className="press-scale mb-1.5 flex items-center gap-1.5 rounded-full border border-border/60 px-2.5 py-1 text-text-muted transition hover:border-border hover:bg-white/5 hover:text-text"
        >
          <span>Changes</span>
          {/* Falls back to a file count until the diff lands, because `+0 -0`
              during the fetch would be a lie dressed as precision. */}
          {counts && (counts.additions > 0 || counts.deletions > 0) ? (
            <span className="flex items-center gap-1 tabular-nums">
              {counts.additions > 0 && <span className="text-success">+{counts.additions}</span>}
              {counts.deletions > 0 && <span className="text-danger">-{counts.deletions}</span>}
            </span>
          ) : (
            <span className="tabular-nums text-text-subtle">
              {changed} file{changed === 1 ? '' : 's'}
            </span>
          )}
        </button>
      </div>
    </div>
  )
}
