import assert from 'node:assert/strict'
import { branchLifecycle, type ForgeStatusView, type PullRequestView } from '../src/shared/forge'
import type { GitStatusView, RepoStatusView } from '../src/shared/api'
import {
  loadRepoStatusCache,
  saveRepoStatusCache,
  retainForgeStatus
} from '../src/renderer/src/lib/repo-status-cache'

const cache = new Map<string, string>()
let writes = 0
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => cache.get(key) ?? null,
    setItem: (key: string, value: string) => {
      writes++
      cache.set(key, value)
    }
  }
})
const sync: GitStatusView = {
  isRepo: true,
  root: '/repo',
  branch: 'feature',
  dirty: false,
  changed: 0,
  ahead: 0,
  behind: 0,
  hasUpstream: true,
  defaultBranch: 'main'
}
const pull: PullRequestView = {
  number: 42,
  title: 'Feature',
  state: 'merged',
  url: 'https://github.com/test/repo/pull/42',
  sourceBranch: 'feature',
  targetBranch: 'main',
  author: null,
  createdAt: 0,
  updatedAt: 0,
  checks: null,
  review: null
}
const view = (pr: PullRequestView | null): ForgeStatusView => ({
  pull: pr,
  remote: {
    kind: 'github',
    host: 'github.com',
    slug: 'test/repo',
    webBase: 'https://github.com/test/repo'
  },
  lifecycle: branchLifecycle({ sync, pr, forgeKnown: true }),
  syncTarget: null,
  error: null,
  refreshing: false,
  unknownHost: null
})
const previous = view(pull)
const clean = view(null)
for (const next of [
  null,
  { ...clean, refreshing: true },
  { ...clean, error: { reason: 'network' as const, message: 'timeout' } },
  { ...clean, error: { reason: 'auth' as const, message: 'expired' } }
]) {
  const retained = retainForgeStatus(previous, next, sync, true)
  assert.equal(retained?.pull?.number, 42)
  assert.equal(retained?.lifecycle.phase, 'merged')
  assert.equal(
    retainForgeStatus(previous, next, sync, false),
    next,
    'new branches never inherit old PRs'
  )
}
assert.equal(
  retainForgeStatus(previous, clean, sync, true),
  clean,
  'authoritative no-PR clears old PR'
)
const draft = view({ ...pull, state: 'draft' })
assert.equal(retainForgeStatus(previous, draft, sync, true), draft, 'new PR updates the dot')
assert.equal(retainForgeStatus(undefined, clean, sync, true), clean)
assert.equal(retainForgeStatus(undefined, null, sync, true), null)

const repo: RepoStatusView = {
  name: 'repo',
  worktreePath: '/tree/repo',
  branch: 'feature',
  isRepo: true,
  pending: false,
  dirty: true,
  changed: 1,
  ahead: 0,
  behind: 0,
  hasUpstream: true,
  defaultBranch: 'main',
  forge: { ...draft, refreshing: true },
  sync: null
}
const statuses = {
  gitStatus: { '/tree': sync, '/deleted': sync },
  forgeStatus: { '/tree': { ...previous, refreshing: true }, '/deleted': previous },
  repoStatus: { '/multi': [repo], '/deleted': [repo] }
}
const chats = [
  { worktreePath: '/tree', workspacePath: '/repo' },
  { worktreePath: '/multi', workspacePath: '/workspace' }
]
saveRepoStatusCache(statuses, chats)
const restored = loadRepoStatusCache()
assert.deepEqual(restored.gitStatus, { '/tree': sync })
assert.deepEqual(restored.forgeStatus, { '/tree': previous })
assert.deepEqual(restored.repoStatus, { '/multi': [{ ...repo, forge: draft }] })
saveRepoStatusCache(statuses, chats)
assert.equal(writes, 1, 'unchanged polls do not write to disk')
saveRepoStatusCache(restored, [chats[1]])
assert.deepEqual(Object.keys(loadRepoStatusCache().gitStatus), [], 'deleted sessions are pruned')
assert.equal(loadRepoStatusCache().repoStatus['/multi'].length, 1)

const key = [...cache.keys()][0]
saveRepoStatusCache(
  { gitStatus: { '/tree': sync }, forgeStatus: { '/tree': clean }, repoStatus: {} },
  [chats[0]]
)
assert.deepEqual(
  loadRepoStatusCache().forgeStatus,
  { '/tree': clean },
  'neutral/no-PR status hydrates too'
)
for (const invalid of [
  'oops',
  'null',
  '{"version":2}',
  '{"version":1,"gitStatus":{"bad":{}},"forgeStatus":{"bad":{}},"repoStatus":{"bad":[{}]}}'
]) {
  cache.set(key, invalid)
  assert.deepEqual(loadRepoStatusCache(), { gitStatus: {}, forgeStatus: {}, repoStatus: {} })
}
Object.assign(globalThis, {
  localStorage: {
    getItem: () => {
      throw Error('denied')
    },
    setItem: () => {
      throw Error('quota')
    }
  }
})
assert.deepEqual(loadRepoStatusCache(), { gitStatus: {}, forgeStatus: {}, repoStatus: {} })
assert.doesNotThrow(() => saveRepoStatusCache(statuses, chats))
console.log(
  'REPO STATUS OK: restart hydration, multi-repo snapshots, failed/cold lookups, branch changes, authoritative clears, pruning, corrupt/unavailable storage'
)
