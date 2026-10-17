import './BotsHarness'
import { useEffect } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { Sidebar } from '../../src/renderer/src/components/Sidebar'
import { useRoxyStore } from '../../src/renderer/src/lib/store'
import { branchLifecycle, type PullState } from '../../src/shared/forge'
import type { GitStatusView, RepoStatusView } from '../../src/shared/api'
import type { Chat } from '../../src/shared/types'

const git: GitStatusView = {
  isRepo: true,
  root: '/project',
  branch: 'feature/sidebar',
  dirty: false,
  changed: 0,
  ahead: 0,
  behind: 0,
  hasUpstream: true,
  defaultBranch: 'main'
}

const forge = (state: PullState, number = 42) => {
  const pull = {
    number,
    title: 'Sidebar polish',
    state,
    url: `https://github.com/test/repo/pull/${number}`,
    sourceBranch: 'feature/sidebar',
    targetBranch: 'main',
    author: null,
    createdAt: 0,
    updatedAt: 0,
    checks: null,
    review: null
  }
  return {
    remote: null,
    pull,
    lifecycle: branchLifecycle({ sync: git, pr: pull, forgeKnown: true }),
    syncTarget: null,
    error: null,
    refreshing: false,
    unknownHost: null
  }
}

const chat = (id: string): Chat => ({
  id,
  title: id,
  kind: 'main',
  providerId: null,
  model: null,
  agentId: null,
  reasoningEffort: null,
  contextLimit: null,
  workspacePath: '/project',
  worktreePath: `/trees/${id}`,
  branch: 'feature/sidebar-with-a-long-branch-name',
  repos: null,
  worktreePending: null,
  devPort: null,
  parentId: null,
  contextSummary: null,
  contextSummaryAt: null,
  description: null,
  tasks: [],
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0
})

const repos = (count: number): RepoStatusView[] =>
  Array.from({ length: count }, (_, i) => ({
    ...git,
    name: `repo-${i + 1}`,
    worktreePath: `/trees/multi-${count}/repo-${i + 1}`,
    pending: false,
    dirty: i % 4 === 3,
    forge:
      i % 4 === 3 ? null : forge(i % 4 === 1 ? 'draft' : i % 4 === 2 ? 'closed' : 'merged', i + 1),
    sync: null
  }))

export function SidebarHarness(): JSX.Element {
  useEffect(() => {
    const chats = [
      'Merged',
      'Draft',
      'Open',
      'Dirty',
      'Clean',
      'Closed',
      'Generating',
      'Regular',
      'Regular generating',
      'Shared checkout',
      'Multi 3',
      'Multi 5',
      'Multi 9',
      'Multi 12',
      'Multi 25',
      'Multi unknown'
    ].map(chat)
    const repoStatus: Record<string, RepoStatusView[]> = {}
    for (const count of [3, 5, 9, 12, 25]) {
      const owner = chats.find((c) => c.id === `Multi ${count}`)!
      repoStatus[owner.worktreePath!] = repos(count)
      owner.repos = repoStatus[owner.worktreePath!].map((repo) => ({
        name: repo.name,
        root: `/project/${repo.name}`,
        worktreePath: repo.worktreePath,
        branch: git.branch
      }))
    }
    chats.find((c) => c.id === 'Multi unknown')!.repos = chats.find(
      (c) => c.id === 'Multi 3'
    )!.repos
    for (const c of chats.filter((c) => c.id.startsWith('Regular') || c.id === 'Shared checkout')) {
      c.worktreePath = null
      c.branch = null
    }
    useRoxyStore.setState({
      chats,
      bots: [],
      activeChatId: 'Merged',
      ...(!new URLSearchParams(location.search).has('restoreStatus')
        ? {
            gitStatus: Object.fromEntries(
              chats
                .filter((c) => c.worktreePath)
                .map((c) => [
                  c.worktreePath!,
                  {
                    ...git,
                    dirty: c.id === 'Dirty'
                  }
                ])
            ),
            forgeStatus: {
              '/trees/Merged': forge('merged'),
              '/trees/Draft': forge('draft'),
              '/trees/Open': forge('open'),
              '/trees/Closed': forge('closed'),
              '/trees/Generating': forge('merged'),
              '/trees/Multi unknown': forge('merged'),
              '/project': forge('merged')
            },
            repoStatus
          }
        : {}),
      sendingChats: { Generating: true, 'Regular generating': true },
      refreshAllGitStatus: async () => {},
      selectChat: async (id) => {
        useRoxyStore.setState({ activeChatId: id })
      },
      deleteChat: async (id) => {
        useRoxyStore.setState((s) => ({ chats: s.chats.filter((c) => c.id !== id) }))
      },
      stop: (id) => {
        useRoxyStore.setState((s) => ({ sendingChats: { ...s.sendingChats, [id!]: false } }))
      }
    })
  }, [])
  return (
    <MemoryRouter>
      <Sidebar />
    </MemoryRouter>
  )
}
