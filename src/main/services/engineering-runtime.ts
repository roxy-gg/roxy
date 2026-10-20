import { fork, spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import type { EngineeringSchema } from '../../shared/engineering-tools'

interface Worker {
  child: ChildProcess
  ready: Promise<EngineeringSchema[]>
  pending: Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>
  owned: Map<number, boolean>
  idle?: ReturnType<typeof setTimeout>
  closing?: Promise<void>
}
const workers = new Map<string, Worker>()
const MAX_IDLE = 30 * 60_000
function killTree(worker: Worker): Promise<void> {
  const child = worker.child
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  const pid = child.pid
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      killer.once('error', () => {
        child.kill()
        resolve()
      })
      killer.once('exit', (code) => {
        if (code) child.kill()
        resolve()
      })
    } else {
      for (const [pid, group] of worker.owned) {
        try {
          process.kill(group ? -pid : pid, 'SIGKILL')
        } catch {
          /* Provider already exited. */
        }
      }
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
      resolve()
    }
  })
}
function idle(key: string, worker: Worker): void {
  clearTimeout(worker.idle)
  if (!worker.pending.size && !worker.closing) {
    worker.idle = setTimeout(() => void closeEngineeringSession(key), MAX_IDLE)
    worker.idle.unref()
  }
}
function start(
  key: string,
  node: string,
  packageRoot: string,
  cwd: string,
  env: Record<string, string>
): Worker {
  const existing = workers.get(key)
  if (existing?.closing) throw new Error('Native REA session is closing. Retry on the next turn.')
  if (existing) return existing
  const resource = join(__dirname, '../../resources/engineering-worker.mjs')
  const script = app.isPackaged
    ? join(process.resourcesPath, 'app.asar.unpacked/resources/engineering-worker.mjs')
    : existsSync(resource)
      ? resource
      : join(app.getAppPath(), 'resources/engineering-worker.mjs')
  const child = fork(script, [packageRoot], {
    execPath: node,
    execArgv: [],
    cwd,
    env,
    silent: true,
    detached: process.platform !== 'win32'
  })
  child.stdout?.resume()
  child.stderr?.resume()
  let resolveReady!: (catalog: EngineeringSchema[]) => void
  let rejectReady!: (error: Error) => void
  const worker: Worker = {
    child,
    pending: new Map(),
    owned: new Map(),
    ready: new Promise((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
  }
  workers.set(key, worker)
  idle(key, worker)
  const timeout = setTimeout(() => {
    rejectReady(new Error('Native REA worker startup timed out'))
    void closeEngineeringSession(key)
  }, 30_000)
  const ended = (): void => {
    clearTimeout(timeout)
    clearTimeout(worker.idle)
    if (workers.get(key) === worker) workers.delete(key)
    const error = new Error('Native REA session closed. Reopen the target before continuing.')
    rejectReady(error)
    for (const request of worker.pending.values()) request.reject(error)
    worker.pending.clear()
  }
  child.once('error', ended)
  child.once('exit', ended)
  child.on('message', (message: unknown) => {
    const m = message as {
      kind: string
      id: string
      pid: number
      group: boolean
      catalog: EngineeringSchema[]
      result: unknown
      error?: string
    }
    if (m.kind === 'owned' && Number.isSafeInteger(m.pid) && m.pid > 0)
      worker.owned.set(m.pid, m.group)
    if (m.kind === 'released') worker.owned.delete(m.pid)
    if (m.kind === 'ready') {
      clearTimeout(timeout)
      resolveReady(m.catalog)
    }
    if (m.kind === 'result') {
      const pending = worker.pending.get(m.id)
      worker.pending.delete(m.id)
      if (m.error) pending?.reject(new Error(m.error))
      else pending?.resolve(m.result)
      idle(key, worker)
    }
  })
  return worker
}
export async function engineeringCatalog(
  node: string,
  packageRoot: string,
  cwd: string,
  env: Record<string, string>
): Promise<EngineeringSchema[]> {
  const key = `catalog-${randomUUID()}`
  try {
    return await start(key, node, packageRoot, cwd, env).ready
  } finally {
    await closeEngineeringSession(key)
  }
}
export async function executeEngineering(
  key: string,
  node: string,
  packageRoot: string,
  cwd: string,
  env: Record<string, string>,
  operation: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
  admitted: () => boolean = () => true
): Promise<unknown> {
  signal?.throwIfAborted()
  if (!admitted()) throw new Error('Native REA dispatch is no longer enabled')
  const worker = start(key, node, packageRoot, cwd, env)
  const id = randomUUID()
  let cancelTimer: ReturnType<typeof setTimeout> | undefined
  const cancel = (): void => {
    if (worker.child.connected) worker.child.send({ kind: 'cancel', id }, () => {})
    cancelTimer ??= setTimeout(() => void closeEngineeringSession(key), 3000)
  }
  const deadline = setTimeout(cancel, 10 * 60_000)
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    await worker.ready
    signal?.throwIfAborted()
    if (worker.closing || !admitted())
      throw new Error('Reverse engineering settings changed; retry on the next turn.')
    clearTimeout(worker.idle)
    return await new Promise((resolve, reject) => {
      worker.pending.set(id, { resolve, reject })
      worker.child.send({ kind: 'execute', id, operation, input }, (error) => {
        if (error) {
          worker.pending.delete(id)
          idle(key, worker)
          reject(error)
        }
      })
    })
  } finally {
    clearTimeout(deadline)
    clearTimeout(cancelTimer)
    signal?.removeEventListener('abort', cancel)
    idle(key, worker)
  }
}
export async function closeEngineeringSession(key: string): Promise<void> {
  const worker = workers.get(key)
  if (!worker) return
  worker.closing ??= new Promise<void>((resolve) => {
    clearTimeout(worker.idle)
    let final: ReturnType<typeof setTimeout> | undefined
    const settled = (): void => {
      clearTimeout(timer)
      clearTimeout(final)
      resolve()
    }
    const timer = setTimeout(() => {
      void killTree(worker).finally(() => {
        // Settle requests even if the OS refuses to terminate an elevated child.
        for (const request of worker.pending.values())
          request.reject(
            new Error('Native REA shutdown forced; reopen the target before continuing.')
          )
        worker.pending.clear()
        final = setTimeout(settled, 2000)
      })
    }, 5000)
    worker.child.once('exit', settled)
    worker.child.once('error', settled)
    if (worker.child.exitCode !== null || worker.child.signalCode !== null) settled()
    else if (worker.child.connected) worker.child.send({ kind: 'close' }, () => {})
    else void killTree(worker)
  })
  await worker.closing
  // Retain a still-live owner rather than accepting new work over an orphan.
  if (
    (worker.child.exitCode !== null || worker.child.signalCode !== null) &&
    workers.get(key) === worker
  )
    workers.delete(key)
}
export async function closeEngineeringRuntimes(): Promise<void> {
  await Promise.all([...workers.keys()].map(closeEngineeringSession))
}
