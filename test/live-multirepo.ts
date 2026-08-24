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
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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

function git(args: string[], cwd: string): void {
  spawnSync('git', args, { cwd, encoding: 'utf8', shell: false })
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

  // Leave the sandbox on disk: the DB handle is still open and Windows will
  // not unlink it. The OS temp dir is the right owner of that cleanup.

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
