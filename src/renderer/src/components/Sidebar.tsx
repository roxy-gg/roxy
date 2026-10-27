import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useMotion } from '../lib/motion'
import {
  FolderOpen,
  GitBranch,
  GitFork,
  Hammer,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings as SettingsIcon,
  Square,
  SquarePen,
  Trash2
} from 'lucide-react'
import { MorphIcon } from 'morphicons/react'
import type { Chat } from '@shared/types'
import { sidebarGitDot, type SidebarGitDotState } from '@shared/forge'
import { statusKeyForSession } from '@shared/workstream'
import { repoCountBadge } from '@shared/repos'
import { useRoxyStore } from '../lib/store'
import { cn } from '../lib/cn'
import { ContextMenuRow, ContextMenuSurface, CONTEXT_MENU_PAD, CONTEXT_ROW_H } from './ContextMenu'
import { BotsSection } from './BotsSection'
import { BrailleSpinner } from './ThinkingIndicator'
import { UpdateCard } from './UpdateCard'
import { SidebarFrame, SidebarNavItem } from './SidebarFrame'
import roxy from '../assets/roxy.png'

/**
 * How often to re-read git + PR state for EVERY session.
 *
 * Far slower than the strip's 5s, and deliberately so. The strip polls one
 * session; this sweeps all of them, and each one costs a git spawn. Pull
 * request state also changes on the order of minutes - the forge answer is
 * cached for 60s in the main process, so polling faster than this would spawn
 * git for a number that cannot have moved.
 */
const SWEEP_MS = 30_000
const RAIL_COLLAPSED_KEY = 'roxy.sidebar.collapsed'
const COLLAPSED_PROJECTS_KEY = 'roxy.sidebar.projects.v1'
const GIT_DOT_COLOR = {
  local: 'bg-text-muted',
  pending: 'bg-warning',
  merged: 'bg-success',
  closed: 'bg-danger'
} as const satisfies Record<SidebarGitDotState, string>

const storedCollapsedProjects = (): Set<string> => {
  try {
    const paths: unknown = JSON.parse(localStorage.getItem(COLLAPSED_PROJECTS_KEY) ?? '[]')
    return new Set(
      Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : []
    )
  } catch {
    return new Set()
  }
}

interface Project {
  path: string
  name: string
  sessions: Chat[]
}

/** Keep per-repo details on the whole row, not on tiny individual dots. */
function sessionRowTitle(chat: Chat, statuses: string[], t: TFunction): string {
  const bits = [chat.title]
  if (chat.branch) bits.push(chat.branch)
  // Multi-repo: name the repos. "uncommitted changes" is not actionable when a
  // session spans four of them, and the row itself has no space to say which.
  const repos = chat.repos ?? []
  if (repos.length > 1) {
    bits.push(
      t('sidebar.rowRepos', {
        count: repos.length,
        names: repos.map((r) => r.name).join(', ')
      })
    )
  }
  return [...bits, ...statuses].join(' - ')
}

/** Lucide's `folder` and `folder-open`, as data rather than components.
 *
 * morphicons consumes icon GEOMETRY, so these are the raw `d` strings from
 * lucide-react's own icon nodes - kept here verbatim so the morphing folder
 * and every static lucide icon in the app stay visually identical. */
const FOLDER_CLOSED =
  'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z'
const FOLDER_OPEN =
  'm6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2'

/**
 * The project row's folder, which opens and closes in place of a chevron.
 *
 * The shape genuinely morphs: morphicons resamples both icons, solves the
 * optimal similarity between them and springs along it, so the closed folder
 * unfolds into the open one rather than cross-fading. Two reasons it is worth
 * a dependency over the hand-written CSS `d` transition this replaces:
 *
 * 1. CSS can only interpolate `d` when both paths share an identical command
 *    sequence, which lucide's two folders do NOT - matching them by hand meant
 *    redrawing one icon to fit the other, and the result barely moved.
 * 2. The explicit reducedMotion prop follows Roxy's app preference, so this
 *    library and the canvas progress indicators agree about whether to animate.
 */
function FolderMorph({ open, className }: { open: boolean; className?: string }): JSX.Element {
  const { reduced } = useMotion()
  return (
    <MorphIcon
      icon={open ? FOLDER_OPEN : FOLDER_CLOSED}
      // Matches every static lucide icon around it.
      strokeWidth={2}
      // 2x the speed of the "smooth" preset (k 170), still critically damped so
      // a 14px folder does not wobble. A spring's frequency goes as sqrt(k), so
      // doubling speed is k*4, and c = 2*sqrt(k) keeps zeta = 1 (the same
      // relation every built-in preset uses). Settles in ~225ms, against the
      // preset's ~450ms - which was sluggish for an icon this small.
      spring={{ stiffness: 680, damping: 52 }}
      reducedMotion={reduced ? 'always' : 'never'}
      className={className}
    />
  )
}

export function Sidebar(): JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const chats = useRoxyStore((s) => s.chats)
  const activeChatId = useRoxyStore((s) => s.activeChatId)
  const selectChat = useRoxyStore((s) => s.selectChat)
  const gitStatus = useRoxyStore((s) => s.gitStatus)
  const forgeStatus = useRoxyStore((s) => s.forgeStatus)
  const repoStatus = useRoxyStore((s) => s.repoStatus)
  const refreshAllGitStatus = useRoxyStore((s) => s.refreshAllGitStatus)
  const runningSubagents = useRoxyStore((s) => s.runningSubagents)
  const newSession = useRoxyStore((s) => s.newSession)
  const newSessionInProject = useRoxyStore((s) => s.newSessionInProject)
  const deleteChat = useRoxyStore((s) => s.deleteChat)
  const forkChat = useRoxyStore((s) => s.forkChat)
  const renameChat = useRoxyStore((s) => s.renameChat)
  const sendingChats = useRoxyStore((s) => s.sendingChats)
  const stop = useRoxyStore((s) => s.stop)
  const cancelSubagent = useRoxyStore((s) => s.cancelSubagent)
  const bots = useRoxyStore((s) => s.bots)
  const runningAutomation = useRoxyStore((s) => s.runningAutomation)
  const reorderSessions = useRoxyStore((s) => s.reorderSessions)
  const reorderProjects = useRoxyStore((s) => s.reorderProjects)
  const projectOrder = useRoxyStore((s) => s.projectOrder)
  const [collapsed, setCollapsed] = useState<Set<string>>(storedCollapsedProjects)
  const [expandedSubs, setExpandedSubs] = useState<Set<string>>(new Set())
  const [railed, setRailed] = useState<boolean>(
    () => localStorage.getItem(RAIL_COLLAPSED_KEY) === '1'
  )
  // The open right-click menu: which session, and where the cursor was.
  const [contextMenu, setContextMenu] = useState<{ chat: Chat; x: number; y: number } | null>(null)
  const remotePhase = useRoxyStore((s) => s.remote.phase)
  // Green only when truly live; amber while spinning up or reconnecting.
  const remoteDot: 'green' | 'amber' | null =
    remotePhase === 'live'
      ? 'green'
      : remotePhase === 'starting' || remotePhase === 'offline'
        ? 'amber'
        : null

  useEffect(() => {
    localStorage.setItem(RAIL_COLLAPSED_KEY, railed ? '1' : '0')
  }, [railed])

  // Double-click a session name to rename it inline. Enter / click-away saves,
  // Escape cancels. `cancelRef` lets the shared blur handler tell the two apart.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const cancelRef = useRef(false)

  // Drag-to-reorder sessions within a project (native HTML5 DnD, no dep). We track
  // the dragged session id + the id we're hovering over so the list can show a
  // drop indicator and reorder live; the persist happens on drop.
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  // Which edge of the hovered row we'd drop on. 'after' is what lets an item reach
  // the very bottom (drop onto the last row's lower half) — a before-only insert
  // structurally could never place anything past the last row.
  const [dropAfter, setDropAfter] = useState(false)

  // Drag-to-reorder whole projects (workspace folders). Kept separate from the
  // session DnD state above so a session drag never triggers a project reorder
  // (and vice-versa), even though their native drag events share the DOM tree.
  const [projectDrag, setProjectDrag] = useState<string | null>(null)
  const [projectDragOver, setProjectDragOver] = useState<string | null>(null)
  const [projectDropAfter, setProjectDropAfter] = useState(false)

  // Reorder `sessions` so `sourceId` lands just before/after `targetId`, returning
  // the new id order (or null when nothing actually moved / it's a cross-project drag).
  const reorderWithin = (
    sessions: Chat[],
    sourceId: string,
    targetId: string,
    place: 'before' | 'after'
  ): string[] | null => {
    const ids = sessions.map((s) => s.id)
    const from = ids.indexOf(sourceId)
    if (from === -1 || ids.indexOf(targetId) === -1) return null
    ids.splice(from, 1)
    ids.splice(ids.indexOf(targetId) + (place === 'after' ? 1 : 0), 0, sourceId)
    // Bail if the order is unchanged (e.g. dropped onto your own current slot) so
    // we don't fire a pointless persist + refresh.
    if (ids.every((id, i) => id === sessions[i].id)) return null
    return ids
  }

  const onSessionDrop = (project: Project, targetId: string): void => {
    const source = dragId
    const place = dropAfter ? 'after' : 'before'
    setDragId(null)
    setDragOverId(null)
    setDropAfter(false)
    if (!source || source === targetId) return
    const order = reorderWithin(project.sessions, source, targetId, place)
    if (order) void reorderSessions(project.path === '(no folder)' ? null : project.path, order)
  }

  const beginRename = (chat: Chat): void => {
    cancelRef.current = false
    setDraftTitle(chat.title)
    setEditingId(chat.id)
  }

  // Right-click anywhere on a session row. Renaming is excluded: the row is an
  // <input> then, and stealing its native text menu (cut/paste/spelling) to
  // offer "Rename" would be strictly worse.
  const openContextMenu = (e: ReactMouseEvent, chat: Chat): void => {
    if (editingId === chat.id) return
    e.preventDefault()
    // Native menus close a stale one and open the new one in a single gesture;
    // matching that means overwriting whatever was open, not toggling.
    setContextMenu({ chat, x: e.clientX, y: e.clientY })
  }

  // A row is busy while its own turn streams (a session) or its delegate is
  // still running (a subagent) - exactly when the row swaps its trash for a
  // stop control. The menu has to agree: an action the row withholds but the
  // right-click still offers is not a guarantee, it is a second way in.
  const isBusy = (chat: Chat): boolean =>
    chat.kind === 'sub' ? !!runningSubagents[chat.id] : !!sendingChats[chat.id]

  // The rows a right-click offers, in escalating order of consequence.
  const contextMenuItems = (chat: Chat): MenuItem[] => {
    const busy = isBusy(chat)
    return [
      {
        label: t('sidebar.menu.fork'),
        icon: GitFork,
        onSelect: () => void forkChat(chat.id)
      },
      { label: t('sidebar.menu.rename'), icon: SquarePen, onSelect: () => beginRename(chat) },
      {
        // The label carries the reason. A greyed row with no explanation reads
        // as a bug; this one names the single step that re-enables it, and the
        // control to do it is already on the row you right-clicked.
        label: busy
          ? chat.kind === 'sub'
            ? t('sidebar.menu.deleteBusySub')
            : t('sidebar.menu.deleteBusyTurn')
          : t('sidebar.menu.delete'),
        icon: Trash2,
        danger: true,
        disabled: busy,
        onSelect: () => void deleteChat(chat.id)
      }
    ]
  }

  const commitRename = (): void => {
    const id = editingId
    if (!id) return
    setEditingId(null)
    if (cancelRef.current) {
      cancelRef.current = false
      return
    }
    const next = draftTitle.trim()
    const current = chats.find((c) => c.id === id)
    if (next && current && next !== current.title) void renameChat(id, next)
  }

  const onRenameKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      e.currentTarget.blur()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancelRef.current = true
      e.currentTarget.blur()
    }
  }

  // A project = a workspace folder; main sessions group under it.
  const projects = useMemo<Project[]>(() => {
    const map = new Map<string, Project>()
    const ensure = (path: string): Project => {
      let group = map.get(path)
      if (!group) {
        const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path
        group = { path, name, sessions: [] }
        map.set(path, group)
      }
      return group
    }
    for (const c of chats) {
      if (c.kind !== 'main' || bots.some((bot) => bot.chatId === c.id)) continue
      ensure(c.workspacePath ?? '(no folder)').sessions.push(c)
    }
    const groups = [...map.values()]
    // Order by the user's saved project order; unknowns (a just-created project
    // not yet in projectOrder, or the '(no folder)' catch-all) fall to the bottom.
    // Array.sort is stable, so those keep their newest-first insertion order.
    const rank = new Map(projectOrder.map((p, i) => [p, i]))
    return groups.sort(
      (a, b) =>
        (rank.get(a.path) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(b.path) ?? Number.MAX_SAFE_INTEGER)
    )
  }, [chats, bots, projectOrder])

  useEffect(() => {
    const live = new Set(projects.map((p) => p.path))
    try {
      localStorage.setItem(
        COLLAPSED_PROJECTS_KEY,
        JSON.stringify([...collapsed].filter((p) => live.has(p)))
      )
    } catch {
      // Sidebar expansion is a preference, not a requirement.
    }
  }, [collapsed, projects])

  // Reorder projects so the dragged folder lands before/after the drop target,
  // then persist. Only real folders take part — the '(no folder)' catch-all
  // isn't a registered project, so it always stays pinned at the bottom.
  const onProjectDrop = (targetPath: string): void => {
    const source = projectDrag
    const place = projectDropAfter ? 'after' : 'before'
    setProjectDrag(null)
    setProjectDragOver(null)
    setProjectDropAfter(false)
    if (!source || source === targetPath || targetPath === '(no folder)') return
    const current = projects.map((p) => p.path).filter((p) => p !== '(no folder)')
    const from = current.indexOf(source)
    if (from === -1 || current.indexOf(targetPath) === -1) return
    const paths = current.slice()
    paths.splice(from, 1)
    paths.splice(paths.indexOf(targetPath) + (place === 'after' ? 1 : 0), 0, source)
    if (paths.every((p, i) => p === current[i])) return
    void reorderProjects(paths)
  }

  // Shared project checkouts cannot attribute a PR to any one conversation.
  const statusById = useMemo(() => {
    const map = new Map<
      string,
      { dots: { key: string; state: SidebarGitDotState }[]; titles: string[] }
    >()
    for (const c of chats) {
      const key = c.worktreePath
      if (!key) continue
      // Never let the composite summary speak for each of its repositories.
      const repos = c.repos?.length
        ? (repoStatus[key] ?? [])
        : [{ ...gitStatus[key], name: '', worktreePath: key, forge: forgeStatus[key] }]
      const dots: { key: string; state: SidebarGitDotState }[] = []
      const titles: string[] = []
      for (const repo of repos) {
        if (!repo.isRepo) continue
        const lifecycle = repo.forge?.lifecycle
        const state = sidebarGitDot({
          dirty: repo.dirty,
          ahead: repo.ahead,
          phase: lifecycle?.phase
        })
        const details = [
          lifecycle?.title ??
            (repo.ahead > 0 ? t('workstream.ahead', { count: repo.ahead }) : null),
          repo.dirty ? t('sidebar.rowDirty') : null
        ]
          .filter(Boolean)
          .join(' - ')
        if (details) titles.push(repo.name ? `${repo.name}: ${details}` : details)
        if (state) dots.push({ key: repo.worktreePath, state })
      }
      map.set(c.id, { dots, titles })
    }
    return map
  }, [chats, gitStatus, forgeStatus, repoStatus, t])

  // How many repos each multi-repo session spans, for the row badge. Absent for
  // a single-repo session (`repoCountBadge` returns null at 1), so the map is
  // empty in the common case and the badge never renders.
  const repoCountById = useMemo(() => {
    const map = new Map<string, string>()
    for (const c of chats) {
      const badge = repoCountBadge(c.repos?.length ?? 0)
      if (badge) map.set(c.id, badge)
    }
    return map
  }, [chats])

  // Keep every row's status current, not just the open session's - the whole
  // point is answering "what happened to my PR?" without clicking into each one.
  //
  // Depends on the COUNT of pollable sessions rather than on `chats`, which is
  // replaced on every streamed message: with the array in the deps this timer
  // would restart continuously and, at a 30s period, effectively never fire.
  // The count moves only when a session is created, deleted, or gains a
  // worktree - exactly when a fresh sweep is actually warranted.
  const pollableCount = useMemo(
    () => chats.reduce((n, c) => (statusKeyForSession(c) ? n + 1 : n), 0),
    [chats]
  )
  useEffect(() => {
    if (!pollableCount) return
    void refreshAllGitStatus()
    const timer = setInterval(() => {
      // A backgrounded window has nobody reading the sidebar, and this sweep
      // spawns git once per workstream. Skipping it while hidden is the
      // difference between a status indicator and a battery drain.
      if (document.hidden) return
      void refreshAllGitStatus()
    }, SWEEP_MS)
    // Regaining focus is the highest-value moment to refresh: the user has most
    // likely just come back from merging the PR in a browser.
    const onFocus = (): void => void refreshAllGitStatus()
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [pollableCount, refreshAllGitStatus])

  // Subagent sessions grouped by the main chat that spawned them.
  const subsByParent = useMemo(() => {
    const map = new Map<string, Chat[]>()
    for (const c of chats) {
      if (c.kind !== 'sub' || !c.parentId) continue
      const list = map.get(c.parentId)
      if (list) list.push(c)
      else map.set(c.parentId, [c])
    }
    return map
  }, [chats])

  const toggleSubs = (id: string): void =>
    setExpandedSubs((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const toggleProject = (path: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  if (railed) {
    return (
      <aside
        data-sidebar-surface
        className="sidebar-rail relative flex h-full shrink-0 flex-col items-center border-r border-border bg-surface"
      >
        <div className="titlebar reserve-controls-left h-[54px] w-full shrink-0" />
        <div className="flex flex-col items-center gap-1 pt-1">
          <button
            onClick={() => setRailed(false)}
            title={t('sidebar.expand')}
            className="press-scale flex h-8 w-8 items-center justify-center sq sq-lg rounded-lg text-text-muted hover:bg-white/5 hover:text-text"
          >
            <PanelLeftOpen className="h-4 w-4" />
          </button>
          <button
            onClick={newSession}
            title={t('sidebar.newProject')}
            className="press-scale flex h-8 w-8 items-center justify-center sq sq-lg rounded-lg text-text-muted hover:bg-white/5 hover:text-text"
          >
            <FolderOpen className="h-4 w-4" />
          </button>
        </div>
        <BotsSection rail />
        <div className="mb-3 mt-auto flex flex-col items-center gap-1">
          <button
            onClick={() => navigate('/settings')}
            title={t('sidebar.settings')}
            className="relative press-scale flex h-8 w-8 items-center justify-center sq sq-lg rounded-lg text-text-muted hover:bg-white/5 hover:text-text"
          >
            <SettingsIcon className="h-4 w-4" />
            {remoteDot && (
              <span
                className={cn(
                  'absolute right-1 top-1 h-1.5 w-1.5 rounded-full ring-2 ring-surface',
                  remoteDot === 'green' ? 'bg-success' : 'bg-warning'
                )}
                title={t(
                  remoteDot === 'green' ? 'sidebar.sharingLive' : 'sidebar.sharingConnecting'
                )}
              />
            )}
          </button>
        </div>
      </aside>
    )
  }

  return (
    <SidebarFrame>
      <div className="titlebar reserve-controls-left flex items-center gap-2 px-4 py-3.5">
        <div className="sidebar-brand flex items-center gap-2.5">
          <img
            src={roxy}
            alt="Roxy"
            className="h-7 w-7 sq sq-lg rounded-lg object-cover inset-ring-1 inset-ring-border"
          />
          <span className="text-sm font-semibold tracking-tight">Roxy</span>
        </div>
        <div className="sidebar-controls ml-auto flex items-center gap-1">
          <button
            onClick={() => setRailed(true)}
            title={t('sidebar.collapse')}
            className="press-scale flex h-7 w-7 items-center justify-center sq sq-lg rounded-lg text-text-muted hover:bg-white/5 hover:text-text"
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="px-3">
        <button
          onClick={newSession}
          title={t('sidebar.newProjectTitle')}
          className="press-scale flex h-9 w-full items-center justify-center gap-2 sq sq-lg rounded-lg bg-white text-sm font-medium text-black hover:bg-white/90"
        >
          <FolderOpen className="h-4 w-4" /> {t('sidebar.newProject')}
        </button>
        <BotsSection />
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-3 pb-3">
        <section className="flex min-h-0 flex-1 flex-col">
          <div className="mb-2 flex items-center px-1">
            <span className="text-xs font-medium text-text-muted">{t('sidebar.projects')}</span>
          </div>
          {projects.length === 0 ? (
            <p className="px-1 text-xs text-text-subtle">{t('sidebar.empty')}</p>
          ) : (
            <div className="flex flex-col gap-2">
              {projects.map((project) => {
                const isCollapsed = collapsed.has(project.path)
                const canDragProject = project.path !== '(no folder)'
                return (
                  <div
                    key={project.path}
                    className={cn(
                      'relative',
                      projectDrag === project.path && 'opacity-40',
                      projectDragOver === project.path &&
                        projectDrag &&
                        projectDrag !== project.path &&
                        (projectDropAfter
                          ? 'after:absolute after:inset-x-1 after:-bottom-px after:h-0.5 after:rounded-full after:bg-accent'
                          : 'before:absolute before:inset-x-1 before:-top-px before:h-0.5 before:rounded-full before:bg-accent')
                    )}
                    onDragOver={(e) => {
                      if (!projectDrag || !canDragProject) return
                      e.preventDefault()
                      if (projectDrag === project.path) return
                      const r = e.currentTarget.getBoundingClientRect()
                      const after = e.clientY - r.top > r.height / 2
                      if (projectDragOver !== project.path) setProjectDragOver(project.path)
                      if (after !== projectDropAfter) setProjectDropAfter(after)
                    }}
                    onDrop={(e) => {
                      if (!projectDrag) return
                      e.preventDefault()
                      onProjectDrop(project.path)
                    }}
                  >
                    <div
                      className={cn(
                        'group/project action-rail action-rail-sm flex items-center gap-1 pl-1',
                        projectDrag && 'cursor-grabbing'
                      )}
                      draggable={canDragProject}
                      onDragStart={(e) => {
                        if (!canDragProject) return
                        setProjectDrag(project.path)
                        e.dataTransfer.effectAllowed = 'move'
                        e.stopPropagation()
                      }}
                      onDragEnd={() => {
                        setProjectDrag(null)
                        setProjectDragOver(null)
                        setProjectDropAfter(false)
                      }}
                    >
                      <button
                        onClick={() => toggleProject(project.path)}
                        aria-expanded={!isCollapsed}
                        className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs font-medium text-text-muted transition-colors hover:text-text"
                      >
                        {/* The chevron that used to sit here is gone. It and the
                            folder were two glyphs reporting one fact, and a folder
                            already HAS an open and a closed state - so the icon that
                            names the thing can report it, and the row gets the
                            chevron's width back. */}
                        <FolderMorph
                          open={!isCollapsed}
                          className="h-3.5 w-3.5 shrink-0 opacity-70 transition-opacity group-hover/project:opacity-100"
                        />
                        <span className="truncate" title={project.path}>
                          {project.name}
                        </span>
                      </button>
                      <button
                        onClick={() => void newSessionInProject(project.path)}
                        title={t('sidebar.newSessionInProject')}
                        className="press-scale flex h-5 w-5 shrink-0 items-center justify-center sq sq-base rounded text-text-subtle hover:bg-white/5 hover:text-text"
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {!isCollapsed && (
                      <>
                        <ul className="mt-0.5 flex flex-col gap-0.5 pl-2">
                          {project.sessions.map((chat) => {
                            const sending = !!sendingChats[chat.id] || !!runningAutomation[chat.id]
                            const subs = subsByParent.get(chat.id) ?? []
                            const subsOpen = expandedSubs.has(chat.id)
                            // How many of this session's delegates are working
                            // right now — so a COLLAPSED parent still shows that
                            // something is happening underneath it.
                            const liveSubs = subs.filter((x) => runningSubagents[x.id]).length
                            const status = statusById.get(chat.id)
                            const dotColumns = Math.ceil(Math.sqrt(status?.dots.length ?? 0))
                            const dotSize =
                              status?.dots.length === 1 ? 6 : Math.min(3, 12 / dotColumns)
                            const dotGap = (dotSize * 2) / 3
                            return (
                              <li
                                key={chat.id}
                                // Only the whole row is draggable when not renaming;
                                // the inline input stays editable during a rename.
                                draggable={editingId !== chat.id}
                                onDragStart={(e) => {
                                  setDragId(chat.id)
                                  e.dataTransfer.effectAllowed = 'move'
                                }}
                                onDragEnter={() =>
                                  dragId && dragId !== chat.id && setDragOverId(chat.id)
                                }
                                onDragOver={(e) => {
                                  if (!dragId) return
                                  e.preventDefault() // allow drop
                                  if (dragId === chat.id) return
                                  // Top half → drop before this row; bottom half → after.
                                  // The 'after' branch is what makes the bottom reachable.
                                  const r = e.currentTarget.getBoundingClientRect()
                                  const after = e.clientY - r.top > r.height / 2
                                  if (dragOverId !== chat.id) setDragOverId(chat.id)
                                  if (after !== dropAfter) setDropAfter(after)
                                }}
                                onDrop={(e) => {
                                  e.preventDefault()
                                  onSessionDrop(project, chat.id)
                                }}
                                onDragEnd={() => {
                                  setDragId(null)
                                  setDragOverId(null)
                                  setDropAfter(false)
                                }}
                                className={cn(
                                  'relative',
                                  dragId === chat.id && 'opacity-40',
                                  // Drop indicator: a hairline on the edge we'd insert at
                                  // (top for 'before', bottom for 'after').
                                  dragOverId === chat.id &&
                                    dragId !== chat.id &&
                                    (dropAfter
                                      ? 'after:absolute after:inset-x-1 after:-bottom-px after:h-0.5 after:rounded-full after:bg-accent'
                                      : 'before:absolute before:inset-x-1 before:-top-px before:h-0.5 before:rounded-full before:bg-accent')
                                )}
                              >
                                <div
                                  onContextMenu={(e) => openContextMenu(e, chat)}
                                  className={cn(
                                    'group action-rail flex items-center gap-2 sq sq-lg rounded-lg py-1.5 pl-2.5 text-sm transition-colors',
                                    dragId && 'cursor-grabbing',
                                    // Keep the right-clicked row visibly selected
                                    // for as long as its menu is open, so a menu
                                    // floating over a dense list still says which
                                    // session it is about to act on. It borrows
                                    // the selected look wholesale: a second,
                                    // lesser highlight would just be a new thing
                                    // to learn.
                                    chat.id === activeChatId || contextMenu?.chat.id === chat.id
                                      ? 'bg-elevated text-text'
                                      : 'text-text-muted hover:bg-white/5 hover:text-text'
                                  )}
                                >
                                  {editingId === chat.id ? (
                                    <input
                                      autoFocus
                                      value={draftTitle}
                                      onChange={(e) => setDraftTitle(e.target.value)}
                                      onKeyDown={onRenameKeyDown}
                                      onBlur={commitRename}
                                      onFocus={(e) => e.currentTarget.select()}
                                      onClick={(e) => e.stopPropagation()}
                                      className="min-w-0 flex-1 sq sq-base sq-ring sq-ring-accent rounded border border-accent/60 bg-bg px-1.5 py-0.5 text-sm text-text outline-none"
                                    />
                                  ) : (
                                    <button
                                      onClick={() => selectChat(chat.id)}
                                      onDoubleClick={() => beginRename(chat)}
                                      title={sessionRowTitle(chat, status?.titles ?? [], t)}
                                      className="min-w-0 flex-1 text-left"
                                    >
                                      <span className="block truncate">{chat.title}</span>
                                      {/* A worktree session's branch: this is what makes the
                                          sidebar readable as N parallel workstreams. */}
                                      {chat.branch && (
                                        <span className="flex items-center gap-1 text-[10px] text-text-subtle">
                                          <GitBranch className="h-2.5 w-2.5 shrink-0 opacity-70" />
                                          <span className="truncate">{chat.branch}</span>
                                          {/* Multi-repo: the branch name spans
                                              N repos. Null for single-repo, so
                                              ordinary rows are untouched. */}
                                          {repoCountById.get(chat.id) && (
                                            <span className="shrink-0 rounded bg-white/8 px-0.5 text-[9px] leading-3 text-text-subtle">
                                              {repoCountById.get(chat.id)}
                                            </span>
                                          )}
                                        </span>
                                      )}
                                    </button>
                                  )}
                                  {subs.length > 0 && (
                                    <button
                                      onClick={() => toggleSubs(chat.id)}
                                      title={t('sidebar.subagentTooltip', {
                                        subagents: t('sidebar.subagentCount', {
                                          count: subs.length
                                        }),
                                        working:
                                          liveSubs > 0
                                            ? t('sidebar.subagentWorking', { count: liveSubs })
                                            : '',
                                        action: subsOpen
                                          ? t('sidebar.subagentToggleHide', {
                                              count: subs.length
                                            })
                                          : t('sidebar.subagentToggleView', {
                                              count: subs.length
                                            })
                                      })}
                                      className={cn(
                                        'flex h-5 min-w-[1.25rem] shrink-0 items-center justify-center rounded-full px-1 text-[10px] font-medium tabular-nums transition-[opacity,color,background-color]',
                                        liveSubs > 0
                                          ? 'bg-accent/10 text-accent'
                                          : 'bg-surface-2 text-text-subtle hover:text-text',
                                        // Normally a disclosure control, so it earns space only
                                        // on hover or while the list it toggles is open. Live
                                        // delegates are the exception: a BACKGROUND subagent runs
                                        // while its parent sits idle, and the slot on the right
                                        // speaks for the parent's own turn, not theirs. A tinted
                                        // status dot used to carry that - now that the dot is
                                        // gone the pill pins itself instead, and it says how many
                                        // rather than merely that something is up.
                                        subsOpen || liveSubs > 0
                                          ? 'opacity-100'
                                          : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100'
                                      )}
                                    >
                                      {subs.length}
                                    </button>
                                  )}
                                  {/* Activity, Git state, and actions share one fixed slot.
                                      Running rows keep Stop rather than allowing mid-turn deletion. */}
                                  {sending ? (
                                    // Stop THAT session. `store.stop()` only ever knew the
                                    // active chat, so a session streaming in the background
                                    // could not be stopped without switching to it first.
                                    <button
                                      onClick={() => stop(chat.id)}
                                      title={t('sidebar.stopSession')}
                                      className="group/stop flex h-6 w-6 shrink-0 items-center justify-center sq sq-md rounded-md text-accent transition-colors hover:bg-white/10"
                                    >
                                      <BrailleSpinner className="text-sm group-hover/stop:hidden" />
                                      <Square className="hidden h-2.5 w-2.5 fill-current group-hover/stop:block" />
                                    </button>
                                  ) : (
                                    <div className="relative flex h-6 w-6 shrink-0 items-center justify-center">
                                      {!!status?.dots.length && (
                                        <span
                                          role="img"
                                          aria-label={status.titles.join(' - ')}
                                          className="pointer-events-none flex h-full w-full items-center justify-center group-hover:invisible group-focus-within:invisible"
                                        >
                                          <span
                                            className="flex flex-wrap justify-center"
                                            style={{
                                              width:
                                                dotColumns * dotSize + (dotColumns - 1) * dotGap,
                                              gap: dotGap
                                            }}
                                          >
                                            {status.dots.map((dot) => (
                                              <span
                                                key={dot.key}
                                                data-git-status={dot.state}
                                                style={{ width: dotSize, height: dotSize }}
                                                className={cn(
                                                  'shrink-0 rounded-full',
                                                  GIT_DOT_COLOR[dot.state]
                                                )}
                                              />
                                            ))}
                                          </span>
                                        </span>
                                      )}
                                      <button
                                        onClick={() => deleteChat(chat.id)}
                                        title={t('sidebar.deleteSession')}
                                        className="absolute inset-0 flex items-center justify-center sq sq-md rounded-md text-text-subtle opacity-0 transition-[opacity,color,background-color] hover:bg-white/5 hover:text-danger group-hover:opacity-100 group-focus-within:opacity-100"
                                      >
                                        <Trash2 className="h-3.5 w-3.5" />
                                      </button>
                                    </div>
                                  )}
                                </div>
                                {subsOpen && subs.length > 0 && (
                                  <ul className="mt-0.5 ml-3 flex flex-col gap-0.5 border-l border-border pl-2">
                                    {subs.map((sub) => (
                                      <li key={sub.id}>
                                        <div
                                          onContextMenu={(e) => openContextMenu(e, sub)}
                                          className={cn(
                                            'group/sub action-rail action-rail-sm flex items-center gap-2 sq sq-lg rounded-lg py-1 pl-2 text-xs transition-colors',
                                            sub.id === activeChatId ||
                                              contextMenu?.chat.id === sub.id
                                              ? 'bg-elevated text-text'
                                              : 'text-text-muted hover:bg-white/5 hover:text-text'
                                          )}
                                        >
                                          {/* Identity, not status: the row says what it IS at a
                                              glance and keeps saying it while the delegate
                                              works. Cancel moved to the action slot below. */}
                                          <Hammer className="h-3 w-3 shrink-0 opacity-70" />
                                          {editingId === sub.id ? (
                                            <input
                                              autoFocus
                                              value={draftTitle}
                                              onChange={(e) => setDraftTitle(e.target.value)}
                                              onKeyDown={onRenameKeyDown}
                                              onBlur={commitRename}
                                              onFocus={(e) => e.currentTarget.select()}
                                              onClick={(e) => e.stopPropagation()}
                                              className="min-w-0 flex-1 sq sq-base sq-ring sq-ring-accent rounded border border-accent/60 bg-bg px-1.5 py-0.5 text-xs text-text outline-none"
                                            />
                                          ) : (
                                            <button
                                              onClick={() => selectChat(sub.id)}
                                              onDoubleClick={() => beginRename(sub)}
                                              title={sub.title}
                                              className="min-w-0 flex-1 truncate text-left"
                                            >
                                              {sub.title}
                                            </button>
                                          )}
                                          {/* Same slot, same rule as the parent row above. */}
                                          {runningSubagents[sub.id] ? (
                                            // Skip one delegate from the sidebar — the fastest
                                            // path for the "a commit hook spawned a README
                                            // subagent I don't want" case, with nothing to open.
                                            <button
                                              onClick={() => void cancelSubagent(sub.id)}
                                              title={t('sidebar.cancelSubagent')}
                                              className="group/cancel flex h-5 w-5 shrink-0 items-center justify-center sq sq-base rounded text-accent transition-colors hover:bg-white/10"
                                            >
                                              <BrailleSpinner className="text-xs group-hover/cancel:hidden" />
                                              <Square className="hidden h-2 w-2 fill-current group-hover/cancel:block" />
                                            </button>
                                          ) : (
                                            <button
                                              onClick={() => deleteChat(sub.id)}
                                              title={t('sidebar.deleteSubagentSession')}
                                              className="flex h-5 w-5 shrink-0 items-center justify-center sq sq-base rounded text-text-subtle opacity-0 transition-[opacity,color,background-color] hover:bg-white/5 hover:text-danger group-hover/sub:opacity-100"
                                            >
                                              <Trash2 className="h-3 w-3" />
                                            </button>
                                          )}
                                        </div>
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </li>
                            )
                          })}
                        </ul>
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </section>
      </div>

      {contextMenu && (
        <SessionContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems(contextMenu.chat)}
          onClose={() => setContextMenu(null)}
        />
      )}

      <div className="border-t border-border px-3 py-2">
        <SidebarNavItem className="w-full" onClick={() => navigate('/settings')}>
          <SettingsIcon aria-hidden="true" className="h-4 w-4 shrink-0 opacity-80" />
          <span className="flex-1">{t('sidebar.settings')}</span>
          {remoteDot && (
            <span
              className={cn(
                'h-2 w-2 shrink-0 rounded-full',
                remoteDot === 'green' ? 'bg-success' : 'bg-warning'
              )}
              title={t(remoteDot === 'green' ? 'sidebar.sharingLive' : 'sidebar.sharingConnecting')}
            />
          )}
        </SidebarNavItem>
      </div>

      <UpdateCard />
    </SidebarFrame>
  )
}

/** One row of the session context menu. */
interface MenuItem {
  label: string
  icon: typeof Trash2
  onSelect: () => void
  danger?: boolean
  /** Offered but not available right now. The label should say why. */
  disabled?: boolean
}

/**
 * The right-click menu on a session row.
 *
 * Positioned at the cursor rather than at the row: a context menu that opens
 * somewhere other than where you clicked makes you re-find it, and with rows
 * this dense you'd routinely be pointing at a different session than the one
 * the menu belongs to. Positioning, portalling and dismissal all live in
 * ContextMenuSurface — shared with the clipboard menu, so the two behave
 * identically.
 */
function SessionContextMenu({
  x,
  y,
  items,
  onClose
}: {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}): JSX.Element {
  return (
    <ContextMenuSurface
      x={x}
      y={y}
      height={items.length * CONTEXT_ROW_H + CONTEXT_MENU_PAD}
      onClose={onClose}
    >
      {items.map((item) => (
        <ContextMenuRow
          key={item.label}
          label={item.label}
          icon={item.icon}
          danger={item.danger}
          disabled={item.disabled}
          onSelect={() => {
            onClose()
            item.onSelect()
          }}
        />
      ))}
    </ContextMenuSurface>
  )
}
