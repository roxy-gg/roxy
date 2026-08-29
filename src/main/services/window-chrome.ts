/**
 * Native window chrome — the parts of the window CSS cannot reach.
 *
 * On Windows and Linux the minimise / maximise / close buttons are drawn by the
 * OS into a Window Controls Overlay, not by us. That overlay sits above the
 * page, so no stylesheet touches it: give it a fixed color and it stays that
 * color forever, which is exactly the dark block that shows up as a mismatched
 * rectangle in the corner of a light theme.
 *
 * Two other native surfaces have the same problem and are handled here too:
 *
 *  - `backgroundColor`, painted before the renderer has drawn anything. Wrong
 *    value = a flash of the old theme on launch and on resize.
 *  - The symbol color of the control glyphs, which has to stay legible against
 *    whatever the theme put behind it.
 *
 * The overlay is set TRANSPARENT rather than recolored. The page already paints
 * that strip (the title bar is our own React header), so letting the app's own
 * background show through means the controls sit on the real UI — including a
 * gradient or any other treatment a theme uses that a single flat color could
 * never match. Only the glyphs are colored, and they follow the theme's text.
 */
import { BrowserWindow } from 'electron'
import {
  DEFAULT_THEME_ID,
  getBuiltInTheme,
  type PlatformId,
  type ResolvedTheme
} from '../../shared/theme'
import { getSettings } from '../db/repo'

/**
 * Fully-transparent black is special-cased by Electron and falls back to the
 * default frame color (electron#51014), which is the opaque block we are trying
 * to remove. A single unit of red is visually identical, is still fully
 * transparent, and takes the intended code path.
 */
const TRANSPARENT = 'rgba(1, 0, 0, 0)'

/** Sensible fallbacks if a theme somehow omits these (it shouldn't). */
const FALLBACK_BG = '#0a0a0a'
const FALLBACK_SYMBOL = '#9a9aa3'

/** The window-control heights this app uses, per window kind. */
export const OVERLAY_HEIGHT = { main: 48, browser: 40 } as const

/**
 * The glyph color for the window controls.
 *
 * Uses the theme's muted text so the buttons read as chrome rather than
 * content, and stays legible on both polarities because a light theme's muted
 * text is dark by construction.
 */
export function symbolColorFor(theme: ResolvedTheme): string {
  const muted = theme.vars['--color-text-muted']
  // The OS parses this itself and understands only literal colors — a `var()`
  // or `color-mix()` would be dropped and silently revert to the system color.
  if (muted && /^#|^rgb|^hsl/i.test(muted.trim())) return muted.trim()
  return theme.appearance === 'light' ? '#5c5c66' : FALLBACK_SYMBOL
}

/** The opaque color painted before the first frame, and behind the page. */
export function backgroundColorFor(theme: ResolvedTheme): string {
  const bg = theme.vars['--color-bg']
  // Must be opaque and literal: this is what the OS shows during a resize, so a
  // translucent or unparseable value flashes as black.
  if (bg && /^#[0-9a-f]{6}$/i.test(bg.trim())) return bg.trim()
  return theme.appearance === 'light' ? '#ffffff' : FALLBACK_BG
}

/**
 * Apply a theme to one window's native chrome.
 *
 * Best-effort by design: `setTitleBarOverlay` throws on a window that was not
 * created with an overlay (every window on macOS, where the traffic lights are
 * native and already follow the OS), and a window can be destroyed between the
 * broadcast and this call. Neither is worth failing a theme change over.
 */
export function applyWindowChrome(win: BrowserWindow, theme: ResolvedTheme): void {
  if (win.isDestroyed()) return
  try {
    win.setBackgroundColor(backgroundColorFor(theme))
  } catch {
    // ignore — cosmetic
  }
  // macOS draws its own traffic lights and has no overlay to set.
  if (process.platform === 'darwin') return
  try {
    win.setTitleBarOverlay({
      color: TRANSPARENT,
      symbolColor: symbolColorFor(theme)
    })
  } catch {
    // Window has no overlay (or an older Electron): leave it as constructed.
  }
}

/** The platform id the theme resolver expects, from the current process. */
export function chromePlatform(): PlatformId {
  return process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : 'win32'
}

/** Apply a theme to every open window. */
export function applyWindowChromeAll(theme: ResolvedTheme): void {
  for (const win of BrowserWindow.getAllWindows()) applyWindowChrome(win, theme)
}

/**
 * The `titleBarOverlay` to construct a window with.
 *
 * Transparent from the very first frame, so a window never flashes an opaque
 * block before the theme arrives. `height` is the one part that is structural
 * rather than cosmetic — it must match the app's header height or the controls
 * overlap the UI.
 */
export function initialOverlay(height: number): Electron.TitleBarOverlay {
  return { color: TRANSPARENT, symbolColor: FALLBACK_SYMBOL, height }
}

/**
 * The opaque color to construct a window with, read straight from settings.
 *
 * Synchronous on purpose. It is needed inside the BrowserWindow constructor,
 * before any await, because this is the color the OS paints BEFORE the renderer
 * has drawn a single frame. Resolving it asynchronously would mean every launch
 * flashes the default palette on the way to the user's actual theme -- the same
 * flash primeTheme() exists to prevent on the renderer side.
 */
export function initialBackgroundColor(): string {
  try {
    // Safe to read here: the DB is opened lazily by getDb(), so importing the
    // repo does not itself touch disk -- this call is the first thing that does.
    const id = getSettings().activeThemeId
    // Only built-ins are readable synchronously; a user theme lives on disk and
    // arrives a moment later over the normal theme broadcast. Falling back to the
    // default still avoids the jarring flash for everyone on a built-in.
    const theme = (id ? getBuiltInTheme(id) : null) ?? getBuiltInTheme(DEFAULT_THEME_ID)
    const bg = theme?.colors?.bg
    if (bg && /^#[0-9a-f]{6}$/i.test(bg)) return bg
  } catch {
    // Settings unreadable this early: the default is the safe answer.
  }
  return FALLBACK_BG
}
