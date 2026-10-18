import { app, BrowserWindow } from 'electron'
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
const MAX_FRAMES = 80
const MAX_DATA_URL = Math.ceil(MAX_BYTES / 3) * 4 + 32
const filename = (): string => path.join(app.getPath('userData'), 'chat-background.json')
let cached: Promise<BackgroundState> | undefined
let pending: Promise<unknown> = Promise.resolve()
let imageRevision = 0
const listeners = new Set<() => void>()
export function subscribeBackgroundChanges(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
const changed = (): void => {
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      /* Usage observers cannot break a saved background. */
    }
  }
}

/** Read the committed file for cross-process usage reconciliation, not a window's cached state. */
export async function getBackgroundCatalogId(): Promise<string | null> {
  try {
    const data = JSON.parse(await fs.readFile(filename(), 'utf8'))
    return data &&
      typeof data.image === 'string' &&
      data.image.length <= MAX_DATA_URL &&
      /^data:(?:image\/(?:png|gif)|video\/mp4);base64,[A-Za-z0-9+/=]+$/.test(data.image) &&
      typeof data.catalogId === 'string' &&
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(data.catalogId)
      ? data.catalogId
      : null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError)
      return null
    throw error
  }
}

export function getBackground(): Promise<BackgroundState> {
  cached ??= (async () => {
    try {
      const source = await fs.readFile(filename(), 'utf8')
      const data = JSON.parse(source)
      if (!data || typeof data !== 'object')
        return { settings: { ...DEFAULT_BACKGROUND }, image: null }
      let poster: string | undefined
      if (
        typeof data.poster === 'string' &&
        data.poster.length <= MAX_DATA_URL &&
        /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(data.poster)
      ) {
        try {
          const decoded = sharp(Buffer.from(data.poster.split(',')[1], 'base64'), {
            limitInputPixels: MAX_PIXELS
          })
          const meta = await decoded.metadata()
          if (meta.format === 'png') {
            await decoded.raw().toBuffer()
            poster = data.poster
          }
        } catch {
          /* Ignore a damaged still frame. */
        }
      }
      // Existing GIF backgrounds may predate stored reduced-motion frames.
      if (
        !poster &&
        typeof data.image === 'string' &&
        data.image.length <= MAX_DATA_URL &&
        /^data:image\/gif;base64,[A-Za-z0-9+/=]+$/.test(data.image)
      ) {
        try {
          const png = await sharp(Buffer.from(data.image.split(',')[1], 'base64'), {
            limitInputPixels: MAX_PIXELS,
            animated: false
          })
            .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
            .png()
            .toBuffer()
          if (png.length <= MAX_BYTES) poster = `data:image/png;base64,${png.toString('base64')}`
        } catch {
          /* A damaged GIF must not animate under reduced motion. */
        }
      }
      const image =
        typeof data.image === 'string' &&
        data.image.length <= MAX_DATA_URL &&
        /^data:(?:image\/(?:png|gif)|video\/mp4);base64,[A-Za-z0-9+/=]+$/.test(data.image) &&
        (!data.image.startsWith('data:video/') || !!poster) &&
        (!data.image.startsWith('data:image/gif;') || !!poster)
          ? data.image
          : null
      return {
        settings: normalizeBackground(data.settings),
        image,
        ...(poster ? { poster } : {}),
        ...(image &&
        typeof data.catalogId === 'string' &&
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(data.catalogId)
          ? { catalogId: data.catalogId }
          : {})
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
      if (previous.catalogId !== state.catalogId || previous.image !== state.image) changed()
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
  return changeBackground((state) => ({ settings: state.settings, image: null }))
}

export function resetBackground(): Promise<void> {
  imageRevision++
  const work = pending.then(async () => {
    const file = filename()
    await Promise.all([fs.rm(file, { force: true }), fs.rm(`${file}.tmp`, { force: true })])
    cached = undefined
    changed()
  })
  pending = work.catch(() => undefined)
  return work
}

export function reserveBackgroundImport(): number {
  return ++imageRevision
}
export function isCurrentBackgroundImport(revision: number): boolean {
  return revision === imageRevision
}

/** Only called with a trusted picker path or main-created catalog temporary file. */
export async function importBackground(
  file: string,
  owner?: BrowserWindow,
  revision = reserveBackgroundImport(),
  catalogId?: string
): Promise<BackgroundResult> {
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
  let poster: string | undefined
  if (['.mp4', '.mov'].includes(path.extname(file).toLowerCase())) {
    const decoder = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        partition: 'background-decoder'
      }
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    let rejectDecode: (error: Error) => void = () => {}
    const interrupted = new Promise<never>((_resolve, reject) => {
      rejectDecode = reject
      timer = setTimeout(() => reject(new Error('decode timeout')), 15000)
    })
    const abort = (): void => rejectDecode(new Error('decoder unavailable'))
    decoder.webContents.once('render-process-gone', abort)
    decoder.once('closed', abort)
    owner?.once('closed', abort)
    if (owner?.isDestroyed()) abort()
    try {
      image = `data:video/mp4;base64,${bytes.toString('base64')}`
      await Promise.race([
        decoder.loadURL(
          'data:text/html,' +
            encodeURIComponent(
              '<meta http-equiv="Content-Security-Policy" content="default-src none; media-src data:; img-src data:"><video muted></video>'
            )
        ),
        interrupted
      ])
      poster = await Promise.race([
        decoder.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const video = document.querySelector('video');
        const timer = setTimeout(() => reject(new Error('decode timeout')), 15000);
        video.onerror = () => { clearTimeout(timer); reject(new Error('unsupported video')); };
        video.onloadeddata = () => {
          try {
            if (!video.videoWidth || !video.videoHeight || video.videoWidth * video.videoHeight > ${MAX_PIXELS} || !Number.isFinite(video.duration)) throw new Error('invalid dimensions');
            const scale = Math.min(1, 2048 / Math.max(video.videoWidth, video.videoHeight));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
            canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
            canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
            clearTimeout(timer); resolve(canvas.toDataURL('image/png'));
          } catch (error) { clearTimeout(timer); reject(error); }
        };
        video.src = ${JSON.stringify(image)}; video.load();
      })`),
        interrupted
      ])
      if (!poster || poster.length > MAX_DATA_URL) return { ok: false, error: 'tooLarge' }
    } catch {
      return { ok: false, error: 'invalidVideo' }
    } finally {
      clearTimeout(timer)
      owner?.removeListener('closed', abort)
      decoder.removeListener('closed', abort)
      if (!decoder.isDestroyed()) {
        decoder.webContents.removeListener('render-process-gone', abort)
        decoder.destroy()
      }
    }
    return changeBackground((state) =>
      revision === imageRevision
        ? { settings: state.settings, image, poster, ...(catalogId ? { catalogId } : {}) }
        : null
    )
  }
  try {
    const source = sharp(bytes, { limitInputPixels: MAX_PIXELS, animated: false })
    const meta = await source.metadata()
    if (!meta.format || !['png', 'jpeg', 'webp', 'gif'].includes(meta.format))
      return { ok: false, error: 'invalidImage' }
    if (meta.format === 'gif' && (meta.pages ?? 1) > 1) {
      if (
        (meta.pages ?? 1) > MAX_FRAMES ||
        (meta.width ?? 0) * (meta.height ?? 0) * (meta.pages ?? 1) > MAX_PIXELS
      )
        return { ok: false, error: 'tooLarge' }
      const gif = await sharp(bytes, { limitInputPixels: MAX_PIXELS, animated: true })
        .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
        .gif({ loop: 0 })
        .toBuffer()
      if (gif.length > MAX_BYTES) return { ok: false, error: 'tooLarge' }
      image = `data:image/gif;base64,${gif.toString('base64')}`
      poster = `data:image/png;base64,${(await source.resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).png().toBuffer()).toString('base64')}`
    } else {
      // Static images are bounded and metadata-free. SVGs and remote URLs never reach the renderer.
      const png = await source
        .rotate()
        .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
        .png()
        .toBuffer()
      if (png.length > MAX_BYTES) return { ok: false, error: 'tooLarge' }
      image = `data:image/png;base64,${png.toString('base64')}`
    }
  } catch {
    return { ok: false, error: 'invalidImage' }
  }
  return changeBackground((state) =>
    revision === imageRevision
      ? {
          settings: state.settings,
          image,
          ...(poster ? { poster } : {}),
          ...(catalogId ? { catalogId } : {})
        }
      : null
  )
}
