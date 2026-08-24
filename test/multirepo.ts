/**
 * Multi-repo (composite) workstreams, exercised against a REAL git binary.
 *
 * The pure path/JSON rules live in test/shared.ts. This file covers the part
 * that can only be verified by running git: that N sibling repos can share one
 * branch name, that a composite worktree is created and torn down correctly,
 * that a repo which cannot be checked out is SKIPPED rather than failing the
 * whole workstream, and that prune can tell a live composite child from an
 * orphan.
 *
 * Standalone (no Electron, no DB) so it runs in plain node: the git-level
 * behaviour is what is under test, not the wiring. Run: npm run smoke:multirepo
 */
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  rmdirSync,
  writeFileSync,
  readdirSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { isMultiRepo, planRepoLinks, sharedBranch, type RepoLink } from '../src/shared/repos'

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

/** Run git, never throwing. Mirrors services/git.ts's contract. */
function git(args: string[], cwd: string): { ok: boolean; out: string; err: string } {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' }
  })
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}

const ROOT = path.join(tmpdir(), `roxy-multirepo-${process.pid}`)
const PROJECT = path.join(ROOT, 'project')
const WORKTREES = path.join(ROOT, 'worktrees')

/** backend/frontend/shared have commits; `empty` is a repo with none. */
function buildFixture(): void {
  rmSync(ROOT, { recursive: true, force: true })
  for (const name of ['backend', 'frontend', 'shared']) {
    const dir = path.join(PROJECT, name)
    mkdirSync(dir, { recursive: true })
    git(['init', '-q', '-b', 'main'], dir)
    writeFileSync(path.join(dir, 'README.md'), `hello ${name}\n`)
    git(['add', '-A'], dir)
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', `init ${name}`], dir)
  }
  const empty = path.join(PROJECT, 'empty')
  mkdirSync(empty, { recursive: true })
  git(['init', '-q', '-b', 'main'], empty)
}

/**
 * The composite creation loop from services/worktree.ts, in miniature.
 * Returns the links that succeeded and the repos that were skipped.
 */
function createComposite(
  compositeRoot: string,
  roots: string[],
  branch: string
): { links: RepoLink[]; skipped: string[] } {
  const planned = planRepoLinks(compositeRoot, roots, branch, path)
  const links: RepoLink[] = []
  const skipped: string[] = []
  for (const link of planned) {
    const r = git(['worktree', 'add', '-b', branch, link.worktreePath, 'HEAD'], link.root)
    if (r.ok) links.push(link)
    else skipped.push(link.name)
  }
  return { links, skipped }
}

function main(): void {
  const probe = spawnSync('git', ['--version'], { encoding: 'utf8' })
  if (probe.status !== 0) {
    console.log('SKIPPED - no git binary')
    return
  }

  buildFixture()
  const roots = ['backend', 'empty', 'frontend', 'shared'].map((n) => path.join(PROJECT, n))
  const BRANCH = 'roxy/cursed-ranoa-king'
  const composite = path.join(WORKTREES, 'project', 'cursed-ranoa-king')

  // ---- creation ----------------------------------------------------------
  const { links, skipped } = createComposite(composite, roots, BRANCH)

  check(
    'a repo with no commits is skipped, not fatal',
    skipped.length === 1 && skipped[0] === 'empty',
    `skipped=${skipped.join(',')}`
  )
  check('every other repo got a worktree', links.length === 3, `links=${links.length}`)
  check('partial failure still yields a usable workstream', links.length > 0 && isMultiRepo(links))
  check(
    'the composite root holds one directory per live repo',
    readdirSync(composite).sort().join(',') === 'backend,frontend,shared',
    readdirSync(composite).join(',')
  )

  // The core claim: one branch name, N repos, no collision.
  const branches = links.map((l) => git(['rev-parse', '--abbrev-ref', 'HEAD'], l.worktreePath).out)
  check(
    'every repo is on the SAME branch name',
    branches.every((b) => b === BRANCH),
    branches.join(',')
  )
  check(
    'sharedBranch agrees once links carry it',
    sharedBranch(links.map((l) => ({ ...l, branch: BRANCH }))) === BRANCH
  )
  // Same name, but genuinely independent refs - different repos, different shas.
  const shas = links.map((l) => git(['rev-parse', 'HEAD'], l.worktreePath).out)
  check('the branches are independent (distinct commits)', new Set(shas).size === shas.length)

  // ---- the composite root is NOT a repo ----------------------------------
  // Every git command must run in a CHILD. This is the single rule that, if
  // broken, makes status/push/rename silently operate on the wrong tree.
  check(
    'the composite root is not itself a working tree',
    !git(['rev-parse', '--show-toplevel'], composite).ok
  )
  check(
    'a child resolves to its own toplevel',
    git(['rev-parse', '--show-toplevel'], path.join(composite, 'backend')).ok
  )

  // Relative sibling paths still resolve - tooling that walks sideways works.
  check(
    'siblings are reachable by relative path',
    existsSync(path.join(composite, 'backend', '..', 'shared', 'README.md'))
  )

  // ---- removal -----------------------------------------------------------
  // `git worktree remove` REFUSES unless run from a repo that owns the path;
  // the composite root owns nothing, so the cwd must be the link's own repo.
  const wrongCwd = git(['worktree', 'remove', path.join(composite, 'backend')], PROJECT)
  check('removing without the owning repo as cwd fails', !wrongCwd.ok, wrongCwd.err)

  const dirty = links.find((l) => l.name === 'frontend') as RepoLink
  writeFileSync(path.join(dirty.worktreePath, 'uncommitted.txt'), 'work in progress\n')

  const kept: string[] = []
  for (const link of links) {
    const r = git(['worktree', 'remove', link.worktreePath], link.root)
    if (!r.ok) kept.push(link.name)
  }
  check(
    'a repo with uncommitted work is left in place',
    kept.length === 1 && kept[0] === 'frontend',
    `kept=${kept.join(',')}`
  )
  check('its files survive', existsSync(path.join(dirty.worktreePath, 'uncommitted.txt')))
  check('clean siblings were removed', !existsSync(path.join(composite, 'backend')))
  check(
    'the composite root survives while any child remains',
    existsSync(composite) && readdirSync(composite).length === 1
  )

  // Force the dirty one, then the parent should be empty and removable.
  git(['worktree', 'remove', '--force', dirty.worktreePath], dirty.root)
  check('force removes the dirty child', !existsSync(dirty.worktreePath))
  check(
    'the emptied composite root is left behind by git',
    existsSync(composite) && readdirSync(composite).length === 0
  )
  rmdirSync(composite)
  check('so teardown must rmdir it explicitly', !existsSync(composite))

  // ---- prune safety ------------------------------------------------------
  // git reports composite CHILDREN, never the root. A claimed-set built from
  // roots alone would mark every live child as an orphan and delete it.
  const second = path.join(WORKTREES, 'project', 'second-slug')
  const live = createComposite(second, [path.join(PROJECT, 'backend')], 'roxy/second-slug')
  const reported = git(['worktree', 'list', '--porcelain'], path.join(PROJECT, 'backend')).out
  // git prints fully-resolved forward-slash paths, while Node hands back
  // whatever the caller had - which under %TEMP% on Windows is an 8.3 short
  // name (`C:\Users\FREDDY~1\...`). Comparing those two spellings as strings
  // silently fails. Production solves this with `canonicalPath`
  // (realpathSync.native + normalize); the same rule applies here, and getting
  // it wrong is what makes a live worktree look orphaned so prune deletes it.
  const canon = (p: string): string => {
    try {
      return realpathSync.native(p).replace(/\\/g, '/')
    } catch {
      return p.replace(/\\/g, '/')
    }
  }
  const listed = reported
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => canon(l.slice('worktree '.length).trim()))
  check(
    'git lists the CHILD path, not the composite root',
    listed.includes(canon(live.links[0].worktreePath)) && !listed.includes(canon(second)),
    listed.join(' | ')
  )
  const claimedRootsOnly = new Set([second])
  const claimedExpanded = new Set([second, ...live.links.map((l) => l.worktreePath)])
  check(
    'claiming only roots would mark a LIVE child as prunable (the bug)',
    !claimedRootsOnly.has(live.links[0].worktreePath)
  )
  check('claiming expanded paths protects it', claimedExpanded.has(live.links[0].worktreePath))

  // ---- syncing a composite against origin -------------------------------
  // The claim under test is the one the whole feature rests on: a workstream
  // branch that was NEVER PUSHED still has somewhere to update from and reset
  // to. Its upstream is null, so anything keying off `@{upstream}` reports
  // "nothing to sync" - which is why `syncRefFor` falls back to origin/<base>.
  const SYNC = path.join(ROOT, 'sync')
  const origin = path.join(SYNC, 'origin.git')
  const clone = path.join(SYNC, 'clone')
  mkdirSync(SYNC, { recursive: true })
  git(['init', '-q', '--bare', '-b', 'main', origin], SYNC)
  git(['clone', '-q', origin, clone], SYNC)
  writeFileSync(path.join(clone, 'a.txt'), 'one\n')
  git(['add', '-A'], clone)
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'first'], clone)
  git(['push', '-q', 'origin', 'main'], clone)

  // A workstream branch, exactly as createWorktree makes one: cut from main,
  // never pushed, tracking nothing.
  const wt = path.join(SYNC, 'wt')
  git(['worktree', 'add', '-q', '-b', 'roxy/feature', wt, 'HEAD'], clone)
  const upstream = git(['rev-parse', '--abbrev-ref', 'roxy/feature@{upstream}'], wt)
  check('sync: a fresh workstream branch has NO upstream', !upstream.ok)

  // ...and yet it has an obvious base, which is what makes the buttons legal.
  const baseRef = git(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}'], wt)
  check('sync: but origin/main resolves from inside the worktree', baseRef.ok && !!baseRef.out)

  // Someone else pushes to main while the workstream sits there.
  writeFileSync(path.join(clone, 'b.txt'), 'two\n')
  git(['add', '-A'], clone)
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'second'], clone)
  git(['push', '-q', 'origin', 'main'], clone)
  git(['fetch', '-q', 'origin'], wt)

  // This is the exact measurement `distanceFrom` makes: left-only commits are
  // what we are BEHIND, right-only what we are ahead.
  const dist = git(['rev-list', '--left-right', '--count', 'origin/main...HEAD'], wt)
  const [behind, ahead] = dist.out.split(/\s+/).map(Number)
  check('sync: the unpushed branch measures 1 behind origin/main', behind === 1, dist.out)
  check('sync: and 0 ahead, so it can fast-forward', ahead === 0, dist.out)

  // Update: a plain fast-forward onto the base ref.
  const ff = git(['merge', '--ff-only', 'origin/main'], wt)
  check('sync: update fast-forwards onto origin/main', ff.ok, ff.err)
  check('sync: and the new file arrived', existsSync(path.join(wt, 'b.txt')))

  // Reset: local commits are discarded, and uncommitted work is STASHED first -
  // the promise that makes a destructive one-click button acceptable.
  writeFileSync(path.join(wt, 'c.txt'), 'local\n')
  git(['add', '-A'], wt)
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'local work'], wt)
  writeFileSync(path.join(wt, 'd.txt'), 'uncommitted\n')
  const aheadNow = git(['rev-list', '--left-right', '--count', 'origin/main...HEAD'], wt)
  check('sync: a local commit shows as ahead', aheadNow.out.split(/\s+/).map(Number)[1] === 1)

  const stash = git(['stash', 'push', '--include-untracked', '-m', 'roxy: before reset'], wt)
  check('sync: uncommitted work stashes before the reset', stash.ok, stash.err)
  const hardReset = git(['reset', '--hard', 'origin/main'], wt)
  check('sync: reset lands on origin/main', hardReset.ok, hardReset.err)
  check('sync: the local commit is gone', !existsSync(path.join(wt, 'c.txt')))
  const stashList = git(['stash', 'list'], wt)
  check('sync: and the uncommitted work is recoverable', /roxy: before reset/.test(stashList.out))
  const popped = git(['stash', 'pop'], wt)
  check(
    'sync: `git stash pop` really brings it back',
    popped.ok && existsSync(path.join(wt, 'd.txt'))
  )

  // ---- a repo with NO REMOTE AT ALL -------------------------------------
  // The local-only case: a scratch repo, or anything not pushed yet. There is
  // no origin/main, but there IS a local main, and it is not a stale mirror of
  // anything - it is the only truth in the repo. Refusing to sync would strand
  // these with no way back to main at all.
  const lonely = path.join(SYNC, 'lonely')
  mkdirSync(lonely, { recursive: true })
  git(['init', '-q', '-b', 'main'], lonely)
  writeFileSync(path.join(lonely, 'x.txt'), 'x\n')
  git(['add', '-A'], lonely)
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'only'], lonely)

  const noRemote = git(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'], lonely)
  check('local: there is no origin/main to sync with', !noRemote.ok || !noRemote.out)
  check('local: and no remote configured at all', !git(['remote', 'get-url', 'origin'], lonely).ok)
  const localMain = git(['rev-parse', '--verify', '--quiet', 'refs/heads/main^{commit}'], lonely)
  check('local: but local main exists, so there IS a base', localMain.ok && !!localMain.out)

  // main moves on while a workstream branch sits behind it.
  git(['checkout', '-q', '-b', 'roxy/local-feature'], lonely)
  git(['checkout', '-q', 'main'], lonely)
  writeFileSync(path.join(lonely, 'y.txt'), 'y\n')
  git(['add', '-A'], lonely)
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'moved on'], lonely)
  git(['checkout', '-q', 'roxy/local-feature'], lonely)

  const localDist = git(['rev-list', '--left-right', '--count', 'main...HEAD'], lonely)
  check('local: the branch measures 1 behind local main', localDist.out.split(/\s+/)[0] === '1')

  // Update, with no fetch anywhere in sight.
  const localFf = git(['merge', '--ff-only', 'main'], lonely)
  check('local: update fast-forwards onto local main', localFf.ok, localFf.err)
  check('local: and the file arrived', existsSync(path.join(lonely, 'y.txt')))

  // Reset works the same way.
  writeFileSync(path.join(lonely, 'z.txt'), 'z\n')
  git(['add', '-A'], lonely)
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'local only work'], lonely)
  const localReset = git(['reset', '--hard', 'main'], lonely)
  check('local: reset lands on local main', localReset.ok, localReset.err)
  check('local: discarding the local commit', !existsSync(path.join(lonely, 'z.txt')))

  // Being ON main is the one case that must stay silent: syncing a branch to
  // itself can only ever report "already up to date".
  git(['checkout', '-q', 'main'], lonely)
  const self = git(['rev-list', '--left-right', '--count', 'main...HEAD'], lonely)
  check(
    'local: main vs itself is 0/0, so the button would be a no-op',
    self.out.replace(/\s+/g, '') === '00'
  )

  rmSync(ROOT, { recursive: true, force: true })

  if (fails.length) {
    console.error(`\nMULTIREPO FAILED - ${fails.length} failing: ${fails.join(', ')}`)
    process.exit(1)
  }
  console.log(`\nMULTIREPO OK - ${pass} checks passed`)
}

main()
