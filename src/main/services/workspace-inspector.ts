import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs, realpath } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { promisify } from 'node:util'
import path from 'node:path'
import { diffLines } from 'diff'
import * as repo from '../db/repo'
import { discoverRepos, findGitRoot, sessionCwd } from './workspace'
import type {
  InspectionResult,
  WorkspaceEntry,
  WorkspaceInspectorApi,
  WorkspaceRoot,
  WorkspaceSnapshot
} from '../../shared/workspace-inspector'

const nativeRealpath = promisify(realpath.native)

const FILE_LIMIT = 512 * 1024
const CHANGE_LIMIT = 500
const DIRECTORY_LIMIT = 1000

class InspectionError extends Error {
  constructor(
    readonly reason: 'unavailable' | 'tooLarge' | 'binary' | 'unsafe',
    readonly code?: string | number
  ) {
    super(reason)
  }
}

// Overflow fails explicitly instead of presenting truncated output as a complete diff.
async function git(cwd: string, args: string[], maxBuffer = 2 * 1024 * 1024): Promise<Buffer> {
  const filters: string[] = []
  if (args[0] === 'status' || args[0] === 'diff') {
    try {
      const names = (
        await git(cwd, ['config', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|process)$'])
      )
        .toString()
        .trim()
        .split('\n')
      for (const name of new Set(names.map((name) => name.replace(/\.(clean|process)$/, '')))) {
        filters.push(
          '-c',
          name + '.clean=',
          '-c',
          name + '.process=',
          '-c',
          name + '.required=false'
        )
      }
    } catch (error) {
      if (!(error instanceof InspectionError) || error.code !== 1) throw error
    }
  }
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [
        '--literal-pathspecs',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'submodule.recurse=false',
        ...filters,
        ...args
      ],
      {
        cwd,
        encoding: 'buffer',
        maxBuffer,
        timeout: 10_000,
        windowsHide: true,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))
          ),
          GIT_OPTIONAL_LOCKS: '0',
          GIT_TERMINAL_PROMPT: '0',
          GIT_NO_LAZY_FETCH: '1'
        }
      },
      (error, stdout) => {
        if (error)
          reject(
            new InspectionError(
              error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'tooLarge' : 'unavailable',
              error.code ?? undefined
            )
          )
        else resolve(stdout)
      }
    )
  })
}

function rootsForSession(sessionId: string): { id: string; name: string; directory: string }[] {
  if (typeof sessionId !== 'string' || !sessionId) return []
  let owner = repo.getChat(sessionId)
  const seen = new Set<string>()
  while (owner?.kind === 'sub' && owner.parentId) {
    if (seen.has(owner.id) || seen.size >= 32) return []
    seen.add(owner.id)
    owner = repo.getChat(owner.parentId)
  }
  if (!owner?.workspacePath || owner.kind === 'bot') return []
  const cwd = sessionCwd(owner.id)
  if (!cwd) return []
  const links = owner.repos?.length
    ? owner.repos.map((link) => ({ name: link.name, directory: link.worktreePath }))
    : owner.worktreePath
      ? [{ name: path.basename(owner.workspacePath), directory: findGitRoot(cwd) ?? cwd }]
      : (() => {
          const discovered = discoverRepos(cwd)
          return discovered.roots.length
            ? discovered.roots.map((directory) => ({ name: path.basename(directory), directory }))
            : [{ name: path.basename(cwd), directory: cwd }]
        })()
  return links.map((link) => ({
    ...link,
    id: createHash('sha256')
      .update(owner.id + '\0' + link.directory)
      .digest('hex')
  }))
}

function rootFor(sessionId: string, rootId: string): string {
  const root = rootsForSession(sessionId).find((candidate) => candidate.id === rootId)
  if (!root) throw new InspectionError('unsafe')
  return root.directory
}

/** Reject static links and metadata paths; this is not a sandbox against concurrent local writers. */
async function safePath(root: string, relative: string): Promise<string> {
  if (
    typeof relative !== 'string' ||
    relative.includes('\0') ||
    relative.includes('\\') ||
    relative.includes(':') ||
    path.isAbsolute(relative)
  )
    throw new InspectionError('unsafe')
  const parts = relative ? relative.split('/') : []
  if (parts.some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git'))
    throw new InspectionError('unsafe')
  const realRoot = await nativeRealpath(root)
  let target = realRoot
  for (const part of parts) {
    target = path.join(target, part)
    if ((await fs.lstat(target)).isSymbolicLink()) throw new InspectionError('unsafe')
  }
  const resolved = await nativeRealpath(target)
  const inside = path.relative(realRoot, resolved)
  if (
    inside === '..' ||
    inside.startsWith('..' + path.sep) ||
    path.isAbsolute(inside) ||
    inside.split(path.sep).some((part) => part.toLowerCase() === '.git')
  )
    throw new InspectionError('unsafe')
  return resolved
}

function text(bytes: Buffer): string {
  if (bytes.includes(0)) throw new InspectionError('binary')
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new InspectionError('binary')
  }
}

async function readText(root: string, relative: string): Promise<string> {
  const filename = await safePath(root, relative)
  if (!(await fs.lstat(filename)).isFile()) throw new InspectionError('unsafe')
  const handle = await fs.open(filename, 'r')
  try {
    return await readHandle(handle)
  } finally {
    await handle.close()
  }
}

async function readHandle(handle: FileHandle): Promise<string> {
  const stat = await handle.stat()
  if (!stat.isFile()) throw new InspectionError('unsafe')
  if (stat.size > FILE_LIMIT) throw new InspectionError('tooLarge')
  const bytes = Buffer.alloc(FILE_LIMIT + 1)
  let length = 0
  while (length < bytes.length) {
    const read = await handle.read(bytes, length, bytes.length - length, length)
    if (!read.bytesRead) break
    length += read.bytesRead
  }
  if (length > FILE_LIMIT) throw new InspectionError('tooLarge')
  return text(bytes.subarray(0, length))
}

function revision(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

const saves = new Map<string, Promise<unknown>>()

export async function writeWorkspace(
  sessionId: string,
  rootId: string,
  relative: string,
  content: string,
  expectedRevision: string
): ReturnType<WorkspaceInspectorApi['write']> {
  try {
    if (
      typeof content !== 'string' ||
      typeof expectedRevision !== 'string' ||
      !/^[a-f0-9]{64}$/.test(expectedRevision)
    )
      throw new InspectionError('unsafe')
    const bytes = Buffer.from(content, 'utf8')
    if (bytes.length > FILE_LIMIT) throw new InspectionError('tooLarge')
    if (text(bytes) !== content) throw new InspectionError('binary')
    const root = rootFor(sessionId, rootId)
    const filename = await safePath(root, relative)
    const previous = saves.get(filename)
    const save = (async () => {
      await previous?.catch(() => {})
      // Serialize our own writers and revalidate after waiting. External local writers
      // can still race this check; this is optimistic conflict detection, not a sandbox.
      if (rootFor(sessionId, rootId) !== root || (await safePath(root, relative)) !== filename)
        throw new InspectionError('unsafe')
      if (!(await fs.lstat(filename)).isFile()) throw new InspectionError('unsafe')
      const handle = await fs.open(filename, 'r+')
      try {
        // Editing a hard link could modify a file outside this session's root.
        if ((await handle.stat()).nlink !== 1) throw new InspectionError('unsafe')
        if (revision(await readHandle(handle)) !== expectedRevision)
          return { ok: false, reason: 'changed' } as const
        let offset = 0
        while (offset < bytes.length) {
          const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset)
          if (!bytesWritten) throw new InspectionError('unavailable')
          offset += bytesWritten
        }
        await handle.truncate(bytes.length)
        await handle.sync()
        return { ok: true, revision: revision(content) } as const
      } finally {
        await handle.close()
      }
    })()
    saves.set(filename, save)
    try {
      return await save
    } finally {
      if (saves.get(filename) === save) saves.delete(filename)
    }
  } catch (error) {
    return failure(error)
  }
}

async function headFor(root: string): Promise<string | null> {
  try {
    return (await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])).toString().trim()
  } catch (error) {
    if (error instanceof InspectionError && error.code === 1) return null
    throw error
  }
}

async function inspectRoot(
  root: ReturnType<typeof rootsForSession>[number]
): Promise<WorkspaceRoot> {
  const result: WorkspaceRoot = {
    id: root.id,
    name: root.name,
    branch: null,
    isRepo: false,
    unavailable: false,
    partial: false,
    changes: []
  }
  try {
    await fs.access(root.directory)
    if (!findGitRoot(root.directory)) return result
    result.isRepo = true
    const status = (
      await git(root.directory, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--no-renames',
        '--ignore-submodules=all'
      ])
    )
      .toString('utf8')
      .split('\0')
    const head = await headFor(root.directory)
    result.branch =
      (
        await git(root.directory, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() =>
          Buffer.from('')
        )
      )
        .toString()
        .trim() || null
    const stats = new Map<string, { additions: number | null; deletions: number | null }>()
    if (head) {
      const rows = (
        await git(root.directory, [
          'diff',
          '--numstat',
          '-z',
          '--no-renames',
          '--no-ext-diff',
          '--no-textconv',
          '--ignore-submodules=all',
          head,
          '--'
        ])
      )
        .toString('utf8')
        .split('\0')
      for (const row of rows) {
        const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(row)
        if (match)
          stats.set(match[3], {
            additions: match[1] === '-' ? null : Number(match[1]),
            deletions: match[2] === '-' ? null : Number(match[2])
          })
      }
    }
    const records = new Map<string, string>()
    const replacements = new Set<string>()
    for (const row of status) {
      if (!row) continue
      const file = row.slice(3)
      // A staged deletion followed by an untracked replacement produces two status rows.
      if (records.has(file)) replacements.add(file)
      records.set(file, records.has(file) ? ' M' : row.slice(0, 2))
    }
    let inspectedBytes = 0
    for (const [file, flags] of records) {
      if (result.changes.length >= CHANGE_LIMIT) {
        result.partial = true
        break
      }
      const conflict = flags.includes('U') || flags === 'AA' || flags === 'DD'
      let counts = stats.get(file)
      if (head && replacements.has(file)) {
        counts = { additions: null, deletions: null }
        try {
          const entry = (await git(root.directory, ['ls-tree', '-z', head, '--', file])).toString()
          const match = /^(100644|100755) blob ([a-f0-9]+)\t/.exec(entry)
          if (!match) throw new InspectionError('unsafe')
          const before = text(await git(root.directory, ['cat-file', 'blob', match[2]], FILE_LIMIT))
          const after = await readText(root.directory, file)
          const chunks = diffLines(before, after, { timeout: 100 })
          if (!chunks) throw new InspectionError('tooLarge')
          counts = {
            additions: chunks.reduce((sum, chunk) => sum + (chunk.added ? chunk.count : 0), 0),
            deletions: chunks.reduce((sum, chunk) => sum + (chunk.removed ? chunk.count : 0), 0)
          }
        } catch {
          result.partial = true
        }
      }
      const added = flags === '??' || !head || flags.includes('A')
      if (flags === 'AD' && !counts) counts = { additions: 0, deletions: 0 }
      if (!counts && added) {
        counts = { additions: null, deletions: null }
        try {
          if (inspectedBytes >= 4 * 1024 * 1024) throw new InspectionError('tooLarge')
          const content = await readText(root.directory, file)
          inspectedBytes += Buffer.byteLength(content)
          counts = {
            additions: content ? content.split('\n').length - (content.endsWith('\n') ? 1 : 0) : 0,
            deletions: 0
          }
        } catch (error) {
          if (!(error instanceof InspectionError) || error.reason !== 'binary')
            result.partial = true
        }
      }
      // Staged edits can be cancelled by unstaged edits; retain the file with net zero lines.
      result.changes.push({
        path: file,
        status: conflict
          ? 'conflict'
          : flags[1] === 'D' || flags === 'D '
            ? 'deleted'
            : added
              ? 'added'
              : 'modified',
        ...(counts ?? { additions: 0, deletions: 0 })
      })
    }
  } catch {
    result.unavailable = true
    result.changes = []
  }
  return result
}

const pending = new Map<string, Promise<WorkspaceSnapshot>>()
export function inspectWorkspace(sessionId: string): Promise<WorkspaceSnapshot> {
  const roots = rootsForSession(sessionId)
  const scope = JSON.stringify([sessionId, roots.map((root) => root.id)])
  const existing = pending.get(scope)
  if (existing) return existing
  const request = Promise.all(roots.map(inspectRoot)).then((roots) => ({
    roots
  }))
  pending.set(scope, request)
  void request.then(
    () => pending.delete(scope),
    () => pending.delete(scope)
  )
  return request
}

function failure(error: unknown): {
  ok: false
  reason: 'unavailable' | 'tooLarge' | 'binary' | 'unsafe'
} {
  return { ok: false, reason: error instanceof InspectionError ? error.reason : 'unavailable' }
}

export async function listWorkspace(
  sessionId: string,
  rootId: string,
  relative: string
): Promise<InspectionResult<{ entries: WorkspaceEntry[]; partial: boolean }>> {
  try {
    const directory = await safePath(rootFor(sessionId, rootId), relative)
    const entries: WorkspaceEntry[] = []
    let partial = false
    const handle = await fs.opendir(directory)
    for await (const entry of handle) {
      if (entry.name.toLowerCase() === '.git') continue
      if (entries.length >= DIRECTORY_LIMIT) {
        partial = true
        break
      }
      if (!entry.isFile() && !entry.isDirectory() && !entry.isSymbolicLink()) continue
      entries.push({
        name: entry.name,
        path: relative ? relative + '/' + entry.name : entry.name,
        kind: entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'directory' : 'file'
      })
    }
    entries.sort(
      (a, b) =>
        Number(b.kind === 'directory') - Number(a.kind === 'directory') ||
        a.name.localeCompare(b.name)
    )
    return { ok: true, entries, partial }
  } catch (error) {
    return failure(error)
  }
}

export async function readWorkspace(
  sessionId: string,
  rootId: string,
  relative: string,
  comparison: boolean
): ReturnType<WorkspaceInspectorApi['read']> {
  try {
    const root = rootFor(sessionId, rootId)
    let before = ''
    let after = ''
    if (comparison) {
      const snapshot = await inspectWorkspace(sessionId)
      const change = snapshot.roots
        .find((candidate) => candidate.id === rootId)
        ?.changes.find((candidate) => candidate.path === relative)
      if (!change) throw new InspectionError('unavailable')
      const head = await headFor(root)
      if (head) {
        const entry = (await git(root, ['ls-tree', '-z', head, '--', relative])).toString()
        if (entry) {
          const match = /^(100644|100755) blob ([a-f0-9]+)\t/.exec(entry)
          if (!match) throw new InspectionError('unsafe')
          before = text(await git(root, ['cat-file', 'blob', match[2]], FILE_LIMIT))
        }
      }
      if (change.status !== 'deleted') after = await readText(root, relative)
    } else after = await readText(root, relative)
    return { ok: true, before, after, ...(!comparison ? { revision: revision(after) } : {}) }
  } catch (error) {
    return failure(error)
  }
}
