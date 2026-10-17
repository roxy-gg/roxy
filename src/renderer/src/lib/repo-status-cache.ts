import type { GitStatusView, RepoStatusView } from '@shared/api'
import { branchLifecycle, type BranchSync, type ForgeStatusView } from '@shared/forge'
import type { Chat } from '@shared/types'

const CACHE_KEY = 'roxy:repo-status:v1'

interface RepoStatusCache {
  gitStatus: Record<string, GitStatusView>
  forgeStatus: Record<string, ForgeStatusView>
  repoStatus: Record<string, RepoStatusView[]>
}

/** A pending/failed lookup is not an authoritative "no PR" answer. */
export function retainForgeStatus(
  previous: ForgeStatusView | undefined,
  next: ForgeStatusView | null,
  sync: BranchSync,
  sameBranch: boolean
): ForgeStatusView | null {
  if (!sameBranch || !previous || (next && !next.error && !next.refreshing)) return next
  const pull = next?.pull ?? previous.pull
  return {
    ...(next ?? previous),
    pull,
    lifecycle: branchLifecycle({ sync, pr: pull, forgeKnown: !!(next ?? previous).remote })
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

function gitFields(value: unknown): value is GitStatusView | RepoStatusView {
  return (
    record(value) &&
    typeof value.isRepo === 'boolean' &&
    (value.branch === null || typeof value.branch === 'string') &&
    typeof value.dirty === 'boolean' &&
    typeof value.hasUpstream === 'boolean' &&
    [value.changed, value.ahead, value.behind].every(
      (n) => typeof n === 'number' && Number.isFinite(n)
    )
  )
}

function forgeStatus(value: unknown): value is ForgeStatusView {
  return (
    record(value) &&
    record(value.lifecycle) &&
    typeof value.lifecycle.title === 'string' &&
    typeof value.lifecycle.label === 'string' &&
    [
      'unpublished',
      'ahead',
      'behind',
      'diverged',
      'synced',
      'draft',
      'open',
      'merged',
      'closed'
    ].includes(value.lifecycle.phase as string) &&
    ['neutral', 'info', 'success', 'warning', 'danger'].includes(value.lifecycle.tone as string) &&
    (value.pull === null ||
      (record(value.pull) &&
        typeof value.pull.number === 'number' &&
        typeof value.pull.url === 'string' &&
        typeof value.pull.sourceBranch === 'string' &&
        typeof value.pull.targetBranch === 'string' &&
        ['draft', 'open', 'merged', 'closed'].includes(value.pull.state as string)))
  )
}

/** Synchronous hydration prevents a blank status column during app startup. */
export function loadRepoStatusCache(): RepoStatusCache {
  const empty: RepoStatusCache = { gitStatus: {}, forgeStatus: {}, repoStatus: {} }
  try {
    const cached: unknown = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null')
    if (!record(cached) || cached.version !== 1) return empty
    if (record(cached.gitStatus)) {
      empty.gitStatus = Object.fromEntries(
        Object.entries(cached.gitStatus).filter(
          (entry): entry is [string, GitStatusView] =>
            gitFields(entry[1]) &&
            'root' in entry[1] &&
            (entry[1].root === null || typeof entry[1].root === 'string')
        )
      )
    }
    if (record(cached.forgeStatus)) {
      empty.forgeStatus = Object.fromEntries(
        Object.entries(cached.forgeStatus)
          .filter(([, v]) => forgeStatus(v))
          .map(([key, v]) => [key, { ...(v as ForgeStatusView), refreshing: false }])
      )
    }
    if (record(cached.repoStatus)) {
      empty.repoStatus = Object.fromEntries(
        Object.entries(cached.repoStatus)
          .filter(
            ([, repos]) =>
              Array.isArray(repos) &&
              repos.every(
                (repo: unknown) =>
                  record(repo) &&
                  gitFields(repo) &&
                  typeof repo.name === 'string' &&
                  typeof repo.worktreePath === 'string' &&
                  (repo.forge === null || forgeStatus(repo.forge))
              )
          )
          .map(([key, repos]) => [
            key,
            (repos as RepoStatusView[]).map((repo) => ({
              ...repo,
              forge: repo.forge ? { ...repo.forge, refreshing: false } : null
            }))
          ])
      )
    }
  } catch {
    // Corrupt or unavailable storage must never prevent the app from opening.
  }
  return empty
}

export function saveRepoStatusCache(
  status: RepoStatusCache,
  chats: Pick<Chat, 'worktreePath' | 'workspacePath'>[]
): void {
  try {
    const live = new Set(chats.map((chat) => chat.worktreePath ?? chat.workspacePath))
    const snapshot = JSON.stringify({
      version: 1,
      gitStatus: Object.fromEntries(
        Object.entries(status.gitStatus).filter(([key]) => live.has(key))
      ),
      forgeStatus: Object.fromEntries(
        Object.entries(status.forgeStatus).filter(([key]) => live.has(key))
      ),
      repoStatus: Object.fromEntries(
        Object.entries(status.repoStatus).filter(([key]) => live.has(key))
      )
    })
    if (localStorage.getItem(CACHE_KEY) !== snapshot) localStorage.setItem(CACHE_KEY, snapshot)
  } catch {
    // Quota/security errors leave the in-memory status and polling intact.
  }
}
