import assert from 'node:assert/strict'
import { app } from 'electron'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

async function main(): Promise<void> {
  await app.whenReady()
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'roxy-inspector-'))
  app.setPath('userData', sandbox)
  const repo = require('../src/main/db/repo') as typeof import('../src/main/db/repo')
  const { inspectWorkspace, listWorkspace, readWorkspace } =
    require('../src/main/services/workspace-inspector') as typeof import('../src/main/services/workspace-inspector')
  const root = path.join(sandbox, 'project')
  await fs.mkdir(root)
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Inspector Test')
  git('config', 'user.email', 'inspector@example.test')
  git('config', 'core.autocrlf', 'false')
  await fs.writeFile(path.join(root, 'file.txt'), 'one\ntwo\n')
  await fs.writeFile(path.join(root, 'removed.txt'), 'remove me\n')
  await fs.writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 1, 2]))
  git('add', '.')
  git('commit', '-qm', 'baseline')
  const chat = repo.createChat({ title: 'Inspector', workspacePath: root })
  const initial = (await inspectWorkspace(chat.id)).roots[0]
  assert.equal(initial.isRepo, true)
  assert.equal(initial.branch, 'main')
  assert.deepEqual(initial.changes, [])
  await fs.writeFile(path.join(root, 'file.txt'), 'one\nthree\n')
  git('add', 'file.txt')
  await fs.writeFile(path.join(root, 'file.txt'), 'one\nfour\n')
  await fs.rm(path.join(root, 'removed.txt'))
  await fs.writeFile(path.join(root, 'new file.txt'), 'new\nfile')
  await fs.writeFile(path.join(root, '[literal].txt'), 'literal\n')
  await fs.writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 3, 4]))
  await fs.mkdir(path.join(root, '..notes'))
  await fs.writeFile(path.join(root, '..notes', 'hello.txt'), 'allowed')
  const beforeStatus = git('status', '--porcelain=v1')
  const beforeIndex = git('write-tree')
  const snapshot = (await inspectWorkspace(chat.id)).roots[0]
  const change = (file: string) => snapshot.changes.find((entry) => entry.path === file)!
  assert.deepEqual(change('file.txt'), {
    path: 'file.txt',
    status: 'modified',
    additions: 1,
    deletions: 1
  })
  assert.equal(change('new file.txt').additions, 2)
  assert.equal(change('removed.txt').status, 'deleted')
  assert.equal(change('binary.bin').additions, null)
  assert.deepEqual(await readWorkspace(chat.id, snapshot.id, 'file.txt', true), {
    ok: true,
    before: 'one\ntwo\n',
    after: 'one\nfour\n'
  })
  assert.deepEqual(await readWorkspace(chat.id, snapshot.id, 'removed.txt', true), {
    ok: true,
    before: 'remove me\n',
    after: ''
  })
  assert.deepEqual(await readWorkspace(chat.id, snapshot.id, '[literal].txt', true), {
    ok: true,
    before: '',
    after: 'literal\n'
  })
  assert.equal((await readWorkspace(chat.id, snapshot.id, 'binary.bin', false)).ok, false)
  const entries = await listWorkspace(chat.id, snapshot.id, '')
  assert(entries.ok)
  assert(!entries.entries.some((entry) => entry.name === '.git'))
  assert.equal(entries.entries[0].name, '..notes')
  assert.equal((await readWorkspace(chat.id, snapshot.id, '..notes/hello.txt', false)).ok, true)
  for (const invalid of [
    '../outside.txt',
    '/absolute',
    'C:/Windows',
    'file.txt:stream',
    '.git/config',
    '.GIT/config',
    'a/../../outside',
    'a\\b'
  ]) {
    assert.deepEqual(await readWorkspace(chat.id, snapshot.id, invalid, false), {
      ok: false,
      reason: 'unsafe'
    })
  }
  assert.deepEqual(await readWorkspace(chat.id, 'forged', 'file.txt', false), {
    ok: false,
    reason: 'unsafe'
  })
  await fs.writeFile(path.join(root, 'huge.txt'), 'x'.repeat(512 * 1024 + 1))
  assert.deepEqual(await readWorkspace(chat.id, snapshot.id, 'huge.txt', false), {
    ok: false,
    reason: 'tooLarge'
  })
  await fs.rm(path.join(root, 'huge.txt'))
  const outside = path.join(sandbox, 'outside')
  await fs.mkdir(outside)
  await fs.writeFile(path.join(outside, 'secret.txt'), 'outside')
  await fs.symlink(
    outside,
    path.join(root, 'escape'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  assert.deepEqual(await readWorkspace(chat.id, snapshot.id, 'escape/secret.txt', false), {
    ok: false,
    reason: 'unsafe'
  })
  assert.deepEqual(await listWorkspace(chat.id, snapshot.id, 'escape'), {
    ok: false,
    reason: 'unsafe'
  })
  await fs.rm(path.join(root, 'escape'))
  assert.equal(git('status', '--porcelain=v1'), beforeStatus)
  assert.equal(git('write-tree'), beforeIndex)
  await fs.writeFile(path.join(root, 'file.txt'), 'one\ntwo\n')
  const cancelled = (await inspectWorkspace(chat.id)).roots[0].changes.find(
    (entry) => entry.path === 'file.txt'
  )!
  assert.equal(cancelled.additions, 0)
  assert.equal(cancelled.deletions, 0)
  const unbornRoot = path.join(sandbox, 'unborn')
  await fs.mkdir(unbornRoot)
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: unbornRoot })
  await fs.writeFile(path.join(unbornRoot, 'hello.txt'), 'hello\n')
  const unbornChat = repo.createChat({ title: 'Unborn', workspacePath: unbornRoot })
  const unborn = (await inspectWorkspace(unbornChat.id)).roots[0]
  assert.equal(unborn.changes[0].additions, 1)
  assert.deepEqual(await readWorkspace(unbornChat.id, unborn.id, 'hello.txt', true), {
    ok: true,
    before: '',
    after: 'hello\n'
  })
  const plain = repo.createChat({ title: 'Plain', workspacePath: outside })
  assert.equal((await inspectWorkspace(plain.id)).roots[0].isRepo, false)
  git('rm', '--cached', 'removed.txt')
  await fs.writeFile(path.join(root, 'removed.txt'), 'replacement\n')
  const replacement = (await inspectWorkspace(chat.id)).roots[0].changes.filter(
    (entry) => entry.path === 'removed.txt'
  )
  assert.equal(replacement.length, 1)
  assert.equal(replacement[0].status, 'modified')
  assert.equal(replacement[0].additions, 1)
  assert.equal(replacement[0].deletions, 1)
  assert.deepEqual(await readWorkspace(chat.id, snapshot.id, 'removed.txt', true), {
    ok: true,
    before: 'remove me\n',
    after: 'replacement\n'
  })
  // Repository environment overrides must never redirect this session's inspection.
  const inherited = { ...process.env }
  try {
    process.env.GIT_DIR = path.join(unbornRoot, '.git')
    process.env.GIT_WORK_TREE = unbornRoot
    process.env.GIT_INDEX_FILE = path.join(unbornRoot, '.git', 'index')
    const scoped = (await inspectWorkspace(chat.id)).roots[0]
    assert.equal(scoped.unavailable, false)
    assert(scoped.changes.some((entry) => entry.path === 'file.txt'))
    assert(!scoped.changes.some((entry) => entry.path === 'hello.txt'))
  } finally {
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) {
      if (inherited[name] === undefined) delete process.env[name]
      else process.env[name] = inherited[name]
    }
  }
  // Inspection must not execute fsmonitor or configured clean/process filters.
  git('config', 'core.fsmonitor', 'echo ran > hook-ran.txt; false')
  git('config', 'filter.probe.clean', 'echo ran > filter-ran.txt; cat')
  git('config', 'filter.probe.process', 'echo ran > process-ran.txt; false')
  git('config', 'filter.probe.required', 'true')
  await fs.writeFile(path.join(root, '.gitattributes'), 'file.txt filter=probe\n')
  const noHooks = (await inspectWorkspace(chat.id)).roots[0]
  assert.equal(noHooks.unavailable, false)
  for (const name of ['hook-ran.txt', 'filter-ran.txt', 'process-ran.txt']) {
    await assert.rejects(fs.access(path.join(root, name)))
  }
  git('config', '--unset', 'core.fsmonitor')
  git('config', '--remove-section', 'filter.probe')
  await fs.rm(path.join(root, '.gitattributes'))
  await fs.writeFile(path.join(root, 'cancelled.txt'), 'new\n')
  git('add', 'cancelled.txt')
  await fs.rm(path.join(root, 'cancelled.txt'))
  const cancelledAdd = (await inspectWorkspace(chat.id)).roots[0]
  assert.equal(cancelledAdd.partial, false)
  assert.deepEqual(
    cancelledAdd.changes.find((entry) => entry.path === 'cancelled.txt'),
    { path: 'cancelled.txt', status: 'deleted', additions: 0, deletions: 0 }
  )
  if (process.platform === 'win32') {
    const alias = path.join(root, 'GIT~1')
    if (
      await fs.access(alias).then(
        () => true,
        () => false
      )
    ) {
      assert.deepEqual(await readWorkspace(chat.id, snapshot.id, 'GIT~1/config', false), {
        ok: false,
        reason: 'unsafe'
      })
      assert.deepEqual(await listWorkspace(chat.id, snapshot.id, 'GIT~1'), {
        ok: false,
        reason: 'unsafe'
      })
    }
  }
  const worktreePath = path.join(sandbox, 'checkout')
  git('worktree', 'add', '-q', '-b', 'inspector-worktree', worktreePath)
  repo.setChatWorktree(chat.id, { worktreePath })
  await fs.writeFile(path.join(worktreePath, 'file.txt'), 'isolated\n')
  const isolated = (await inspectWorkspace(chat.id)).roots[0]
  assert.notEqual(isolated.id, snapshot.id)
  assert.deepEqual(await readWorkspace(chat.id, snapshot.id, 'file.txt', false), {
    ok: false,
    reason: 'unsafe'
  })
  assert.deepEqual(await readWorkspace(chat.id, isolated.id, 'file.txt', false), {
    ok: true,
    before: '',
    after: 'isolated\n'
  })
  const child = repo.createChat({ title: 'Child', parentId: chat.id, kind: 'sub' })
  const grandchild = repo.createChat({ title: 'Grandchild', parentId: child.id, kind: 'sub' })
  assert.equal((await inspectWorkspace(grandchild.id)).roots[0].id, isolated.id)
  const compositePath = path.join(sandbox, 'composite')
  await fs.mkdir(compositePath)
  const composite = repo.createChat({ title: 'Composite', workspacePath: compositePath })
  repo.setChatWorktree(composite.id, {
    worktreePath: compositePath,
    repos: [
      { name: 'external-checkout', root, worktreePath, branch: 'inspector-worktree' },
      { name: 'unborn', root: unbornRoot, worktreePath: unbornRoot, branch: 'main' }
    ]
  })
  const compositeSnapshot = await inspectWorkspace(composite.id)
  assert.equal(compositeSnapshot.roots.length, 2)
  assert.deepEqual(
    await readWorkspace(composite.id, compositeSnapshot.roots[0].id, 'file.txt', false),
    { ok: true, before: '', after: 'isolated\n' }
  )
  git('worktree', 'remove', '--force', worktreePath)
  assert.equal((await inspectWorkspace(chat.id)).roots[0].unavailable, true)
  assert.equal((await readWorkspace(chat.id, isolated.id, 'file.txt', false)).ok, false)
  console.log(
    'WORKSPACE INSPECTOR OK: net staged/unstaged counts, literal paths, additions, deletions, binary, clean/unborn/non-Git, bounded reads, traversal/junction rejection, no index/worktree mutations'
  )
}

main()
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
