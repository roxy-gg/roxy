/**
 * Writing Web Storage into the Roxy browser's partition.
 *
 * Cookies have a first-class Electron API (`session.cookies`). localStorage
 * does NOT: there is no `session.setStorage`, and `clearStorageData` can only
 * delete. The only supported way to populate an origin's storage is to BE that
 * origin — load it in a page on the target partition and assign through the
 * real `window.localStorage`.
 *
 * So this opens a hidden, offscreen window on `persist:roxy-browser`, navigates
 * to the origin, writes, and disposes it. Two consequences worth knowing:
 *
 *   - It performs a real navigation to the site. We request `about:blank`-like
 *     minimal work by aborting the load as soon as the document exists, but the
 *     origin must be reachable for the browser to grant us a storage context.
 *   - `sessionStorage` is per browsing-context. Writing it in a throwaway window
 *     would be pointless — it dies with the window — so session storage is
 *     applied to a LIVE tab instead (see `applySessionStorage`).
 *
 * Everything here is origin-scoped and main-only. The renderer never gets a
 * `webContents` or an arbitrary `executeJavaScript`, because that would be a
 * general-purpose code-execution channel wearing a storage costume.
 */
import { BrowserWindow } from 'electron'
import { PARTITION } from './browser'
import { isImportableOrigin, type RelayStorage } from '../../shared/relay'

/** How long to wait for the origin to produce a document before giving up. */
const LOAD_TIMEOUT_MS = 15_000

/**
 * The script that does the writing, built with the payload inlined as JSON.
 *
 * Values are injected as a single JSON literal rather than interpolated one by
 * one: a cookie/token value containing a quote or a backslash would otherwise
 * break out of the string and run as code in the page's own origin. `JSON
 * .stringify` of the whole record is exactly one safe literal.
 *
 * Storage can throw even when present (Safari-style private mode, quota, a
 * site's own hardening), so each key is attempted independently and failures
 * are counted rather than aborting the batch.
 */
function writerScript(kind: 'localStorage' | 'sessionStorage', data: RelayStorage): string {
  return `(() => {
    const data = ${JSON.stringify(data)};
    let ok = 0;
    let failed = 0;
    try {
      const store = window.${kind};
      for (const k of Object.keys(data)) {
        try { store.setItem(k, data[k]); ok++; } catch { failed++; }
      }
    } catch {
      return { ok: 0, failed: Object.keys(data).length, blocked: true };
    }
    return { ok, failed, blocked: false };
  })()`
}

export interface StorageWriteResult {
  ok: number
  failed: number
  /** The origin denied storage access outright (third-party blocking, etc). */
  blocked: boolean
}

/**
 * Write `data` into `origin`'s localStorage on the browser partition.
 *
 * Throws on an unusable origin or an unreachable site; per-key failures come
 * back in the result instead, since a partial import is still useful.
 */
export async function writeLocalStorage(
  origin: string,
  data: RelayStorage
): Promise<StorageWriteResult> {
  if (!isImportableOrigin(origin)) throw new Error(`Cannot write storage for "${origin}".`)
  if (!Object.keys(data).length) return { ok: 0, failed: 0, blocked: false }

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      partition: PARTITION,
      // This window exists to touch one origin's storage. It must not get
      // Node, a preload, or any bridge into the app.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // Never surface this window; it is machinery, not UI.
      offscreen: false
    }
  })

  try {
    await loadOrigin(win, origin)
    return (await win.webContents.executeJavaScript(
      writerScript('localStorage', data),
      true
    )) as StorageWriteResult
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

/**
 * Navigate to `origin` far enough to have a storage context, then stop.
 *
 * We resolve on `dom-ready` rather than `did-finish-load` so a site with slow
 * or hanging subresources doesn't stall the import — the document (and thus
 * `window.localStorage`) exists by then. The load is halted immediately after,
 * so we don't sit there running the site's scripts.
 */
function loadOrigin(win: BrowserWindow, origin: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out loading ${origin}.`))
    }, LOAD_TIMEOUT_MS)

    const onReady = (): void => {
      cleanup()
      // The document exists; we don't need the rest of the page.
      if (!win.isDestroyed()) win.webContents.stop()
      resolve()
    }
    const onFail = (
      _e: Electron.Event,
      code: number,
      desc: string,
      _url: string,
      isMainFrame: boolean
    ): void => {
      // Subresource failures are none of our business; only a main-frame
      // failure means we never got a document.
      if (!isMainFrame) return
      // -3 is ERR_ABORTED, which our own stop() triggers.
      if (code === -3) return
      cleanup()
      reject(new Error(`Could not reach ${origin} (${desc}).`))
    }
    function cleanup(): void {
      clearTimeout(timer)
      if (win.isDestroyed()) return
      win.webContents.off('dom-ready', onReady)
      win.webContents.off('did-fail-load', onFail)
    }

    win.webContents.once('dom-ready', onReady)
    win.webContents.on('did-fail-load', onFail)
    win.loadURL(origin).catch(() => {
      // loadURL rejects on abort too; did-fail-load is the authority here.
    })
  })
}

/**
 * Write sessionStorage into a LIVE browsing context.
 *
 * Unlike localStorage this cannot be done in a throwaway window: session
 * storage is scoped to one tab and vanishes with it. The caller passes the
 * webContents of a tab already on the target origin; if none is open, session
 * storage simply isn't importable and the caller reports that.
 */
export async function writeSessionStorage(
  contents: Electron.WebContents,
  origin: string,
  data: RelayStorage
): Promise<StorageWriteResult> {
  if (!Object.keys(data).length) return { ok: 0, failed: 0, blocked: false }
  // Refuse to write one origin's credentials into a page showing another.
  const current = safeOrigin(contents.getURL())
  if (current !== origin) {
    throw new Error(`The open tab is on ${current || 'no page'}, not ${origin}.`)
  }
  return (await contents.executeJavaScript(
    writerScript('sessionStorage', data),
    true
  )) as StorageWriteResult
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}
