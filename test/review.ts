/**
 * Checks the review layer (main/services/git.ts) against a REAL repository.
 *
 * The parsing here is the part most likely to break silently: `-z` output is
 * NUL-delimited with rename pairs spread across three fields, and a path with a
 * space in it is exactly the case that a naive line-splitting parser gets wrong
 * without ever throwing. So the fixture deliberately contains a space in a
 * filename, a rename, a binary file, a deletion and an untracked file.
 *
 * Runs under electron, because git.ts imports `app` for the worktree root:
 *   npx electron test/.out/review.cjs
 */
import { app } from 'electron'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  reviewCommits,
  reviewDiff,
  reviewFiles,
  revertFiles,
  stageFiles,
  unstageFiles
} from '../src/main/services/git'

let pass = 0
const fails: string[] = []
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++
    console.log('  \u2713', name)
  } else {
    fails.push(name)
    console.error('  \u2717', name, detail ? `\n      ${detail}` : '')
  }
}

function git(args: string[], cwd: string): void {
  spawnSync('git', args, { cwd, encoding: 'utf8', shell: false })
}

async function main(): Promise<void> {
  await app.whenReady()

  const sandbox = path.join(app.getPath('temp'), `roxy-review-${process.pid}`)
  rmSync(sandbox, { recursive: true, force: true })
  mkdirSync(sandbox, { recursive: true })
  app.setPath('userData', sandbox)

  const repo = path.join(sandbox, 'repo')
  mkdirSync(repo, { recursive: true })
  git(['init', '-q', '-b', 'main'], repo)
  git(['config', 'user.email', 't@t'], repo)
  git(['config', 'user.name', 't'], repo)

  // --- baseline commit -----------------------------------------------------
  writeFileSync(path.join(repo, 'kept.txt'), 'one\ntwo\nthree\n')
  writeFileSync(path.join(repo, 'gone.txt'), 'delete me\n')
  writeFileSync(path.join(repo, 'old name.txt'), 'rename me\n')
  writeFileSync(path.join(repo, 'huge.txt'), 'a'.repeat(400_001))
  git(['add', '-A'], repo)
  git(['commit', '-qm', 'init'], repo)

  console.log('\ncommits')
  const commits = await reviewCommits(repo, 10)
  check('lists the initial commit', commits.length === 1, JSON.stringify(commits))
  check('carries the subject', commits[0]?.subject === 'init', commits[0]?.subject)
  check('carries an ISO date', /^\d{4}-\d{2}-\d{2}T/.test(commits[0]?.date ?? ''), commits[0]?.date)

  // --- a working tree with one of everything -------------------------------
  writeFileSync(path.join(repo, 'kept.txt'), 'one\ntwo modified\nthree\nfour\n')
  rmSync(path.join(repo, 'gone.txt'))
  git(['mv', 'old name.txt', 'new name.txt'], repo)
  writeFileSync(path.join(repo, 'fresh.txt'), 'brand new\n')
  writeFileSync(path.join(repo, 'huge.txt'), 'b'.repeat(400_001))
  // A NUL byte in the first block is how binary content is detected.
  writeFileSync(path.join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255]))

  console.log('\nunstaged scope')
  const unstaged = await reviewFiles(repo, 'unstaged')
  const byPath = new Map(unstaged.map((f) => [f.path, f]))

  check('sees the modified file', byPath.get('kept.txt')?.status === 'modified')
  check(
    'counts lines on the modified file',
    byPath.get('kept.txt')?.additions === 2 && byPath.get('kept.txt')?.deletions === 1,
    JSON.stringify(byPath.get('kept.txt'))
  )
  check('sees the deletion', byPath.get('gone.txt')?.status === 'deleted')
  check('sees the untracked file', byPath.get('fresh.txt')?.status === 'untracked')
  check('counts an untracked file as all additions', byPath.get('fresh.txt')?.additions === 1)
  check('flags the binary file', byPath.get('blob.bin')?.binary === true)

  // `git mv` stages the rename, so it shows up as untracked+deleted in the
  // unstaged view - the rename itself is in the INDEX. That is git's own
  // model, and the pane reflects it rather than inventing a merged view.
  console.log('\nstaged scope (the rename lives here)')
  const staged = await reviewFiles(repo, 'staged')
  const renamed = staged.find((f) => f.status === 'renamed')
  check('detects the rename', !!renamed, JSON.stringify(staged))
  check('names the new path', renamed?.path === 'new name.txt', renamed?.path)
  check('remembers the old path', renamed?.oldPath === 'old name.txt', renamed?.oldPath)
  check(
    'survives a space in the path (the -z case)',
    !!staged.find((f) => f.path === 'new name.txt'),
    staged.map((f) => f.path).join(' | ')
  )
  check(
    'unstages both sides of a rename',
    (await unstageFiles(repo, ['new name.txt', 'old name.txt'])).ok &&
      !(await reviewFiles(repo, 'staged')).some((f) =>
        ['new name.txt', 'old name.txt'].includes(f.path)
      )
  )
  check(
    'stages both sides of a rename again',
    (await stageFiles(repo, ['new name.txt', 'old name.txt'])).ok
  )

  // --- diffs ---------------------------------------------------------------
  console.log('\ndiffs')
  const modified = await reviewDiff(repo, 'unstaged', 'kept.txt')
  check('reads the previous contents', modified?.before === 'one\ntwo\nthree\n', modified?.before)
  check(
    'reads the current contents',
    modified?.after === 'one\ntwo modified\nthree\nfour\n',
    modified?.after
  )

  const added = await reviewDiff(repo, 'unstaged', 'fresh.txt')
  check('an untracked file has an empty before', added?.before === '', JSON.stringify(added))
  check('an untracked file has its contents as after', added?.after === 'brand new\n')

  const deleted = await reviewDiff(repo, 'unstaged', 'gone.txt')
  check('a deleted file has an empty after', deleted?.after === '', JSON.stringify(deleted))
  check('a deleted file keeps its before', deleted?.before === 'delete me\n')

  const binary = await reviewDiff(repo, 'unstaged', 'blob.bin')
  check('refuses to diff binary content', binary?.binary === true, JSON.stringify(binary))

  const oversized = await reviewDiff(repo, 'unstaged', 'huge.txt')
  check('refuses to diff oversized text', oversized?.binary === true, JSON.stringify(oversized))

  // Under `core.autocrlf` (the Windows default) git stores LF but checks out
  // CRLF, so the two sides of a diff arrive with different line endings and
  // EVERY line looks changed - a one-line edit rendered as a whole-file
  // rewrite. Both sides must come back normalized, the way git's own diff sees
  // them.
  writeFileSync(path.join(repo, 'crlf.txt'), 'alpha\nbeta\ngamma\n')
  git(['add', '--', 'crlf.txt'], repo)
  git(['commit', '-qm', 'lf in the blob', '--', 'crlf.txt'], repo)
  // What a CRLF checkout leaves in the worktree: same content, one line edited.
  writeFileSync(path.join(repo, 'crlf.txt'), 'alpha\r\nbeta edited\r\ngamma\r\n')
  const eol = await reviewDiff(repo, 'unstaged', 'crlf.txt')
  check(
    'a CRLF worktree does not turn every line into a change',
    !eol?.after.includes('\r'),
    JSON.stringify(eol?.after)
  )
  check(
    'so only the edited line actually differs',
    eol?.before === 'alpha\nbeta\ngamma\n' && eol?.after === 'alpha\nbeta edited\ngamma\n',
    JSON.stringify(eol)
  )

  // --- staging -------------------------------------------------------------
  console.log('\nstage / unstage')
  check('stages one file', (await stageFiles(repo, ['kept.txt'])).ok)
  check(
    'a staged file leaves the unstaged view',
    !(await reviewFiles(repo, 'unstaged')).some((f) => f.path === 'kept.txt')
  )
  check(
    'and appears in the staged view',
    (await reviewFiles(repo, 'staged')).some((f) => f.path === 'kept.txt')
  )
  check('unstages it again', (await unstageFiles(repo, ['kept.txt'])).ok)
  check(
    'and it comes back to the unstaged view',
    (await reviewFiles(repo, 'unstaged')).some((f) => f.path === 'kept.txt')
  )

  // --- revert (the destructive one) ---------------------------------------
  console.log('\nrevert')
  check('reverts a tracked file', (await revertFiles(repo, ['kept.txt'])).ok)
  const afterRevert = await reviewFiles(repo, 'unstaged')
  check(
    'the tracked file is clean again',
    !afterRevert.some((f) => f.path === 'kept.txt'),
    afterRevert.map((f) => f.path).join(' | ')
  )
  check('deletes an untracked file', (await revertFiles(repo, ['fresh.txt'])).ok)
  check(
    'the untracked file is gone',
    !(await reviewFiles(repo, 'unstaged')).some((f) => f.path === 'fresh.txt')
  )
  check(
    'reverts both sides of a staged rename',
    (await revertFiles(repo, ['new name.txt', 'old name.txt'])).ok &&
      existsSync(path.join(repo, 'old name.txt')) &&
      !existsSync(path.join(repo, 'new name.txt'))
  )

  // --- branch scope --------------------------------------------------------
  // Diffed against the MERGE BASE, so a commit landing on main afterwards must
  // NOT show up as part of this branch's work.
  console.log('\nbranch scope')
  // Commit whatever the fixture still has pending (the rename, the deletion,
  // the binary), so the feature commit below contains ONE file and the commit
  // scope's assertion is about scoping rather than about leftovers.
  git(['add', '-A'], repo)
  git(['commit', '-qm', 'tidy'], repo)

  git(['checkout', '-qb', 'feature'], repo)
  writeFileSync(path.join(repo, 'feature.txt'), 'feature work\n')
  git(['add', '-A'], repo)
  git(['commit', '-qm', 'feature'], repo)

  git(['checkout', '-q', 'main'], repo)
  writeFileSync(path.join(repo, 'unrelated.txt'), 'someone else\n')
  git(['add', '-A'], repo)
  git(['commit', '-qm', 'unrelated'], repo)
  git(['checkout', '-q', 'feature'], repo)

  const branch = await reviewFiles(repo, 'branch')
  check(
    "includes the branch's own work",
    branch.some((f) => f.path === 'feature.txt'),
    branch.map((f) => f.path).join(' | ')
  )
  check(
    'excludes what landed on main after branching',
    !branch.some((f) => f.path === 'unrelated.txt'),
    branch.map((f) => f.path).join(' | ')
  )

  // --- commit scope --------------------------------------------------------
  console.log('\ncommit scope')
  const log = await reviewCommits(repo, 5)
  const featureSha = log.find((c) => c.subject === 'feature')?.sha
  const single = await reviewFiles(repo, 'commit', featureSha)
  check(
    'shows only that commit',
    single.length === 1 && single[0].path === 'feature.txt',
    single.map((f) => f.path).join(' | ')
  )

  const rootSha = log[log.length - 1]?.sha
  const root = await reviewFiles(repo, 'commit', rootSha)
  check(
    'a root commit diffs against the empty tree',
    root.length > 0 && root.every((f) => f.status === 'added'),
    root.map((f) => `${f.status} ${f.path}`).join(' | ')
  )

  // --- unborn repository -------------------------------------------------
  console.log('\nunborn repository')
  const unborn = path.join(sandbox, 'unborn')
  mkdirSync(unborn, { recursive: true })
  git(['init', '-q', '-b', 'main'], unborn)
  writeFileSync(path.join(unborn, 'first.txt'), 'first commit\n')
  check('stages a file before the first commit', (await stageFiles(unborn, ['first.txt'])).ok)
  const firstStaged = await reviewFiles(unborn, 'staged')
  check(
    'reviews the first commit against the empty tree',
    firstStaged.length === 1 && firstStaged[0].status === 'added',
    JSON.stringify(firstStaged)
  )
  check('unstages before the first commit', (await unstageFiles(unborn, ['first.txt'])).ok)
  check(
    'the unstaged file becomes untracked',
    (await reviewFiles(unborn, 'unstaged')).some((file) => file.path === 'first.txt')
  )
  check('stages the first file again', (await stageFiles(unborn, ['first.txt'])).ok)
  check('reverts a staged first-commit file', (await revertFiles(unborn, ['first.txt'])).ok)
  check('the reverted first-commit file is deleted', !existsSync(path.join(unborn, 'first.txt')))

  // --- degrades instead of throwing ---------------------------------------
  console.log('\nnon-repos')
  check('empty list outside a repo', (await reviewFiles(sandbox, 'unstaged')).length === 0)
  check('null diff outside a repo', (await reviewDiff(sandbox, 'unstaged', 'x')) === null)
  check('no commits outside a repo', (await reviewCommits(sandbox)).length === 0)

  console.log(`\n${pass} passed, ${fails.length} failed`)
  if (fails.length) {
    console.error('FAILED:', fails.join(', '))
    app.exit(1)
  }
  app.exit(0)
}

void main().catch((e) => {
  console.error(e)
  app.exit(1)
})
