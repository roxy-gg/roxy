/**
 * Multi-repo projects: the pure half.
 *
 * A Roxy "project" is just a folder the user opened. Usually that folder IS a
 * git repo, but plenty of people keep a workspace like:
 *
 *   project/
 *     backend/    <- its own repo
 *     frontend/   <- its own repo
 *     shared/     <- its own repo
 *
 * with no repo at the top. A session there used to get no workstream at all
 * ("this folder isn't a git repository"), which meant no isolation and no
 * parallel agents for exactly the people who need it most.
 *
 * The fix is a COMPOSITE worktree: one directory per session, containing one
 * real git worktree per repo, all on the same branch name:
 *
 *   worktrees/project/cursed-ranoa-king/     <- composite root, NOT a repo
 *     backend/    <- worktree of project/backend   on roxy/cursed-ranoa-king
 *     frontend/   <- worktree of project/frontend  on roxy/cursed-ranoa-king
 *     shared/     <- worktree of project/shared    on roxy/cursed-ranoa-king
 *
 * Two facts make this work, both verified against real git rather than assumed:
 *   - branch names are per-repo, so the same name in three repos is three
 *     unrelated branches and never collides;
 *   - relative sibling paths (`../shared`) still resolve inside the composite,
 *     so tooling that walks sideways keeps working.
 *
 * `chats.worktree_path` therefore stops meaning "a git working tree" and starts
 * meaning "the folder this session works in". For a single-repo project those
 * are the same directory and NOTHING about the old behaviour changes — which is
 * the property every function here is written to preserve.
 *
 * No Node, no Electron, no DB: this file is unit-tested by `npm run smoke:shared`.
 * The filesystem half (`discoverRepos`) lives in `main/services/workspace.ts`.
 */

/** Minimal `path` surface, injected so this module stays platform-agnostic. */
export interface RepoPathOps {
  join(...parts: string[]): string
  basename(p: string): string
}

/**
 * How a project folder relates to git — decided once, by `discoverRepos`.
 *
 *   none   -> no repo here or above; sessions run in place (unchanged)
 *   single -> the project is (or sits inside) ONE repo; classic worktree
 *   multi  -> the project isn't a repo but has repos one level down; composite
 */
export type RepoLayout = 'none' | 'single' | 'multi'

/**
 * One repo inside a session's composite worktree.
 *
 * Persisted as JSON in `chats.repos`. NULL/empty there means single-repo, and
 * every single-repo code path short-circuits on that — so existing sessions and
 * existing projects keep running the exact code they ran before.
 */
export interface RepoLink {
  /**
   * Folder name under both the project root and the composite root, e.g.
   * `backend`. This is the join key between the two trees, which is why the
   * composite deliberately mirrors the project's own layout.
   */
  name: string
  /** The repo's main working tree, inside the project folder. */
  root: string
  /** This session's worktree for that repo (`<compositeRoot>/<name>`). */
  worktreePath: string
  /** The branch checked out there. Identical across links by construction. */
  branch: string | null
}

/**
 * Upper bound on repos adopted from one project folder.
 *
 * A composite worktree costs one full checkout per repo, created serially on a
 * session's FIRST TURN — so a folder holding 40 clones would turn "send a
 * message" into a multi-minute disk operation. Far better to adopt a sane
 * prefix (sorted, so it's deterministic) than to hang the turn.
 */
export const MAX_COMPOSITE_REPOS = 12

/**
 * Directory names never scanned for a nested repo.
 *
 * Dependency and build directories routinely CONTAIN checkouts (a vendored
 * dependency, a Go module cache, a pnpm store) that are emphatically not part
 * of the user's project. Adopting one would create a worktree of somebody
 * else's repo and put it on a branch named after this session.
 */
export const SKIP_REPO_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'bower_components',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.venv',
  'venv',
  'env',
  '__pycache__',
  'Pods',
  'DerivedData',
  'tmp',
  'temp'
])

/** Whether a directory name is eligible to hold one of a project's repos. */
export function isScannableDir(name: string): boolean {
  // Dotfolders are config/tooling (`.git`, `.vscode`, `.roxy`), never project
  // members — and skipping them keeps `.git` itself out of the scan for free.
  if (!name || name.startsWith('.')) return false
  return !SKIP_REPO_DIRS.has(name)
}

/** True when a session's worktree is a composite of several repos. */
export function isMultiRepo(links: RepoLink[] | null | undefined): boolean {
  return !!links && links.length > 0
}

/**
 * Which directory the worktree path math should treat as "the repo root".
 *
 * `resolveWorktreeCwd` maps a project folder into a worktree by preserving its
 * path RELATIVE to the repo root. A composite root mirrors the PROJECT folder,
 * not any one repo, so the project folder is its own anchor and the mapping
 * resolves to the composite root itself.
 *
 * Getting this wrong is silent and severe: `findGitRoot` on a multi-repo
 * project walks past it and can land on some unrelated ancestor repo (a
 * `~/code` that happens to be versioned), and the session would then run in a
 * subdirectory of the composite that does not exist.
 */
export function worktreeAnchor(
  workspacePath: string,
  links: RepoLink[] | null | undefined,
  gitRoot: string | null | undefined
): string | null {
  if (isMultiRepo(links)) return workspacePath
  return gitRoot ?? null
}

/** A repo's directory inside a composite worktree. */
export function compositeChildPath(compositeRoot: string, name: string, p: RepoPathOps): string {
  return p.join(compositeRoot, name)
}

/**
 * Build the links for a set of repo roots under one composite root.
 *
 * Pure so materialization can compute the whole plan up front and tests can
 * assert the layout without touching a disk.
 */
export function planRepoLinks(
  compositeRoot: string,
  repoRoots: string[],
  branch: string | null,
  p: RepoPathOps
): RepoLink[] {
  return repoRoots.map((root) => {
    const name = p.basename(root)
    return { name, root, worktreePath: compositeChildPath(compositeRoot, name, p), branch }
  })
}

/**
 * Decode `chats.repos`, tolerating anything malformed.
 *
 * Rebuilt field by field rather than returned as-is (the same rule
 * `parseWorktreeIntent` follows): a hand-edited or future-version row must not
 * be able to smuggle an unexpected shape onto the turn path. A link missing any
 * required field is DROPPED rather than defaulted — a link with an empty `root`
 * would later be handed to `git worktree remove` with no repo to run it from.
 */
export function parseRepoLinks(json: string | null | undefined): RepoLink[] {
  if (!json) return []
  try {
    const raw = JSON.parse(json) as unknown
    if (!Array.isArray(raw)) return []
    const out: RepoLink[] = []
    const seen = new Set<string>()
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue
      const v = item as Partial<RepoLink>
      if (typeof v.name !== 'string' || !v.name) continue
      if (typeof v.root !== 'string' || !v.root) continue
      if (typeof v.worktreePath !== 'string' || !v.worktreePath) continue
      // Two links with one name would both map to the same composite child,
      // and the second removal would fail on an already-deleted directory.
      if (seen.has(v.name)) continue
      seen.add(v.name)
      out.push({
        name: v.name,
        root: v.root,
        worktreePath: v.worktreePath,
        branch: typeof v.branch === 'string' ? v.branch : null
      })
    }
    return out
  } catch {
    return []
  }
}

/** Encode links for storage. Empty encodes as null, which means "single repo". */
export function serializeRepoLinks(links: RepoLink[] | null | undefined): string | null {
  return links && links.length ? JSON.stringify(links) : null
}

// ---------------------------------------------------------------------------
// Aggregation: N repo statuses -> the one line the UI shows
// ---------------------------------------------------------------------------

/** The per-repo git facts the UI aggregates over. One entry per live repo. */
export interface RepoStatusLite {
  name: string
  isRepo: boolean
  branch: string | null
  dirty: boolean
  changed: number
  ahead: number
  behind: number
  hasUpstream: boolean
}

/** The single summary line a composite workstream presents. */
export interface AggregateStatus {
  /** The name every repo shares, or null when they have diverged. */
  branch: string | null
  /** True when ANY repo has uncommitted work. */
  dirty: boolean
  /** Total changed entries across every repo. */
  changed: number
  ahead: number
  behind: number
  /** How many repos are in the workstream. */
  repoCount: number
  /** Repos with uncommitted work, in display order. */
  dirtyRepos: string[]
  /**
   * True when the repos are NOT all on one branch name. A real state after a
   * rename that half-succeeded, and worth surfacing rather than hiding: the
   * session no longer has one name that describes it.
   */
  diverged: boolean
}

/**
 * Fold N repo statuses into the one line the sidebar/strip shows.
 *
 * Every choice here is "which lie is least bad when the repos disagree":
 *   - dirty is ANY, because the warning dot exists to stop you throwing work
 *     away, and a clean majority does not make the dirty one safe to delete;
 *   - changed/ahead/behind are SUMS, because they answer "how much is
 *     outstanding across this workstream" - a magnitude, not a coordinate into
 *     any one repo;
 *   - branch is the shared name or NOTHING, never a sample of one repo.
 *
 * Repos reporting `isRepo: false` are ignored rather than counted as clean: a
 * checkout that vanished underneath us knows nothing about its own dirtiness,
 * and treating it as clean is the direction that loses work.
 */
export function aggregateRepoStatus(repos: RepoStatusLite[]): AggregateStatus {
  const live = repos.filter((r) => r.isRepo)
  const branches = live.map((r) => r.branch).filter((b): b is string => !!b)
  const first = branches[0] ?? null
  const allAgree = branches.length === live.length && branches.every((b) => b === first)

  return {
    branch: live.length && allAgree ? first : null,
    dirty: live.some((r) => r.dirty),
    changed: live.reduce((n, r) => n + r.changed, 0),
    ahead: live.reduce((n, r) => n + r.ahead, 0),
    behind: live.reduce((n, r) => n + r.behind, 0),
    repoCount: live.length,
    dirtyRepos: live.filter((r) => r.dirty).map((r) => r.name),
    diverged: live.length > 1 && !allAgree
  }
}

/**
 * The count badge for a composite workstream, or null when there is nothing
 * worth saying.
 *
 * Null for 0 and 1 on purpose: a single-repo session must render EXACTLY as it
 * did before multi-repo support existed, and a `1` on every ordinary session
 * would be pure noise.
 */
export function repoCountBadge(count: number): string | null {
  return count > 1 ? String(count) : null
}

/**
 * Tooltip line for a composite: which repos are dirty, or that none are.
 *
 * The strip shows one summary dot; this is what hovering it says, and it has to
 * name names - "something in here is dirty" is not actionable when the session
 * spans four repos.
 */
export function describeRepoStatus(agg: AggregateStatus): string {
  if (!agg.repoCount) return 'No repositories checked out.'
  const scope = `${agg.repoCount} ${agg.repoCount === 1 ? 'repository' : 'repositories'}`
  if (agg.diverged) return `${scope}, on different branches.`
  if (!agg.dirtyRepos.length) return `${scope}, all clean.`
  return `Uncommitted changes in ${agg.dirtyRepos.join(', ')}.`
}

/**
 * The one branch name to show for a session, given its links.
 *
 * Normally every link carries the same name, so this is just "the branch". It
 * returns null when they have DIVERGED, which is a real state: a rename that
 * succeeded in two repos and failed in the third leaves the set inconsistent,
 * and printing one of the three names would assert something false about the
 * other two.
 */
export function sharedBranch(links: RepoLink[] | null | undefined): string | null {
  if (!links || !links.length) return null
  const first = links[0].branch
  if (!first) return null
  return links.every((l) => l.branch === first) ? first : null
}
