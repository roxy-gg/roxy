import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  powerMonitor,
  shell,
  systemPreferences,
  utilityProcess
} from 'electron'
import type { UtilityProcess, IpcMainInvokeEvent } from 'electron'
import type { Recorder } from '@handy-computer/recorder'
import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CHANNELS } from '../../shared/ipc'
import {
  VOICE_MODELS,
  normalizeVoice,
  type VoiceDevice,
  type VoiceError,
  type VoiceEvent,
  type VoiceResult,
  type VoiceSettings,
  type VoiceState
} from '../../shared/voice'
import { getChat, getVoiceSettings, setVoiceSettings } from '../db/repo'

let window: BrowserWindow | null = null
let shortcuts: string[] = []
let lastShortcutPress = 0
let download: (NonNullable<VoiceState['download']> & { controller: AbortController }) | null = null
let lastError: VoiceError | null = null
let changing = false
let publishRevision = 0
type Recording = {
  id: string
  chatId: string
  recorder?: Recorder
  worker?: UtilityProcess
  sequence: number
  pending: number
  stopping: boolean
  cancelled: boolean
  closing?: Promise<void>
  opening?: Promise<Recorder>
  timer?: NodeJS.Timeout
  finish?: () => void
  reject?: () => void
  begin?: () => void
}
let active: Recording | null = null
type VoiceEngine = {
  modelId: string
  worker?: UtilityProcess
  ready?: Promise<UtilityProcess>
  reject?: () => void
}
let engine: VoiceEngine | null = null
const root = (): string => join(app.getPath('userData'), 'voice-models')
const directory = (id: string): string => join(root(), id)
const supported = (): boolean =>
  (process.platform === 'win32' && process.arch === 'x64') ||
  (process.platform === 'darwin' && ['arm64', 'x64'].includes(process.arch)) ||
  (process.platform === 'linux' && ['arm64', 'x64'].includes(process.arch))

function emit(event: VoiceEvent): void {
  if (window && !window.isDestroyed()) window.webContents.send(CHANNELS.voiceEvent, event)
}
function permission(): string {
  return process.platform === 'darwin' || process.platform === 'win32'
    ? systemPreferences.getMediaAccessStatus('microphone')
    : 'unknown'
}
async function installed(id: string): Promise<boolean> {
  const model = VOICE_MODELS.find((m) => m.id === id)
  if (!model) return false
  try {
    if ((await readFile(join(directory(id), 'verified'), 'utf8')) !== model.revision) return false
    return (
      await Promise.all(
        model.files.map(async (f) => (await stat(join(directory(id), f.name))).size === f.bytes)
      )
    ).every(Boolean)
  } catch {
    return false
  }
}
export async function voiceState(): Promise<VoiceState> {
  const models = (
    await Promise.all(VOICE_MODELS.map(async (m) => ((await installed(m.id)) ? m.id : null)))
  ).filter((id): id is string => id !== null)
  return {
    settings: getVoiceSettings(),
    supported: supported(),
    permission: permission(),
    installed: models,
    download: download
      ? { modelId: download.modelId, received: download.received, total: download.total }
      : null,
    error: lastError
  }
}
async function publish(): Promise<void> {
  const revision = ++publishRevision
  const state = await voiceState()
  if (revision === publishRevision) emit({ type: 'state', state })
}
function fail(error: VoiceError): VoiceResult<never> {
  return { ok: false, error }
}

function unloadEngine(): void {
  const previous = engine
  engine = null
  previous?.reject?.()
  previous?.worker?.kill()
}

function loadEngine(modelId: string): Promise<UtilityProcess> {
  if (engine?.modelId === modelId && engine.ready) return engine.ready
  unloadEngine()
  const loading: VoiceEngine = { modelId }
  engine = loading
  loading.ready = (async () => {
    if (!(await installed(modelId))) throw 'modelRequired'
    if (engine !== loading) throw 'engineFailed'
    const worker = utilityProcess.fork(join(__dirname, 'voice-inference.js'), [], {
      serviceName: 'Roxy Voice',
      stdio: 'ignore'
    })
    loading.worker = worker
    worker.once('spawn', () => {
      if (engine !== loading) worker.kill()
    })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject('engineFailed'), 60_000)
      loading.reject = () => {
        clearTimeout(timer)
        reject('engineFailed')
      }
      worker.on('message', (message) => {
        if (engine !== loading) return
        if (message.type === 'ready') {
          clearTimeout(timer)
          resolve()
          return
        }
        if (message.type === 'error') {
          const recording = active
          unloadEngine()
          if (recording?.worker === worker) void stopVoice(false, 'engineFailed')
          return
        }
        const recording = active
        if (
          !recording ||
          recording.worker !== worker ||
          recording.cancelled ||
          message.recordingId !== recording.id
        )
          return
        if (message.type === 'started') recording.begin?.()
        else if (message.type === 'text' && typeof message.text === 'string') {
          emit({
            type: 'transcript',
            recordingId: recording.id,
            sequence: ++recording.sequence,
            text: message.text
          })
        } else if (message.type === 'ack')
          recording.pending = Math.max(0, recording.pending - message.frames)
        else if (message.type === 'finished') recording.finish?.()
      })
      worker.once('exit', () => {
        loading.reject?.()
        if (engine !== loading) return
        engine = null
        if (active?.worker === worker) void stopVoice(false, 'engineFailed')
      })
      worker.postMessage({ type: 'load', directory: directory(modelId) })
    })
    return worker
  })().catch((error) => {
    if (engine === loading) unloadEngine()
    throw error
  })
  return loading.ready
}

function warmEngine(): void {
  const settings = getVoiceSettings()
  if (!supported() || !settings.enabled || !settings.modelId) {
    unloadEngine()
    return
  }
  // Loading weights never requests mic permission or opens a capture stream.
  void loadEngine(settings.modelId).catch(() => undefined)
}

function bindHotkeys(settings: VoiceSettings): VoiceError | null {
  const wanted = settings.enabled ? settings.hotkeys.filter(Boolean) : []
  if (new Set(wanted.map((s) => s.toLowerCase())).size !== wanted.length) return 'shortcutInvalid'
  const added: string[] = []
  try {
    for (const key of wanted) {
      if (shortcuts.includes(key)) continue
      if (
        globalShortcut.isRegistered(key) ||
        !globalShortcut.register(key, () => {
          const now = Date.now()
          const repeated = now - lastShortcutPress < 250
          lastShortcutPress = now
          if (repeated) return
          if (!window || window.isDestroyed()) return
          if (window.isMinimized()) window.restore()
          window.show()
          window.focus()
          emit({ type: 'toggle' })
        })
      ) {
        added.forEach((k) => globalShortcut.unregister(k))
        return 'shortcutTaken'
      }
      added.push(key)
    }
  } catch {
    added.forEach((k) => globalShortcut.unregister(k))
    return 'shortcutInvalid'
  }
  shortcuts.filter((k) => !wanted.includes(k)).forEach((k) => globalShortcut.unregister(k))
  shortcuts = wanted
  return null
}

export function setVoiceWindow(target: BrowserWindow): void {
  window = target
  const abandon = (): void => {
    void stopVoice(false)
  }
  target.webContents.on('destroyed', abandon)
  target.webContents.on('render-process-gone', abandon)
  target.webContents.on('did-start-navigation', (_e, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) abandon()
  })
  target.on('closed', () => {
    if (window === target) window = null
  })
}

export async function stopVoice(finalize: boolean, error?: VoiceError): Promise<void> {
  const recording = active
  if (!recording) return
  if (!recording.recorder) finalize = false
  if (!finalize) {
    recording.cancelled = true
    recording.reject?.()
    recording.finish?.()
  }
  if (error === 'engineFailed' || error === 'tooSlow') unloadEngine()
  if (recording.closing) return recording.closing
  recording.stopping = true
  clearTimeout(recording.timer)
  recording.closing = (async () => {
    try {
      if (finalize && recording.recorder?.isRecording) {
        const result = await recording.recorder.stop()
        if (!result.complete) error = 'captureFailed'
      }
      const recorder = recording.recorder ?? (await recording.opening?.catch(() => undefined))
      await recorder?.close()
      if (finalize && !recording.cancelled && active === recording && recording.worker) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            error = 'engineFailed'
            unloadEngine()
            resolve()
          }, 15_000)
          recording.finish = () => {
            clearTimeout(timer)
            resolve()
          }
          recording.worker!.postMessage({ type: 'finish', recordingId: recording.id })
        })
      }
    } catch {
      error ??= 'captureFailed'
    } finally {
      recording.reject?.()
      try {
        recording.worker?.postMessage({ type: 'reset', recordingId: recording.id })
      } catch {
        unloadEngine()
      }
      if (active === recording) active = null
      emit({ type: 'recording', recordingId: recording.id, phase: 'stopped', error })
    }
  })()
  return recording.closing
}

async function startVoice(id: string, chatId: string): Promise<VoiceResult> {
  if (active || changing) return fail('busy')
  if (!supported()) return fail('unsupported')
  const settings = getVoiceSettings()
  if (!settings.enabled) return fail('disabled')
  if (!settings.modelId) return fail('modelRequired')
  if (
    typeof chatId !== 'string' ||
    typeof id !== 'string' ||
    !id ||
    id.length > 100 ||
    !getChat(chatId)
  )
    return fail('unknown')
  // Claim before awaiting the OS prompt or model loading, so cancel/navigation
  // invalidates even a late permission response or Bluetooth open completion.
  const recording: Recording = {
    id,
    chatId,
    sequence: 0,
    pending: 0,
    stopping: false,
    cancelled: false
  }
  active = recording
  try {
    const worker = await loadEngine(settings.modelId)
    if (active !== recording || recording.cancelled) return fail('busy')
    if (process.platform === 'darwin') {
      const access = permission()
      if (
        access === 'denied' ||
        access === 'restricted' ||
        (access !== 'granted' && !(await systemPreferences.askForMediaAccess('microphone')))
      ) {
        throw 'permissionDenied'
      }
    }
    if (active !== recording || recording.cancelled) return fail('busy')
    recording.worker = worker
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        unloadEngine()
        reject('engineFailed')
      }, 15_000)
      recording.begin = () => {
        clearTimeout(timer)
        resolve()
      }
      recording.reject = () => {
        clearTimeout(timer)
        reject('engineFailed')
      }
      worker.postMessage({ type: 'begin', recordingId: id })
    })
    if (active !== recording || recording.cancelled) return fail('busy')
    const native = await import('@handy-computer/recorder')
    const devices = await native.listInputDevices()
    if (active !== recording || recording.cancelled) return fail('busy')
    const selected = settings.microphone
    const device = selected
      ? (devices.find((d) => d.id === selected.id) ??
        devices.find((d) => d.name === selected.name && d.occurrence === selected.occurrence))
      : undefined
    let fallback = !!selected && !device
    let first = true
    const options = {
      sampleRate: 16000,
      channels: 'mono' as const,
      framesPerChunk: 1600,
      collect: false,
      onChunk: ({ samples }: { samples: Float32Array }): void => {
        if (active !== recording || recording.cancelled) return
        if (!getChat(recording.chatId)) {
          void stopVoice(false)
          return
        }
        if (first) {
          first = false
          emit({ type: 'recording', recordingId: id, phase: 'recording', fallback })
        }
        recording.pending += samples.length
        if (recording.pending > 16000 * 5) {
          void stopVoice(false, 'tooSlow')
          return
        }
        try {
          worker.postMessage({ type: 'audio', recordingId: id, samples })
        } catch {
          void stopVoice(false, 'engineFailed')
        }
      },
      onFailure: (e: { code: string }): void => {
        if (active === recording && !recording.cancelled)
          void stopVoice(
            false,
            e.code === 'PermissionDenied' ? 'permissionDenied' : 'captureFailed'
          )
      }
    }
    let recorder: Recorder
    try {
      recording.opening = native.Recorder.open({ ...options, device: device?.id })
      recorder = await recording.opening
    } catch (e) {
      if (active !== recording || recording.cancelled) return fail('busy')
      if (!device || (e as { code?: string }).code !== 'DeviceUnavailable') throw e
      fallback = true
      recording.opening = native.Recorder.open(options)
      recorder = await recording.opening
    }
    recording.recorder = recorder
    if (active !== recording || recording.cancelled || recorder.failure) {
      await recorder.close()
      if (active === recording && !recording.cancelled) throw 'captureFailed'
      return fail('busy')
    }
    recorder.start()
    recording.timer = setTimeout(() => {
      if (active === recording) void stopVoice(true)
    }, 10 * 60_000)
    return { ok: true, value: undefined }
  } catch (e) {
    const code: VoiceError =
      typeof e === 'string'
        ? (e as VoiceError)
        : (e as { code?: string }).code === 'PermissionDenied'
          ? 'permissionDenied'
          : 'captureFailed'
    if (active === recording) await stopVoice(false, code)
    return fail(code)
  }
}

async function downloadModel(id: string): Promise<VoiceResult> {
  if (download || changing) return fail('busy')
  if (!getVoiceSettings().enabled) return fail('disabled')
  const model = VOICE_MODELS.find((m) => m.id === id)
  if (!model) return fail('modelRequired')
  const job = {
    modelId: id,
    received: 0,
    total: model.files.reduce((n, f) => n + f.bytes, 0),
    controller: new AbortController()
  }
  download = job
  lastError = null
  const temp = join(root(), id + '.partial')
  try {
    if (await installed(id)) return { ok: true, value: undefined }
    job.controller.signal.throwIfAborted()
    await rm(temp, { recursive: true, force: true })
    await mkdir(temp, { recursive: true })
    await publish()
    let lastUpdate = 0
    for (const file of model.files) {
      const response = await fetch(
        `https://huggingface.co/${model.repository}/resolve/${model.revision}/${file.name}`,
        {
          signal: AbortSignal.any([job.controller.signal, AbortSignal.timeout(30 * 60_000)])
        }
      )
      if (!response.ok || !response.body) throw 'downloadFailed'
      const hash = createHash('sha256')
      let bytes = 0
      const handle = await open(join(temp, file.name), 'w')
      try {
        for await (const chunk of response.body) {
          job.controller.signal.throwIfAborted()
          bytes += chunk.length
          if (bytes > file.bytes) throw 'integrityFailed'
          hash.update(chunk)
          let offset = 0
          while (offset < chunk.length) {
            const written = (await handle.write(chunk, offset)).bytesWritten
            if (!written) throw 'downloadFailed'
            offset += written
          }
          job.received += chunk.length
          if (Date.now() - lastUpdate > 150) {
            lastUpdate = Date.now()
            void publish()
          }
        }
      } finally {
        await handle.close()
      }
      if (bytes !== file.bytes || hash.digest('hex') !== file.sha256) throw 'integrityFailed'
    }
    job.controller.signal.throwIfAborted()
    await writeFile(join(temp, 'verified'), model.revision)
    await rm(directory(id), { recursive: true, force: true })
    await rename(temp, directory(id))
    if (getVoiceSettings().modelId === id) warmEngine()
    return { ok: true, value: undefined }
  } catch (e) {
    const cancelled = job.controller.signal.aborted
    if (!cancelled) lastError = e === 'integrityFailed' ? 'integrityFailed' : 'downloadFailed'
    await rm(temp, { recursive: true, force: true }).catch(() => undefined)
    if (cancelled) return { ok: true, value: undefined }
    return fail(lastError ?? 'downloadFailed')
  } finally {
    if (download === job) download = null
    await publish()
  }
}

export function shutdownVoice(): void {
  download?.controller.abort()
  shortcuts.forEach((key) => globalShortcut.unregister(key))
  shortcuts = []
  void stopVoice(false)
  unloadEngine()
}

export async function resetVoice(): Promise<void> {
  shutdownVoice()
  await stopVoice(false)
  setVoiceSettings(normalizeVoice(null))
  lastError = null
  await publish()
}

export function registerVoiceIpc(): void {
  lastError = bindHotkeys(getVoiceSettings())
  warmEngine()
  powerMonitor.on('suspend', () => {
    void stopVoice(false)
  })
  powerMonitor.on('lock-screen', () => {
    void stopVoice(false)
  })
  const trusted = (e: IpcMainInvokeEvent): boolean =>
    !!window &&
    !window.isDestroyed() &&
    e.sender === window.webContents &&
    e.senderFrame === e.sender.mainFrame &&
    [
      process.env.ELECTRON_RENDERER_URL?.replace(/\/$/, '') + '/',
      pathToFileURL(join(__dirname, '../renderer/index.html')).href
    ].includes(e.sender.getURL().split('#')[0])
  const handle = (
    channel: string,
    action: (e: IpcMainInvokeEvent, ...args: any[]) => unknown
  ): void => {
    ipcMain.handle(channel, (e, ...args) => (trusted(e) ? action(e, ...args) : fail('disabled')))
  }
  handle(CHANNELS.voiceState, () => voiceState())
  handle(CHANNELS.voiceUpdate, async (_e, patch: Partial<VoiceSettings>) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return fail('unknown')
    if (changing) return fail('busy')
    changing = true
    try {
      const before = getVoiceSettings()
      const next = normalizeVoice({ ...before, ...patch })
      const error = bindHotkeys(next)
      if (error) return fail(error)
      try {
        setVoiceSettings(next)
      } catch {
        bindHotkeys(before)
        return fail('unknown')
      }
      await stopVoice(false)
      warmEngine()
      if (!next.enabled) download?.controller.abort()
      lastError = null
      await publish()
      return { ok: true, value: next }
    } finally {
      changing = false
    }
  })
  handle(CHANNELS.voiceDevices, async (): Promise<VoiceResult<VoiceDevice[]>> => {
    if (!getVoiceSettings().enabled) return fail('disabled')
    try {
      if (
        process.platform === 'darwin' &&
        permission() !== 'granted' &&
        !(await systemPreferences.askForMediaAccess('microphone'))
      )
        return fail('permissionDenied')
      const native = await import('@handy-computer/recorder')
      await publish()
      return {
        ok: true,
        value: (await native.listInputDevices())
          .filter((d) => !d.isMonitor)
          .map(({ id, name, occurrence, isDefault }) => ({ id, name, occurrence, isDefault }))
      }
    } catch {
      return fail('deviceUnavailable')
    }
  })
  handle(CHANNELS.voicePrivacy, () => {
    if (process.platform === 'darwin')
      return shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
      )
    if (process.platform === 'win32') return shell.openExternal('ms-settings:privacy-microphone')
    return undefined
  })
  handle(CHANNELS.voiceDownload, (_e, id: string) => downloadModel(id))
  handle(CHANNELS.voiceCancelDownload, () => {
    download?.controller.abort()
  })
  handle(CHANNELS.voiceRemove, async (_e, id: string) => {
    if (changing || download?.modelId === id || !VOICE_MODELS.some((m) => m.id === id))
      return fail('busy')
    changing = true
    try {
      await stopVoice(false)
      if (engine?.modelId === id) unloadEngine()
      await rm(directory(id), { recursive: true, force: true })
      if (getVoiceSettings().modelId === id)
        setVoiceSettings({ ...getVoiceSettings(), modelId: null })
      await publish()
      return { ok: true, value: undefined }
    } catch {
      return fail('unknown')
    } finally {
      changing = false
    }
  })
  handle(CHANNELS.voiceStart, (_e, id: string, chatId: string) => startVoice(id, chatId))
  handle(CHANNELS.voiceStop, async (_e, id: string, finalize: boolean) => {
    if (active?.id === id) await stopVoice(finalize === true)
  })
}
