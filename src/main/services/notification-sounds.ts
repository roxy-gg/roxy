import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { getDb } from '../db/database'
import { CHANNELS } from '../../shared/ipc'
import {
  SOUND_MAX_BYTES,
  SOUND_MAX_COUNT,
  SOUND_MIN_SECONDS,
  SOUND_MAX_SECONDS,
  type NotificationSound,
  type NotificationSoundLibrary,
  type NotificationSoundResult
} from '../../shared/notification-sounds'

const KEY = 'notification_sound_library'
const directory = (): string => path.join(app.getPath('userData'), 'notification-sounds')
const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id)
let generation = 0
let pending: Promise<unknown> = Promise.resolve()

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const work = pending.then(operation)
  pending = work.catch(() => {})
  return work
}

export async function importSound(
  file: string,
  owner?: BrowserWindow,
  revision = generation
): Promise<NotificationSoundResult> {
  let bytes: Buffer | undefined
  let format: NotificationSound['format']
  let duration: number
  try {
    bytes = await readBounded(file)
    const ext = path.extname(file).toLowerCase()
    if (
      ext === '.wav' &&
      bytes.toString('ascii', 0, 4) === 'RIFF' &&
      bytes.toString('ascii', 8, 12) === 'WAVE'
    ) {
      format = 'wav'
      let pcm = false
      for (let offset = 12; offset + 8 <= bytes.length; ) {
        const size = bytes.readUInt32LE(offset + 4)
        if (offset + 8 + size > bytes.length) throw Error('invalidAudio')
        if (bytes.toString('ascii', offset, offset + 4) === 'fmt ') {
          pcm =
            size >= 16 &&
            bytes.readUInt16LE(offset + 8) === 1 &&
            [1, 2].includes(bytes.readUInt16LE(offset + 10)) &&
            bytes.readUInt32LE(offset + 12) <= 48000 &&
            [16, 24].includes(bytes.readUInt16LE(offset + 22))
        }
        offset += 8 + size + (size % 2)
      }
      if (!pcm) throw Error('invalidAudio')
    } else if (
      ext === '.mp3' &&
      (bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe6) === 0xe2))
    ) {
      format = 'mp3'
    } else throw Error('invalidAudio')
    duration = await decode(bytes, owner)
    if (duration < SOUND_MIN_SECONDS || duration > SOUND_MAX_SECONDS)
      return { ok: false, error: 'duration' }
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    return {
      ok: false,
      error:
        message === 'tooLarge'
          ? 'tooLarge'
          : message === 'invalidAudio' || bytes
            ? 'invalidAudio'
            : 'readFailed'
    }
  }
  const audio = bytes
  return serialize(async () => {
    if (revision !== generation) return { ok: false, error: 'cancelled' }
    const state = getSoundLibrary()
    const id = createHash('sha256').update(audio).digest('hex')
    const existing = state.sounds.find((sound) => sound.id === id)
    if (!existing && state.sounds.length >= SOUND_MAX_COUNT)
      return { ok: false, error: 'libraryFull' }
    const sound: NotificationSound = existing ?? {
      id,
      format,
      bytes: audio.length,
      duration,
      name: path
        .basename(file, path.extname(file))
        .replace(/[\x00-\x1f\x7f]/g, '')
        .slice(0, 100)
    }
    const target = path.join(directory(), `${id}.${format}`)
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      await fs.mkdir(directory(), { recursive: true })
      await fs.writeFile(temporary, audio, { mode: 0o600 })
      await fs.rename(temporary, target)
      return save({ ...state, sounds: existing ? state.sounds : [...state.sounds, sound] })
    } catch {
      if (!existing) await fs.rm(target, { force: true }).catch(() => {})
      return { ok: false, error: 'saveFailed' }
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {})
    }
  })
}

export function selectSound(id: unknown): Promise<NotificationSoundResult> {
  return serialize(async () => {
    const state = getSoundLibrary()
    if (id !== null && (!validId(id) || !state.sounds.some((sound) => sound.id === id)))
      return { ok: false, error: 'readFailed' }
    try {
      return save({ ...state, selectedId: id })
    } catch {
      return { ok: false, error: 'saveFailed' }
    }
  })
}

export function deleteSound(id: unknown): Promise<NotificationSoundResult> {
  return serialize(async () => {
    const state = getSoundLibrary()
    const sound = state.sounds.find((sound) => sound.id === id)
    if (!validId(id) || !sound) return { ok: false, error: 'readFailed' }
    try {
      // Commit first: a failed disk cleanup may leave an orphan, never a broken selection.
      const result = save({
        selectedId: state.selectedId === id ? null : state.selectedId,
        sounds: state.sounds.filter((sound) => sound.id !== id)
      })
      await fs.rm(path.join(directory(), `${id}.${sound.format}`), { force: true }).catch(() => {})
      return result
    } catch {
      return { ok: false, error: 'saveFailed' }
    }
  })
}

export async function soundAudio(id?: unknown): Promise<string | null> {
  const revision = generation
  const state = getSoundLibrary()
  const requested = id === undefined ? state.selectedId : id
  if (!validId(requested)) return null
  const sound = state.sounds.find((sound) => sound.id === requested)
  if (!sound) return null
  try {
    const bytes = await readBounded(path.join(directory(), `${sound.id}.${sound.format}`))
    if (revision !== generation || createHash('sha256').update(bytes).digest('hex') !== sound.id)
      return null
    return `data:audio/${sound.format === 'mp3' ? 'mpeg' : 'wav'};base64,${bytes.toString('base64')}`
  } catch {
    return null
  }
}

export function resetNotificationSounds(): Promise<void> {
  generation++
  return serialize(async () => {
    await fs.rm(directory(), { recursive: true, force: true })
    save({ selectedId: null, sounds: [] })
  })
}

export function registerNotificationSoundIpc(): void {
  const trusted = (event: Electron.IpcMainInvokeEvent): boolean =>
    !!BrowserWindow.fromWebContents(event.sender) &&
    event.senderFrame === event.sender.mainFrame &&
    [
      process.env.ELECTRON_RENDERER_URL,
      process.env.ELECTRON_RENDERER_URL?.replace(/\/$/, '') + '/',
      pathToFileURL(path.join(__dirname, '../renderer/index.html')).href
    ].includes(event.sender.getURL().split('#')[0])
  ipcMain.handle(CHANNELS.notifySoundsGet, (event) => {
    if (!trusted(event)) throw Error('Untrusted sound request')
    return getSoundLibrary()
  })
  ipcMain.handle(CHANNELS.notifySoundsAudio, (event, id: unknown) =>
    trusted(event) ? soundAudio(id) : null
  )
  ipcMain.handle(CHANNELS.notifySoundsSelect, (event, id: unknown) =>
    trusted(event) ? selectSound(id) : { ok: false, error: 'readFailed' }
  )
  ipcMain.handle(CHANNELS.notifySoundsDelete, (event, id: unknown) =>
    trusted(event) ? deleteSound(id) : { ok: false, error: 'readFailed' }
  )
  ipcMain.handle(CHANNELS.notifySoundsImport, async (event) => {
    if (!trusted(event)) return { ok: false, error: 'readFailed' }
    const revision = generation
    const owner = BrowserWindow.fromWebContents(event.sender)!
    try {
      const result = await dialog.showOpenDialog(owner, {
        properties: ['openFile'],
        filters: [{ name: 'MP3 / WAV', extensions: ['mp3', 'wav'] }]
      })
      if (result.canceled || !result.filePaths[0] || revision !== generation || owner.isDestroyed())
        return { ok: false, error: 'cancelled' }
      return await importSound(result.filePaths[0], owner, revision)
    } catch {
      return { ok: false, error: 'readFailed' }
    }
  })
}

export function getSoundLibrary(): NotificationSoundLibrary {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(KEY) as
    | { value: string }
    | undefined
  try {
    const data = JSON.parse(row?.value ?? '{}')
    const sounds: NotificationSound[] = Array.isArray(data?.sounds)
      ? data.sounds
          .filter(
            (sound: NotificationSound) =>
              sound &&
              validId(sound.id) &&
              typeof sound.name === 'string' &&
              sound.name.length <= 100 &&
              !/[\x00-\x1f\x7f]/.test(sound.name) &&
              ['mp3', 'wav'].includes(sound.format) &&
              Number.isInteger(sound.bytes) &&
              sound.bytes > 0 &&
              sound.bytes <= SOUND_MAX_BYTES &&
              Number.isFinite(sound.duration) &&
              sound.duration >= SOUND_MIN_SECONDS &&
              sound.duration <= SOUND_MAX_SECONDS
          )
          .slice(0, SOUND_MAX_COUNT)
      : []
    return {
      sounds,
      selectedId: sounds.some((sound) => sound.id === data.selectedId) ? data.selectedId : null
    }
  } catch {
    return { sounds: [], selectedId: null }
  }
}

function save(state: NotificationSoundLibrary): NotificationSoundResult {
  getDb()
    .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run(KEY, JSON.stringify(state))
  for (const window of BrowserWindow.getAllWindows()) {
    try {
      if (!window.isDestroyed()) window.webContents.send(CHANNELS.notifySoundsChanged, state)
    } catch {
      /* A closing window cannot invalidate a committed library. */
    }
  }
  return { ok: true, state }
}

async function readBounded(file: string): Promise<Buffer> {
  const handle = await fs.open(file, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size === 0) throw Error('invalidAudio')
    if (stat.size > SOUND_MAX_BYTES) throw Error('tooLarge')
    const buffer = Buffer.alloc(SOUND_MAX_BYTES + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null)
      if (!bytesRead) break
      offset += bytesRead
    }
    if (offset > SOUND_MAX_BYTES) throw Error('tooLarge')
    return buffer.subarray(0, offset)
  } finally {
    await handle.close()
  }
}

/** Decode untrusted bytes in an isolated Chromium renderer, never in the app window. */
async function decode(bytes: Buffer, owner?: BrowserWindow): Promise<number> {
  const decoder = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      partition: 'notification-sound-decoder'
    }
  })
  decoder.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  decoder.webContents.on('will-navigate', (event) => event.preventDefault())
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort = (): void => {}
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(Error('invalidAudio'))
    timer = setTimeout(abort, 10000)
  })
  decoder.webContents.once('render-process-gone', abort)
  decoder.once('closed', abort)
  owner?.once('closed', abort)
  try {
    if (owner?.isDestroyed()) throw Error('invalidAudio')
    await Promise.race([
      decoder.loadURL(
        'data:text/html,' +
          encodeURIComponent(
            '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; media-src blob:">'
          )
      ),
      interrupted
    ])
    const result = await Promise.race([
      decoder.webContents.executeJavaScript(`(async () => {
        const context = new AudioContext();
        try {
          const bytes = Uint8Array.from(atob(${JSON.stringify(bytes.toString('base64'))}), c => c.charCodeAt(0));
          // Bound decompression before allocating the decoded PCM buffer.
          const media = new Audio();
          const url = URL.createObjectURL(new Blob([bytes]));
          try {
            await new Promise((resolve, reject) => {
              media.onloadedmetadata = resolve;
              media.onerror = reject;
              media.src = url;
            });
            if (!Number.isFinite(media.duration)) throw new Error('invalidAudio');
            if (media.duration > ${SOUND_MAX_SECONDS} || media.duration < ${SOUND_MIN_SECONDS})
              return { duration: media.duration, channels: 1 };
          } finally { media.removeAttribute('src'); media.load(); URL.revokeObjectURL(url); }
          const audio = await context.decodeAudioData(bytes.buffer);
          return { duration: audio.duration, channels: audio.numberOfChannels };
        } finally { await context.close(); }
      })()`),
      interrupted
    ])
    if (!result || !Number.isFinite(result.duration) || ![1, 2].includes(result.channels))
      throw Error('invalidAudio')
    return result.duration
  } finally {
    clearTimeout(timer)
    owner?.removeListener('closed', abort)
    decoder.removeListener('closed', abort)
    if (!decoder.isDestroyed()) {
      decoder.webContents.removeListener('render-process-gone', abort)
      decoder.destroy()
    }
  }
}
