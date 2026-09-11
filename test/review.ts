/** Smoke tests the review Git layer against real temporary repositories. */
import { app } from 'electron'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as review from '../src/main/services/git'
import { codeReviewReposForOwner, runTool } from '../src/main/harness/tools'

let failed = 0

function check(condition: unknown, message: string): void {
  if (condition) console.log(`PASS: ${message}`)
  else {
    failed++
    console.error(`FAIL: ${message}`)
  }
}

function text(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim()
}

async function command(cwd: string, ...args: string[]): Promise<string> {
  const result = await review.git(args, cwd)
  if (!result.ok) throw new Error(`${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

async function write(cwd: string, file: string, contents: string | Uint8Array): Promise<void> {
  const target = path.join(cwd, file)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, contents)
}

async function main(): Promise<void> {
  await app.whenReady()
  const routed = codeReviewReposForOwner(
    {
      repos: [
        { name: 'api', worktreePath: '/work/api' },
        { name: 'web', worktreePath: '/work/web' }
      ]
    },
    '/fallback'
  )
  check(
    routed.map((item) => `${item.name}:${item.cwd}`).join('|') === 'api:/work/api|web:/work/web',
    'code_review routes a composite session to every persisted repo'
  )
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'roxy-review-'))
  try {
    await command(cwd, 'init')
    await command(cwd, 'config', 'user.name', 'Review Test')
    await command(cwd, 'config', 'user.email', 'review@example.test')
    await write(cwd, 'alpha file.txt', 'one\ntwo\n')
    await write(cwd, 'rename-old.txt', 'rename me\n')
    await write(cwd, 'binary.bin', Uint8Array.from([0, 1, 2, 3]))
    await command(cwd, 'add', '.')
    await command(cwd, 'commit', '-m', 'base')

    const baseBranch = await command(cwd, 'branch', '--show-current')
    await command(cwd, 'switch', '-c', 'review-branch')
    await command(cwd, 'config', 'branch.review-branch.roxy-base', baseBranch)
    await write(cwd, 'branch commit.txt', 'committed on branch\n')
    await command(cwd, 'add', '--', 'branch commit.txt')
    await command(cwd, 'commit', '-m', 'branch change')
    await write(cwd, 'branch commit.txt', 'committed on branch\nstaged local line\n')
    await command(cwd, 'add', '--', 'branch commit.txt')
    await write(
      cwd,
      'branch commit.txt',
      'committed on branch\nstaged local line\nunstaged local line\n'
    )
    await write(cwd, 'branch staged local.txt', 'staged only\n')
    await command(cwd, 'add', '--', 'branch staged local.txt')
    await write(cwd, 'branch unstaged local.txt', 'unstaged only\n')
    const branchFiles = await review.reviewFiles(cwd, 'branch')
    const branchDiff = await review.reviewDiff(cwd, 'branch', 'branch commit.txt')
    const branchPatch = await runTool('code_review', { scope: 'branch' }, { cwd })
    check(
      branchFiles.some((file) => file.path === 'branch commit.txt') &&
        !branchFiles.some((file) => file.path.includes('local.txt')),
      'branch files compare merge-base to HEAD and exclude local staged/unstaged changes'
    )
    check(
      branchDiff?.after === 'committed on branch\n' && !branchDiff.after.includes('local line'),
      'branch diff reads committed HEAD content instead of the worktree'
    )
    check(
      branchPatch.ok &&
        branchPatch.output.includes('branch commit.txt') &&
        !branchPatch.output.includes('branch staged local.txt') &&
        !branchPatch.output.includes('branch unstaged local.txt'),
      'code_review branch scope excludes local staged/unstaged changes'
    )
    await command(cwd, 'restore', '--staged', '--', 'branch staged local.txt')
    await command(cwd, 'restore', '--staged', '--worktree', '--', 'branch commit.txt')
    await fs.rm(path.join(cwd, 'branch staged local.txt'))
    await fs.rm(path.join(cwd, 'branch unstaged local.txt'))

    const subdir = path.join(cwd, 'workspace', 'nested')
    const subdirFile = 'workspace/subdir review.txt'
    await fs.mkdir(subdir, { recursive: true })
    await write(cwd, subdirFile, 'before\n')
    await command(cwd, 'add', '--', subdirFile)
    await command(cwd, 'commit', '-m', 'subdirectory fixture')
    await write(cwd, subdirFile, 'after\n')
    const subdirFiles = await review.reviewFiles(subdir, 'unstaged')
    const subdirDiff = await review.reviewDiff(subdir, 'unstaged', subdirFile)
    check(
      subdirFiles.some((file) => file.path === subdirFile),
      'reviewFiles from a subdirectory returns repository-relative paths'
    )
    check(
      subdirDiff?.before === 'before\n' && subdirDiff.after === 'after\n',
      'reviewDiff from a subdirectory reads repository-relative before and after content'
    )
    check(
      (await review.stageFiles(subdir, [subdirFile])).ok,
      'stageFiles works from a subdirectory'
    )
    check(
      (await command(cwd, 'status', '--short', '--', subdirFile)) ===
        'M  "workspace/subdir review.txt"',
      'stageFiles from a subdirectory stages the repository-relative path'
    )
    check(
      (await review.unstageFiles(subdir, [subdirFile])).ok,
      'unstageFiles works from a subdirectory'
    )
    check(
      (await review.reviewFiles(subdir, 'unstaged')).some((file) => file.path === subdirFile) &&
        !(await review.reviewFiles(subdir, 'staged')).some((file) => file.path === subdirFile),
      'unstageFiles from a subdirectory unstages the repository-relative path'
    )
    await review.stageFiles(subdir, [subdirFile])
    await write(cwd, subdirFile, 'after\nunstaged\n')
    check(
      (await review.revertFiles(subdir, [subdirFile], 'unstaged')).ok &&
        text(await fs.readFile(path.join(cwd, subdirFile), 'utf8')) === 'after',
      'unstaged revert from a subdirectory restores the indexed version'
    )
    check(
      (await review.revertFiles(subdir, [subdirFile], 'staged')).ok &&
        text(await fs.readFile(path.join(cwd, subdirFile), 'utf8')) === 'after',
      'staged revert from a subdirectory preserves the worktree version'
    )
    check(
      !(await review.stageFiles(subdir, ['../escape.txt'])).ok &&
        (await review.reviewDiff(subdir, 'unstaged', '../escape.txt')) === null,
      'repository-relative traversal remains rejected from a subdirectory'
    )
    const subdirTool = await runTool('code_review', { scope: 'unstaged' }, { cwd: subdir })
    check(
      subdirTool.ok && subdirTool.output.includes(subdirFile),
      'code_review works when its cwd is a subdirectory'
    )
    await command(cwd, 'restore', '--worktree', '--', subdirFile)

    await write(cwd, 'alpha file.txt', 'one\nstaged\n')
    await command(cwd, 'add', '--', 'alpha file.txt')
    await write(cwd, 'alpha file.txt', 'one\nstaged\nunstaged\n')
    const stagedBefore = await command(cwd, 'show', ':alpha file.txt')
    const revertedUnstaged = await review.revertFiles(cwd, ['alpha file.txt'], 'unstaged')
    const worktreeAfter = await fs.readFile(path.join(cwd, 'alpha file.txt'), 'utf8')
    const stagedAfter = await command(cwd, 'show', ':alpha file.txt')
    check(revertedUnstaged.ok, 'tracked unstaged revert succeeds')
    check(text(worktreeAfter) === stagedBefore, 'unstaged revert restores the indexed version')
    check(stagedAfter === stagedBefore, 'unstaged revert preserves staged changes')

    await write(cwd, 'alpha file.txt', 'one\nstaged\nstill unstaged\n')
    const revertedStaged = await review.revertFiles(cwd, ['alpha file.txt'], 'staged')
    const headText = await command(cwd, 'show', 'HEAD:alpha file.txt')
    const indexText = await command(cwd, 'show', ':alpha file.txt')
    const diskText = (await fs.readFile(path.join(cwd, 'alpha file.txt'), 'utf8')).trim()
    check(revertedStaged.ok, 'staged revert succeeds')
    check(
      indexText === headText && text(diskText) === 'one\nstaged\nstill unstaged',
      'staged revert resets only the index and preserves overlapping worktree edits'
    )
    check(
      (await command(cwd, 'status', '--short', '--', 'alpha file.txt')) === 'M "alpha file.txt"',
      'staged revert exposes the preserved edit as unstaged'
    )
    await command(cwd, 'restore', '--worktree', '--', 'alpha file.txt')

    await write(cwd, 'staged addition.txt', 'temporary\n')
    await command(cwd, 'add', '--', 'staged addition.txt')
    const revertedAddition = await review.revertFiles(cwd, ['staged addition.txt'], 'staged')
    check(revertedAddition.ok, 'staged addition revert succeeds')
    check(
      text(await fs.readFile(path.join(cwd, 'staged addition.txt'), 'utf8')) === 'temporary' &&
        (await command(cwd, 'status', '--short', '--', 'staged addition.txt')) ===
          '?? "staged addition.txt"',
      'staged addition revert keeps the file as untracked'
    )
    await fs.rm(path.join(cwd, 'staged addition.txt'))

    await write(cwd, 'unrelated untracked.txt', 'keep me\n')
    const ignoredUnrelated = await review.revertFiles(cwd, ['unrelated untracked.txt'], 'staged')
    check(ignoredUnrelated.ok, 'staged revert ignores a path not present in HEAD or index')
    check(
      text(await fs.readFile(path.join(cwd, 'unrelated untracked.txt'), 'utf8')) === 'keep me',
      'staged revert does not delete an unrelated untracked file'
    )
    await fs.rm(path.join(cwd, 'unrelated untracked.txt'))

    await command(cwd, 'rm', '--', 'alpha file.txt')
    const revertedDeletion = await review.revertFiles(cwd, ['alpha file.txt'], 'staged')
    check(revertedDeletion.ok, 'staged deletion revert succeeds')
    check(
      (await command(cwd, 'status', '--short', '--', 'alpha file.txt')) === 'D "alpha file.txt"',
      'staged deletion revert leaves the deletion unstaged'
    )
    check(
      !(await fs.stat(path.join(cwd, 'alpha file.txt')).catch(() => null)),
      'staged deletion revert does not recreate deleted worktree content'
    )
    await command(cwd, 'restore', '--worktree', '--', 'alpha file.txt')

    await command(cwd, 'rm', '--', 'alpha file.txt')
    await write(cwd, 'alpha file.txt', 'recreated after staged deletion\n')
    const revertedRecreatedDeletion = await review.revertFiles(cwd, ['alpha file.txt'], 'staged')
    check(revertedRecreatedDeletion.ok, 'recreated staged deletion revert succeeds')
    check(
      text(await fs.readFile(path.join(cwd, 'alpha file.txt'), 'utf8')) ===
        'recreated after staged deletion' &&
        text(await command(cwd, 'show', ':alpha file.txt')) === headText,
      'staged deletion revert preserves recreated worktree content while restoring the index'
    )
    await command(cwd, 'restore', '--worktree', '--', 'alpha file.txt')

    await command(cwd, 'mv', 'rename-old.txt', 'rename new.txt')
    const staged = await review.reviewFiles(cwd, 'staged')
    const renamed = staged.find((file) => file.status === 'renamed')
    check(
      renamed?.oldPath === 'rename-old.txt' && renamed.path === 'rename new.txt',
      'rename retains old and new paths'
    )
    const renameDiff = renamed
      ? await review.reviewDiff(cwd, 'staged', renamed.path, undefined, renamed.oldPath)
      : null
    check(
      renameDiff?.before === renameDiff?.after && renameDiff?.before === 'rename me\n',
      'rename diff reads the old path before and new path after'
    )
    const revertedRename = await review.revertFiles(
      cwd,
      ['rename new.txt', 'rename-old.txt'],
      'staged'
    )
    check(revertedRename.ok, 'staged rename revert succeeds')
    check(
      (await command(cwd, 'status', '--short', '--', 'rename-old.txt', 'rename new.txt')) ===
        'D rename-old.txt\n?? "rename new.txt"',
      'staged rename revert preserves the worktree paths as unstaged/untracked'
    )
    check(
      !(await fs.stat(path.join(cwd, 'rename-old.txt')).catch(() => null)) &&
        text(await fs.readFile(path.join(cwd, 'rename new.txt'), 'utf8')) === 'rename me',
      'staged rename revert does not lose the renamed path or its content'
    )
    check(
      text(await command(cwd, 'show', ':rename-old.txt')) === 'rename me',
      'staged rename revert restores the original path in the index'
    )
    await fs.rm(path.join(cwd, 'rename new.txt'))
    await command(cwd, 'restore', '--worktree', '--', 'rename-old.txt')

    await write(cwd, 'untracked space.txt', 'new\nfile\n')
    const unstaged = await review.reviewFiles(cwd, 'unstaged')
    check(
      unstaged.some((file) => file.path === 'untracked space.txt' && file.status === 'untracked'),
      'unstaged includes untracked paths with spaces'
    )
    check(
      unstaged.some((file) => file.path === 'untracked space.txt' && file.additions === 2),
      'untracked line count is useful'
    )

    check(
      review.clampCommitLimit(0) === 30 && review.clampCommitLimit(500) === 100,
      'commit limits are clamped'
    )
    check((await review.revsForScope(cwd, 'commit')) === null, 'commit scope requires a commit')
    check(
      (await review.reviewDiff(cwd, 'unstaged', '../escape.txt')) === null,
      'diff rejects paths outside the repository'
    )
    check(
      !(await review.stageFiles(cwd, ['../escape.txt'])).ok,
      'mutations reject paths outside the repository'
    )

    const invalidTool = await runTool('code_review', { scope: 'wat' }, { cwd })
    const missingCommit = await runTool('code_review', { scope: 'commit' }, { cwd })
    const untrackedTool = await runTool('code_review', { scope: 'unstaged' }, { cwd })
    check(!invalidTool.ok, 'code_review validates its scope')
    check(!missingCommit.ok, 'code_review requires a commit for commit scope')
    check(
      untrackedTool.output.includes('untracked space.txt'),
      'code_review includes untracked text files'
    )

    await fs.rm(path.join(cwd, 'untracked space.txt'))
    const originalIndex = await fs.readFile(path.join(cwd, '.git', 'index'))
    const baseline = await review.snapshotWorktreeTree(cwd)
    check(!!baseline, 'session baseline snapshots the current worktree')
    check(
      Buffer.compare(originalIndex, await fs.readFile(path.join(cwd, '.git', 'index'))) === 0,
      'session baseline does not modify the real index'
    )
    await write(cwd, 'session file.txt', 'first\nsecond\n')
    const sessionFiles = baseline ? await review.reviewFilesFromTree(cwd, baseline) : []
    check(
      sessionFiles.some(
        (file) =>
          file.path === 'session file.txt' && file.status === 'added' && file.additions === 2
      ),
      'session review includes new worktree files'
    )
    const sessionDiff = baseline
      ? await review.reviewDiffFromTree(cwd, baseline, 'session file.txt')
      : null
    check(
      sessionDiff?.before === '' && sessionDiff.after === 'first\nsecond\n',
      'session diff renders a newly added file'
    )
    await command(cwd, 'add', '--', 'session file.txt')
    await command(cwd, 'commit', '-m', 'session commit')
    check(
      baseline
        ? (await review.reviewFilesFromTree(cwd, baseline)).some(
            (file) => file.path === 'session file.txt'
          )
        : false,
      'session changes remain visible after commit'
    )
    const afterCommit = await review.snapshotWorktreeTree(cwd)
    check(
      afterCommit === (await command(cwd, 'rev-parse', 'HEAD^{tree}')),
      'session snapshot matches committed HEAD when the worktree is clean'
    )

    const dirtyBaseline = await review.snapshotWorktreeTree(cwd)
    await write(cwd, 'preexisting dirty.txt', 'already here\n')
    const dirtyStart = await review.snapshotWorktreeTree(cwd)
    await write(cwd, 'created later.txt', 'later\n')
    const sinceDirtyStart = dirtyStart ? await review.reviewFilesFromTree(cwd, dirtyStart) : []
    check(
      !sinceDirtyStart.some((file) => file.path === 'preexisting dirty.txt') &&
        sinceDirtyStart.some((file) => file.path === 'created later.txt'),
      'session baseline excludes changes that predated the session'
    )
    check(!!dirtyBaseline, 'session snapshots also work from a dirty repository')
    await fs.rm(path.join(cwd, 'preexisting dirty.txt'))
    await fs.rm(path.join(cwd, 'created later.txt'))

    const deletionBaseline = await review.snapshotWorktreeTree(cwd)
    await fs.rm(path.join(cwd, 'session file.txt'))
    const deletionDiff = deletionBaseline
      ? await review.reviewDiffFromTree(cwd, deletionBaseline, 'session file.txt')
      : null
    check(
      deletionDiff?.before === 'first\nsecond\n' && deletionDiff.after === '',
      'session diff renders deleted files'
    )

    const unborn = await fs.mkdtemp(path.join(os.tmpdir(), 'roxy-review-unborn-'))
    try {
      await command(unborn, 'init')
      await write(unborn, 'new file.txt', 'staged version\n')
      await command(unborn, 'add', '--', 'new file.txt')
      await write(unborn, 'new file.txt', 'unstaged version\n')
      const unbornUnstaged = await review.revertFiles(unborn, ['new file.txt'], 'unstaged')
      check(unbornUnstaged.ok, 'unstaged revert succeeds in a repository without HEAD')
      check(
        text(await fs.readFile(path.join(unborn, 'new file.txt'), 'utf8')) === 'staged version' &&
          text(await command(unborn, 'show', ':new file.txt')) === 'staged version',
        'unstaged revert without HEAD restores the worktree from the index and keeps it staged'
      )

      await write(unborn, 'new file.txt', 'preserved worktree\n')
      const unbornStaged = await review.revertFiles(unborn, ['new file.txt'], 'staged')
      check(unbornStaged.ok, 'staged revert succeeds in a repository without HEAD')
      check(
        text(await fs.readFile(path.join(unborn, 'new file.txt'), 'utf8')) ===
          'preserved worktree' &&
          (await command(unborn, 'status', '--short', '--', 'new file.txt')) ===
            '?? "new file.txt"',
        'staged revert without HEAD preserves the worktree and leaves the file untracked'
      )

      await write(unborn, 'purely untracked.txt', 'delete me\n')
      const removedUntracked = await review.revertFiles(
        unborn,
        ['purely untracked.txt'],
        'unstaged'
      )
      check(
        removedUntracked.ok &&
          !(await fs.stat(path.join(unborn, 'purely untracked.txt')).catch(() => null)),
        'unstaged revert without HEAD deletes a purely untracked file'
      )
    } finally {
      await fs.rm(unborn, { recursive: true, force: true })
    }
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
  }
  app.exit(failed ? 1 : 0)
}

void main().catch((error) => {
  console.error(error)
  app.exit(1)
})
