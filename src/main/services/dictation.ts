import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { promises as fsp } from 'node:fs'
import http, { type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { app, BrowserWindow } from 'electron'
import WebSocket, { type RawData } from 'ws'
import {
  DICTATION_MODEL_FILE,
  DICTATION_MODEL_SHA256,
  DICTATION_MODEL_SIZE,
  DICTATION_RUNTIME_VERSION,
  IDLE_DICTATION_STATE,
  dictationModelUrl,
  dictationRuntimeAsset,
  dictationRuntimeUrl,
  type DictationMode,
  type DictationPolishInput,
  type DictationStartInput,
  type DictationState,
  type DictationTranscript
} from '../../shared/dictation'
import { CHANNELS } from '../../shared/ipc'
import { usageCost } from '../../shared/cost'
import { resolveSessionConfig } from '../../shared/session-config'
import * as repo from '../db/repo'
import { extract } from './cliproxy'
import { streamChat } from './llm'
import { modelCost } from './models'

interface ActiveSession {
  requestId: string
  senderId: number
  socket: WebSocket
  finalSeen: boolean
  failure?: string
  finish?: () => void
}

interface PendingStart {
  requestId: string
  senderId: number
  cancelled: boolean
}

let state: DictationState = { ...IDLE_DICTATION_STATE }
let child: ChildProcess | null = null
let serverPort = 0
let serverKey = ''
let serverMode: DictationMode | null = null
let installing: Promise<void> | null = null
let starting: Promise<void> | null = null
let active: ActiveSession | null = null
let startOwner: PendingStart | null = null

function root(): string {
  return join(app.getPath('userData'), 'dictation')
}

function runtimeDir(): string {
  return join(root(), `nemo-speech-v${DICTATION_RUNTIME_VERSION}`)
}

function runtimeBin(): string {
  return join(runtimeDir(), 'bin', process.platform === 'win32' ? 'nemo-speech.exe' : 'nemo-speech')
}

function modelPath(): string {
  return join(root(), 'models', DICTATION_MODEL_FILE)
}

function copyState(): DictationState {
  return { ...state }
}

function broadcastState(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(CHANNELS.dictationState, copyState())
  }
}

function update(patch: Partial<DictationState>): void {
  state = { ...state, ...patch, rev: state.rev + 1 }
  broadcastState()
}

function sendTranscript(senderId: number, payload: DictationTranscript): void {
  const win = BrowserWindow.getAllWindows().find(
    (candidate) => candidate.webContents.id === senderId
  )
  if (win && !win.isDestroyed()) win.webContents.send(CHANNELS.dictationTranscript, payload)
}

async function exists(path: string): Promise<boolean> {
  try {
    await fsp.access(path)
    return true
  } catch {
    return false
  }
}

async function installed(): Promise<boolean> {
  return (await exists(runtimeBin())) && (await exists(modelPath()))
}

export async function status(): Promise<DictationState> {
  const asset = dictationRuntimeAsset(process.platform, process.arch)
  const isInstalled = Boolean(asset) && (await installed())
  if (!asset && state.status !== 'unsupported') {
    update({
      status: 'unsupported',
      installed: false,
      error: `Local dictation is not available on ${process.platform}/${process.arch}.`
    })
  } else if (state.status === 'idle' || state.status === 'ready') {
    state = { ...state, installed: isInstalled, status: isInstalled ? 'ready' : 'idle' }
  }
  return copyState()
}

interface DownloadResponse {
  status: number
  headers: IncomingHttpHeaders
  body: IncomingMessage
}

function openDownload(
  url: string,
  headers: Record<string, string> = {},
  redirects = 0
): Promise<DownloadResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const client = target.protocol === 'http:' ? http : https
    const request = client.get(
      target,
      {
        headers: {
          Accept: 'application/octet-stream',
          'User-Agent': `Roxy/${app.getVersion()}`,
          ...headers
        }
      },
      (response) => {
        const status = response.statusCode ?? 0
        const location = response.headers.location
        if (location && status >= 300 && status < 400) {
          response.resume()
          if (redirects >= 10) {
            reject(new Error('The dictation download redirected too many times.'))
            return
          }
          void openDownload(new URL(location, target).toString(), headers, redirects + 1).then(
            resolve,
            reject
          )
          return
        }
        resolve({ status, headers: response.headers, body: response })
      }
    )
    request.setTimeout(30_000, () => request.destroy(new Error('The download timed out.')))
    request.once('error', reject)
  })
}

async function ensureFreeSpace(path: string, bytes: number): Promise<void> {
  await fsp.mkdir(path, { recursive: true })
  const disk = await fsp.statfs(path)
  const free = disk.bavail * disk.bsize
  if (free < bytes) {
    throw new Error(
      `Not enough free disk space for local dictation. ${Math.ceil(bytes / 1_048_576)} MB is required.`
    )
  }
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

async function download(
  url: string,
  destination: string,
  expectedHash: string,
  expectedSize: number | null,
  onProgress: (progress: number) => void
): Promise<void> {
  await fsp.mkdir(join(destination, '..'), { recursive: true })
  const partial = `${destination}.part`
  let offset = 0
  try {
    offset = (await fsp.stat(partial)).size
  } catch {
    // A new download starts at zero.
  }
  if (expectedSize !== null && offset > expectedSize) {
    await fsp.rm(partial, { force: true })
    offset = 0
  }
  if (expectedSize !== null && offset === expectedSize) {
    if ((await sha256(partial)) === expectedHash) {
      await fsp.rm(destination, { force: true })
      await fsp.rename(partial, destination)
      onProgress(100)
      return
    }
    await fsp.rm(partial, { force: true })
    offset = 0
  }

  const headers: Record<string, string> = offset > 0 ? { Range: `bytes=${offset}-` } : {}
  let response = await openDownload(url, headers)
  if (offset > 0 && response.status === 416) {
    await fsp.rm(partial, { force: true })
    offset = 0
    response = await openDownload(url)
  }
  if (response.status < 200 || response.status >= 300) {
    response.body.resume()
    throw new Error(`Download failed (${response.status}).`)
  }
  if (offset > 0 && response.status !== 206) {
    await fsp.rm(partial, { force: true })
    offset = 0
  }
  const remaining = Number(response.headers['content-length'] || 0)
  const total = expectedSize ?? (remaining > 0 ? offset + remaining : 0)
  let received = offset
  response.body.on('data', (chunk: Buffer) => {
    received += chunk.length
    if (total > 0) onProgress(Math.min(99, Math.floor((received / total) * 100)))
  })
  await pipeline(response.body, createWriteStream(partial, { flags: offset > 0 ? 'a' : 'w' }))

  const written = (await fsp.stat(partial)).size
  if (expectedSize !== null && written !== expectedSize) {
    throw new Error(`The download stopped early (${written} of ${expectedSize} bytes).`)
  }
  const actualHash = await sha256(partial)
  if (actualHash !== expectedHash) {
    await fsp.rm(partial, { force: true })
    throw new Error(
      `The downloaded ${destination.split(/[\\/]/).pop() ?? 'dictation file'} did not match ` +
        `its published checksum (got ${actualHash.slice(0, 12)}…, expected ` +
        `${expectedHash.slice(0, 12)}…). Retry once; if it repeats, a proxy or security ` +
        'product may be rewriting the download.'
    )
  }
  await fsp.rm(destination, { force: true })
  await fsp.rename(partial, destination)
  onProgress(100)
}

async function installRuntime(): Promise<void> {
  const asset = dictationRuntimeAsset(process.platform, process.arch)
  if (!asset) throw new Error(`Unsupported platform: ${process.platform}/${process.arch}.`)
  if (await exists(runtimeBin())) return

  update({ status: 'downloading-runtime', progress: 0, error: undefined })
  await ensureFreeSpace(root(), 100 * 1_048_576)
  const archive = join(root(), asset.archive)
  await download(dictationRuntimeUrl(asset.archive), archive, asset.sha256, null, (progress) =>
    update({ progress })
  )

  const staging = join(root(), `.runtime-${Date.now()}-${randomBytes(4).toString('hex')}`)
  try {
    await fsp.mkdir(staging, { recursive: true })
    await extract(archive, staging)
    const expected = join(
      staging,
      'bin',
      process.platform === 'win32' ? 'nemo-speech.exe' : 'nemo-speech'
    )
    if (!(await exists(expected)))
      throw new Error("The runtime archive didn't contain nemo-speech.")
    await fsp.rm(runtimeDir(), { recursive: true, force: true })
    await fsp.rename(staging, runtimeDir())
    if (process.platform !== 'win32') await fsp.chmod(runtimeBin(), 0o755)
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined)
    await fsp.rm(archive, { force: true }).catch(() => undefined)
  }
}

async function installModel(): Promise<void> {
  if (await exists(modelPath())) return
  update({ status: 'downloading-model', progress: 0, error: undefined })
  await ensureFreeSpace(root(), DICTATION_MODEL_SIZE + 200 * 1_048_576)
  await download(
    dictationModelUrl(),
    modelPath(),
    DICTATION_MODEL_SHA256,
    DICTATION_MODEL_SIZE,
    (progress) => update({ progress })
  )
}

async function ensureInstalled(): Promise<void> {
  if (!installing) {
    installing = (async () => {
      await installRuntime()
      await installModel()
      update({ installed: true, status: 'ready', progress: 100, error: undefined })
    })().finally(() => {
      installing = null
    })
  }
  return installing
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => (port ? resolve(port) : reject(new Error('Could not allocate a port.'))))
    })
  })
}

async function waitUntilReady(port: number, proc: ChildProcess): Promise<void> {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error('The local speech runtime exited during startup.')
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ready`)
      if (response.ok) return
    } catch {
      // The listener is not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('The local speech runtime did not become ready in time.')
}

async function ensureServer(mode: DictationMode): Promise<void> {
  if (child && child.exitCode === null && serverMode === mode) return
  await stopServer()
  if (!starting) {
    starting = (async () => {
      update({ status: 'starting', progress: 100, mode, error: undefined })
      serverPort = await freePort()
      serverKey = randomBytes(24).toString('base64url')
      serverMode = mode
      const context = mode === 'fast' ? '1' : '6'
      const proc = spawn(
        runtimeBin(),
        [
          '--json',
          'serve',
          '--asr-model',
          modelPath(),
          '--host',
          '127.0.0.1',
          '--port',
          String(serverPort),
          '--no-ui',
          '--asr.streaming.rnnt_right_context',
          context
        ],
        {
          cwd: runtimeDir(),
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, NEMO_SPEECH_HTTP_API_KEY: serverKey }
        }
      )
      child = proc
      let stderr = ''
      proc.on('error', (error) => {
        if (child !== proc) return
        child = null
        serverMode = null
        if (active) {
          active.socket.close()
          active = null
        }
        update({ status: 'error', error: `Could not start local dictation: ${error.message}` })
      })
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-4000)
      })
      proc.once('exit', (code) => {
        if (child !== proc) return
        child = null
        serverMode = null
        if (active) {
          active.socket.close()
          active = null
        }
        if (state.status !== 'idle' && state.status !== 'error') {
          update({
            status: 'error',
            error: stderr.trim() || `The local speech runtime exited (${code ?? 'unknown'}).`
          })
        }
      })
      await Promise.race([
        waitUntilReady(serverPort, proc),
        new Promise<never>((_resolve, reject) => proc.once('error', reject))
      ])
      update({ status: 'ready', mode, error: undefined })
    })().finally(() => {
      starting = null
    })
  }
  return starting
}

function eventText(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  for (const key of ['delta', 'text', 'transcript']) {
    if (typeof record[key] === 'string') return record[key]
  }
  const nested = record.item
  return nested && typeof nested === 'object' ? eventText(nested) : ''
}

function handleSocketMessage(session: ActiveSession, data: RawData): void {
  if (typeof data !== 'string' && !Buffer.isBuffer(data)) return
  let event: Record<string, unknown>
  try {
    event = JSON.parse(data.toString()) as Record<string, unknown>
  } catch {
    return
  }
  const type = typeof event.type === 'string' ? event.type : ''
  if (type.endsWith('.delta')) {
    sendTranscript(session.senderId, {
      requestId: session.requestId,
      kind: 'partial',
      text: eventText(event)
    })
  } else if (type.endsWith('.completed')) {
    session.finalSeen = true
    sendTranscript(session.senderId, {
      requestId: session.requestId,
      kind: 'final',
      text: eventText(event)
    })
    session.finish?.()
  } else if (type === 'error') {
    const message = eventText(event.error) || eventText(event) || 'Local transcription failed.'
    session.failure = message
    session.socket.close()
    if (active === session) active = null
    update({ status: 'error', error: message })
    session.finish?.()
  }
}

async function openSession(input: DictationStartInput, senderId: number): Promise<void> {
  const socket = new WebSocket(
    `ws://127.0.0.1:${serverPort}/v1/realtime?api_key=${encodeURIComponent(serverKey)}`
  )
  const session: ActiveSession = {
    requestId: input.requestId,
    senderId,
    socket,
    finalSeen: false
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Could not connect to local dictation.')),
      10_000
    )
    socket.once('open', () => {
      clearTimeout(timeout)
      socket.send(
        JSON.stringify({
          type: 'session.update',
          session: {
            sample_rate: 16000,
            language: 'en-US',
            automatic_punctuation: true,
            endpointing_ms: 800
          }
        })
      )
      resolve()
    })
    socket.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
  })
  socket.on('message', (data) => handleSocketMessage(session, data))
  socket.once('close', () => {
    if (active === session) {
      active = null
      session.failure = 'The local transcription connection closed unexpectedly.'
      session.finish?.()
      update({ status: 'error', error: session.failure })
    }
  })
  active = session
}

export async function start(input: DictationStartInput, senderId: number): Promise<DictationState> {
  if (!input.requestId.trim()) throw new Error('A dictation request ID is required.')
  if (active || startOwner) throw new Error('A dictation session is already active.')
  const owner: PendingStart = { requestId: input.requestId, senderId, cancelled: false }
  startOwner = owner
  try {
    await ensureInstalled()
    if (owner.cancelled) throw new Error('Dictation start was cancelled.')
    await ensureServer(input.mode)
    if (owner.cancelled) throw new Error('Dictation start was cancelled.')
    await openSession(input, senderId)
    if (owner.cancelled) throw new Error('Dictation start was cancelled.')
    update({ status: 'listening', mode: input.mode, error: undefined })
    return copyState()
  } catch (error) {
    await stopServer().catch(() => undefined)
    const message = error instanceof Error ? error.message : String(error)
    if (owner.cancelled) {
      update({ status: state.installed ? 'ready' : 'idle', error: undefined })
    } else {
      update({ status: 'error', error: message })
    }
    throw error
  } finally {
    if (startOwner === owner) startOwner = null
  }
}

export function pushAudio(
  requestId: string,
  audio: ArrayBuffer | Uint8Array,
  senderId: number
): void {
  if (
    !active ||
    active.requestId !== requestId ||
    active.senderId !== senderId ||
    active.socket.readyState !== WebSocket.OPEN
  )
    return
  const bytes = audio instanceof Uint8Array ? audio : new Uint8Array(audio)
  if (bytes.byteLength === 0 || bytes.byteLength > 128 * 1024) return
  if (active.socket.bufferedAmount > 2 * 1024 * 1024) {
    active.socket.close()
    active = null
    update({ status: 'error', error: 'Microphone audio could not be processed in real time.' })
    return
  }
  active.socket.send(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
}

export async function stop(
  requestId: string,
  cancel: boolean,
  senderId?: number
): Promise<DictationState> {
  const session = active
  if (!session || session.requestId !== requestId) {
    if (
      startOwner?.requestId === requestId &&
      (senderId === undefined || startOwner.senderId === senderId)
    ) {
      startOwner.cancelled = true
    }
    return copyState()
  }
  if (senderId !== undefined && session.senderId !== senderId) {
    throw new Error('That dictation session belongs to another window.')
  }
  update({ status: 'stopping' })
  if (session.socket.readyState === WebSocket.OPEN) {
    if (cancel) {
      session.socket.send(JSON.stringify({ type: 'input_audio_buffer.clear' }))
    } else if (session.finalSeen) {
      // Realtime endpointing already finalized this utterance. Closing now avoids
      // waiting for a second completion event after the renderer auto-submits.
    } else {
      let timedOut = false
      session.finalSeen = false
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          timedOut = true
          resolve()
        }, 8_000)
        session.finish = () => {
          clearTimeout(timeout)
          resolve()
        }
        session.socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
      })
      if (!session.finalSeen) {
        session.socket.close()
        if (active === session) active = null
        const message =
          session.failure ||
          (timedOut
            ? 'Local dictation timed out while finishing the transcript.'
            : 'Local dictation could not finish the transcript.')
        update({ status: 'error', error: message })
        throw new Error(message)
      }
    }
    session.socket.close()
  }
  if (active === session) active = null
  update({ status: 'ready', error: undefined })
  return copyState()
}

export async function polish(input: DictationPolishInput): Promise<string> {
  const text = input.text.trim()
  if (!text) throw new Error('There is no transcript to polish.')
  if (text.length > 50_000) throw new Error('The transcript is too long to polish.')
  const provider = repo
    .listConnectedProviders()
    .find((candidate) => candidate.id === input.providerId && candidate.enabled)
  if (!provider) throw new Error('The selected AI provider is not connected.')
  if (!input.model.trim()) throw new Error('Select a chat model before polishing.')
  const chat = input.chatId ? repo.getChat(input.chatId) : undefined
  if (input.chatId && !chat) throw new Error('The active chat no longer exists.')
  const expected = resolveSessionConfig(chat, repo.getSettings())
  if (expected.providerId !== input.providerId || expected.model !== input.model) {
    throw new Error('The selected chat model changed. Try Polish again.')
  }

  const system =
    'Rewrite the dictated text only. Remove filler words and false starts; restore punctuation ' +
    'and capitalization. Preserve meaning and preserve code identifiers, commands, filenames, ' +
    'paths, URLs, numbers, and technical terms exactly. Return only the rewritten text.'
  let output = ''
  await streamChat({
    providerId: input.providerId,
    model: input.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: text }
    ],
    signal: new AbortController().signal,
    onDelta: (delta) => {
      output += delta
    }
  })
  const polished = output.trim()
  if (!polished) throw new Error('The selected model returned an empty transcript.')
  const usage = {
    input: Math.ceil((system.length + text.length) / 4),
    output: Math.ceil(polished.length / 4),
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    estimated: true
  }
  repo.recordUsage({
    chatId: input.chatId ?? null,
    providerId: input.providerId,
    model: input.model,
    usage,
    cost: usageCost(usage, modelCost(input.providerId, input.model))
  })
  return polished
}

async function stopServer(): Promise<void> {
  if (active) {
    const requestId = active.requestId
    await stop(requestId, true).catch(() => undefined)
  }
  const proc = child
  child = null
  serverMode = null
  if (proc && proc.exitCode === null) {
    proc.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (proc.exitCode === null) proc.kill('SIGKILL')
        resolve()
      }, 3_000)
      proc.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
    })
  }
}

export function shutdown(): void {
  const session = active
  active = null
  session?.socket.terminate()
  const proc = child
  child = null
  serverMode = null
  if (proc && proc.exitCode === null) proc.kill('SIGTERM')
  state = { ...IDLE_DICTATION_STATE }
}

export async function clearCache(): Promise<DictationState> {
  if (installing || starting) throw new Error('Wait for local dictation setup to finish first.')
  await stopServer()
  await fsp.rm(root(), { recursive: true, force: true })
  state = { ...IDLE_DICTATION_STATE, rev: state.rev + 1 }
  broadcastState()
  return copyState()
}
