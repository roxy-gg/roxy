/**
 * Turn-completion notifications - the main-process half.
 *
 * One job, and it has to live here rather than in the renderer: the native OS
 * toast. The renderer's Web `Notification` also reaches the OS, but it gives no
 * way to focus the window when the toast is clicked, which is the entire point
 * of the notification.
 *
 * The SOUND is not here at all. It is a bundled asset played by the renderer,
 * which is the only side with audio output.
 *
 * Deliberately says nothing about WHEN to notify: that decision is the
 * renderer's, because only it knows whether the turn was stopped, whether a
 * queue is still draining, whether the window is focused, and what the strings
 * say.
 */
import { app, BrowserWindow, Notification, nativeImage } from 'electron'
import { CHANNELS } from '../../shared/ipc'

/**
 * The app's identity for Windows toasts. Windows renders this string as the
 * toast's header, so it must be the stable id and never a filesystem path.
 */
export const APP_USER_MODEL_ID = 'com.roxy.app'

const isWindows = process.platform === 'win32'
const isMac = process.platform === 'darwin'

/**
 * Toasts still awaiting a click, newest last.
 *
 * A shown `Notification` that nothing references can be garbage collected, and
 * with it the `click` handler - while the toast is still sitting in the Windows
 * Action Center, clickable. Holding it here is what makes "click the toast,
 * land on that session" work minutes later.
 *
 * Bounded, because `close` cannot be trusted to arrive: a Windows toast that
 * times out into the Action Center and is dismissed from there often never
 * fires it, and macOS is no better. Left uncapped this would retain one
 * Notification per completed turn for the life of the process.
 *
 * Dropping the OLDEST is the right eviction: Windows itself keeps only about
 * 20 toasts per app in the Action Center, so anything past the cap is already
 * gone from the UI and can no longer be clicked.
 */
const live = new Set<Notification>()
const MAX_LIVE = 20

/** Roxy's icon, injected from main so this module needs no `?asset` import. */
let iconPath: string | undefined
export function setToastIcon(p: string): void {
  iconPath = p
}

/**
 * The window a clicked toast should raise.
 *
 * Not `getAllWindows()[0]`: the agent browser (services/browser.ts) opens its
 * own BrowserWindow with the same preload, so the first entry can be that one -
 * the click would raise a browser window and send `notifyActivated` to a
 * renderer with no handler for it, leaving the toast apparently dead. The rest
 * of main broadcasts to every window instead, which is right for a data push
 * and wrong here: this one FOCUSES whatever it sends to.
 *
 * Re-registered by `createWindow`, so the reference survives the window being
 * closed and recreated on macOS `activate`.
 */
let toastWindow: BrowserWindow | null = null
export function setToastWindow(win: BrowserWindow): void {
  toastWindow = win
  win.on('closed', () => {
    if (toastWindow === win) toastWindow = null
  })
}

/**
 * How to get a window back when there is none.
 *
 * A macOS-only path, and the reason it has to exist: `window-all-closed` does
 * not quit on darwin, so the app can sit in the dock with no window while its
 * toasts sit in Notification Center. Clicking one then has nothing to raise.
 * On Windows the app is already gone in that situation.
 */
let openWindow: (() => BrowserWindow) | null = null
export function setWindowFactory(fn: () => BrowserWindow): void {
  openWindow = fn
}

/**
 * A click that arrived before there was a renderer to tell, held until one
 * asks for it. Pushing at a window that is still loading would be lost: the
 * store subscribes to `notifyActivated` partway through bootstrap, well after
 * `did-finish-load`, so main cannot know when the listener is up. The renderer
 * pulls instead, at the moment it subscribes.
 */
let pendingChatId: string | null = null
export function takePendingActivation(): string | null {
  const id = pendingChatId
  pendingChatId = null
  return id
}

/**
 * A `file:///` URI Windows will actually load. `encodeURI` matters: the app can
 * sit under a path with spaces (a user folder like "Jair Escamilla" is the
 * common case) and an unencoded space silently drops the image, leaving the
 * generic placeholder that this template exists to replace.
 */
function fileUri(p: string): string {
  return 'file:///' + encodeURI(p.replace(/\\/g, '/'))
}

/** XML-escape text before it goes into a Windows toast template. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Bring the whole app forward, not just the window.
 *
 * macOS needs this: `BrowserWindow.focus()` raises the window within Roxy but
 * cannot take focus from the editor you were actually in, so a clicked toast
 * looked like it did nothing. `steal` is the documented way to say "the user
 * asked for this", which a toast click is - it is not the app interrupting.
 */
function focusApp(): void {
  if (isMac) app.focus({ steal: true })
}

/**
 * Post a native OS toast for the session `chatId`.
 *
 * Clicking it focuses the window AND asks the renderer to open that session -
 * which is the whole point of a per-session toast, and the reason this isn't the
 * renderer's Web Notification API: only main can raise the window.
 *
 * `silent: true` always: Roxy plays its own chime, and letting the OS add its
 * default alert on top produces two noises for one event.
 */
export function showTurnToast(title: string, body: string, chatId: string): void {
  if (!Notification.isSupported()) return
  const icon = iconPath ? nativeImage.createFromPath(iconPath) : undefined
  const notification = new Notification({
    title,
    body,
    silent: true,
    // On macOS, `icon` sets `contentImage` (displayed as an attachment thumbnail
    // on the right side of the banner). The application icon on the left is
    // provided natively by the OS from the .app bundle (Roxy in packaged builds).
    // Suppress `icon` on macOS so we don't display a redundant thumbnail on the right.
    ...(!isMac && icon && !icon.isEmpty() ? { icon } : {}),
    // Windows ignores `icon` for the large circular avatar, so ask for the
    // template explicitly. `ToastGeneric` + a `appLogoOverride` crop gives the
    // rounded app icon at the top-left instead of the generic placeholder.
    ...(isWindows && iconPath
      ? {
          toastXml: `<toast activationType="foreground">
  <visual>
    <binding template="ToastGeneric">
      <image placement="appLogoOverride" hint-crop="circle" src="${esc(fileUri(iconPath))}"/>
      <text hint-maxLines="1">${esc(title)}</text>
      <text>${esc(body)}</text>
    </binding>
  </visual>
  <audio silent="true"/>
</toast>`
        }
      : {})
  })
  live.add(notification)
  if (live.size > MAX_LIVE) live.delete(live.values().next().value as Notification)
  notification.on('close', () => live.delete(notification))
  notification.on('click', () => {
    live.delete(notification)
    const existing = toastWindow && !toastWindow.isDestroyed() ? toastWindow : null
    if (!existing) {
      // No window (macOS, everything closed): reopen, and leave the session id
      // for the new renderer to collect once it is listening.
      pendingChatId = chatId
      openWindow?.()
      focusApp()
      return
    }
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    focusApp()
    // Raising the window is not enough: it comes back on whatever session was
    // last open, which is exactly the one you did NOT get notified about.
    existing.webContents.send(CHANNELS.notifyActivated, chatId)
  })
  notification.show()
}
