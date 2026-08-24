/**
 * Where a session's work actually happens.
 *
 * `sessionCwd()` is the ONLY working-directory resolver in the app: the agent
 * turn, tool runs, shell commands and the phone header all go through it. A
 * session normally works directly in the project folder the user opened, but a
 * worktree-backed session works in its own isolated checkout instead — that's
 * what lets several agents run in parallel without sharing one filesystem.
 *
 * If you ever find yourself writing a second cwd-resolution path, don't: every
 * consumer must agree, or a session will read from one tree and write to
 * another.
 */
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import * as repo from '../db/repo'
import { resolveWorktreeCwd } from '../../shared/workspace'
import {
  MAX_COMPOSITE_REPOS,
  isScannableDir,
  worktreeAnchor,
  type RepoLayout
} from '../../shared/repos'

/** How far `sessionCwd` will follow `parentId` before giving up (cycle guard). */
const MAX_PARENT_DEPTH = 32

/**
 * Walk up from `dir` looking for a `.git` entry; returns the repo root if found.
 *
 * Note `.git` is a FILE (not a directory) inside a worktree, so `existsSync`
 * rather than a directory check — this must resolve a repo root from inside a
 * worktree too.
 */
export function findGitRoot(dir: string): string | undefined {
  let cur = dir
  for (let i = 0; i < 64 && cur; i++) {
    try {
      if (existsSync(path.join(cur, '.git'))) return cur
    } catch {
      /* ignore unreadable dirs */
    }
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return undefined
}

/**
 * How long a project's repo scan is trusted before it's re-read from disk.
 *
 * The scan is one `readdir` plus one `existsSync` per child, but it sits behind
 * the status poll (every few seconds, per session), so an uncached version
 * would stat a folder tree continuously for the life of the app. Repos are not
 * added to a project mid-session often enough to justify that; 30s makes a
 * newly-cloned sibling show up without anyone having to think about it.
 */
const REPO_SCAN_TTL_MS = 30_000

interface RepoScan {
  layout: RepoLayout
  roots: string[]
  at: number
}

const repoScanCache = new Map<string, RepoScan>()

/** Test-only: forget cached project scans. */
export function _clearRepoScanCache(): void {
  repoScanCache.clear()
}

/**
 * The git repos a project folder is made of, and how it is shaped.
 *
 * Three cases, in the order they are checked — the order matters, because each
 * later case must not be able to steal a project an earlier one owns:
 *
 *   1. the folder IS a repo, or sits INSIDE one -> `single`, root = that repo.
 *      The overwhelmingly common case, and the one that has to stay identical
 *      to the pre-multi-repo behaviour, so it returns before any scan happens.
 *   2. no repo at or above it, but repos ONE LEVEL down -> `multi`.
 *   3. no repos anywhere -> `none`; sessions run in place, exactly as before.
 *
 * The scan is deliberately depth-1. Walking arbitrarily deep would find
 * checkouts nobody considers part of the project (a fixture repo under
 * `test/fixtures`, a submodule three levels down) and would cost an unbounded
 * directory walk on a folder that may hold a hundred thousand files. One level
 * is the layout people actually mean by "a folder with my repos in it".
 *
 * Roots are sorted, so the adopted set — and the order it is created in — is
 * deterministic: the `MAX_COMPOSITE_REPOS` cut has to fall the same way every
 * time, or a session's repo set would quietly change between runs.
 */
export function discoverRepos(projectRoot: string): { layout: RepoLayout; roots: string[] } {
  if (!projectRoot) return { layout: 'none', roots: [] }

  const cached = repoScanCache.get(projectRoot)
  if (cached && Date.now() - cached.at < REPO_SCAN_TTL_MS) {
    return { layout: cached.layout, roots: cached.roots }
  }

  const scan = scanProject(projectRoot)
  repoScanCache.set(projectRoot, { ...scan, at: Date.now() })
  return scan
}

function scanProject(projectRoot: string): { layout: RepoLayout; roots: string[] } {
  // Case 1: the project is a repo, or lives inside one. `findGitRoot` walks up,
  // so this also covers a project folder that is a SUBDIRECTORY of its repo
  // (`~/repo/apps/web`) — which already worked and must keep working.
  const own = findGitRoot(projectRoot)
  if (own) return { layout: 'single', roots: [own] }

  // Case 2: a folder of repos. One readdir, no recursion.
  let names: string[]
  try {
    names = readdirSync(projectRoot, { withFileTypes: true })
      .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && isScannableDir(d.name))
      .map((d) => d.name)
      .sort()
  } catch {
    // Unreadable (permissions, or a folder deleted out from under us) — treat
    // as "no repos" rather than throwing on the turn path.
    return { layout: 'none', roots: [] }
  }

  const roots: string[] = []
  for (const name of names) {
    if (roots.length >= MAX_COMPOSITE_REPOS) break
    const child = path.join(projectRoot, name)
    try {
      // `.git` is a FILE inside a worktree and a directory in a normal clone,
      // so this is an existence check, not a directory check.
      if (existsSync(path.join(child, '.git'))) roots.push(child)
    } catch {
      /* unreadable child — skip it */
    }
  }

  if (!roots.length) return { layout: 'none', roots: [] }
  return { layout: 'multi', roots }
}

/**
 * The absolute directory a session's tools operate in, or '' when it has no
 * workspace (loops, and sessions created before a folder was picked).
 *
 * Resolution order:
 *   1. no chat / no workspace          -> ''
 *   2. sub-session                     -> its parent's cwd (subagents always
 *                                         work in the tree that spawned them)
 *   3. no worktree                     -> the project folder, as before
 *   4. worktree                        -> the matching path inside it, keeping
 *                                         any sub-path of the repo the project
 *                                         folder pointed at
 *
 * For a MULTI-REPO session (4) the worktree is a composite root that mirrors
 * the project folder rather than any single repo, so the anchor for that path
 * math is the project folder itself — see `worktreeAnchor`. Using a git root
 * there would be actively wrong: `findGitRoot` on a multi-repo project walks
 * PAST it and can land on an unrelated ancestor repo, which would map the
 * session into a subdirectory of the composite that does not exist.
 */
export function sessionCwd(chatId: string): string {
  if (!chatId) return ''
  let id = chatId
  const seen = new Set<string>()
  for (let depth = 0; depth < MAX_PARENT_DEPTH; depth++) {
    if (seen.has(id)) return ''
    seen.add(id)
    const chat = repo.getChat(id)
    if (!chat) return ''
    // Subagents never own a worktree — they run in their parent's tree, so the
    // parent's worktree (or lack of one) decides for both.
    if (chat.kind === 'sub' && chat.parentId) {
      id = chat.parentId
      continue
    }
    const workspacePath = chat.workspacePath
    if (!workspacePath) return ''
    if (!chat.worktreePath) return workspacePath
    return resolveWorktreeCwd(
      workspacePath,
      chat.worktreePath,
      worktreeAnchor(workspacePath, chat.repos, findGitRoot(workspacePath) ?? null),
      path
    )
  }
  // Runaway parent chain — treat it as unresolvable rather than loop forever.
  return ''
}
