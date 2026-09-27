/**
 * The Roxy browser â€” a real, persistent Electron BrowserWindow the agent can
 * drive. It uses a `persist:` session partition so cookies/logins survive
 * restarts (sign in once, automate forever), and it taps Electron's native
 * APIs to screenshot the page, read its HTML, and collect console messages.
 *
 * This is the foundation for full browser automation: every capability here is
 * exposed to the agent as a `browser_*` tool (see ../harness/tools.ts).
 *
 * ISOLATION: every capability is keyed by a session key (a chat id), and each
 * key gets its OWN window, tab list, active tab and console log. Concurrent
 * chats therefore drive independent browsers and never clobber each other's
 * tabs. They still share the `persist:` partition, so a login in one session is
 * a login in all. A shared DEFAULT key backs the manual "Open browser" button
 * and any caller that doesn't pass a key (e.g. the smoke test).
 */
import { BrowserView, BrowserWindow } from 'electron'
import { is } from '@electron-toolkit/utils'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  OVERLAY_HEIGHT,
  applyWindowChrome,
  initialBackgroundColor,
  chromePlatform,
  initialOverlay
} from './window-chrome'
import { resolveThemeById } from './themes'
import { getSettings } from '../db/repo'
import { CHANNELS } from '../../shared/ipc'
import type { BrowserState, BrowserTab } from '../../shared/api'
import { attachNativeContextMenu } from './context-menu'
import { BROWSER_PARTITION, ensureApplied as ensureProxyApplied } from './browser-proxy'
import type { ResolvedTheme } from '../../shared/theme'

/** Persisted session â†’ cookies, localStorage and logins survive app restarts. */
export const PARTITION = BROWSER_PARTITION
const MAX_CONSOLE = 500
/** Height of the chrome overlaid at the top: tab strip + URL-bar toolbar. */
const CHROME_H = 80
/** Where a blank/new tab lands â€” a homepage, like a normal browser. */
const HOME_URL = 'https://www.google.com'
/** The shared window used by the manual "Open browser" button and keyless callers. */
const DEFAULT_KEY = '__default__'

/** App icon path, injected from main (so this file has no `?asset` import â€” the
 *  smoke harness bundles it with esbuild, which doesn't understand `?asset`). */
let appIconPath: string | undefined
export function setAppIcon(p: string): void {
  appIconPath = p
}

export interface ConsoleEntry {
  /** 0=verbose, 1=info, 2=warning, 3=error (Electron's console level). */
  level: number
  message: string
  line?: number
  url?: string
  ts: number
}

/** One open tab â€” a persistent-session page view. The active tab fills the
 *  window; the rest sit at zero size (still alive, so their pages are kept). */
interface Tab {
  id: string
  view: BrowserView
  /** The real URL represented by our internal load-error document. */
  errorUrl?: string
  errorPageUrl?: string
  errorSeq: number
}

/** One isolated browser â€” a window + its tabs + console, owned by a session key. */
interface Session {
  key: string
  /** A human label (usually the project folder) shown in the window title. */
  label?: string
  win: BrowserWindow | null
  tabs: Tab[]
  activeTabId: string | null
  consoleLog: ConsoleEntry[]
  tabSeq: number
  /**
   * Chrome height in px when a chrome panel (the cookie editor) is open.
   * BrowserViews always paint ABOVE the window's own webContents, so a panel
   * rendered in the chrome would be hidden behind the page. Growing the chrome
   * instead pushes the page view down out of sight -- the panel is genuinely
   * on top, with no z-index fight to lose.
   */
  chromeH?: number
}

/** Every live browser, keyed by session (chat) id. */
const sessions = new Map<string, Session>()

/** The session for `key`, creating an empty one on first use. */
function getSession(key: string): Session {
  let s = sessions.get(key)
  if (!s) {
    s = { key, win: null, tabs: [], activeTabId: null, consoleLog: [], tabSeq: 0 }
    sessions.set(key, s)
  }
  return s
}

/** The session for `key` WITHOUT creating one â€” for read/nav ops that must not spawn a window. */
function peek(key: string): Session | undefined {
  return sessions.get(key)
}

/** The active tab's view for a session, or null when there's no usable tab. */
function activeView(s: Session): BrowserView | null {
  const t = s.tabs.find((x) => x.id === s.activeTabId)
  return t && !t.view.webContents.isDestroyed() ? t.view : null
}

/** The active page's contents for `key` â€” what every browser_* tool drives. */
function pageContents(key: string): Electron.WebContents {
  const s = peek(key)
  const v = s ? activeView(s) : null
  if (!v) throw new Error('No browser is open. Use browser_open first.')
  return v.webContents
}

/** The window title for a session â€” names the project so windows are tellable apart. */
function windowTitle(s: Session): string {
  return s.label ? `Roxy Browser â€” ${s.label}` : 'Roxy Browser'
}

function ensureWindow(s: Session): BrowserWindow {
  if (s.win && !s.win.isDestroyed()) {
    if (!activeView(s)) createTab(s)
    return s.win
  }
  s.consoleLog = []
  s.tabs = []
  s.activeTabId = null
  const isMac = process.platform === 'darwin'
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: true,
    title: windowTitle(s),
    backgroundColor: initialBackgroundColor(),
    autoHideMenuBar: true,
    ...(isMac || !appIconPath ? {} : { icon: appIconPath }),
    // Hide the native OS title bar â€” our React chrome (tab strip + URL bar) IS
    // the title bar. Keep native window controls, themed to match (no second
    // light bar stacked on top of the chrome).
    titleBarStyle: 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 12, y: 14 } }
      : { titleBarOverlay: initialOverlay(OVERLAY_HEIGHT.browser) }),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  s.win = win

  // A window opened AFTER a theme change would otherwise wear the constructor's
  // fallback colors, since the theme broadcast only reaches windows that already
  // existed. Catch it up immediately.
  void resolveThemeById(getSettings().activeThemeId, chromePlatform()).then((theme) =>
    applyWindowChrome(win, theme)
  )

  // The chrome (tab strip + URL bar) is a real React app rendered into the
  // WINDOW's OWN webContents â€” not a BrowserView â€” so its title-bar strip is
  // draggable via `-webkit-app-region` (which doesn't work inside a BrowserView)
  // and the native control overlay lands on it cleanly. Page tabs sit in
  // BrowserViews on top, below the chrome. Best-effort load (the test harness
  // has no bundled browser.html â€” the pages still work).
  win.webContents.once('did-finish-load', () => {
    pushState(s)
    pushTabs(s)
  })
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.webContents
      .loadURL(`${process.env['ELECTRON_RENDERER_URL']}/browser.html`)
      .catch(() => undefined)
  } else {
    void win.webContents
      .loadFile(path.join(__dirname, '../renderer/browser.html'))
      .catch(() => undefined)
  }

  win.on('resize', () => layout(s))
  win.on('closed', () => {
    // The window is gone (user hit X, or we closed it). Drop the session so a
    // later browser_* call lazily spins up a fresh one for this key.
    sessions.delete(s.key)
  })

  createTab(s)
  return win
}

/** Lay out the chrome strip + active page; park inactive tabs at zero size. */
function layout(s: Session): void {
  if (!s.win || s.win.isDestroyed()) return
  const { width, height } = s.win.getContentBounds()
  const top = s.chromeH ?? CHROME_H
  for (const t of s.tabs) {
    if (t.view.webContents.isDestroyed()) continue
    t.view.setBounds(
      t.id === s.activeTabId
        ? { x: 0, y: top, width, height: Math.max(0, height - top) }
        : { x: 0, y: 0, width: 0, height: 0 }
    )
  }
}

/**
 * Reserve height px of window for the chrome, so a chrome-rendered panel can
 * cover the page. Pass 0/undefined to restore the normal toolbar height.
 *
 * Clamped to the window, because a panel taller than the window would push the
 * page view to a negative height and Chromium would reject the bounds.
 */
export function setChromeHeight(height: number, key: string = DEFAULT_KEY): void {
  const s = peek(key)
  if (!s || !s.win || s.win.isDestroyed()) return
  const max = s.win.getContentBounds().height
  s.chromeH = height > CHROME_H ? Math.min(height, max) : undefined
  layout(s)
}

/** Create a tab (optionally at a URL) and make it active. Assumes a window. */
function createTab(s: Session, rawUrl?: string): string {
  if (!s.win || s.win.isDestroyed()) return ''
  const view = new BrowserView({
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  const id = `tab-${++s.tabSeq}`
  const tab: Tab = { id, view, errorSeq: 0 }
  s.tabs.push(tab)
  s.win.addBrowserView(view)
  wireTab(s, tab)
  s.activeTabId = id
  layout(s)
  pushTabs(s)
  void ensureProxyApplied()
    .then(() => view.webContents.loadURL(rawUrl ? normalizeUrl(rawUrl) : HOME_URL))
    .catch(() => undefined)
  return id
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!
  )
}

function loadErrorCopy(errorCode: number, host: string): string {
  switch (errorCode) {
    case -106:
      return 'Your internet connection appears to be offline.'
    case -105:
      return `We couldn't find an address for ${host}.`
    case -102:
      return `${host} refused the connection.`
    case -118:
      return `${host} took too long to respond.`
    case -109:
      return `${host} couldn't be reached from this network.`
    case -111:
    case -130:
      return 'The browser proxy could not connect to this site.'
    default:
      return `${host} didn't answer this time.`
  }
}

/** A small themed document shown inside the tab instead of Chromium's blank failure surface. */
function loadErrorPage(
  failedUrl: string,
  errorCode: number,
  errorDescription: string,
  theme: ResolvedTheme | null
): string {
  let host = failedUrl
  try {
    host = new URL(failedUrl).hostname || failedUrl
  } catch {
    // Keep the original string when Chromium reports a non-standard URL.
  }
  const vars = theme?.vars
  const bg = vars?.['--color-bg'] ?? '#0a0a0a'
  const surface = vars?.['--color-surface'] ?? '#141416'
  const border = vars?.['--color-border'] ?? '#2a2a2e'
  const text = vars?.['--color-text'] ?? '#f4f4f5'
  const muted = vars?.['--color-text-muted'] ?? '#a1a1aa'
  const subtle = vars?.['--color-text-subtle'] ?? '#71717a'
  const accent = vars?.['--color-accent'] ?? '#7c8cff'
  const accentHover = vars?.['--color-accent-hover'] ?? accent
  const contrast = vars?.['--color-white'] ?? '#ffffff'
  const contrastText = vars?.['--color-black'] ?? '#000000'
  const fontSans = vars?.['--font-sans'] ?? 'ui-sans-serif, system-ui, sans-serif'
  const fontMono = vars?.['--font-mono'] ?? 'ui-monospace, SFMono-Regular, Consolas, monospace'
  const safeCss = (value: string): string => value.replace(/</g, '\\3c ')
  const detail = errorDescription.replace(/^ERR_/, '').replaceAll('_', ' ').toLowerCase()

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Couldn't reach ${escapeHtml(host)}</title>
  <style>
    :root {
      color-scheme: ${theme?.appearance === 'light' ? 'light' : 'dark'};
      --error-bg: ${safeCss(bg)};
      --error-surface: ${safeCss(surface)};
      --error-border: ${safeCss(border)};
      --error-text: ${safeCss(text)};
      --error-muted: ${safeCss(muted)};
      --error-subtle: ${safeCss(subtle)};
      --error-accent: ${safeCss(accent)};
      --error-accent-hover: ${safeCss(accentHover)};
      --error-contrast: ${safeCss(contrast)};
      --error-contrast-text: ${safeCss(contrastText)};
      --error-font-sans: ${safeCss(fontSans)};
      --error-font-mono: ${safeCss(fontMono)};
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 40px 24px; background: var(--error-bg); color: var(--error-text); font-family: var(--error-font-sans); }
    main { width: min(100%, 520px); }
    .illustration { position: relative; width: 116px; height: 116px; margin-bottom: 28px; display: grid; place-items: center; border: 1px solid var(--error-border); border-radius: 32px; background: var(--error-surface); transform: rotate(-2deg); }
    .spark { position: absolute; right: -9px; top: 13px; width: 25px; height: 25px; color: var(--error-accent); }
    svg { width: 72px; height: 72px; color: var(--error-muted); transform: rotate(2deg); }
    h1 { margin: 0; font-size: clamp(27px, 4vw, 36px); line-height: 1.12; letter-spacing: -0.035em; text-wrap: balance; }
    .host { color: var(--error-accent); overflow-wrap: anywhere; }
    .message { margin: 14px 0 0; max-width: 440px; color: var(--error-muted); font-size: 15px; line-height: 1.65; text-wrap: pretty; }
    .actions { display: flex; align-items: center; gap: 14px; margin-top: 28px; }
    .retry { display: inline-flex; min-height: 40px; align-items: center; justify-content: center; padding: 0 18px; border-radius: 12px; background: var(--error-contrast); color: var(--error-contrast-text); font-size: 14px; font-weight: 650; text-decoration: none; transition: transform 140ms cubic-bezier(.23, 1, .32, 1), opacity 140ms ease; }
    .retry:focus-visible { outline: 2px solid var(--error-accent); outline-offset: 3px; }
    .retry:active { transform: scale(.97); }
    .hint { color: var(--error-subtle); font-size: 12px; }
    .detail { margin-top: 44px; color: var(--error-subtle); font-family: var(--error-font-mono); font-size: 11px; letter-spacing: .02em; }
    @media (hover: hover) and (pointer: fine) { .retry:hover { opacity: .82; transform: translateY(-1px); } }
    @media (max-width: 520px) { body { place-items: start; padding-top: 14vh; } .actions { align-items: flex-start; flex-direction: column; gap: 10px; } }
    @media (prefers-reduced-motion: reduce) { .retry { transition: opacity 140ms ease; } .retry:active { transform: none; } }
  </style>
</head>
<body>
  <main id="roxy-browser-error">
    <div class="illustration" aria-hidden="true">
      <svg viewBox="0 0 80 80" fill="none">
        <path d="M25 14v12m30-12v12M19 12h12v13a9 9 0 0 1-9 9h-3V12Zm30 0h12v22h-3a9 9 0 0 1-9-9V12Z" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M40 31v12c0 8-6 14-14 14H16" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>
        <path d="M13 51 7 57l6 6" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M47 55c4-4 11-4 15 0m-12 9h9" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>
      </svg>
      <svg class="spark" viewBox="0 0 24 24" fill="none"><path d="m12 2 1.6 6.4L20 10l-6.4 1.6L12 18l-1.6-6.4L4 10l6.4-1.6L12 2Z" fill="currentColor"/></svg>
    </div>
    <h1>We couldn't reach <span class="host">${escapeHtml(host)}</span></h1>
    <p class="message">${escapeHtml(loadErrorCopy(errorCode, host))} Check the address or your connection, then give it another try.</p>
    <div class="actions">
      <a class="retry" href="${escapeHtml(failedUrl)}">Try again</a>
      <span class="hint">You can also use the reload button above.</span>
    </div>
    <div class="detail">${escapeHtml(detail)} &middot; ${errorCode}</div>
  </main>
</body>
</html>`
}

async function showLoadError(
  s: Session,
  tab: Tab,
  failedUrl: string,
  errorCode: number,
  errorDescription: string
): Promise<void> {
  if (!failedUrl || tab.view.webContents.isDestroyed()) return
  const token = ++tab.errorSeq
  tab.errorUrl = failedUrl
  pushState(s)
  pushTabs(s)
  const theme = await resolveThemeById(getSettings().activeThemeId, chromePlatform()).catch(
    () => null
  )
  if (tab.errorSeq !== token || tab.errorUrl !== failedUrl || tab.view.webContents.isDestroyed()) {
    return
  }
  const html = loadErrorPage(failedUrl, errorCode, errorDescription, theme)
  const errorPageUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
  tab.errorPageUrl = errorPageUrl
  await tab.view.webContents.loadURL(errorPageUrl).catch(() => undefined)
  if (tab.errorSeq === token) {
    pushState(s)
    pushTabs(s)
  }
}

/** Console + navigation listeners for a tab's page. */
function wireTab(s: Session, tab: Tab): void {
  const wc = tab.view.webContents
  // Real websites in a BrowserView have no React tree of ours to portal a
  // themed menu into, so these pages get the NATIVE right-click editing menu.
  attachNativeContextMenu(wc)
  wc.on('console-message', (_e, level, message, line, sourceId) => {
    s.consoleLog.push({ level, message, line, url: sourceId, ts: Date.now() })
    if (s.consoleLog.length > MAX_CONSOLE) s.consoleLog = s.consoleLog.slice(-MAX_CONSOLE)
  })
  const onNav = (): void => {
    if (tab.id === s.activeTabId) pushState(s)
    pushTabs(s)
  }
  wc.on('did-start-navigation', (_e, url, isInPlace, isMainFrame) => {
    if (
      !isMainFrame ||
      isInPlace ||
      url === tab.errorPageUrl ||
      url.startsWith('chrome-error://')
    ) {
      return
    }
    tab.errorSeq++
    tab.errorUrl = undefined
    tab.errorPageUrl = undefined
    onNav()
  })
  wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (isMainFrame && errorCode !== -3 /* not a benign ERR_ABORTED */) {
      s.consoleLog.push({
        level: 3,
        message: `Failed to load ${validatedURL}: ${errorDescription} (${errorCode})`,
        ts: Date.now()
      })
      if (validatedURL !== tab.errorPageUrl && !validatedURL.startsWith('chrome-error://')) {
        void showLoadError(s, tab, validatedURL, errorCode, errorDescription)
      }
    }
  })
  wc.on('did-navigate', onNav)
  wc.on('did-navigate-in-page', onNav)
  wc.on('did-start-loading', onNav)
  wc.on('did-stop-loading', onNav)
  wc.on('page-title-updated', onNav)
}

/** Send a session's active-tab navigation state to its toolbar. */
function pushState(s: Session): void {
  const tab = s.tabs.find((entry) => entry.id === s.activeTabId)
  if (!tab || !s.win || s.win.isDestroyed() || s.win.webContents.isDestroyed()) return
  const wc = tab.view.webContents
  if (wc.isDestroyed()) return
  const state: BrowserState = {
    url: tab.errorUrl ?? wc.getURL(),
    title: tab.errorUrl ? errorTabTitle(tab.errorUrl) : wc.getTitle(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    loading: wc.isLoadingMainFrame()
  }
  s.win.webContents.send(CHANNELS.browserState, state)
}

function errorTabTitle(url: string): string {
  try {
    return `Couldn't reach ${new URL(url).hostname}`
  } catch {
    return "Couldn't reach this site"
  }
}

/** The open tabs for a session (id, title, url, active). */
function tabsOf(s: Session): BrowserTab[] {
  return s.tabs.map((t) => {
    const dead = t.view.webContents.isDestroyed()
    return {
      id: t.id,
      title: dead
        ? ''
        : t.errorUrl
          ? errorTabTitle(t.errorUrl)
          : t.view.webContents.getTitle() || 'New tab',
      url: dead ? '' : (t.errorUrl ?? t.view.webContents.getURL()),
      active: t.id === s.activeTabId
    }
  })
}

/** The open tabs for `key` â€” also used by the browser_tabs tool. */
export function listTabs(key: string = DEFAULT_KEY): BrowserTab[] {
  const s = peek(key)
  return s ? tabsOf(s) : []
}

/** Send a session's open tab list to its toolbar tab strip. */
function pushTabs(s: Session): void {
  if (!s.win || s.win.isDestroyed() || s.win.webContents.isDestroyed()) return
  s.win.webContents.send(CHANNELS.browserTabs, tabsOf(s))
}

/** Add a scheme when the user/agent passes a bare host like "github.com". */
function normalizeUrl(input: string): string {
  const url = input.trim()
  if (!url) return 'about:blank'
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) || url.startsWith('about:')) return url
  return `https://${url}`
}

/** Resolve which session (key) owns a chrome window's webContents, or null. */
export function keyForContents(wc: Electron.WebContents): string | null {
  for (const s of sessions.values()) {
    if (s.win && !s.win.isDestroyed() && s.win.webContents === wc) return s.key
  }
  return null
}

/** Label a session's window (usually the project folder), so windows are tellable apart. */
export function setLabel(key: string, label: string): void {
  if (key === DEFAULT_KEY) return
  const s = getSession(key)
  s.label = label
  if (s.win && !s.win.isDestroyed()) s.win.setTitle(windowTitle(s))
}

export async function open(
  rawUrl: string,
  key: string = DEFAULT_KEY
): Promise<{ url: string; title: string; error?: string }> {
  const s = getSession(key)
  ensureWindow(s)
  const wc = pageContents(key)
  const url = normalizeUrl(rawUrl)
  // Show the window so you can watch the agent browse, but DON'T steal focus
  // (showInactive) â€” the agent driving the browser shouldn't yank you out of
  // whatever you're typing. The Settings "Open browser" button (openWindow)
  // still focuses it for manual sign-in.
  if (s.win?.isMinimized()) s.win.restore()
  s.win?.showInactive()
  let error: string | undefined
  try {
    await ensureProxyApplied()
    await wc.loadURL(url)
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
  const reportedUrl = currentUrl(key) || url
  const tab = s.tabs.find((entry) => entry.id === s.activeTabId)
  return {
    url: reportedUrl,
    title: tab?.errorUrl ? errorTabTitle(reportedUrl) : wc.getTitle(),
    error
  }
}

export async function screenshot(
  saveDir?: string,
  key: string = DEFAULT_KEY
): Promise<{ dataUrl: string; width: number; height: number; savedTo?: string }> {
  const wc = pageContents(key)
  const s = peek(key)
  if (s?.win?.isMinimized()) s.win.restore()
  let image = await wc.capturePage()
  const { width: rawWidth } = image.getSize()
  // Downscale large captures so the inline preview stays light.
  if (rawWidth > 1280) image = image.resize({ width: 1280 })
  const { width, height } = image.getSize()
  const dataUrl = `data:image/jpeg;base64,${image.toJPEG(72).toString('base64')}`

  let savedTo: string | undefined
  if (saveDir) {
    const dir = path.join(saveDir, '.roxy', 'screenshots')
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, `shot-${Date.now()}.png`)
    await fs.writeFile(file, image.toPNG())
    savedTo = path.relative(saveDir, file)
  }
  return { dataUrl, width, height, savedTo }
}

export async function getHtml(selector?: string, key: string = DEFAULT_KEY): Promise<string> {
  const code = selector
    ? `(() => { const el = document.querySelector(${JSON.stringify(selector)});` +
      ` return el ? el.outerHTML : ${JSON.stringify(`(no element matches "${selector}")`)}; })()`
    : 'document.documentElement.outerHTML'
  const html: unknown = await pageContents(key).executeJavaScript(code)
  return typeof html === 'string' ? html : String(html)
}

export function getConsole(key: string = DEFAULT_KEY): {
  entries: ConsoleEntry[]
  errors: number
  warnings: number
} {
  const s = peek(key)
  const log = s?.consoleLog ?? []
  const errors = log.filter((e) => e.level >= 3).length
  const warnings = log.filter((e) => e.level === 2).length
  return { entries: [...log], errors, warnings }
}

export function currentUrl(key: string = DEFAULT_KEY): string | null {
  const s = peek(key)
  const tab = s?.tabs.find((entry) => entry.id === s.activeTabId)
  return tab ? (tab.errorUrl ?? tab.view.webContents.getURL()) : null
}

/** Close a session's browser (window + all its tabs). */
export function close(key: string = DEFAULT_KEY): void {
  const s = sessions.get(key)
  if (!s) return
  if (s.win && !s.win.isDestroyed())
    s.win.close() // fires 'closed' â†’ sessions.delete
  else sessions.delete(key)
}

/** Tear down a session's browser when its chat is deleted. */
export function disposeSession(key: string): void {
  close(key)
}

/** Close every browser window (app shutdown). */
export function closeAll(): void {
  for (const key of [...sessions.keys()]) close(key)
}

/** Keep already-open internal error pages in step with live theme changes. */
export function applyThemeToErrorPages(theme: ResolvedTheme): void {
  const vars = theme.vars
  const errorVars: Record<string, string> = {
    '--error-bg': vars['--color-bg'] ?? '#0a0a0a',
    '--error-surface': vars['--color-surface'] ?? '#141416',
    '--error-border': vars['--color-border'] ?? '#2a2a2e',
    '--error-text': vars['--color-text'] ?? '#f4f4f5',
    '--error-muted': vars['--color-text-muted'] ?? '#a1a1aa',
    '--error-subtle': vars['--color-text-subtle'] ?? '#71717a',
    '--error-accent': vars['--color-accent'] ?? '#7c8cff',
    '--error-accent-hover': vars['--color-accent-hover'] ?? '#7c8cff',
    '--error-contrast': vars['--color-white'] ?? '#ffffff',
    '--error-contrast-text': vars['--color-black'] ?? '#000000',
    '--error-font-sans': vars['--font-sans'] ?? 'ui-sans-serif, system-ui, sans-serif',
    '--error-font-mono': vars['--font-mono'] ?? 'ui-monospace, SFMono-Regular, Consolas, monospace'
  }
  const code = `(() => {
    document.documentElement.style.colorScheme = ${JSON.stringify(theme.appearance)};
    const vars = ${JSON.stringify(errorVars)};
    for (const [name, value] of Object.entries(vars)) document.documentElement.style.setProperty(name, value);
  })()`
  for (const s of sessions.values()) {
    for (const tab of s.tabs) {
      if (!tab.errorUrl || tab.view.webContents.isDestroyed()) continue
      void tab.view.webContents.executeJavaScript(code).catch(() => undefined)
    }
  }
}

/** Open a new tab (optionally at a URL) and make it active. */
export function newTab(rawUrl?: string, key: string = DEFAULT_KEY): void {
  const s = getSession(key)
  ensureWindow(s)
  createTab(s, rawUrl)
}

/** Switch the visible tab. */
export function activateTab(id: string, key: string = DEFAULT_KEY): void {
  const s = peek(key)
  if (!s || !s.tabs.some((t) => t.id === id)) return
  s.activeTabId = id
  layout(s)
  pushState(s)
  pushTabs(s)
}

/** Reorder a tab to a new index in the strip (drag-to-reorder from the chrome). */
export function moveTab(id: string, toIndex: number, key: string = DEFAULT_KEY): void {
  const s = peek(key)
  if (!s) return
  const from = s.tabs.findIndex((t) => t.id === id)
  if (from === -1) return
  const to = Math.max(0, Math.min(toIndex, s.tabs.length - 1))
  if (from === to) return
  const [tab] = s.tabs.splice(from, 1)
  s.tabs.splice(to, 0, tab)
  pushTabs(s)
}

/** Close a tab; activate a neighbour, or close the window if it was the last. */
export function closeTab(id: string, key: string = DEFAULT_KEY): void {
  const s = peek(key)
  if (!s) return
  const idx = s.tabs.findIndex((t) => t.id === id)
  if (idx === -1) return
  const [tab] = s.tabs.splice(idx, 1)
  if (s.win && !s.win.isDestroyed()) s.win.removeBrowserView(tab.view)
  try {
    tab.view.webContents.close()
  } catch {
    // a removed view will be garbage-collected
  }
  if (s.activeTabId === id) {
    const next = s.tabs[idx] ?? s.tabs[idx - 1] ?? null
    if (next) {
      s.activeTabId = next.id
      layout(s)
      pushState(s)
    } else {
      close(key)
      return
    }
  }
  pushTabs(s)
}

/** Open (or focus) the browser window so the user can browse / sign in manually. */
export function openWindow(key: string = DEFAULT_KEY): void {
  const s = getSession(key)
  ensureWindow(s)
  if (s.win?.isMinimized()) s.win.restore()
  s.win?.show()
  s.win?.focus()
  if (!pageContents(key).getURL()) {
    void ensureProxyApplied()
      .then(() => pageContents(key).loadURL(HOME_URL))
      .catch(() => undefined)
  }
}

export async function navigate(rawUrl: string, key: string = DEFAULT_KEY): Promise<void> {
  const s = getSession(key)
  ensureWindow(s)
  try {
    await ensureProxyApplied()
    await pageContents(key).loadURL(normalizeUrl(rawUrl))
  } catch {
    // surfaced via did-fail-load / the toolbar
  }
}

export function back(key: string = DEFAULT_KEY): void {
  const s = peek(key)
  const wc = (s && activeView(s)?.webContents) ?? null
  if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
}

export function forward(key: string = DEFAULT_KEY): void {
  const s = peek(key)
  const wc = (s && activeView(s)?.webContents) ?? null
  if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
}

export function reload(key: string = DEFAULT_KEY): void {
  const s = peek(key)
  const tab = s?.tabs.find((entry) => entry.id === s.activeTabId)
  if (!tab) return
  if (tab.errorUrl) void navigate(tab.errorUrl, key)
  else tab.view.webContents.reload()
}

export function stop(key: string = DEFAULT_KEY): void {
  const s = peek(key)
  if (s) activeView(s)?.webContents.stop()
}

/** Click the first element matching a CSS selector. */
export async function click(selector: string, key: string = DEFAULT_KEY): Promise<string> {
  if (!selector.trim()) return 'browser_click: missing "selector"'
  const code = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'not-found'; el.scrollIntoView({ block: 'center' }); el.click(); return 'clicked'; })()`
  const r = await pageContents(key).executeJavaScript(code, true)
  return r === 'clicked' ? `Clicked ${selector}` : `No element matches "${selector}".`
}

/** Scroll the page: to a selector, or by direction (up/down/top/bottom). */
export async function scroll(
  opts: {
    selector?: string
    direction?: string
    amount?: number
  },
  key: string = DEFAULT_KEY
): Promise<string> {
  const { selector, direction, amount } = opts
  let code: string
  if (selector?.trim()) {
    code = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'not-found'; el.scrollIntoView({ behavior: 'instant', block: 'center' }); return 'ok'; })()`
  } else {
    const dy = typeof amount === 'number' ? amount : 700
    const expr =
      direction === 'top'
        ? 'window.scrollTo(0, 0)'
        : direction === 'bottom'
          ? 'window.scrollTo(0, document.body.scrollHeight)'
          : direction === 'up'
            ? `window.scrollBy(0, ${-dy})`
            : `window.scrollBy(0, ${dy})`
    code = `(() => { ${expr}; return 'ok'; })()`
  }
  const r = await pageContents(key).executeJavaScript(code, true)
  return r === 'not-found' ? `No element matches "${selector}".` : 'Scrolled.'
}

/** Type text into an input/textarea/contenteditable matching a selector. */
export async function type(
  selector: string,
  text: string,
  key: string = DEFAULT_KEY
): Promise<string> {
  if (!selector.trim()) return 'browser_type: missing "selector"'
  const code = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'not-found'; el.focus(); if ('value' in el) { el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); } else { el.textContent = ${JSON.stringify(text)}; } return 'ok'; })()`
  const r = await pageContents(key).executeJavaScript(code, true)
  return r === 'ok' ? `Typed into ${selector}.` : `No element matches "${selector}".`
}
