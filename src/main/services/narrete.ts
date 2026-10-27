import {
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  powerMonitor,
  screen,
  systemPreferences
} from 'electron'
import type { IpcMainInvokeEvent, Point } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CHANNELS } from '../../shared/ipc'
import {
  NARRETE_NOTE_LIMIT,
  narreteCrop,
  narreteDrag,
  type NarreteCaptureResult,
  type NarreteResult,
  type NarreteSelection,
  type NarreteSurface,
  type NarreteRegion
} from '../../shared/narrete'
import { getChat, getSettings, setNarreteEnabled } from '../db/repo'
import { composeNarrete } from './narrete-image'
import { listenNarreteInput } from './narrete-input'

type Surface = {
  window: BrowserWindow
  displayId: string
  previewDataUrl: string | null
  rectangles: NarreteSelection[]
  ignoring: boolean
  focusable: boolean
  armed: boolean
  ready?: () => void
}
type Session = {
  id: string
  chatId: string
  note: string
  regions: NarreteRegion[]
  surfaces: Surface[]
  selected: Surface | null
  selection: NarreteSelection | null
  refreshing: boolean
  submitting: boolean
  revision: number
  stopInput?: () => void
  routing?: NodeJS.Timeout
  gesture: { surface: Surface; start: Point } | null
  buttons: Set<number>
  ctrlKey: boolean
  altKey: boolean
  closed: Promise<NarreteCaptureResult>
  finish: (result: NarreteCaptureResult) => void
}
let owner: BrowserWindow | null = null
let active: Session | null = null
const surfaceUrl = (): string =>
  process.env.ELECTRON_RENDERER_URL
    ? new URL('narrete.html', process.env.ELECTRON_RENDERER_URL.replace(/\/?$/, '/')).href
    : pathToFileURL(join(__dirname, '../renderer/narrete.html')).href

export const isNarreteCapturing = (): boolean => active !== null
export const narreteVoiceWindow = (): BrowserWindow | null => active?.selected?.window ?? null

function surfaceFor(event: IpcMainInvokeEvent): Surface | undefined {
  if (event.senderFrame !== event.sender.mainFrame || event.sender.getURL() !== surfaceUrl()) return
  return active?.surfaces.find(
    (surface) => !surface.window.isDestroyed() && surface.window.webContents === event.sender
  )
}
export const isNarreteSurfaceSender = (event: IpcMainInvokeEvent): boolean => !!surfaceFor(event)
export function isNarreteVoiceSender(event: IpcMainInvokeEvent, chatId?: string): boolean {
  return (
    !!active &&
    !!active.selected &&
    surfaceFor(event) === active.selected &&
    (chatId === undefined || active.chatId === chatId) &&
    !active.refreshing
  )
}

export function setNarreteWindow(window: BrowserWindow): void {
  owner = window
  const cancel = (): void => active?.finish({ ok: false, error: 'cancelled' })
  window.webContents.on('destroyed', cancel)
  window.webContents.on('render-process-gone', cancel)
  window.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) cancel()
  })
  window.on('closed', () => {
    if (owner === window) owner = null
  })
}

const surfaceState = (
  session: Session,
  surface: Surface,
  error?: 'captureFailed'
): NarreteSurface => ({
  chatId: session.chatId,
  language: getSettings().language,
  note: session.note,
  regions: session.regions,
  selection: session.selected === surface ? session.selection : null,
  previewDataUrl: session.selected === surface ? surface.previewDataUrl : null,
  revision: session.revision,
  error
})

function publish(session: Session, error?: 'captureFailed'): void {
  session.revision++
  for (const surface of session.surfaces) {
    surface.rectangles = []
    try {
      surface.window.webContents.send(CHANNELS.narreteReset, surfaceState(session, surface, error))
    } catch {
      /* A sibling display can still finish the collected brief. */
    }
  }
}

function hit(surface: Surface, point: Point): boolean {
  const bounds = surface.window.getBounds()
  return surface.rectangles.some(
    (rect) =>
      point.x >= bounds.x + rect.x &&
      point.y >= bounds.y + rect.y &&
      point.x < bounds.x + rect.x + rect.width &&
      point.y < bounds.y + rect.y + rect.height
  )
}

function route(session: Session): void {
  if (active !== session || session.buttons.size) return
  const point = screen.getCursorScreenPoint()
  const armed =
    session.ctrlKey &&
    !session.altKey &&
    !session.selected &&
    !session.refreshing &&
    !session.submitting
  for (const surface of session.surfaces) {
    if (armed !== surface.armed) {
      surface.armed = armed
      // Another always-on-top app can rise above our click-through overlay.
      // Raise capture surfaces again without activating them or taking focus.
      if (armed) surface.window.moveTop()
    }
    const overWidget = hit(surface, point)
    const ignoring = session.refreshing || (!armed && !overWidget)
    const focusable = !session.refreshing && (overWidget || surface === session.selected)
    if (focusable !== surface.focusable) {
      surface.focusable = focusable
      // Permit widget activation (WM_MOUSEACTIVATE on Windows), but keep
      // capture-only interception from stealing keyboard focus from the desktop.
      surface.window.setFocusable(focusable)
      surface.window.setSkipTaskbar(true)
    }
    if (ignoring !== surface.ignoring) {
      surface.ignoring = ignoring
      if (ignoring && !session.selected) surface.window.blur()
      surface.window.setIgnoreMouseEvents(ignoring, { forward: true })
    }
  }
}

async function capture(
  session: Session,
  surface: Surface,
  selection: NarreteSelection
): Promise<void> {
  if (active !== session || session.selected || session.refreshing || session.submitting) return
  session.refreshing = true
  session.surfaces.forEach(({ window }) => window.hide())
  let timer: NodeJS.Timeout | undefined
  try {
    await new Promise((resolve) => setTimeout(resolve, 100))
    if (active !== session) return
    const display = screen
      .getAllDisplays()
      .find((display) => String(display.id) === surface.displayId)
    if (!display) throw new Error('Display changed')
    const longest = Math.min(
      4096,
      Math.max(display.size.width, display.size.height) * display.scaleFactor
    )
    const sources = await Promise.race([
      desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: longest, height: longest }
      }),
      session.closed.then(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 15_000)
      })
    ])
    if (active !== session) return
    const source =
      sources?.find((item) => item.display_id === surface.displayId) ??
      (sources?.length === 1 && screen.getAllDisplays().length === 1 ? sources[0] : undefined)
    if (!source || source.thumbnail.isEmpty()) throw new Error('Capture failed')
    const size = source.thumbnail.getSize()
    const crop = narreteCrop(selection, size.width, size.height)
    if (!crop) throw new Error('Invalid capture region')
    let image = source.thumbnail.crop(crop)
    const cropped = image.getSize()
    if (Math.max(cropped.width, cropped.height) > 1536)
      image = image.resize(cropped.width >= cropped.height ? { width: 1536 } : { height: 1536 })
    surface.previewDataUrl = 'data:image/jpeg;base64,' + image.toJPEG(92).toString('base64')
    session.selected = surface
    session.selection = selection
    publish(session)
    surface.window.setFocusable(true)
    surface.focusable = true
    surface.window.setIgnoreMouseEvents(true, { forward: true })
    surface.ignoring = true
    surface.window.show()
    surface.window.focus()
  } catch {
    if (active === session) publish(session, 'captureFailed')
  } finally {
    clearTimeout(timer)
    session.refreshing = false
    if (active === session) {
      if (!session.selected) session.surfaces.forEach(({ window }) => window.showInactive())
      route(session)
    }
  }
}

async function start(id: string, chatId: string): Promise<NarreteCaptureResult> {
  if (active) return { ok: false, error: 'busy' }
  const window = owner
  if (
    !window ||
    window.isDestroyed() ||
    typeof id !== 'string' ||
    !id ||
    id.length > 100 ||
    typeof chatId !== 'string' ||
    !getChat(chatId)
  )
    return { ok: false, error: 'captureFailed' }
  // The native listener is X11-only; its published Linux ARM binary is not ARM.
  if (
    process.platform === 'linux' &&
    (process.env.XDG_SESSION_TYPE === 'wayland' ||
      process.env.WAYLAND_DISPLAY ||
      process.arch !== 'x64')
  )
    return { ok: false, error: 'unsupported' }
  if (process.platform === 'darwin') {
    if (!systemPreferences.isTrustedAccessibilityClient(true))
      return { ok: false, error: 'inputPermissionDenied' }
    if (['denied', 'restricted'].includes(systemPreferences.getMediaAccessStatus('screen')))
      return { ok: false, error: 'permissionDenied' }
  }
  let resolve!: (result: NarreteCaptureResult) => void
  const result = new Promise<NarreteCaptureResult>((done) => {
    resolve = done
  })
  const session: Session = {
    id,
    chatId,
    note: '',
    regions: [],
    surfaces: [],
    selected: null,
    selection: null,
    refreshing: false,
    submitting: false,
    revision: 0,
    gesture: null,
    buttons: new Set(),
    ctrlKey: false,
    altKey: false,
    closed: result,
    finish: (outcome) => {
      if (active !== session) return
      active = null
      clearInterval(session.routing)
      try {
        session.stopInput?.()
      } catch {
        /* Cleanup must still close every surface. */
      }
      session.surfaces.forEach(({ window }) => {
        if (!window.isDestroyed()) window.destroy()
      })
      if (outcome.ok && !window.isDestroyed()) {
        window.show()
        window.focus()
      }
      resolve(outcome)
    }
  }
  active = session
  const timer = setTimeout(() => session.finish({ ok: false, error: 'captureFailed' }), 30_000)
  try {
    await Promise.race([
      Promise.all(
        screen.getAllDisplays().map(async (display) => {
          const overlay = new BrowserWindow({
            ...display.bounds,
            show: false,
            frame: false,
            transparent: true,
            focusable: false,
            resizable: false,
            movable: false,
            alwaysOnTop: true,
            skipTaskbar: true,
            acceptFirstMouse: true,
            fullscreenable: false,
            backgroundColor: '#00000000',
            webPreferences: {
              preload: join(__dirname, '../preload/index.js'),
              additionalArguments: ['--narrete-overlay'],
              sandbox: true,
              contextIsolation: true,
              nodeIntegration: false,
              devTools: false,
              backgroundThrottling: false
            }
          })
          const surface: Surface = {
            window: overlay,
            displayId: String(display.id),
            previewDataUrl: null,
            rectangles: [],
            ignoring: true,
            focusable: false,
            armed: false
          }
          const ready = new Promise<void>((done) => {
            surface.ready = done
          })
          session.surfaces.push(surface)
          overlay.setIgnoreMouseEvents(true, { forward: true })
          overlay.setMenu(null)
          overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
          overlay.webContents.on('will-navigate', (event) => event.preventDefault())
          overlay.webContents.on('render-process-gone', () =>
            session.finish({ ok: false, error: 'cancelled' })
          )
          overlay.on('closed', () => session.finish({ ok: false, error: 'cancelled' }))
          await overlay.loadURL(surfaceUrl())
          await ready
        })
      ),
      result
    ])
    if (active !== session) return await result
    const stop = await listenNarreteInput(
      (event) => {
        try {
          if (active !== session) return
          session.ctrlKey = event.ctrlKey
          session.altKey = event.altKey
          if (!event.ctrlKey || event.altKey) {
            session.gesture?.surface.window.webContents.send(CHANNELS.narreteDrag, null)
            session.gesture = null
          }
          if (event.type === 'modifiers') {
            // Routing stays latched through mouse-up, even after cancellation.
            route(session)
            return
          }
          const point =
            process.platform === 'win32'
              ? screen.screenToDipPoint({ x: event.x, y: event.y })
              : { x: event.x, y: event.y }
          if (event.type === 'down') {
            const alreadyDown = session.buttons.size > 0
            session.buttons.add(event.button)
            if (
              alreadyDown ||
              event.button !== 1 ||
              !event.ctrlKey ||
              event.altKey ||
              session.selected ||
              session.refreshing ||
              session.submitting
            )
              return
            const surface = session.surfaces.find((surface) => {
              const b = surface.window.getBounds()
              return (
                point.x >= b.x &&
                point.x < b.x + b.width &&
                point.y >= b.y &&
                point.y < b.y + b.height
              )
            })
            // Never intercept halfway through a drag that began in another app.
            if (surface && !surface.ignoring && !hit(surface, point))
              session.gesture = { surface, start: point }
          } else if (event.type === 'move') {
            const gesture = session.gesture
            if (gesture)
              gesture.surface.window.webContents.send(
                CHANNELS.narreteDrag,
                narreteDrag(gesture.start, point, gesture.surface.window.getBounds())
              )
            route(session)
          } else {
            session.buttons.delete(event.button)
            if (event.button !== 1) {
              route(session)
              return
            }
            const gesture = session.gesture
            session.gesture = null
            gesture?.surface.window.webContents.send(CHANNELS.narreteDrag, null)
            const selection =
              gesture && event.ctrlKey && !event.altKey
                ? narreteDrag(gesture.start, point, gesture.surface.window.getBounds())
                : null
            if (gesture && selection) void capture(session, gesture.surface, selection)
            route(session)
          }
        } catch {
          session.finish({ ok: false, error: 'captureFailed' })
        }
      },
      () => {
        // Let the renderer handle IME Escape while editing. Else Escape works
        // even with another application focused; it is not suppressed there.
        if (active === session && (!session.selected || !session.selected.window.isFocused()))
          session.finish({ ok: false, error: 'cancelled' })
      }
    )
    if (active !== session) {
      stop()
      return await result
    }
    session.stopInput = stop
    clearTimeout(timer)
    session.surfaces.forEach(({ window }) => window.showInactive())
    session.routing = setInterval(() => route(session), 16)
    return await result
  } catch {
    session.finish({ ok: false, error: 'captureFailed' })
    return await result
  } finally {
    clearTimeout(timer)
  }
}

export function registerNarreteIpc(): void {
  const trusted = (event: IpcMainInvokeEvent): boolean =>
    !!owner &&
    !owner.isDestroyed() &&
    event.sender === owner.webContents &&
    event.senderFrame === event.sender.mainFrame &&
    [
      process.env.ELECTRON_RENDERER_URL?.replace(/\/$/, '') + '/',
      pathToFileURL(join(__dirname, '../renderer/index.html')).href
    ].includes(event.sender.getURL().split('#')[0])
  ipcMain.handle(CHANNELS.settingsSetNarreteEnabled, (event, enabled) => {
    if (!trusted(event) || typeof enabled !== 'boolean')
      throw new Error('Invalid Narrete preference')
    if (!enabled) active?.finish({ ok: false, error: 'cancelled' })
    return setNarreteEnabled(enabled)
  })
  ipcMain.handle(CHANNELS.narreteStart, (event, id, chatId) => {
    if (!trusted(event) || !getSettings().narreteEnabled)
      return { ok: false, error: 'captureFailed' }
    return start(id, chatId)
  })
  ipcMain.handle(CHANNELS.narreteState, (event) => {
    const surface = surfaceFor(event)
    if (!surface || !active) throw new Error('Invalid capture surface')
    return surfaceState(active, surface)
  })
  ipcMain.handle(CHANNELS.narreteReady, (event) => {
    const surface = surfaceFor(event)
    surface?.ready?.()
    if (surface) surface.ready = undefined
  })
  ipcMain.handle(
    CHANNELS.narreteLayout,
    (event, revision: number, rectangles: NarreteSelection[]) => {
      const surface = surfaceFor(event)
      if (
        !active ||
        !surface ||
        revision !== active.revision ||
        !Array.isArray(rectangles) ||
        rectangles.length > 8
      )
        return
      const b = surface.window.getBounds()
      if (
        rectangles.some(
          (r) =>
            !r ||
            ![r.x, r.y, r.width, r.height].every(Number.isFinite) ||
            r.x < 0 ||
            r.y < 0 ||
            r.width < 0 ||
            r.height < 0 ||
            r.x + r.width > b.width + 1 ||
            r.y + r.height > b.height + 1
        )
      )
        return
      surface.rectangles = rectangles
      route(active)
    }
  )
  ipcMain.handle(
    CHANNELS.narreteRefresh,
    (event, note: string, selection?: NarreteSelection): NarreteResult => {
      const session = active
      const surface = surfaceFor(event)
      if (
        !session ||
        !surface ||
        session.refreshing ||
        session.submitting ||
        session.selected !== surface ||
        !session.selection ||
        !surface.previewDataUrl
      )
        return { ok: false, error: 'busy' }
      if (
        typeof note !== 'string' ||
        note.length > NARRETE_NOTE_LIMIT ||
        (selection && !note.trim())
      )
        return { ok: false, error: 'captureFailed' }
      try {
        if (selection) {
          // Save the exact main-owned crop shown in the preview, never renderer geometry.
          const dataUrl = surface.previewDataUrl
          // Bound memory, not the number of feedback items. Keep this selection
          // editable if a very long session exhausts its temporary byte budget.
          if (
            session.regions.reduce(
              (bytes, region) => bytes + region.dataUrl.length,
              dataUrl.length
            ) > 90_000_000
          )
            return { ok: false, error: 'captureFailed' }
          session.regions.push({ dataUrl, note: note.trim() })
        }
        session.note = selection ? '' : note
        session.selected = null
        session.selection = null
        for (const surface of session.surfaces) {
          surface.previewDataUrl = null
          surface.window.setFocusable(false)
          surface.focusable = false
          surface.window.blur()
          surface.window.setIgnoreMouseEvents(true, { forward: true })
          surface.ignoring = true
        }
        publish(session)
        session.surfaces.forEach(({ window }) => window.showInactive())
        route(session)
        return { ok: true }
      } catch {
        return { ok: false, error: 'captureFailed' }
      }
    }
  )
  ipcMain.handle(
    CHANNELS.narreteSubmit,
    async (event, selection: NarreteSelection | null, note: string): Promise<NarreteResult> => {
      const session = active
      if (
        !session ||
        !surfaceFor(event) ||
        session.selected ||
        session.refreshing ||
        session.submitting
      )
        return { ok: false, error: 'busy' }
      if (selection !== null || note !== '' || session.note.trim() || !session.regions.length)
        return { ok: false, error: 'sendFailed' }
      session.submitting = true
      try {
        const image = await Promise.race([
          composeNarrete(session.regions, () => active !== session),
          session.closed.then(() => null)
        ])
        if (!image || active !== session) return { ok: false, error: 'cancelled' }
        if (!getChat(session.chatId)) {
          session.finish({ ok: false, error: 'cancelled' })
          return { ok: false, error: 'cancelled' }
        }
        session.finish({
          ok: true,
          text: session.regions.map((region, index) => `${index + 1}. ${region.note}`).join('\n\n'),
          image
        })
        return { ok: true }
      } catch {
        session.submitting = false
        return { ok: false, error: 'sendFailed' }
      }
    }
  )
  ipcMain.handle(CHANNELS.narreteCancel, (event, id) => {
    if (active && ((trusted(event) && active.id === id) || surfaceFor(event)))
      active.finish({ ok: false, error: 'cancelled' })
  })
  powerMonitor.on('suspend', () => active?.finish({ ok: false, error: 'cancelled' }))
  powerMonitor.on('lock-screen', () => active?.finish({ ok: false, error: 'cancelled' }))
  screen.on('display-removed', () => active?.finish({ ok: false, error: 'cancelled' }))
  screen.on('display-added', () => active?.finish({ ok: false, error: 'cancelled' }))
  screen.on('display-metrics-changed', () => active?.finish({ ok: false, error: 'cancelled' }))
}
