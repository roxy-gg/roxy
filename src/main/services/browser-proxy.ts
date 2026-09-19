import { app, BrowserWindow, session } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  BrowserProxyConfig,
  BrowserProxyInput,
  BrowserProxySaveResult,
  BrowserProxyScheme
} from '../../shared/api'
import { CHANNELS } from '../../shared/ipc'
import { decryptSecret, encryptSecret, type SecurePayload } from './secure'

export const BROWSER_PARTITION = 'persist:roxy-browser'

const SCHEMES = new Set<BrowserProxyScheme>(['http', 'https', 'socks4', 'socks5'])
const EMPTY: BrowserProxyConfig = {
  enabled: false,
  scheme: 'http',
  host: '',
  port: 0,
  username: '',
  hasPassword: false
}

interface StoredProxy {
  enabled: boolean
  scheme: BrowserProxyScheme
  host: string
  port: number
  username: string
  password?: SecurePayload
}

let loaded: StoredProxy | null = null
let loadPromise: Promise<StoredProxy> | null = null
let applyPromise: Promise<void> = Promise.resolve()
let appliedKey: string | null = null

function filePath(): string {
  return path.join(app.getPath('userData'), 'browser-proxy.json')
}

function publicConfig(value: StoredProxy): BrowserProxyConfig {
  return {
    enabled: value.enabled,
    scheme: value.scheme,
    host: value.host,
    port: value.port,
    username: value.username,
    hasPassword: Boolean(value.password?.data)
  }
}

function normalizeStored(raw: unknown): StoredProxy {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...EMPTY }
  const value = raw as Partial<StoredProxy>
  const scheme = SCHEMES.has(value.scheme as BrowserProxyScheme) ? value.scheme! : 'http'
  const port = Number.isInteger(value.port) && Number(value.port) > 0 ? Number(value.port) : 0
  const password = value.password
  const host = typeof value.host === 'string' ? value.host.trim() : ''
  return {
    enabled: Boolean(value.enabled) && Boolean(host) && port > 0,
    scheme,
    host,
    port,
    username: typeof value.username === 'string' ? value.username : '',
    ...(password && typeof password.data === 'string' && typeof password.encrypted === 'boolean'
      ? { password }
      : {})
  }
}

async function load(): Promise<StoredProxy> {
  if (loaded) return loaded
  if (!loadPromise) {
    loadPromise = fs
      .readFile(filePath(), 'utf8')
      .then((text) => normalizeStored(JSON.parse(text)))
      .catch(() => ({ ...EMPTY }))
      .then((value) => {
        loaded = value
        return value
      })
  }
  return loadPromise
}

function validate(input: BrowserProxyInput): string | null {
  if (!SCHEMES.has(input.scheme)) return 'Choose a supported proxy protocol.'
  if (input.enabled && !input.host.trim()) return 'Enter a proxy host.'
  if (input.enabled && (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)) {
    return 'Enter a port from 1 to 65535.'
  }
  if ((input.username || input.password) && input.scheme.startsWith('socks')) {
    return 'Authenticated SOCKS proxies are not supported by Chromium. Use HTTP or HTTPS.'
  }
  return null
}

async function persist(value: StoredProxy): Promise<void> {
  const file = filePath()
  const temp = `${file}.tmp`
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600 })
  await fs.rename(temp, file)
}

function proxyKey(value: StoredProxy): string {
  return `${value.enabled}|${value.scheme}|${value.host}|${value.port}`
}

async function apply(value: StoredProxy): Promise<void> {
  const key = proxyKey(value)
  if (appliedKey === key) return
  const browserSession = session.fromPartition(BROWSER_PARTITION)
  await browserSession.setProxy(
    value.enabled
      ? {
          mode: 'fixed_servers',
          proxyRules: `${value.scheme}://${value.host}:${value.port}`,
          proxyBypassRules: '<local>;localhost;127.0.0.1;[::1]'
        }
      : { mode: 'direct' }
  )
  await browserSession.closeAllConnections()
  appliedKey = key
}

function broadcast(config: BrowserProxyConfig): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(CHANNELS.browserProxyChanged, config)
  }
}

export async function get(): Promise<BrowserProxyConfig> {
  return publicConfig(await load())
}

export async function set(input: BrowserProxyInput): Promise<BrowserProxySaveResult> {
  const current = await load()
  const error = validate(input)
  if (error) return { ok: false, config: publicConfig(current), error }

  const next: StoredProxy = {
    enabled: input.enabled,
    scheme: input.scheme,
    host: input.host.trim(),
    port: Number(input.port),
    username: input.username.trim()
  }
  if (!input.clearPassword) {
    if (input.password !== undefined && input.password !== '') {
      next.password = encryptSecret(input.password)
    } else if (current.password) {
      next.password = current.password
    }
  }

  try {
    await persist(next)
    appliedKey = null
    await apply(next)
    loaded = next
    const config = publicConfig(next)
    broadcast(config)
    return { ok: true, config }
  } catch (e) {
    return {
      ok: false,
      config: publicConfig(current),
      error: e instanceof Error ? e.message : String(e)
    }
  }
}

/** Apply the saved profile before the browser's first request. */
export async function ensureApplied(): Promise<void> {
  const value = await load()
  applyPromise = applyPromise.then(() => apply(value))
  return applyPromise
}

/** Supply credentials only for authentication challenges from the configured proxy. */
export async function credentialsFor(authInfo: Electron.AuthInfo): Promise<{
  username: string
  password: string
} | null> {
  if (!authInfo.isProxy) return null
  const value = await load()
  if (!value.enabled || !value.username || !value.password) return null
  if (authInfo.host.toLowerCase() !== value.host.toLowerCase() || authInfo.port !== value.port) {
    return null
  }
  try {
    return { username: value.username, password: decryptSecret(value.password) }
  } catch {
    return null
  }
}

export async function reset(): Promise<void> {
  loaded = { ...EMPTY }
  loadPromise = Promise.resolve(loaded)
  appliedKey = null
  await fs.rm(filePath(), { force: true }).catch(() => undefined)
  await apply(loaded).catch(() => undefined)
  broadcast(publicConfig(loaded))
}
