/**
 * Worktree lifecycle on top of `git.ts` — creating a session's isolated
 * checkout, and cleaning up ones nothing points at any more.
 *
 * The key policy lives here rather than in `git.ts`: a worktree is materialized
 * LAZILY, on a session's first turn. Creating it when the session is created
 * would litter the disk with directories for every composer someone opened and
 * abandoned. And because it happens on the turn path, failure must be soft — a
 * missing git binary, a locked index or an offline fetch degrades to "run in the
 * project folder", never to a turn that won't start.
 */
import {
  DEFAULT_BRANCH_PREFIX,
  branchNameError,
  isPlaceholderBranch,
  normalizeBranchPrefix
} from '../../shared/branch'
import { slugToBranchSegment } from '../../shared/slugs'
import { isMultiRepo, planRepoLinks, sharedBranch, type RepoLink } from '../../shared/repos'
import { existsSync, readFileSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import * as repo from '../db/repo'
import * as git from './git'
import { discoverRepos } from './workspace'
import { ensureDevPort } from './ports'
import { startBackground, killSessionBackground } from '../harness'
import { activeBackgroundSubChatIds, hasActiveBackgroundJobs } from './background-tasks'
import { emitSessionsUpdated } from './session-events'
import type { WorktreeIntent } from '../../shared/types'

/**
 * Optional per-project worktree config, read from `<project>/.roxy/worktree.json`
 * — the same convention as `.roxy/mcp.json` (see services/mcp.ts).
 *
 *   { "setup": "cp $ROXY_PROJECT_ROOT/.env . && pnpm install" }
 */
export interface WorktreeConfig {
  /** Shell command run in a NEW worktree, once, right after it's created. */
  setup?: string
}

/**
 * Read `.roxy/worktree.json`. Missing or malformed yields `{}` — a broken
 * config must degrade to "no setup script", never break worktree creation.
 */
export function loadWorktreeConfig(projectRoot: string): WorktreeConfig {
  if (!projectRoot) return {}
  const file = path.join(projectRoot, '.roxy', 'worktree.json')
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as WorktreeConfig
    if (!parsed || typeof parsed !== 'object') return {}
    return { setup: typeof parsed.setup === 'string' ? parsed.setup : undefined }
  } catch {
    return {}
  }
}

/**
 * Run the project's setup script in a freshly created worktree.
 *
 * A new worktree has an EMPTY node_modules and no .env — git only tracks what's
 * committed. There is deliberately no auto-copy and no symlink here:
 *   - copying node_modules costs gigabytes per session, and native modules are
 *     built per platform/arch anyway;
 *   - symlinking it to the main checkout would let one branch's `npm install`
 *     mutate every other session's dependencies, which destroys the isolation
 *     this whole feature exists to provide.
 * So the user declares what their project needs, and we run it.
 *
 * It goes through `startBackground` — the same path the `bash` tool uses — so
 * the install shows up in bash_list, streams its output, is owned by the
 * session, and is killed when the session is deleted. Never awaited: a
 * `pnpm install` takes minutes and must not hold up the turn.
 */
function runSetupScript(input: {
  chatId: string
  projectRoot: string
  worktreePath: string
  devPort: number | null
}): void {
  const { setup } = loadWorktreeConfig(input.projectRoot)
  if (!setup?.trim()) return
  try {
    startBackground(setup, input.worktreePath, repo.rootSessionId(input.chatId), {
      ROXY_PROJECT_ROOT: input.projectRoot,
      ROXY_WORKTREE_PATH: input.worktreePath,
      ...(input.devPort ? { ROXY_PORT: String(input.devPort), PORT: String(input.devPort) } : {})
    })
  } catch (e) {
    // A failing setup script must never block the turn.
    console.warn('[worktree] setup script failed to start:', e)
  }
}

export interface MaterializeResult {
  /** True when the session now has a worktree (created, attached, or already had one). */
  ok: boolean
  worktreePath?: string
  branch?: string
  /**
   * The repos inside a composite worktree, or undefined for a single-repo
   * session. Undefined and `[]` both mean "not composite"; see shared/repos.ts.
   */
  repos?: RepoLink[]
  /** Set when we fell back to the project folder; safe to show the user. */
  error?: string
}

/**
 * Give a session the worktree it asked for, if it asked for one.
 *
 * Called on the turn path, so it returns quickly when there's nothing to do
 * (the overwhelmingly common case: no pending intent). The intent is cleared
 * whatever happens — on success it's fulfilled, and on failure retrying it every
 * single turn would just stall each one behind another doomed git call.
 */
export async function materializePendingWorktree(chatId: string): Promise<MaterializeResult> {
  const chat = repo.getChat(chatId)
  if (!chat) return { ok: false }
  const intent = chat.worktreePending
  if (!intent) return { ok: false }
  // Sub-sessions run in their parent's tree and must never own a worktree.
  if (chat.kind === 'sub') {
    repo.setChatWorktreePending(chatId, null)
    return { ok: false }
  }
  // Already has one — the intent is stale (e.g. two turns raced).
  if (chat.worktreePath) {
    repo.setChatWorktreePending(chatId, null)
    return { ok: true, worktreePath: chat.worktreePath, branch: chat.branch ?? undefined }
  }

  const workspace = chat.workspacePath
  if (!workspace) {
    repo.setChatWorktreePending(chatId, null)
    return { ok: false }
  }

  const result = await createForWorkspace(workspace, intent, chat.title)
  // Clear the intent either way: fulfilled, or failed and falling back.
  repo.setChatWorktreePending(chatId, null)
  if (!result.ok || !result.worktreePath) return result

  repo.setChatWorktree(chatId, {
    worktreePath: result.worktreePath,
    branch: result.branch ?? null,
    repos: result.repos ?? null
  })

  // Give the session its own dev port before the setup script runs, so an
  // install that builds against a port sees the right one. Allocation failure
  // (range exhausted) is not fatal — the session just has no reserved port.
  const devPort = await ensureDevPort(chatId)

  // The session just moved: it has a worktree, a branch and a port it did not
  // have a moment ago, and every one of those is on screen. Announce it BEFORE
  // the setup script (fire-and-forget, and often minutes long) so the strip
  // stops saying "(pending) / branch pending" the instant that becomes untrue,
  // rather than whenever the renderer next happens to refetch — which, on a
  // first turn, is not until the whole turn ends.
  emitSessionsUpdated({
    reason: 'worktree',
    sessionIds: [chatId],
    statusKey: result.worktreePath
  })

  // Fire-and-forget: installs take minutes, and the turn starts now.
  runSetupScript({
    chatId,
    projectRoot: workspace,
    worktreePath: result.worktreePath,
    devPort
  })

  return result
}

/** Resolve the repo(s), pick a branch, and create/attach the worktree(s). */
async function createForWorkspace(
  workspace: string,
  intent: WorktreeIntent,
  title: string
): Promise<MaterializeResult> {
  if (!(await git.isGitAvailable())) {
    return { ok: false, error: 'Git isn’t installed, so this session runs in the project folder.' }
  }

  // How the project is shaped decides everything below. `single` covers a
  // folder that IS a repo and a folder INSIDE one, which is every project that
  // worked before this feature existed.
  const { layout, roots } = discoverRepos(workspace)
  if (layout === 'none') {
    return { ok: false, error: 'This folder isn’t a git repository, so the session runs in place.' }
  }
  if (layout === 'multi') {
    return createComposite(workspace, roots, intent, title)
  }

  const root = (await git.repoRoot(workspace)) ?? roots[0]
  if (!root) {
    return { ok: false, error: 'This folder isn’t a git repository, so the session runs in place.' }
  }

  try {
    if (intent.mode === 'new') {
      // Name the branch after the session, so `roxy/legacy-ogre-apprentice`
      // shows up in `git branch` and on the PR instead of `roxy/6fdc60b8`.
      const branch = intent.branch?.trim() || (await git.branchNameForTitle(root, title))
      // A fork asked to start from the commit its source was sitting on. It's
      // advisory: a ref that no longer resolves (the source worktree was
      // deleted in between) falls through to the usual origin/<default> base
      // rather than failing the fork's first turn.
      const baseRef = intent.baseRef?.trim()
        ? ((await git.resolveCommit(root, intent.baseRef.trim())) ?? undefined)
        : undefined
      const r = await git.createWorktree({ repoRoot: root, branch, baseRef })
      if (!r.ok || !r.worktree)
        return { ok: false, error: r.error ?? 'Could not create the worktree.' }
      return { ok: true, worktreePath: r.worktree.path, branch: r.worktree.branch ?? branch }
    }

    // fromBranch / attach both target an existing branch; attachWorktree
    // already reuses an existing worktree when the branch is checked out
    // elsewhere, which is what git itself refuses to do.
    const branch = intent.branch?.trim()
    if (!branch) return { ok: false, error: 'No branch was given for the worktree.' }
    const r = await git.attachWorktree({ repoRoot: root, branch })
    if (!r.ok || !r.worktree)
      return { ok: false, error: r.error ?? 'Could not check out the branch.' }
    return { ok: true, worktreePath: r.worktree.path, branch: r.worktree.branch ?? branch }
  } catch (e) {
    // git.ts doesn't throw, but a caller bug here must still not break a turn.
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Build a COMPOSITE worktree: one directory, one checkout per repo, one branch
 * name shared by all of them.
 *
 * Three rules, each of which is a bug if broken:
 *
 *   - the branch name is chosen ONCE, against every repo at once, so the whole
 *     set can share it (`branchNameForTitle` takes the array for this reason);
 *   - the composite root is reserved ONCE and children go in verbatim, so a
 *     name collision can never split one session across two directories;
 *   - PARTIAL SUCCESS IS SUCCESS. A repo with no commits, a locked index, a
 *     branch someone already checked out — any of these skips that repo and
 *     keeps the rest. This runs on the turn path, where the standing rule is
 *     that git trouble degrades rather than failing the turn, and refusing to
 *     start because one of four repos is empty would be exactly that failure.
 *
 * Only a total wipeout (no repo produced a worktree) falls back to running in
 * the project folder.
 */
async function createComposite(
  workspace: string,
  roots: string[],
  intent: WorktreeIntent,
  title: string
): Promise<MaterializeResult> {
  try {
    // `attach`/`fromBranch` name one branch; `new` derives one free everywhere.
    const requested = intent.branch?.trim()
    if (intent.mode !== 'new' && !requested) {
      return { ok: false, error: 'No branch was given for the worktree.' }
    }
    const branch = requested || (await git.branchNameForTitle(roots, title))

    // Named for the PROJECT, not for any one repo — the composite holds them all.
    const compositeRoot = await git.reserveWorktreePath(git.worktreePathFor(workspace, branch))
    const planned = planRepoLinks(compositeRoot, roots, branch, path)

    const links: RepoLink[] = []
    const skipped: string[] = []
    // Serial, not parallel: N concurrent checkouts contend on the same disk and
    // each one already serializes behind its own repo lock, so the wall-clock
    // win is small and the failure modes (partial trees, interleaved errors)
    // are much worse.
    for (const link of planned) {
      // `new` CREATES the branch (even when the name was given explicitly);
      // fromBranch/attach check out one that already exists. Mixing these up
      // would make a new workstream fail in every repo that has never seen the
      // name — which is all of them.
      const r =
        intent.mode === 'new'
          ? await git.createWorktree({
              repoRoot: link.root,
              branch,
              // A fork's base commit exists only in the repo it came from, so
              // it is resolved PER REPO and simply omitted where it is unknown;
              // that repo then branches off its own default, which is the only
              // sensible base available to it.
              baseRef: intent.baseRef?.trim()
                ? ((await git.resolveCommit(link.root, intent.baseRef.trim())) ?? undefined)
                : undefined,
              path: link.worktreePath,
              exactPath: true
            })
          : await git.attachWorktree({
              repoRoot: link.root,
              branch,
              path: link.worktreePath,
              exactPath: true
            })

      if (r.ok && r.worktree) {
        links.push({ ...link, branch: r.worktree.branch ?? branch })
      } else {
        // Recorded, not thrown: the other repos still get their checkout.
        skipped.push(link.name)
        console.warn(`[worktree] skipped ${link.name}: ${r.error ?? 'unknown error'}`)
      }
    }

    if (!links.length) {
      return {
        ok: false,
        error:
          'None of the repos in this folder could be checked out, so the session runs in place.'
      }
    }

    return {
      ok: true,
      worktreePath: compositeRoot,
      branch: sharedBranch(links) ?? branch,
      repos: links,
      error: skipped.length ? `Left out of this workstream: ${skipped.join(', ')}.` : undefined
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export interface PruneCandidate {
  path: string
  branch: string | null
}

export interface PruneResult {
  ok: boolean
  /** Worktrees no session points at. */
  candidates: PruneCandidate[]
  removed: string[]
  failed: { path: string; error: string }[]
  error?: string
}

/**
 * Find (and optionally remove) worktrees under `workspace`'s repo that no
 * session points at any more.
 *
 * Roxy's own cleanup on session delete can always be escaped — a crash between
 * creating a worktree and saving its path, a session deleted from the phone, a
 * DB reset. Without a prune command those directories accumulate silently, so
 * this exists from day one rather than being added after the complaints.
 *
 * `dryRun` (the default) only reports, so the UI can confirm before deleting.
 */
export async function pruneWorktrees(
  workspace: string,
  opts: { dryRun?: boolean; force?: boolean } = {}
): Promise<PruneResult> {
  const empty: PruneResult = { ok: false, candidates: [], removed: [], failed: [] }
  if (!(await git.isGitAvailable())) return { ...empty, error: 'Git isn’t installed.' }

  const { layout, roots } = discoverRepos(workspace)
  if (layout === 'none' || !roots.length) {
    return { ...empty, error: 'This folder isn’t a git repository.' }
  }

  // Normalized so a case/separator difference doesn't make a live worktree look
  // orphaned and get deleted out from under a session. `listWorktreePaths`
  // returns composite CHILDREN as well as roots, which is essential here: git
  // reports the children, so comparing against roots alone would mark every
  // live multi-repo checkout as garbage.
  const claimed = new Set(repo.listWorktreePaths().map(normalizePath))

  // Each candidate remembers the repo it belongs to, because that is the only
  // cwd from which git will agree to remove it.
  const candidates: (PruneCandidate & { root: string })[] = []
  const seen = new Set<string>()
  for (const root of roots) {
    for (const w of await git.listWorktrees(root)) {
      const key = normalizePath(w.path)
      if (w.isMain || claimed.has(key) || seen.has(key)) continue
      seen.add(key)
      candidates.push({ path: w.path, branch: w.branch, root })
    }
  }

  const reported = candidates.map((c) => ({ path: c.path, branch: c.branch }))
  if (opts.dryRun !== false) return { ok: true, candidates: reported, removed: [], failed: [] }

  const removed: string[] = []
  const failed: { path: string; error: string }[] = []
  for (const c of candidates) {
    const r = await git.removeWorktree(c.path, { force: opts.force, cwd: c.root })
    if (r.ok) removed.push(c.path)
    else failed.push({ path: c.path, error: r.error ?? 'Unknown error' })
  }
  return { ok: true, candidates: reported, removed, failed }
}

/**
 * Rename the branch a session's workstream sits on.
 *
 * Renaming is safe while the branch is checked out: git rewrites the worktree's
 * HEAD in place, so the directory, its node_modules and any uncommitted work
 * are untouched. The DB pointer is updated to match; the worktree PATH is
 * deliberately left alone, because moving a live directory would invalidate
 * every running dev server and open file handle in it for a cosmetic gain.
 */
export async function renameWorkstreamBranch(
  chatId: string,
  to: string
): Promise<{ ok: boolean; branch?: string; error?: string }> {
  const chat = repo.getChat(chatId)
  if (!chat) return { ok: false, error: 'Session not found.' }

  // A sub-session shares its parent's tree; renaming from there would move the
  // parent's branch out from under it.
  const owner = chat.kind === 'sub' && chat.parentId ? repo.getChat(chat.parentId) : chat
  if (!owner?.worktreePath) return { ok: false, error: 'This session has no workstream.' }

  const next = to.trim()
  const problem = branchNameError(next)
  if (problem) return { ok: false, error: problem }

  // Multi-repo: every repo carries the same branch name, so the rename has to
  // land in all of them or the set diverges and no single name describes the
  // session any more.
  if (isMultiRepo(owner.repos)) {
    return renameComposite(owner.id, owner.repos ?? [], next)
  }

  const from = owner.branch ?? (await git.currentBranch(owner.worktreePath))
  if (!from) return { ok: false, error: 'Could not determine the current branch.' }
  if (from === next) return { ok: true, branch: next }

  // Once a branch is pushed, renaming it locally strands the remote under the
  // old name (git only moves the local ref) and any open PR with it. Refuse
  // rather than quietly desynchronize the two.
  if (await git.hasUpstreamBranch(owner.worktreePath, from)) {
    return {
      ok: false,
      error: `"${from}" has already been pushed - rename it on the remote instead.`
    }
  }

  // Run from the worktree itself: it is the path we are certain exists, and git
  // resolves the common repo from there.
  const r = await git.renameBranch(owner.worktreePath, from, next)
  if (!r.ok) return { ok: false, error: r.error }

  repo.setChatWorktree(owner.id, { branch: next })
  return { ok: true, branch: next }
}

/**
 * Rename the shared branch across every repo of a composite workstream.
 *
 * Pre-flight then apply, and ROLL BACK on partial failure. The alternative —
 * renaming what we can and reporting the rest — leaves the session with three
 * repos on two different branch names, which breaks the invariant every
 * multi-repo surface reads from (`sharedBranch` returns null, the strip has no
 * name to show, and a later rename has no single `from` to work off).
 *
 * The pushed-branch check is a veto by ANY repo, for the same reason it is a
 * veto at all: a local rename strands the remote branch under its old name, and
 * one stranded remote is enough to desynchronize the set.
 */
async function renameComposite(
  chatId: string,
  links: RepoLink[],
  next: string
): Promise<{ ok: boolean; branch?: string; error?: string }> {
  // Pre-flight everything before touching anything, so the common refusals cost
  // no partial state at all.
  for (const link of links) {
    const from = link.branch
    if (!from) {
      return { ok: false, error: `Could not determine the current branch in ${link.name}.` }
    }
    if (from === next) continue
    if (await git.hasUpstreamBranch(link.root, from)) {
      return {
        ok: false,
        error: `"${from}" has already been pushed in ${link.name} - rename it on the remote instead.`
      }
    }
  }

  const renamed: { root: string; from: string }[] = []
  for (const link of links) {
    const from = link.branch as string
    if (from === next) continue
    const r = await git.renameBranch(link.root, from, next)
    if (!r.ok) {
      // Undo the ones that already moved, so the set stays consistent.
      for (const back of renamed) await git.renameBranch(back.root, next, back.from)
      return { ok: false, error: r.error ?? `Could not rename the branch in ${link.name}.` }
    }
    renamed.push({ root: link.root, from })
  }

  const updated = links.map((l) => ({ ...l, branch: next }))
  repo.setChatWorktree(chatId, { branch: next, repos: updated })
  return { ok: true, branch: next }
}

/**
 * Rename a session's branch to match a NEW session title, when that is safe.
 *
 * Called when the agent retitles a session (`change_session_metadata`), so a
 * session that starts on a random slug and becomes "Fix auth token refresh"
 * does not keep a branch named after the slug forever.
 *
 * Best-effort and silent by design: this rides along with a metadata update the
 * model asked for, so a refusal must never fail that update. Every skip is a
 * deliberate rule rather than a fallback:
 *
 *   - the branch is not one WE generated -> someone named it on purpose;
 *   - it has been pushed -> the remote, and any open PR, would be stranded;
 *   - the new title yields nothing usable, or the name is already taken.
 */
export async function syncBranchToTitle(
  chatId: string,
  title: string
): Promise<{ renamed: boolean; branch?: string }> {
  try {
    const chat = repo.getChat(chatId)
    if (!chat?.worktreePath || !chat.branch) return { renamed: false }

    // Only ever reclaim a name we generated. A branch the user (or the agent,
    // earlier) chose deliberately is not ours to rewrite.
    if (!isPlaceholderBranch(chat.branch, branchPrefixSetting())) return { renamed: false }

    // An unusable title (emoji-only, say) makes branchNameForTitle fall back to
    // hex; swapping one generated name for another is churn, not information.
    if (!slugToBranchSegment(title)) return { renamed: false }

    // Multi-repo: pick a name free in EVERY repo, then let renameComposite do
    // the pushed-branch veto and the all-or-nothing rename.
    if (isMultiRepo(chat.repos)) {
      const links = chat.repos ?? []
      const next = await git.branchNameForTitle(
        links.map((l) => l.root),
        title
      )
      if (!next || next === chat.branch) return { renamed: false }
      const r = await renameComposite(chat.id, links, next)
      if (!r.ok) return { renamed: false }
      emitSessionsUpdated({ reason: 'branch', sessionIds: [chat.id], statusKey: chat.worktreePath })
      return { renamed: true, branch: next }
    }

    if (await git.hasUpstreamBranch(chat.worktreePath, chat.branch)) return { renamed: false }

    const next = await git.branchNameForTitle(chat.worktreePath, title)
    if (!next || next === chat.branch) return { renamed: false }

    const r = await git.renameBranch(chat.worktreePath, chat.branch, next)
    if (!r.ok) return { renamed: false }

    repo.setChatWorktree(chat.id, { branch: next })
    // The agent renamed its own session's branch. The renderer refreshes chats
    // on this tool's `tool-end`, but that races the DB write and only reaches
    // the window that ran the turn — a phone-driven or loop turn has none.
    emitSessionsUpdated({ reason: 'branch', sessionIds: [chat.id], statusKey: chat.worktreePath })
    return { renamed: true, branch: next }
  } catch {
    // A metadata update must never fail because a branch rename did.
    return { renamed: false }
  }
}

/** The configured branch prefix, for deciding what counts as auto-generated. */
function branchPrefixSetting(): string {
  try {
    return normalizeBranchPrefix(repo.getSettings().branchPrefix)
  } catch {
    return DEFAULT_BRANCH_PREFIX
  }
}

/**
 * Remove a session's worktree, if it owns one no other session shares.
 *
 * ORDERING IS LOAD-BEARING on Windows: a dev server still running in the
 * worktree holds open handles inside node_modules/.next, and `git worktree
 * remove` then fails with a lock error. So the session's background processes
 * are killed FIRST and the kill is awaited (process teardown is not
 * synchronous — taskkill /t needs a moment to reap the tree) before git is
 * asked to delete the directory.
 *
 * Never blocks session deletion: a shared worktree, a still-running background
 * subagent, or a git refusal are all reported and left alone rather than
 * raising. Whatever survives is swept up later by `pruneWorktrees`.
 *
 * UNCOMMITTED WORK IS NEVER DISCARDED. `force` defaults to false so git's own
 * refusal to delete a dirty tree is respected: the directory stays, the session
 * goes, and `pruneWorktrees` lists it later. This matters far more now that
 * sessions get a workstream by DEFAULT -- deleting a session used to throw away
 * a chat log, and would otherwise now throw away the code too, with no
 * confirmation and no reflog entry to recover from.
 */
export async function removeWorktreeForChat(
  chatId: string,
  opts: { force?: boolean } = {}
): Promise<{ ok: boolean; removed: boolean; error?: string }> {
  const chat = repo.getChat(chatId)
  const target = chat?.worktreePath
  if (!target) return { ok: true, removed: false }

  // Shared with another session — never auto-remove (T3's mistake).
  const others = repo.chatsUsingWorktree(target).filter((c) => c.id !== chatId)
  if (others.length) return { ok: true, removed: false }

  // A detached background subagent deliberately outlives the turn that launched
  // it (see services/background-tasks.ts). Deleting the tree out from under one
  // turns every tool call it makes into an ENOENT, so leave it be.
  const busy = activeBackgroundSubChatIds()
  const subIds = repo.listSubchats(chatId).map((c) => c.id)
  if (hasActiveBackgroundJobs(chatId) || subIds.some((id) => busy.has(id))) {
    return {
      ok: false,
      removed: false,
      error: 'A background task is still running in this worktree, so it was left in place.'
    }
  }

  // Stop dev servers/watchers before git touches the directory. Awaited: the
  // kill has to have actually happened, not merely been requested.
  await stopSessionProcesses(chatId)

  // A composite worktree is N real worktrees in one directory, and the
  // directory itself is not a repo — so there is nothing to remove AT `target`.
  // Each child is removed by the repo that owns it (git refuses otherwise:
  // "fatal: <path> is not a working tree"), and the empty parent is cleaned up
  // by hand afterwards, because `git worktree remove` never touches it.
  if (isMultiRepo(chat.repos)) {
    return removeComposite(target, chat.repos ?? [], opts.force ?? false)
  }

  const r = await git.removeWorktree(target, { force: opts.force ?? false })
  if (!r.ok) {
    return {
      ok: false,
      removed: false,
      error: r.error ?? 'The workstream has uncommitted changes, so its folder was left in place.'
    }
  }
  return { ok: true, removed: true }
}

/**
 * Take down a composite worktree, one repo at a time.
 *
 * Partial removal is a normal outcome and is reported as such: `force` is false
 * by default, so a repo with uncommitted work keeps its checkout while its
 * clean siblings go. The composite root is only removed once EVERY child is
 * gone — deleting it earlier would take the dirty tree with it, which is the
 * one thing this whole path exists to prevent.
 */
async function removeComposite(
  compositeRoot: string,
  links: RepoLink[],
  force: boolean
): Promise<{ ok: boolean; removed: boolean; error?: string }> {
  const kept: string[] = []
  for (const link of links) {
    // `cwd` is what makes this work: the owning repo, not the worktree and not
    // the composite root.
    const r = await git.removeWorktree(link.worktreePath, { force, cwd: link.root })
    if (!r.ok) kept.push(link.name)
  }

  if (kept.length) {
    return {
      ok: false,
      removed: false,
      error: `Left in place (uncommitted changes): ${kept.join(', ')}.`
    }
  }

  // Every checkout is gone; the parent is an empty directory git knows nothing
  // about. `rmdir` (not a recursive delete) on purpose — if anything unexpected
  // is still in there, it fails and leaves the contents alone for prune to
  // report, rather than silently deleting whatever it found.
  try {
    await fsp.rmdir(compositeRoot)
  } catch {
    /* not empty, or already gone - prune reports it later */
  }
  return { ok: true, removed: true }
}

/**
 * Kill a session's background processes and give the OS a moment to release
 * their file handles.
 *
 * On Windows the process tree is torn down asynchronously by `taskkill /t`, so
 * returning the instant kill() is called would race `git worktree remove`
 * straight back into the lock error this exists to avoid.
 */
async function stopSessionProcesses(chatId: string): Promise<void> {
  const killed = killSessionBackground(repo.rootSessionId(chatId))
  if (killed > 0) await new Promise((r) => setTimeout(r, 300))
}

/**
 * One spelling for path comparison: fully resolved (git's form, not an 8.3 short
 * name), then lowercased on Windows where the filesystem is case-insensitive.
 * Getting this wrong makes a live worktree look orphaned — and prune deletes it.
 */
function normalizePath(p: string): string {
  const trimmed = git.canonicalPath(p).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
}
