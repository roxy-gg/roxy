import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { lock } from 'proper-lockfile'
import { validWallpaperId } from './wallpapers'

/** One durable anonymous ID, unrelated to telemetry, with coalesced latest-state reporting. */
export function startWallpaperUsage(options: {
  directory: string
  current: () => Promise<string | null>
  subscribe: (listener: () => void) => () => void
  report: (deviceId: string, wallpaperId: string | null, sequence: number) => Promise<void>
  heartbeatMs?: number
  retryMs?: number
}): () => void {
  const file = path.join(options.directory, 'wallpaper-device.json')
  let stopped = false,
    running = false,
    dirty = false
  let retry: ReturnType<typeof setTimeout> | undefined
  const flush = async (): Promise<void> => {
    if (running || stopped) return
    running = true
    let failed = false
    let release: (() => Promise<void>) | undefined
    try {
      await fs.mkdir(options.directory, { recursive: true })
      // Share identity/sequence safely when multiple app processes use the same profile.
      release = await lock(file, { realpath: false, stale: 30_000, retries: 0 })
      while (dirty && !stopped) {
        dirty = false
        const wallpaperId = await options.current()
        let identity: { deviceId: string; sequence: number }
        try {
          const data = JSON.parse(await fs.readFile(file, 'utf8'))
          if (
            !data ||
            !validWallpaperId(data.deviceId) ||
            !Number.isSafeInteger(data.sequence) ||
            data.sequence < 0 ||
            data.sequence >= Number.MAX_SAFE_INTEGER - 1
          )
            throw new SyntaxError('Invalid wallpaper identity')
          identity = { deviceId: data.deviceId, sequence: data.sequence }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError))
            throw error
          if (error instanceof SyntaxError) await fs.rm(file, { force: true })
          if (!wallpaperId) continue
          identity = { deviceId: randomUUID(), sequence: 0 }
        }
        identity.sequence = Math.max(identity.sequence + 1, Date.now())
        await fs.mkdir(options.directory, { recursive: true })
        const temporary = `${file}.${randomUUID()}.tmp`
        try {
          await fs.writeFile(temporary, JSON.stringify(identity), { mode: 0o600 })
          await fs.rename(temporary, file)
        } finally {
          await fs.rm(temporary, { force: true }).catch(() => {})
        }
        if (!stopped) await options.report(identity.deviceId, wallpaperId, identity.sequence)
      }
    } catch {
      dirty = true
      failed = true
    } finally {
      await release?.().catch(() => {})
      running = false
      if (dirty && !stopped) {
        clearTimeout(retry)
        retry = setTimeout(
          () => {
            void flush()
          },
          failed ? (options.retryMs ?? 60_000) : 0
        )
        retry.unref()
      }
    }
  }
  const wake = (): void => {
    dirty = true
    clearTimeout(retry)
    void flush()
  }
  const off = options.subscribe(wake)
  const heartbeat = setInterval(wake, options.heartbeatMs ?? 3600_000)
  heartbeat.unref()
  wake()
  return () => {
    stopped = true
    off()
    clearTimeout(retry)
    clearInterval(heartbeat)
  }
}
