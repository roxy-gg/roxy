import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import macDockIcon from '../../resources/icon-mac.png?asset'
import { registerIpc } from './ipc'
import { getDb } from './db/database'
import { startLoopScheduler } from './services/loops'
import { listModels } from './services/models'
import { backfillUsageFromHistory } from './services/usage'
import { listConnectedProviders } from './db/repo'
import { setAppIcon, closeAll as closeAllBrowsers } from './services/browser'
import { APP_USER_MODEL_ID, setToastIcon } from './services/notifications'
import { cleanupToolOutputs } from './services/tool-output-store'
import { cancelAllBackgroundJobs } from './services/background-tasks'
import { shutdownAllLsp } from './services/lsp'
import { shutdownAllMcp } from './services/mcp'
import { shutdownRemote } from './services/remote'
import { shutdownCliProxy } from './services/cliproxy'
import { initAutoUpdater } from './services/updater'
import { initTracking, shutdownTracking } from './services/track'
import { killAllBackground, setPromptText, setAgentPromptText } from './harness'
import { PROMPT_TEXT, AGENT_PROMPT_TEXT } from '../shared/prompt-text'
import {
  OVERLAY_HEIGHT,
  applyWindowChrome,
  chromePlatform,
  initialBackgroundColor,
  initialOverlay
} from './services/window-chrome'
import { resolveThemeById } from './services/themes'
import * as repo from './db/repo'

function createWindow(): BrowserWindow {
  const isMac = process.platform === 'darwin'
  const mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 760,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: initialBackgroundColor(),
    title: 'Roxy',
    // Native window controls, themed to match the app (no light OS title bar).
    titleBarStyle: 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 16, y: 17 } }
      : { titleBarOverlay: initialOverlay(OVERLAY_HEIGHT.main) }),
    ...(isMac ? {} : { icon }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    // Repaint the native window controls from the active theme before the
    // window is first shown. The constructor can only reach built-in themes
    // synchronously; this covers a user theme, whose file has to be read.
    void resolveThemeById(repo.getSettings().activeThemeId, chromePlatform())
      .then((theme) => applyWindowChrome(mainWindow, theme))
      .catch(() => undefined)
    mainWindow.show()
  })

  // Open external links in the user's browser instead of a new Electron window.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Load the Vite dev server in development, or the built HTML in production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

/**
 * Warm the models.dev catalog for each connected provider (so `modelCost` can
 * price rows), then run the one-time history backfill. Fully best-effort — any
 * failure just leaves backfilled rows unpriced, which real turns fill in later.
 */
async function warmCatalogThenBackfill(): Promise<void> {
  try {
    const providers = listConnectedProviders()
    // Pull each provider's catalog once; listModels caches it process-wide, which
    // is exactly what modelCost() reads from.
    await Promise.allSettled(providers.map((p) => listModels(p.id)))
  } catch {
    // ignore — backfill still runs, just possibly unpriced
  }
  backfillUsageFromHistory()
}

app.whenReady().then(() => {
  // NOT electronApp.setAppUserModelId from @electron-toolkit/utils: in dev it
  // substitutes `process.execPath`, and Windows prints the AUMID verbatim as
  // the toast's header - which is how a full C:\Users\... path ended up above
  // every notification. The id is constant so dev matches what ships.
  app.setAppUserModelId(APP_USER_MODEL_ID)
  // Give the agent's browser window the Roxy icon too (no asset import in the
  // browser service so the smoke's esbuild bundle stays happy).
  setAppIcon(icon)
  // Same icon on the toast; see the note in services/notifications.ts.
  setToastIcon(icon)
  // Inject the tuned per-model + per-agent prompt text into the harness (imported
  // via `?raw` here in the Vite-built entry, so the esbuild smoke bundle never
  // sees it).
  setPromptText(PROMPT_TEXT)
  setAgentPromptText(AGENT_PROMPT_TEXT)

  if (process.platform === 'darwin') {
    // Use the padded variant so the dock icon matches Apple's size convention
    // (the full-bleed resources/icon.png would render oversized next to native apps).
    app.dock?.setIcon(macDockIcon)
  }

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Open the database (runs migrations) and wire up IPC before the first window.
  getDb()
  registerIpc()
  // Anonymous usage tracking (opt-out in Settings). Deliberately after the DB
  // and IPC are up so nothing here can delay the first window, and it owns its
  // own storage - a failure in it can't touch either.
  initTracking()
  startLoopScheduler()
  // Sweep tool-output spill files older than the retention window (best-effort).
  void cleanupToolOutputs()
  // One-time: seed the usage/cost table from existing message history so the
  // dashboard isn't empty after upgrading. Warm the models.dev catalog first so
  // backfilled rows can be priced (else they'd all cost $0). Best-effort + async.
  void warmCatalogThenBackfill()

  const mainWindow = createWindow()
  initAutoUpdater(mainWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Kill any agent-started background processes (dev servers/watchers) on quit,
// cancel any in-flight background subagent tasks (Phase 11), and shut down any
// warm language servers (Phase 12).
// Last chance to send the queued events: 'before-quit' fires before windows
// start tearing down, which gives the final flush a real (if not guaranteed)
// window to reach the network. Losing it costs one app_close, nothing more.
app.on('before-quit', () => {
  shutdownTracking()
})

app.on('will-quit', () => {
  killAllBackground()
  cancelAllBackgroundJobs()
  closeAllBrowsers()
  shutdownAllLsp()
  void shutdownAllMcp()
  shutdownRemote()
  // The Codex sidecar holds the user's subscription tokens - never leave it
  // running (and listening on loopback) after the app that owns it is gone.
  shutdownCliProxy()
})
