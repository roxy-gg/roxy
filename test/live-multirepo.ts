/**
 * End-to-end check of a MULTI-REPO session against the real main-process code:
 * the real database (migrations included), the real `discoverRepos`, the real
 * lazy materialization, and the real teardown.
 *
 * test/multirepo.ts covers the git mechanics in isolation with hand-rolled
 * commands. This one proves the SHIPPING code path does the same thing end to
 * end - that a session created in a folder of repos actually gets a composite
 * worktree, that its cwd resolves inside it, that the DB round-trips the links,
 * and that removing it cleans up.
 *
 * Runs under electron (the DB and `app.getPath` need it):
 *   npx electron test/.out/live.cjs
 */
import { app } from 'electron'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

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

function git(args: string[], cwd: string): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

async function main(): Promise<void> {
  await app.whenReady()

  // A fresh userData so the real migration ladder runs from nothing, and so
  // worktrees land somewhere disposable.
  const sandbox = path.join(app.getPath('temp'), `roxy-live-${process.pid}`)
  // Leave the sandbox on disk: the DB handle is still open and Windows will
  // not unlink it. The OS temp dir is the right owner of that cleanup.
  mkdirSync(sandbox, { recursive: true })
  app.setPath('userData', sandbox)

  // --- fixture: a project folder that is NOT a repo but holds three ---
  const project = path.join(sandbox, 'project')
  for (const name of ['backend', 'frontend', 'shared']) {
    const dir = path.join(project, name)
    mkdirSync(dir, { recursive: true })
    git(['init', '-q', '-b', 'main'], dir)
    writeFileSync(path.join(dir, 'README.md'), `hello ${name}\n`)
    git(['add', '-A'], dir)
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', `init ${name}`], dir)
  }

  // Imported AFTER userData is redirected: the DB opens on first use.
  const repo = require('../src/main/db/repo') as typeof import('../src/main/db/repo')
  const workspace =
    require('../src/main/services/workspace') as typeof import('../src/main/services/workspace')
  const worktree =
    require('../src/main/services/worktree') as typeof import('../src/main/services/worktree')

  // ---- discovery ----------------------------------------------------------
  const scan = workspace.discoverRepos(project)
  check('discovery: a folder of repos is multi', scan.layout === 'multi', scan.layout)
  check(
    'discovery: finds all three, sorted',
    scan.roots.map((r) => path.basename(r)).join(',') === 'backend,frontend,shared',
    scan.roots.join(',')
  )
  check(
    'discovery: a single repo is still single',
    workspace.discoverRepos(path.join(project, 'backend')).layout === 'single'
  )

  // ---- REGRESSION: a single-repo session must be untouched ----------------
  // The whole design rests on `repos === null` short-circuiting every new code
  // path, so an ordinary repo has to come out exactly as it did before.
  const solo = repo.createChat({
    title: 'Solo Session',
    workspacePath: path.join(project, 'backend'),
    worktree: { mode: 'new' }
  })
  const soloRes = await worktree.materializePendingWorktree(solo.id)
  const soloAfter = repo.getChat(solo.id)!
  check('single-repo: still materializes', soloRes.ok, soloRes.error ?? '')
  check('single-repo: records NO repo links (stays on the old path)', !soloAfter.repos)
  check(
    'single-repo: its worktree is a real repo, not a composite',
    existsSync(path.join(soloAfter.worktreePath!, '.git'))
  )
  check(
    'single-repo: cwd is the worktree itself',
    workspace.sessionCwd(solo.id) === soloAfter.worktreePath
  )
  const soloGone = await worktree.removeWorktreeForChat(solo.id, { force: true })
  check('single-repo: teardown still works', soloGone.ok, soloGone.error ?? '')

  // ---- session + lazy materialization -------------------------------------
  const chat = repo.createChat({
    title: 'Cursed Ranoa King',
    workspacePath: project,
    worktree: { mode: 'new' }
  })
  check('session: starts with no worktree (materialization is lazy)', !chat.worktreePath)
  check('session: starts with no repos', !chat.repos)

  const res = await worktree.materializePendingWorktree(chat.id)
  check('materialize: reports success', res.ok, res.error ?? '')

  const after = repo.getChat(chat.id)!
  check('materialize: the session now has a worktree', !!after.worktreePath)
  check(
    'materialize: and records its repos',
    (after.repos?.length ?? 0) === 3,
    String(after.repos?.length)
  )
  check(
    'materialize: every repo shares ONE branch name',
    !!after.branch && (after.repos ?? []).every((r) => r.branch === after.branch),
    after.branch ?? 'null'
  )
  check(
    'materialize: the branch is named after the session',
    (after.branch ?? '').includes('cursed-ranoa-king'),
    after.branch ?? 'null'
  )

  const composite = after.worktreePath!
  check(
    'layout: the composite holds one dir per repo',
    readdirSync(composite).sort().join(',') === 'backend,frontend,shared',
    readdirSync(composite).join(',')
  )
  check(
    'layout: each child is a real checkout',
    (after.repos ?? []).every((r) => existsSync(path.join(r.worktreePath, 'README.md')))
  )
  check('layout: the composite root is NOT a repo', !existsSync(path.join(composite, '.git')))

  // ---- the cwd every tool run uses ----------------------------------------
  // This is the one that matters most: get it wrong and the agent edits the
  // project folder (shared with the user's editor) instead of its own checkout.
  const cwd = workspace.sessionCwd(chat.id)
  check('cwd: resolves to the composite root', cwd === composite, `${cwd} != ${composite}`)
  check('cwd: is a real directory', existsSync(cwd))
  check(
    'cwd: siblings are reachable from inside a repo',
    existsSync(path.join(cwd, 'backend', '..', 'shared', 'README.md'))
  )

  // ---- DB round-trip -------------------------------------------------------
  const reread = repo.getChat(chat.id)!
  check('db: links survive a re-read', JSON.stringify(reread.repos) === JSON.stringify(after.repos))
  const claimed = repo.listWorktreePaths()
  check(
    'db: prune bookkeeping claims every CHILD, not just the root',
    (after.repos ?? []).every((r) => claimed.includes(r.worktreePath)),
    claimed.join(' | ')
  )
  check('db: and the composite root too', claimed.includes(composite))

  // ---- prune must not eat a live workstream --------------------------------
  const pruned = await worktree.pruneWorktrees(project, { dryRun: true })
  check(
    'prune: a live composite has NO orphan candidates',
    pruned.ok && pruned.candidates.length === 0,
    pruned.candidates.map((c) => c.path).join(' | ')
  )

  // ---- teardown ------------------------------------------------------------
  // Dirty one repo: it must survive while its clean siblings go.
  const dirty = (after.repos ?? []).find((r) => r.name === 'frontend')!
  writeFileSync(path.join(dirty.worktreePath, 'wip.txt'), 'work in progress\n')

  const partial = await worktree.removeWorktreeForChat(chat.id)
  check('teardown: refuses while a repo is dirty', !partial.ok, partial.error ?? '')
  check(
    'teardown: the dirty repo keeps its work',
    existsSync(path.join(dirty.worktreePath, 'wip.txt'))
  )

  const forced = await worktree.removeWorktreeForChat(chat.id, { force: true })
  check('teardown: force removes everything', forced.ok, forced.error ?? '')
  check('teardown: the composite root is gone too', !existsSync(composite))

  // ---- fresh remote workstreams --------------------------------------------
  check('fresh: defaults off', repo.getSettings().freshWorkstream === false)
  repo.setFreshWorkstream(true)
  check('fresh: opt-in persists', repo.getSettings().freshWorkstream === true)
  const upstream = path.join(sandbox, 'upstream')
  const local = path.join(sandbox, 'local')
  const remote = path.join(sandbox, 'origin.git')
  mkdirSync(upstream)
  git(['init', '-q', '-b', 'main'], upstream)
  writeFileSync(path.join(upstream, 'README.md'), 'initial\n')
  git(['add', '.'], upstream)
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'initial'], upstream)
  git(['clone', '--bare', upstream, remote], sandbox)
  git(['clone', remote, local], sandbox)
  git(['remote', 'add', 'origin', remote], upstream)
  const initial = git(['rev-parse', 'HEAD'], local)
  writeFileSync(path.join(local, 'local-only.txt'), 'local commit\n')
  git(['add', '.'], local)
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'local-only'], local)
  const localHead = git(['rev-parse', 'HEAD'], local)
  writeFileSync(path.join(local, 'README.md'), 'unsaved local edit\n')
  writeFileSync(path.join(local, 'untracked.txt'), 'keep me\n')

  const fresh = repo.createChat({
    title: 'Fresh Remote',
    workspacePath: local,
    worktree: { mode: 'new' }
  })
  // Advance AFTER session creation: refresh must happen at the first message.
  writeFileSync(path.join(upstream, 'README.md'), 'latest remote\n')
  git(['add', '.'], upstream)
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'remote update'], upstream)
  git(['push', 'origin', 'main'], upstream)
  const latest = git(['rev-parse', 'HEAD'], upstream)
  const freshResult = await worktree.materializePendingWorktree(fresh.id)
  check(
    'fresh: materializes from latest remote, not local commits',
    freshResult.ok && git(['rev-parse', 'HEAD'], freshResult.worktreePath!) === latest,
    freshResult.error
  )
  check(
    'fresh: checkout is clean and excludes local-only files',
    git(['status', '--porcelain'], freshResult.worktreePath!) === '' &&
      !existsSync(path.join(freshResult.worktreePath!, 'local-only.txt'))
  )
  check(
    'fresh: project branch and dirty files are untouched',
    git(['rev-parse', 'HEAD'], local) === localHead &&
      readFileSync(path.join(local, 'README.md'), 'utf8') === 'unsaved local edit\n' &&
      existsSync(path.join(local, 'untracked.txt'))
  )

  // Offline with a cached tracking ref must block, not silently use that ref.
  git(['remote', 'set-url', 'origin', path.join(sandbox, 'missing.git')], local)
  const offline = repo.createChat({
    title: 'Offline Fresh',
    workspacePath: local,
    worktree: { mode: 'new' }
  })
  const offlineResult = await worktree.materializePendingWorktree(offline.id)
  check(
    'fresh: unreachable origin blocks without a checkout',
    offlineResult.blocked === true && !repo.getChat(offline.id)!.worktreePath
  )
  check('fresh: failed attempt keeps intent for retry', !!repo.getChat(offline.id)!.worktreePending)
  writeFileSync(path.join(freshResult.worktreePath!, 'session-wip.txt'), 'keep session edits\n')
  await worktree.materializePendingWorktree(fresh.id)
  check(
    'fresh: existing workstream is never reset',
    existsSync(path.join(freshResult.worktreePath!, 'session-wip.txt'))
  )

  const fork = repo.createChat({
    title: 'Explicit Fork',
    workspacePath: local,
    worktree: { mode: 'new', baseRef: initial }
  })
  const forkResult = await worktree.materializePendingWorktree(fork.id)
  check(
    'fresh: fork keeps its explicit commit even offline',
    forkResult.ok && git(['rev-parse', 'HEAD'], forkResult.worktreePath!) === initial,
    forkResult.error
  )
  const attached = repo.createChat({
    title: 'Explicit Branch',
    workspacePath: local,
    worktree: { mode: 'attach', branch: freshResult.branch }
  })
  const attachedResult = await worktree.materializePendingWorktree(attached.id)
  check(
    'fresh: selected existing branch is reused without reset',
    attachedResult.ok && existsSync(path.join(attachedResult.worktreePath!, 'session-wip.txt')),
    attachedResult.error
  )
  const collision = repo.createChat({
    title: 'No Reuse',
    workspacePath: local,
    worktree: { mode: 'new', branch: freshResult.branch }
  })
  git(['remote', 'set-url', 'origin', remote], local)
  const collisionResult = await worktree.materializePendingWorktree(collision.id)
  check(
    'fresh: new mode cannot reuse an existing dirty checkout',
    collisionResult.blocked === true &&
      existsSync(path.join(freshResult.worktreePath!, 'session-wip.txt'))
  )
  const retryResult = await worktree.materializePendingWorktree(offline.id)
  check(
    'fresh: retry succeeds when origin returns',
    retryResult.ok && !repo.getChat(offline.id)!.worktreePending,
    retryResult.error
  )

  // The server's default can differ from a stale origin/HEAD or local main.
  git(['checkout', '-b', 'trunk'], upstream)
  writeFileSync(path.join(upstream, 'trunk.txt'), 'new remote default\n')
  git(['add', '.'], upstream)
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'trunk'], upstream)
  git(['push', 'origin', 'trunk'], upstream)
  git(['symbolic-ref', 'HEAD', 'refs/heads/trunk'], remote)
  git(['config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main'], local)
  const trunk = repo.createChat({
    title: 'Remote Default',
    workspacePath: local,
    worktree: { mode: 'new' }
  })
  const trunkResult = await worktree.materializePendingWorktree(trunk.id)
  check(
    'fresh: follows remote default despite stale HEAD and narrow fetch config',
    trunkResult.ok && existsSync(path.join(trunkResult.worktreePath!, 'trunk.txt')),
    trunkResult.error
  )
  check(
    'fresh: records actual PR base',
    git(['config', `branch.${trunkResult.branch}.roxy-base`], local) === 'trunk'
  )

  for (const name of ['backend', 'frontend', 'shared']) {
    const dir = path.join(project, name)
    git(['remote', 'add', 'origin', remote], dir)
  }
  git(
    ['remote', 'set-url', 'origin', path.join(sandbox, 'missing.git')],
    path.join(project, 'shared')
  )
  const multiFresh = repo.createChat({
    title: 'Fresh Composite',
    workspacePath: project,
    worktree: { mode: 'new' }
  })
  const multiFail = await worktree.materializePendingWorktree(multiFresh.id)
  check(
    'fresh: composite fetch failure blocks before any checkout',
    multiFail.blocked === true &&
      !repo.getChat(multiFresh.id)!.worktreePath &&
      (await worktree.pruneWorktrees(project)).candidates.length === 0
  )
  git(['remote', 'set-url', 'origin', remote], path.join(project, 'shared'))
  const multiResult = await worktree.materializePendingWorktree(multiFresh.id)
  check(
    'fresh: composite retries with every repo at remote default',
    multiResult.ok &&
      multiResult.repos?.length === 3 &&
      multiResult.repos.every(
        (link) =>
          git(['rev-parse', 'HEAD'], link.worktreePath) === git(['rev-parse', 'HEAD'], upstream)
      ),
    multiResult.error
  )
  await worktree.removeWorktreeForChat(multiFresh.id, { force: true })

  repo.setFreshWorkstream(false)
  check('fresh: disabling persists', repo.getSettings().freshWorkstream === false)
  git(['remote', 'set-url', 'origin', path.join(sandbox, 'missing.git')], local)
  const fallback = repo.createChat({
    title: 'Offline Default',
    workspacePath: local,
    worktree: { mode: 'new' }
  })
  check(
    'fresh: off retains existing offline behavior',
    (await worktree.materializePendingWorktree(fallback.id)).ok
  )

  if (fails.length) {
    console.error(`\nLIVE FAILED - ${fails.length} failing: ${fails.join(', ')}`)
    app.exit(1)
    return
  }
  console.log(`\nLIVE OK - ${pass} checks passed`)
  app.exit(0)
}

void main().catch((e) => {
  console.error('LIVE CRASHED', e)
  app.exit(1)
})
