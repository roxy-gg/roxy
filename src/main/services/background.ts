import { app, BrowserWindow } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { createHash } from 'node:crypto'
import { lock } from 'proper-lockfile'
import {
  DEFAULT_BACKGROUND,
  normalizeBackground,
  type BackgroundResult,
  type BackgroundSettings,
  type BackgroundState,
  type CustomBackground
} from '../../shared/background'

const MAX_BYTES = 25 * 1024 * 1024
const MAX_PIXELS = 40_000_000
const MAX_FRAMES = 80
const MAX_DATA_URL = Math.ceil(MAX_BYTES / 3) * 4 + 32
const filename = (): string => path.join(app.getPath('userData'), 'chat-background.json')
const libraryDirectory = (): string => path.join(app.getPath('userData'), 'chat-backgrounds')
const validCustomId = (id: unknown): id is string =>
  typeof id === 'string' && /^[a-f0-9]{64}$/.test(id)
const validCatalogId = (id: unknown): id is string =>
  typeof id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)
type StoredBackground = BackgroundState & { library?: CustomBackground[]; librarySchema?: 1 }
let cached: Promise<StoredBackground> | undefined
let pending: Promise<unknown> = Promise.resolve()
let imageRevision = 0
let resetGeneration = 0

function storageTransaction<T>(operation: () => Promise<T>): Promise<T> {
  const work = pending.then(async () => {
    await fs.mkdir(app.getPath('userData'), { recursive: true })
    const release = await lock(filename(), {
      realpath: false,
      stale: 30000,
      retries: { retries: 20, minTimeout: 25, maxTimeout: 200 }
    })
    try {
      cached = undefined
      return await operation()
    } finally {
      await release()
    }
  })
  pending = work.catch(() => {})
  return work
}

export function backgroundGeneration(): number {
  return resetGeneration
}
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

async function getStoredBackground(): Promise<StoredBackground> {
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
      const library: CustomBackground[] = Array.isArray(data.library)
        ? data.library
            .filter(
              (entry: CustomBackground) =>
                entry &&
                validCustomId(entry.id) &&
                typeof entry.title === 'string' &&
                entry.title.length <= 100 &&
                !/[\x00-\x1f\x7f]/.test(entry.title) &&
                ['image', 'video'].includes(entry.kind) &&
                Number.isSafeInteger(entry.bytes) &&
                entry.bytes > 0 &&
                entry.bytes <= MAX_DATA_URL * 2 &&
                Number.isSafeInteger(entry.createdAt) &&
                typeof entry.thumbnail === 'string' &&
                entry.thumbnail.length <= 350000 &&
                /^data:image\/webp;base64,[A-Za-z0-9+/=]+$/.test(entry.thumbnail) &&
                (!entry.submissionId || validCatalogId(entry.submissionId)) &&
                (!entry.submissionIds ||
                  (Array.isArray(entry.submissionIds) &&
                    entry.submissionIds.length <= 10 &&
                    entry.submissionIds.every(validCatalogId))) &&
                (!entry.publishedId ||
                  [entry.submissionId, ...(entry.submissionIds ?? [])].includes(entry.publishedId))
            )
            .slice(0, 50)
        : []
      const state: StoredBackground = {
        settings: normalizeBackground(data.settings),
        image,
        ...(poster ? { poster } : {}),
        ...(image &&
        typeof data.catalogId === 'string' &&
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(data.catalogId)
          ? { catalogId: data.catalogId }
          : {}),
        ...(validCustomId(data.customId) &&
        library.some((entry) => entry.id === data.customId) &&
        image &&
        !data.catalogId
          ? { customId: data.customId }
          : {}),
        library,
        librarySchema: 1,
        libraryVersion: Number.isSafeInteger(data.libraryVersion) ? data.libraryVersion : 0
      }
      // Preserve the currently saved local upload when upgrading from single-background storage.
      if (image && !state.catalogId && data.librarySchema !== 1) {
        try {
          const entry = await retainCustomBackground(state, image, poster, '')
          const migrated = { ...state, library: [entry], customId: entry.id, libraryVersion: 1 }
          await fs.writeFile(`${filename()}.tmp`, JSON.stringify(migrated), { mode: 0o600 })
          await fs.rename(`${filename()}.tmp`, filename())
          return migrated
        } catch {
          // A failed migration must never prevent clearing/replacing an older background.
          await fs.rm(`${filename()}.tmp`, { force: true }).catch(() => {})
          delete state.librarySchema
        }
      }
      return state
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

function publicState(state: StoredBackground): BackgroundState {
  const { library, librarySchema: _schema, libraryVersion, ...active } = state
  return {
    ...active,
    ...(libraryVersion ? { libraryVersion } : {}),
    ...(state.customId
      ? { customPublished: !!library?.find((entry) => entry.id === state.customId)?.publishedId }
      : {})
  }
}

export async function getBackground(): Promise<BackgroundState> {
  return storageTransaction(async () => publicState(await getStoredBackground()))
}

async function retainCustomBackground(
  state: StoredBackground,
  image: string,
  poster: string | undefined,
  title: string
): Promise<CustomBackground> {
  const id = createHash('sha256').update(image).digest('hex')
  const existing = state.library?.find((entry) => entry.id === id)
  const bytes = Buffer.byteLength(image) + Buffer.byteLength(poster ?? '')
  if (
    !existing &&
    ((state.library?.length ?? 0) >= 50 ||
      (state.library ?? []).reduce((total, entry) => total + entry.bytes, bytes) >
        350 * 1024 * 1024)
  )
    throw new Error('libraryFull')
  const thumbnail = await sharp(Buffer.from((poster ?? image).split(',')[1], 'base64'), {
    limitInputPixels: MAX_PIXELS
  })
    .resize({ width: 480, height: 270, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 75 })
    .toBuffer()
  if (thumbnail.length > 256 * 1024) throw Error('Invalid thumbnail')
  const entry: CustomBackground = {
    id,
    title,
    kind: image.startsWith('data:video/') ? 'video' : 'image',
    createdAt: Date.now(),
    ...existing,
    thumbnail: `data:image/webp;base64,${thumbnail.toString('base64')}`,
    bytes
  }
  await fs.mkdir(libraryDirectory(), { recursive: true })
  const file = path.join(libraryDirectory(), `${id}.json`)
  try {
    await fs.writeFile(`${file}.tmp`, JSON.stringify({ image, poster }), { mode: 0o600 })
    await fs.rename(`${file}.tmp`, file)
  } finally {
    await fs.rm(`${file}.tmp`, { force: true }).catch(() => {})
  }
  return entry
}

/** Serialize writes across windows and atomically replace the last good image. */
function changeBackground(
  change: (state: StoredBackground) => StoredBackground | null | Promise<StoredBackground | null>
): Promise<BackgroundResult> {
  return storageTransaction(async (): Promise<BackgroundResult> => {
    const file = filename()
    let previous: StoredBackground | undefined
    try {
      previous = await getStoredBackground()
      const state = await change(previous)
      // A superseded import must not recreate storage after a removal/reset.
      if (!state) return { ok: true, state: publicState(previous) }
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(`${file}.tmp`, JSON.stringify(state), { mode: 0o600 })
      await fs.rename(`${file}.tmp`, file)
      cached = Promise.resolve(state)
      if (previous.catalogId !== state.catalogId || previous.image !== state.image) changed()
      return { ok: true, state: publicState(state) }
    } catch (error) {
      await fs.rm(`${file}.tmp`, { force: true }).catch(() => undefined)
      return {
        ok: false,
        error:
          error instanceof Error && error.message === 'libraryFull' ? 'libraryFull' : 'saveFailed'
      }
    } finally {
      // Reconcile unreferenced assets after failed commits, superseded imports, and deletion.
      if (previous) {
        const current = await cached?.catch(() => undefined)
        if (current) {
          const names = await fs.readdir(libraryDirectory()).catch(() => [] as string[])
          for (const name of names) {
            if (
              /^[a-f0-9]{64}\.json(?:\.tmp)?$/.test(name) &&
              (!current.library?.some((entry) => `${entry.id}.json` === name) ||
                name.endsWith('.tmp'))
            )
              await fs.rm(path.join(libraryDirectory(), name), { force: true }).catch(() => {})
          }
        }
      }
    }
  }).catch(() => ({ ok: false, error: 'saveFailed' }))
}

export function updateBackground(settings: Partial<BackgroundSettings>): Promise<BackgroundResult> {
  return changeBackground((state) => ({
    ...state,
    settings: normalizeBackground({ ...state.settings, ...settings })
  }))
}

export function removeBackground(): Promise<BackgroundResult> {
  imageRevision++
  return changeBackground(
    ({ poster: _poster, catalogId: _catalog, customId: _custom, ...state }) => ({
      ...state,
      image: null
    })
  )
}

export async function listCustomBackgrounds(): Promise<CustomBackground[]> {
  return storageTransaction(async () => (await getStoredBackground()).library ?? [])
}

export async function applyCustomBackground(id: string): Promise<BackgroundResult> {
  if (!validCustomId(id)) return { ok: false, error: 'readFailed' }
  const revision = reserveBackgroundImport()
  return changeBackground(async (state) => {
    if (!state.library?.some((entry) => entry.id === id)) throw Error('Missing background')
    const media = await readCustomAsset(id)
    if (!isCurrentBackgroundImport(revision)) return null
    const { catalogId: _catalog, poster: _poster, ...previous } = state
    return {
      ...previous,
      image: media.image,
      ...(media.poster ? { poster: media.poster } : {}),
      customId: id
    }
  })
}

async function readCustomAsset(id: string): Promise<{ image: string; poster?: string }> {
  const file = path.join(libraryDirectory(), `${id}.json`)
  if ((await fs.stat(file)).size > MAX_DATA_URL * 2 + 100) throw Error('Invalid asset')
  const media = JSON.parse(await fs.readFile(file, 'utf8'))
  if (
    typeof media.image !== 'string' ||
    media.image.length > MAX_DATA_URL ||
    createHash('sha256').update(media.image).digest('hex') !== id ||
    !/^data:(?:image\/(?:png|gif)|video\/mp4);base64,[A-Za-z0-9+/=]+$/.test(media.image) ||
    (media.poster !== undefined &&
      (typeof media.poster !== 'string' ||
        media.poster.length > MAX_DATA_URL ||
        !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(media.poster)))
  )
    throw Error('Invalid asset')
  return media
}

export function getCustomSubmission(
  id: string
): Promise<{ entry: CustomBackground; image: string }> {
  return storageTransaction(async () => {
    if (!validCustomId(id)) throw Error('Invalid background')
    const entry = (await getStoredBackground()).library?.find((entry) => entry.id === id)
    if (!entry || entry.publishedId) throw Error('Background cannot be submitted')
    const media = await readCustomAsset(id)
    return { entry, image: media.image }
  })
}

export async function deleteCustomBackground(id: string): Promise<BackgroundResult> {
  if (!validCustomId(id)) return { ok: false, error: 'readFailed' }
  const result = await changeBackground((state) => {
    if (!state.library?.some((entry) => entry.id === id)) throw Error('Missing background')
    const { customId, poster, ...previous } = state
    return {
      ...previous,
      ...(customId === id ? { image: null } : { customId, poster }),
      library: state.library.filter((entry) => entry.id !== id),
      libraryVersion: (state.libraryVersion ?? 0) + 1
    }
  })
  return result
}

export function renameCustomBackground(id: string, title: string): Promise<BackgroundResult> {
  if (
    !validCustomId(id) ||
    typeof title !== 'string' ||
    !title.trim() ||
    title.length > 100 ||
    /[\x00-\x1f\x7f]/.test(title)
  )
    return Promise.resolve({ ok: false, error: 'readFailed' })
  return changeBackground((state) => {
    if (!state.library?.some((entry) => entry.id === id)) throw Error('Missing background')
    return {
      ...state,
      library: state.library.map((entry) =>
        entry.id === id ? { ...entry, title: title.trim() } : entry
      ),
      libraryVersion: (state.libraryVersion ?? 0) + 1
    }
  })
}

export function recordBackgroundSubmission(
  id: string,
  submissionId: string,
  title: string,
  generation = resetGeneration
): Promise<BackgroundResult> {
  return changeBackground((state) =>
    generation !== resetGeneration || !state.library?.some((entry) => entry.id === id)
      ? null
      : {
          ...state,
          library: state.library?.map((entry) =>
            entry.id === id
              ? {
                  ...entry,
                  title: entry.title || title.trim(),
                  submissionId,
                  submissionIds: [
                    ...new Set([
                      ...(entry.submissionIds ?? (entry.submissionId ? [entry.submissionId] : [])),
                      submissionId
                    ])
                  ].slice(0, 10)
                }
              : entry
          ),
          libraryVersion: (state.libraryVersion ?? 0) + 1
        }
  )
}

let publicationWork: Promise<BackgroundResult | null> | undefined
let publicationChecked = 0
export function refreshCustomPublications(
  check: (id: string) => Promise<boolean>
): Promise<BackgroundResult | null> {
  if (publicationWork) return publicationWork
  if (Date.now() - publicationChecked < 60000) return Promise.resolve(null)
  publicationChecked = Date.now()
  const generation = resetGeneration
  const work = (async () => {
    const entries = (await listCustomBackgrounds()).filter((entry) => entry.submissionId)
    const updates = new Map<string, { submissionId: string; publishedId?: string }>()
    // Failed/offline lookups retain the last known state; only an authoritative 404 unpublishes.
    for (let offset = 0; offset < entries.length; offset += 3)
      await Promise.all(
        entries.slice(offset, offset + 3).map(async (entry) => {
          try {
            let publishedId: string | undefined
            for (const id of entry.submissionIds ?? [entry.submissionId!]) {
              if (await check(id)) {
                publishedId = id
                break
              }
            }
            if (publishedId !== entry.publishedId)
              updates.set(entry.id, { submissionId: entry.submissionId!, publishedId })
          } catch {
            /* Publication checks never prevent local library access. */
          }
        })
      )
    if (!updates.size || generation !== resetGeneration) return null
    return changeBackground((state) =>
      generation !== resetGeneration || !state.library?.some((entry) => updates.has(entry.id))
        ? null
        : {
            ...state,
            library: state.library?.map((entry) => {
              const update = updates.get(entry.id)
              return update && update.submissionId === entry.submissionId
                ? { ...entry, publishedId: update.publishedId }
                : entry
            }),
            libraryVersion: (state.libraryVersion ?? 0) + 1
          }
    )
  })().finally(() => {
    if (publicationWork === work) publicationWork = undefined
  })
  publicationWork = work
  return work
}

export function resetBackground(): Promise<void> {
  imageRevision++
  resetGeneration++
  publicationWork = undefined
  return storageTransaction(async () => {
    const file = filename()
    await Promise.all([
      fs.rm(file, { force: true }),
      fs.rm(`${file}.tmp`, { force: true }),
      fs.rm(libraryDirectory(), { recursive: true, force: true })
    ])
    cached = undefined
    publicationChecked = 0
    changed()
  })
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
        const capture = () => {
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
        video.onloadeddata = () => {
          if (!Number.isFinite(video.duration) || video.duration <= 0) {
            clearTimeout(timer); reject(new Error('invalid duration')); return;
          }
          video.onloadeddata = null;
          video.onseeked = capture;
          // Opening frames can be blank; capture a decoded frame inside the clip.
          video.currentTime = Math.min(1, video.duration / 2);
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
    return commitImport()
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
  return commitImport()

  function commitImport(): Promise<BackgroundResult> {
    return changeBackground(async (state) => {
      if (revision !== imageRevision) return null
      const { customId: _custom, catalogId: _catalog, poster: _poster, ...previous } = state
      const entry = catalogId
        ? undefined
        : await retainCustomBackground(
            state,
            image,
            poster,
            path
              .basename(file, path.extname(file))
              .replace(/[\x00-\x1f\x7f]/g, '')
              .slice(0, 100)
          )
      if (revision !== imageRevision) return null
      return {
        ...previous,
        image,
        ...(poster ? { poster } : {}),
        ...(catalogId ? { catalogId } : { customId: entry!.id }),
        library: entry
          ? [entry, ...(state.library ?? []).filter((item) => item.id !== entry.id)]
          : state.library,
        librarySchema: 1,
        libraryVersion: (state.libraryVersion ?? 0) + (entry ? 1 : 0)
      }
    })
  }
}
