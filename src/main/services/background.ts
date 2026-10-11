import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import {
  DEFAULT_BACKGROUND,
  normalizeBackground,
  type BackgroundResult,
  type BackgroundSettings,
  type BackgroundState
} from '../../shared/background'

const MAX_BYTES = 25 * 1024 * 1024
const MAX_PIXELS = 40_000_000
const filename = (): string => path.join(app.getPath('userData'), 'chat-background.json')
let cached: Promise<BackgroundState> | undefined
let pending: Promise<unknown> = Promise.resolve()
let imageRevision = 0

export function getBackground(): Promise<BackgroundState> {
  cached ??= (async () => {
    try {
      const source = await fs.readFile(filename(), 'utf8')
      const data = JSON.parse(source)
      if (!data || typeof data !== 'object')
        return { settings: { ...DEFAULT_BACKGROUND }, image: null }
      return {
        settings: normalizeBackground(data.settings),
        image:
          typeof data.image === 'string' &&
          data.image.length <= MAX_BYTES &&
          /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(data.image)
            ? data.image
            : null
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError))
        throw error
      return { settings: { ...DEFAULT_BACKGROUND }, image: null }
    }
  })()
  return cached.catch((error) => {
    cached = undefined
    throw error
  })
}

/** Serialize writes across windows and atomically replace the last good image. */
function changeBackground(
  change: (state: BackgroundState) => BackgroundState | null
): Promise<BackgroundResult> {
  const work = pending.then(async (): Promise<BackgroundResult> => {
    const file = filename()
    try {
      const previous = await getBackground()
      const state = change(previous)
      // A superseded import must not recreate storage after a removal/reset.
      if (!state) return { ok: true, state: previous }
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(`${file}.tmp`, JSON.stringify(state), { mode: 0o600 })
      await fs.rename(`${file}.tmp`, file)
      cached = Promise.resolve(state)
      return { ok: true, state }
    } catch {
      await fs.rm(`${file}.tmp`, { force: true }).catch(() => undefined)
      return { ok: false, error: 'saveFailed' }
    }
  })
  pending = work
  return work
}

export function updateBackground(settings: Partial<BackgroundSettings>): Promise<BackgroundResult> {
  return changeBackground((state) => ({
    ...state,
    settings: normalizeBackground({ ...state.settings, ...settings })
  }))
}

export function removeBackground(): Promise<BackgroundResult> {
  imageRevision++
  return changeBackground((state) => ({ ...state, image: null }))
}

export function resetBackground(): Promise<void> {
  imageRevision++
  const work = pending.then(async () => {
    const file = filename()
    await Promise.all([fs.rm(file, { force: true }), fs.rm(`${file}.tmp`, { force: true })])
    cached = undefined
  })
  pending = work.catch(() => undefined)
  return work
}

/** Only called with a path returned by the native picker, never renderer input. */
export async function importBackground(file: string): Promise<BackgroundResult> {
  const revision = ++imageRevision
  let bytes: Buffer
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile()) return { ok: false, error: 'invalidImage' }
    if (stat.size > MAX_BYTES) return { ok: false, error: 'tooLarge' }
    bytes = await fs.readFile(file)
    if (bytes.length > MAX_BYTES) return { ok: false, error: 'tooLarge' }
  } catch {
    return { ok: false, error: 'readFailed' }
  }
  let image: string
  try {
    const source = sharp(bytes, { limitInputPixels: MAX_PIXELS, animated: false })
    const meta = await source.metadata()
    if (!meta.format || !['png', 'jpeg', 'webp', 'gif'].includes(meta.format))
      return { ok: false, error: 'invalidImage' }
    // Bounded, static and metadata-free. SVGs and remote URLs never reach the renderer.
    const png = await source
      .rotate()
      .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer()
    image = `data:image/png;base64,${png.toString('base64')}`
  } catch {
    return { ok: false, error: 'invalidImage' }
  }
  return changeBackground((state) => (revision === imageRevision ? { ...state, image } : null))
}
