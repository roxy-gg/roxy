import { app } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const cheatSupported = (): boolean => process.platform === 'win32' && process.arch === 'x64'
const dllWork = new Set<string>()

export function executeMemory(
  input: Record<string, unknown>,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  signal?.throwIfAborted()
  if (!cheatSupported()) throw new Error('Windows x64 is required for memory inspection.')
  const loading = input.operation === 'load_dll'
  const targetKey = JSON.stringify([input.pid, input.identity])
  if (loading && dllWork.has(targetKey))
    throw new Error(
      'A dispatched DLL operation still owns this process. Wait for completion or target exit; do not retry.'
    )
  const resource = join(__dirname, '../../resources/cheat-memory.ps1')
  const script = app.isPackaged
    ? join(process.resourcesPath, 'app.asar.unpacked/resources/cheat-memory.ps1')
    : existsSync(resource)
      ? resource
      : join(app.getAppPath(), 'resources/cheat-memory.ps1')
  return new Promise((resolve, reject) => {
    const child = spawn(
      join(
        process.env.SystemRoot || 'C:\\Windows',
        'System32/WindowsPowerShell/v1.0/powershell.exe'
      ),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
    )
    let stdout = ''
    let stderr = ''
    let failure: Error | undefined
    let settled = false
    if (loading) dllWork.add(targetKey)
    const uncertain = (reason: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      child.unref()
      ;(child.stdout as NodeJS.ReadableStream & { unref?: () => void }).unref?.()
      ;(child.stderr as NodeJS.ReadableStream & { unref?: () => void }).unref?.()
      resolve({
        status: 'unknown',
        dispatchPossible: true,
        rollback: false,
        path: input.path,
        sha256: input.sha256,
        limitation:
          reason +
          ' DLL work may already have executed, may still dispatch, or may still be running. Helper retains its file/process/thread resources until completion or target exit. No unload, rollback or automatic retry.'
      })
    }
    const stop = (reason: Error): void => {
      if (loading) {
        uncertain(reason.message)
        return
      }
      failure ??= reason
      child.kill()
      if (!settled) {
        settled = true
        cleanup()
        reject(failure)
      }
    }
    const cancel = (): void =>
      stop(
        new Error(
          'Operation cancelled; a dispatched write may already have committed. No rollback is implied.'
        )
      )
    const timer = setTimeout(
      () =>
        stop(
          new Error(
            'Memory helper exceeded its 30 second deadline. A dispatched mutation may already have executed.'
          )
        ),
      30_000
    )
    signal?.addEventListener('abort', cancel, { once: true })
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      if (loading && !settled && stdout.includes('\n')) {
        try {
          const early = JSON.parse(stdout.slice(0, stdout.indexOf('\n')))
          if (early.status === 'unknown') uncertain(String(early.limitation))
        } catch {
          /* Wait for a complete helper record or exit. */
        }
      }
      if (Buffer.byteLength(stdout) > 2 * 1024 * 1024)
        stop(new Error('Memory result exceeded 2 MiB.'))
      if (settled && loading) stdout = stdout.slice(-4000)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000)
    })
    child.stdin.on('error', () => {})
    const cleanup = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
    }
    child.once('error', (error) => {
      cleanup()
      if (loading) dllWork.delete(targetKey)
      if (!settled) {
        settled = true
        reject(failure ?? error)
      }
    })
    child.once('close', (code) => {
      cleanup()
      if (loading) dllWork.delete(targetKey)
      if (settled) return
      settled = true
      if (failure || code !== 0)
        return reject(failure ?? new Error(stderr || `Memory helper exited ${code}`))
      try {
        resolve(JSON.parse(stdout))
      } catch {
        reject(new Error('Invalid memory helper response'))
      }
    })
    child.stdin.end(JSON.stringify(input))
    if (signal?.aborted) cancel()
  })
}
