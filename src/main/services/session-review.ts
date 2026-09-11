import { createHash } from 'node:crypto'
import path from 'node:path'
import type { ReviewDiff, ReviewFile } from '../../shared/api'
import * as repo from '../db/repo'
import * as git from './git'

export interface SessionReviewRepo {
  key: string
  name?: string
  cwd: string
}

function ownerSessionId(sessionId: string): string {
  try {
    return repo.rootSessionId(sessionId)
  } catch {
    return sessionId
  }
}

function repoKey(cwd: string): string {
  const resolved = path.resolve(cwd)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function baselineRef(sessionId: string, key: string): string {
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 24)
  return `refs/roxy/sessions/${sessionId}/${digest}`
}

export async function ensureSessionReviewBaselines(
  sessionId: string,
  repos: SessionReviewRepo[]
): Promise<void> {
  const ownerId = ownerSessionId(sessionId)
  await Promise.all(
    repos.map(async (entry) => {
      const root = await git.repoRoot(entry.cwd)
      if (!root) return
      const key = repoKey(root)
      const existing = repo.getSessionReviewBaseline(ownerId, key)
      if (existing) {
        await git.setReviewBaselineRef(root, existing.baselineRef, existing.baselineTree)
        return
      }
      const tree = await git.snapshotWorktreeTree(root)
      if (!tree) return
      const ref = baselineRef(ownerId, key)
      if (!(await git.setReviewBaselineRef(root, ref, tree))) return
      const baseline = repo.addSessionReviewBaseline({
        sessionId: ownerId,
        repoKey: key,
        repoRoot: root,
        baselineTree: tree,
        baselineRef: ref
      })
      if (baseline.baselineTree !== tree)
        await git.setReviewBaselineRef(root, ref, baseline.baselineTree)
    })
  )
}

export async function sessionReviewFiles(
  sessionId: string,
  repos: SessionReviewRepo[]
): Promise<ReviewFile[]> {
  const ownerId = ownerSessionId(sessionId)
  return (
    await Promise.all(
      repos.map(async (entry) => {
        const root = await git.repoRoot(entry.cwd)
        if (!root) return []
        const baseline = repo.getSessionReviewBaseline(ownerId, repoKey(root))
        if (!baseline) return []
        const files = await git.reviewFilesFromTree(root, baseline.baselineTree)
        return entry.name ? files.map((file) => ({ ...file, repo: entry.name })) : files
      })
    )
  ).flat()
}

export async function sessionReviewDiff(
  sessionId: string,
  entry: SessionReviewRepo,
  file: string,
  oldPath?: string
): Promise<ReviewDiff | null> {
  const ownerId = ownerSessionId(sessionId)
  const root = await git.repoRoot(entry.cwd)
  if (!root) return null
  const baseline = repo.getSessionReviewBaseline(ownerId, repoKey(root))
  return baseline ? git.reviewDiffFromTree(root, baseline.baselineTree, file, oldPath) : null
}

export async function deleteSessionReviewBaselines(sessionId: string): Promise<void> {
  let baselines: repo.SessionReviewBaseline[]
  try {
    baselines = repo.listSessionReviewBaselines(sessionId)
  } catch {
    return
  }
  await Promise.all(
    baselines.map((baseline) =>
      git.deleteReviewBaselineRef(baseline.repoRoot, baseline.baselineRef).catch(() => undefined)
    )
  )
}
