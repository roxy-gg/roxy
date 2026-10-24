import assert from 'node:assert/strict'
import { app, BrowserWindow, protocol } from 'electron'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { workspaceMedia } from '../src/shared/workspace-inspector'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'roxy-media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])
app.on('window-all-closed', () => {})

async function main(): Promise<void> {
  await app.whenReady()
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'roxy-inspector-'))
  app.setPath('userData', sandbox)
  const repo = require('../src/main/db/repo') as typeof import('../src/main/db/repo')
  const {
    inspectWorkspace,
    listWorkspace,
    readWorkspace,
    writeWorkspace,
    previewWorkspace,
    serveWorkspaceMedia
  } =
    require('../src/main/services/workspace-inspector') as typeof import('../src/main/services/workspace-inspector')
  protocol.handle('roxy-media', serveWorkspaceMedia)
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
  const revision = (content: string): string => createHash('sha256').update(content).digest('hex')
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
  assert.deepEqual(await readWorkspace(chat.id, snapshot.id, 'binary.bin', true), {
    ok: false,
    reason: 'binary'
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
    assert.deepEqual(await readWorkspace(chat.id, snapshot.id, invalid, true), {
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
  // Media bypasses the text limit, streams exact ranges, and keeps path/root checks.
  for (const [file, kind] of [
    ['photo.PNG', 'image'],
    ['photo.jpeg', 'image'],
    ['movie.mp4', 'video'],
    ['movie.webm', 'video'],
    ['sound.mp3', 'audio'],
    ['paper.pdf', 'pdf']
  ]) {
    assert.equal(workspaceMedia(file)?.kind, kind)
  }
  for (const file of [
    'index.html',
    'script.js',
    'file.bin',
    'constructor',
    '__proto__',
    'png',
    'mp4',
    'folder.png/file'
  ]) {
    assert.equal(workspaceMedia(file), null)
  }
  const mediaBytes = Buffer.alloc(1024 * 1024 + 7)
  for (let i = 0; i < mediaBytes.length; i++) mediaBytes[i] = i % 251
  await fs.writeFile(path.join(outside, 'large video #1.webm'), mediaBytes)
  const mediaRoot = (await inspectWorkspace(plain.id)).roots[0].id
  const preview = await previewWorkspace(plain.id, mediaRoot, 'large video #1.webm')
  assert(preview.ok)
  assert.equal(preview.kind, 'video')
  assert.equal(preview.size, mediaBytes.length)
  assert(!preview.url.includes(outside))
  const full = await serveWorkspaceMedia(new Request(preview.url))
  assert.equal(full.status, 200)
  assert.equal(full.headers.get('content-type'), 'video/webm')
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), mediaBytes)
  for (const [range, start, end] of [
    ['bytes=2-5', 2, 5],
    ['bytes=1048576-', 1048576, mediaBytes.length - 1],
    ['bytes=-4', mediaBytes.length - 4, mediaBytes.length - 1],
    ['bytes=0-9999999', 0, mediaBytes.length - 1]
  ] as const) {
    const response = await serveWorkspaceMedia(new Request(preview.url, { headers: { range } }))
    assert.equal(response.status, 206)
    assert.equal(
      response.headers.get('content-range'),
      `bytes ${start}-${end}/${mediaBytes.length}`
    )
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), mediaBytes.subarray(start, end + 1))
  }
  for (const range of ['bytes=9999999-', 'bytes=5-2', 'bytes=-0', 'bytes=-', 'bytes=0-1,3-4']) {
    assert.equal(
      (await serveWorkspaceMedia(new Request(preview.url, { headers: { range } }))).status,
      416
    )
  }
  const head = await serveWorkspaceMedia(new Request(preview.url, { method: 'HEAD' }))
  assert.equal(head.headers.get('content-length'), String(mediaBytes.length))
  assert.equal((await head.arrayBuffer()).byteLength, 0)
  assert.equal((await serveWorkspaceMedia(new Request('roxy-media://preview/forged'))).status, 404)
  await fs.writeFile(path.join(outside, 'empty.png'), '')
  const empty = await previewWorkspace(plain.id, mediaRoot, 'empty.png')
  assert(empty.ok)
  assert.equal(
    (await (await serveWorkspaceMedia(new Request(empty.url))).arrayBuffer()).byteLength,
    0
  )
  for (const file of ['../outside/photo.png', '.git/config', '/absolute.png']) {
    assert.deepEqual(await previewWorkspace(plain.id, mediaRoot, file), {
      ok: false,
      reason: 'unsafe'
    })
  }
  assert.deepEqual(await previewWorkspace(plain.id, 'forged', 'empty.png'), {
    ok: false,
    reason: 'unsafe'
  })
  assert.deepEqual(await previewWorkspace(plain.id, mediaRoot, 'secret.txt'), {
    ok: false,
    reason: 'binary'
  })
  await fs.symlink(
    outside,
    path.join(root, 'media-escape'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  assert.deepEqual(await previewWorkspace(chat.id, snapshot.id, 'media-escape/empty.png'), {
    ok: false,
    reason: 'unsafe'
  })
  await fs.rm(path.join(root, 'media-escape'))
  // Decode and seek through the actual Electron protocol, not just the handler.
  const mediaWindow = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  })
  try {
    await mediaWindow.loadURL('data:text/html,<body></body>')
    const sharp = (await import('sharp')).default
    for (const format of ['png', 'jpeg'] as const) {
      const imageBytes = await sharp({
        create: { width: 1600, height: 900, channels: 3, background: '#369' }
      })
        [format]()
        .toBuffer()
      await fs.writeFile(path.join(outside, `photo.${format}`), imageBytes)
      const image = await previewWorkspace(plain.id, mediaRoot, `photo.${format}`)
      assert(image.ok)
      assert.deepEqual(
        await mediaWindow.webContents.executeJavaScript(
          `new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve([img.naturalWidth, img.naturalHeight]); img.onerror = () => reject(Error('Image failed')); img.src = ${JSON.stringify(image.url)}; document.body.append(img); })`
        ),
        [1600, 900]
      )
    }
    await fs.copyFile(path.resolve('test/fixtures/background.mp4'), path.join(outside, 'play.mp4'))
    const video = await previewWorkspace(plain.id, mediaRoot, 'play.mp4')
    assert(video.ok)
    assert(
      (await mediaWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const video = document.createElement('video'); video.muted = true; video.src = ${JSON.stringify(video.url)};
      video.onerror = () => reject(Error('Video failed: ' + video.error?.message));
      video.onloadeddata = async () => { await video.play(); video.pause(); video.onseeked = () => resolve(video.videoWidth); video.currentTime = .2; }; document.body.append(video);
    })`)) > 0
    )
    await fs.copyFile(
      path.resolve('src/renderer/src/assets/chime.wav'),
      path.join(outside, 'play.wav')
    )
    const audio = await previewWorkspace(plain.id, mediaRoot, 'play.wav')
    assert(audio.ok)
    assert(
      (await mediaWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const audio = document.createElement('audio'); audio.muted = true; audio.src = ${JSON.stringify(audio.url)};
      audio.onerror = () => reject(Error('Audio failed')); audio.onloadeddata = async () => { await audio.play(); audio.pause(); resolve(audio.duration); }; document.body.append(audio);
    })`)) > 0
    )
    const pdfBytes = await mediaWindow.webContents.printToPDF({})
    await fs.writeFile(path.join(outside, 'document.pdf'), pdfBytes)
    const pdf = await previewWorkspace(plain.id, mediaRoot, 'document.pdf')
    assert(pdf.ok)
    await mediaWindow.webContents.executeJavaScript(
      `new Promise(resolve => { const frame = document.createElement('iframe'); frame.src = ${JSON.stringify(pdf.url)}; frame.onload = () => resolve(true); document.body.append(frame); })`
    )
    await new Promise((resolve) => setTimeout(resolve, 1000))
    assert(
      mediaWindow.webContents.mainFrame.framesInSubtree.some(
        (frame) => frame.url.startsWith('chrome-extension://') && frame.url.endsWith('/index.html')
      ),
      'Electron PDF viewer loads the streamed document'
    )
  } finally {
    mediaWindow.destroy()
  }
  await fs.rm(path.join(outside, 'large video #1.webm'))
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
  assert.deepEqual(await readWorkspace(chat.id, snapshot.id, 'file.txt', true), {
    ok: true,
    before: 'one\ntwo\n',
    after: 'one\ntwo\n'
  })
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
  assert.deepEqual(await readWorkspace(chat.id, snapshot.id, 'cancelled.txt', true), {
    ok: true,
    before: '',
    after: ''
  })
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
  await fs.writeFile(path.join(root, 'stale.png'), Buffer.from([1]))
  const stale = await previewWorkspace(chat.id, snapshot.id, 'stale.png')
  assert(stale.ok)
  repo.setChatWorktree(chat.id, { worktreePath })
  assert.equal((await serveWorkspaceMedia(new Request(stale.url))).status, 404)
  // The old root's capability must not survive switching to an isolated checkout.
  assert.deepEqual(await previewWorkspace(chat.id, snapshot.id, 'stale.png'), {
    ok: false,
    reason: 'unsafe'
  })
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
    after: 'isolated\n',
    revision: revision('isolated\n')
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
    { ok: true, before: '', after: 'isolated\n', revision: revision('isolated\n') }
  )
  // Opening a comparison must stay file-scoped, even in a multi-repo session.
  const childProcess = require('node:child_process') as typeof import('node:child_process')
  const originalExecFile = childProcess.execFile
  const commands: { cwd: string; args: string[] }[] = []
  Object.assign(childProcess, {
    execFile: (...args: unknown[]) => {
      commands.push({ cwd: (args[2] as { cwd: string }).cwd, args: args[1] as string[] })
      return Reflect.apply(originalExecFile, childProcess, args)
    }
  })
  try {
    const started = performance.now()
    assert.deepEqual(
      await readWorkspace(composite.id, compositeSnapshot.roots[0].id, 'file.txt', true),
      { ok: true, before: 'one\ntwo\n', after: 'isolated\n' }
    )
    console.log(`File-only comparison: ${Math.round(performance.now() - started)}ms`)
    assert(commands.length > 0)
    assert(commands.every((command) => command.cwd === worktreePath))
    assert(!commands.some((command) => command.args.includes('diff')))
    const statuses = commands.filter((command) => command.args.includes('status'))
    assert.equal(statuses.length, 1)
    assert.deepEqual(statuses[0].args.slice(-2), ['--', 'file.txt'])
    assert(!commands.some((command) => command.args.includes('symbolic-ref')))
  } finally {
    Object.assign(childProcess, { execFile: originalExecFile })
  }
  // Writes target only existing, bounded UTF-8 files in the current session root.
  const worktreeIndex = execFileSync('git', ['write-tree'], {
    cwd: worktreePath,
    encoding: 'utf8'
  }).trim()
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
    assert.deepEqual(
      await writeWorkspace(chat.id, isolated.id, invalid, 'no', revision('isolated\n')),
      { ok: false, reason: 'unsafe' }
    )
  }
  assert.deepEqual(
    await writeWorkspace(chat.id, snapshot.id, 'file.txt', 'no', revision('isolated\n')),
    { ok: false, reason: 'unsafe' }
  )
  assert.deepEqual(
    await writeWorkspace(chat.id, isolated.id, 'file.txt', 'saved\n', revision('isolated\n')),
    { ok: true, revision: revision('saved\n') }
  )
  assert.equal(await fs.readFile(path.join(worktreePath, 'file.txt'), 'utf8'), 'saved\n')
  assert.equal(await fs.readFile(path.join(root, 'file.txt'), 'utf8'), 'one\ntwo\n')
  assert.deepEqual(
    await writeWorkspace(chat.id, isolated.id, 'file.txt', 'stale\n', revision('isolated\n')),
    { ok: false, reason: 'changed' }
  )
  const racing = await Promise.all(
    ['first\n', 'second\n'].map((content) =>
      writeWorkspace(chat.id, isolated.id, 'file.txt', content, revision('saved\n'))
    )
  )
  assert.equal(racing.filter((result) => result.ok).length, 1)
  assert.equal(racing.filter((result) => !result.ok && result.reason === 'changed').length, 1)
  assert.equal(
    execFileSync('git', ['write-tree'], { cwd: worktreePath, encoding: 'utf8' }).trim(),
    worktreeIndex
  )
  const file = path.join(outside, 'editable.txt')
  const plainRoot = (await inspectWorkspace(plain.id)).roots[0].id
  for (const content of [
    '\ufeffone\r\ntwo\r\n',
    'one\ntwo',
    '',
    '\tunicode \u00e9\n',
    'mixed\r\nend\n',
    'x'.repeat(512 * 1024)
  ]) {
    await fs.writeFile(file, content)
    const read = await readWorkspace(plain.id, plainRoot, 'editable.txt', false)
    assert(read.ok)
    assert.equal(read.after, content)
    assert.equal(read.revision, revision(content))
    const saved = await writeWorkspace(plain.id, plainRoot, 'editable.txt', content, read.revision!)
    assert(saved.ok)
    assert.deepEqual(await fs.readFile(file), Buffer.from(content))
  }
  await fs.writeFile(file, 'safe')
  const identity = await fs.stat(file)
  for (const content of ['longer contents\n', 'x', '', 'restored']) {
    const current = await fs.readFile(file, 'utf8')
    assert.equal(
      (await writeWorkspace(plain.id, plainRoot, 'editable.txt', content, revision(current))).ok,
      true
    )
    assert.deepEqual(await fs.readFile(file), Buffer.from(content))
    const stat = await fs.stat(file)
    assert.equal(stat.dev, identity.dev)
    assert.equal(stat.ino, identity.ino)
    assert.equal(stat.mode, identity.mode)
  }
  if (process.platform !== 'win32') {
    await fs.chmod(file, 0o750)
    assert.equal(
      (
        await writeWorkspace(
          plain.id,
          plainRoot,
          'editable.txt',
          'executable',
          revision('restored')
        )
      ).ok,
      true
    )
    assert.equal((await fs.stat(file)).mode & 0o777, 0o750)
  }
  await fs.writeFile(file, 'safe')
  for (const content of ['a\0b', '\ud800']) {
    assert.deepEqual(
      await writeWorkspace(plain.id, plainRoot, 'editable.txt', content, revision('safe')),
      { ok: false, reason: 'binary' }
    )
  }
  assert.deepEqual(
    await writeWorkspace(
      plain.id,
      plainRoot,
      'editable.txt',
      '\u00e9'.repeat(512 * 1024),
      revision('safe')
    ),
    { ok: false, reason: 'tooLarge' }
  )
  assert.equal(await fs.readFile(file, 'utf8'), 'safe')
  await fs.rm(file)
  assert.equal(
    (await writeWorkspace(plain.id, plainRoot, 'editable.txt', 'no recreation', revision('safe')))
      .ok,
    false
  )
  await assert.rejects(fs.access(file))
  await fs.symlink(
    outside,
    path.join(worktreePath, 'escape'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  assert.deepEqual(
    await writeWorkspace(chat.id, isolated.id, 'escape/secret.txt', 'no', revision('outside')),
    { ok: false, reason: 'unsafe' }
  )
  assert.equal(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8'), 'outside')
  await fs.rm(path.join(worktreePath, 'escape'))
  await fs.link(path.join(outside, 'secret.txt'), path.join(worktreePath, 'hardlink.txt'))
  assert.deepEqual(
    await writeWorkspace(chat.id, isolated.id, 'hardlink.txt', 'no', revision('outside')),
    { ok: false, reason: 'unsafe' }
  )
  assert.equal(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8'), 'outside')
  await fs.rm(path.join(worktreePath, 'hardlink.txt'))
  assert.deepEqual(await writeWorkspace(chat.id, isolated.id, 'binary.bin', 'no', revision('')), {
    ok: false,
    reason: 'binary'
  })
  await fs.writeFile(path.join(worktreePath, 'invalid-utf8.txt'), Buffer.from([0xff, 0xfe, 0x41]))
  assert.deepEqual(
    await writeWorkspace(chat.id, isolated.id, 'invalid-utf8.txt', 'no', revision('')),
    { ok: false, reason: 'binary' }
  )
  assert.deepEqual(
    await fs.readFile(path.join(worktreePath, 'invalid-utf8.txt')),
    Buffer.from([0xff, 0xfe, 0x41])
  )
  assert.equal((await writeWorkspace(chat.id, isolated.id, '', 'no', revision(''))).ok, false)
  assert.equal(
    (await writeWorkspace(chat.id, isolated.id, 'file.txt', 42 as unknown as string, revision('')))
      .ok,
    false
  )
  git('worktree', 'remove', '--force', worktreePath)
  assert.equal((await inspectWorkspace(chat.id)).roots[0].unavailable, true)
  assert.equal((await readWorkspace(chat.id, isolated.id, 'file.txt', false)).ok, false)
  console.log(
    'WORKSPACE INSPECTOR OK: diffs/editor safety, media above 512 KB, byte ranges, PNG/JPEG decode, video playback/seeking, audio playback, native PDF viewer, traversal/junction rejection, stale media roots, no index/worktree mutations'
  )
}

main()
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
