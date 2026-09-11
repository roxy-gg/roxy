/** Integration tests for durable per-session review baselines. */
import { app } from 'electron'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getDb } from '../src/main/db/database'
import * as repo from '../src/main/db/repo'
import * as git from '../src/main/services/git'
import {
  deleteSessionReviewBaselines,
  ensureSessionReviewBaselines,
  sessionReviewDiff,
  sessionReviewFiles
} from '../src/main/services/session-review'

let failed = 0

function check(condition: unknown, label: string): void {
  if (condition) console.log(`PASS: ${label}`)
  else {
    failed++
    console.error(`FAIL: ${label}`)
  }
}

async function command(cwd: string, ...args: string[]): Promise<string> {
  const result = await git.git(args, cwd)
  if (!result.ok) throw new Error(result.stderr || `git ${args.join(' ')} failed`)
  return result.stdout.trim()
}

async function write(cwd: string, file: string, content: string): Promise<void> {
  const target = path.join(cwd, file)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, content)
}

async function main(): Promise<void> {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'roxy-session-review-db-'))
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'roxy-session-review-repo-'))
  app.setPath('userData', userData)
  try {
    await command(cwd, 'init')
    await command(cwd, 'config', 'user.email', 'review@example.com')
    await command(cwd, 'config', 'user.name', 'Review Test')
    await write(cwd, 'existing.txt', 'before\n')
    await command(cwd, 'add', '.')
    await command(cwd, 'commit', '-m', 'base')

    const chat = repo.createChat({ title: 'Session review', workspacePath: cwd })
    await ensureSessionReviewBaselines(chat.id, [{ key: cwd, cwd }])
    await write(cwd, 'existing.txt', 'after\n')
    await write(cwd, 'new.txt', 'new\n')

    const files = await sessionReviewFiles(chat.id, [{ key: cwd, cwd }])
    check(files.length === 2, 'service returns changes since the session baseline')
    check(
      files.some((file) => file.path === 'new.txt'),
      'service includes added files'
    )
    const diff = await sessionReviewDiff(chat.id, { key: cwd, cwd }, 'existing.txt')
    check(
      diff?.before === 'before\n' && diff.after === 'after\n',
      'service returns baseline and current contents'
    )

    const baseline = repo.listSessionReviewBaselines(chat.id)[0]
    check(!!baseline, 'baseline metadata is persisted')
    check(
      baseline ? (await command(cwd, 'cat-file', '-t', baseline.baselineRef)) === 'tree' : false,
      'private Git ref keeps the baseline tree alive'
    )

    const sub = repo.createChat({
      title: 'Subagent',
      kind: 'sub',
      parentId: chat.id,
      workspacePath: cwd
    })
    const subFiles = await sessionReviewFiles(sub.id, [{ key: cwd, cwd }])
    check(subFiles.length === files.length, 'subagents use their owning session baseline')

    await deleteSessionReviewBaselines(chat.id)
    check(
      baseline ? !(await git.git(['show-ref', '--verify', baseline.baselineRef], cwd)).ok : false,
      'deleting a session removes its private Git baseline ref'
    )
  } finally {
    getDb().close()
    await fs.rm(cwd, { recursive: true, force: true })
    await fs.rm(userData, { recursive: true, force: true })
  }
  app.exit(failed ? 1 : 0)
}

void main().catch((error) => {
  console.error(error)
  app.exit(1)
})
