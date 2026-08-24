/**
 * Pure decision logic for the workstream strip — extracted from the component so
 * the rules can be unit-tested without a renderer (`npm run smoke:shared`).
 *
 * The rules are small but easy to get subtly wrong, and every one of them is a
 * visible bug: a strip that flashes and vanishes, a sub-session offering a
 * dropdown that would move its parent's tree, or a permanent greyed-out row in
 * every non-git folder.
 */
import type { WorktreeIntent } from './types'

/** The minimal session shape the strip cares about. */
export interface StripSession {
  id: string
  title: string
  kind: string
  parentId: string | null
  workspacePath: string | null
  worktreePath: string | null
  branch: string | null
  /**
   * A worktree this session asked for but hasn't got yet — worktrees are
   * materialized lazily, on the first turn, so an abandoned composer leaves
   * nothing on disk. Between "new workstream" and that first turn the session
   * has no `worktreePath`, which is NOT the same as belonging to the default
   * workstream, and the strip has to say so.
   */
  worktreePending?: WorktreeIntent | null
}

/** The minimal git status shape the strip cares about. */
export interface StripGitStatus {
  isRepo: boolean
  branch: string | null
  dirty: boolean
  changed: number
}

export interface StripView {
  /** The session whose workstream is displayed (a sub shows its PARENT's). */
  ownerId: string
  /** Key into the polled status map: the worktree, else the project folder. */
  statusKey: string | null
  label: string
  branch: string | null
  dirty: boolean
  /** Sub-sessions inherit their workstream and must not offer the dropdown. */
  readOnly: boolean
  inWorktree: boolean
  /**
   * The workstream is requested but not created yet. The strip dims the label
   * and the menu marks the row, so "pending" never reads as "done".
   */
  pending: boolean
}

/**
 * What the strip should show, or null to render NOTHING.
 *
 * Hidden (not greyed out) when there's no session, no workspace, no git binary,
 * or the folder isn't a repository — most folders aren't repos, and a permanent
 * disabled row would just be a nag. Also hidden until the first status arrives,
 * so it doesn't flash on and back off — except for a session that already has a
 * worktree, whose very existence is proof of a repo (see below).
 *
 * NOTE: the strip also hosts the Services segment, which is NOT git-scoped —
 * a dev server runs in any folder. So the row itself can outlive a null view;
 * see `WorkstreamStrip`, which renders the services segment alone when this
 * returns null.
 */
export function workstreamStripView(input: {
  chat: StripSession | null
  /** Looked up by id — a sub-session's workstream belongs to its parent. */
  findChat: (id: string) => StripSession | null
  gitAvailable: boolean | null
  status: StripGitStatus | undefined
  /**
   * True when the PROJECT FOLDER is a folder OF repos (backend/, frontend/,
   * ...) rather than a repository itself. Probed once per project.
   */
  projectHasRepos?: boolean
}): StripView | null {
  const { chat, findChat, gitAvailable, status } = input
  if (!chat) return null
  if (gitAvailable === false) return null

  // Subagents run in the tree that spawned them, so they display the parent's
  // workstream — read-only, since acting on it would move the parent.
  const owner = chat.kind === 'sub' && chat.parentId ? findChat(chat.parentId) : chat
  if (!owner?.workspacePath) return null

  // Only real sessions get the dropdown: a sub inherits, and a loop has no
  // workstream of its own to change.
  const readOnly = chat.kind !== 'main'

  // `worktreePath` counts as proof of a repo when no status has arrived yet:
  // git only ever creates a worktree INSIDE a repository. That matters at
  // exactly one moment, and it is the moment this screen exists for - a worktree
  // materializing mid-turn moves the session onto a path the status map has
  // never been keyed by, and reading that absent entry as "not a repo" would
  // blank the row for a whole poll interval, right after it finally had
  // something true to say. It does NOT outrank a status that actually arrived
  // saying `isRepo: false`: that means the worktree went away underneath us, and
  // the strip should go quiet.
  //
  // `projectHasRepos` is the third source of proof, and a MULTI-REPO project
  // depends on it entirely: a folder of repos is not itself a repository, so
  // its status legitimately reports `isRepo: false` forever. Without this the
  // strip would be permanently hidden for exactly the workspaces multi-repo
  // support was built for.
  //
  // Order matters, and the multi-repo case is why it is subtle.
  //
  // For a SINGLE-repo session an arrived `isRepo: false` is conclusive: the
  // checkout was deleted underneath us, so the strip goes quiet.
  //
  // For a MULTI-repo session it proves nothing. A composite worktree is a plain
  // directory holding one real worktree per repo, so `git status` on the
  // composite root reports `isRepo: false` for a perfectly healthy workstream -
  // it is not a repository and never was. Treating that as "the worktree
  // vanished" hides the strip for every composite session the moment a plain
  // status lands on its key, which is exactly what happened in practice.
  //
  // So `projectHasRepos` outranks a false status for a multi-repo project,
  // whether or not the worktree exists. The vanished-composite case is still
  // caught, just by the honest signal rather than this one: `repoStatus` from
  // `statusMulti` reports every child as `isRepo: false`, which drives
  // `repoCount === 0` and blanks the strip's contents.
  const proven = status
    ? status.isRepo || !!input.projectHasRepos
    : !!owner.worktreePath || !!input.projectHasRepos
  if (!proven) return null

  // A session that has ASKED for a workstream is not in the default one. Saying
  // "default workstream" there is not merely vague, it is wrong in the direction
  // that matters: it names the shared checkout every other session and the
  // user's editor are sitting in, so the honest reading of the old label was
  // "your next turn edits main directly" — the opposite of what will happen.
  const pending = !owner.worktreePath && !!owner.worktreePending

  return {
    ownerId: owner.id,
    statusKey: owner.worktreePath ?? owner.workspacePath,
    label: workstreamLabel(owner),
    // Same trap on the branch: until the worktree exists the session has no
    // branch of its own, and falling back to the CURRENT branch would display
    // the very branch this workstream is meant to avoid.
    branch: pending
      ? pendingBranch(owner.worktreePending)
      : (owner.branch ?? status?.branch ?? null),
    // Unknown dirtiness reads as clean: the dot is a warning, and inventing one
    // from a status we do not have yet would cry wolf on a fresh worktree.
    dirty: pending ? false : (status?.dirty ?? false),
    readOnly,
    inWorktree: !!owner.worktreePath,
    pending
  }
}

/**
 * What to call a session's workstream.
 *
 * Pending sessions are titled from their intent at creation, so the title is
 * already the right word — it just needs to not claim to exist yet.
 */
function workstreamLabel(owner: StripSession): string {
  if (owner.worktreePath) return owner.title || 'workstream'
  if (owner.worktreePending) return owner.title || 'new workstream'
  return 'default workstream'
}

/**
 * The branch a pending workstream will land on, when it is already known.
 *
 * Only `fromBranch`/`attach` know it: `new` gets a generated placeholder name
 * (`roxy/a1b2c3d4`) at materialization time, and inventing one here would show a
 * branch that never comes to exist.
 */
function pendingBranch(intent: WorktreeIntent | null | undefined): string | null {
  const branch = intent?.branch?.trim()
  return branch || null
}

/**
 * Should a NEW session in this project get its own workstream?
 *
 * Pure so the rule is testable, and central so every entry point (sidebar,
 * folder picker, project menu) answers it identically -- the old behaviour was
 * "whatever each call site happened to pass", which is how the default ended up
 * inconsistent with the dropdown right below it.
 *
 * Both guards are correctness, not caution:
 *   - a folder with no repo in it has nothing to branch from, and
 *     `git worktree add` would fail on the turn path;
 *   - without a git binary the same is true, and `gitAvailable === null` means
 *     "not probed yet", which must not be read as "no".
 *
 * `isRepo` is false for a MULTI-REPO project - the folder itself isn't a
 * repository, its children are - so `hasRepos` carries that case. Without it
 * exactly the people this feature is for (a workspace of sibling repos) would
 * still get no workstream by default, which was the original bug.
 */
export function shouldAutoWorkstream(input: {
  autoWorkstream: boolean
  gitAvailable: boolean | null
  isRepo: boolean | undefined
  /** True when the project is a folder OF repos (see shared/repos.ts). */
  hasRepos?: boolean
}): boolean {
  if (!input.autoWorkstream) return false
  if (input.gitAvailable !== true) return false
  return input.isRepo === true || input.hasRepos === true
}

/**
 * Which status entry a session polls, or null when it shouldn't poll at all.
 *
 * Keyed by WORKTREE path so N sessions sharing one worktree share a single
 * poll, and sub-sessions never poll separately from their parent.
 */
export function statusKeyForSession(chat: StripSession): string | null {
  if (chat.kind === 'sub') return null
  return chat.worktreePath ?? chat.workspacePath
}
