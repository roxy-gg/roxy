/**
 * Applies a resolved theme to the document.
 *
 * The whole mechanism is one line of real work — `setProperty` on the root
 * element — because Tailwind v4 compiles design tokens to *runtime* `var()`
 * references. `bg-surface` emits `background-color: var(--color-surface)`, so
 * re-pointing that property restyles every element using it, live. No
 * stylesheet is swapped, nothing is re-rendered, and React is not involved.
 *
 * Two things make this subtler than it looks:
 *
 * 1. Inline styles beat everything. `main.css` sets `--font-sans` under
 *    `[data-platform='darwin']` to get San Francisco on macOS; if we wrote a
 *    font here unconditionally we would silently override that. So a theme that
 *    says nothing about fonts emits no font property at all (see resolveTheme),
 *    and `clearTheme` removes properties rather than resetting them to defaults.
 *
 * 2. The first paint must already be themed. The renderer boots, asks main for
 *    the theme over async IPC, and only then can apply it — which is at least
 *    one frame of the DEFAULT palette. On a light theme that is a black flash.
 *    `primeTheme()` closes that gap using a synchronous localStorage cache.
 */
import type { ResolvedTheme } from '@shared/theme'
import { api } from './api'

/**
 * Cache of the last applied theme, read synchronously before the first paint.
 *
 * localStorage is the only store the renderer can read *synchronously* at
 * startup — IPC, indexedDB and the filesystem are all async, and any of them
 * would land after the first frame. It is a cache, never the source of truth:
 * main still resolves the real theme a moment later and overwrites this.
 */
const CACHE_KEY = 'roxy.theme.v1'

/** Custom properties we set, so `clearTheme` can remove exactly those. */
let applied: string[] = []

/**
 * Write a resolved theme onto `<html>`.
 *
 * Properties are diffed against the previous theme rather than cleared and
 * re-set: removing a property, even for one frame, makes the UI flash the
 * default palette on every theme switch.
 */
export function applyTheme(theme: ResolvedTheme): void {
  const root = document.documentElement
  const next = theme.vars ?? {}

  for (const name of applied) {
    if (!(name in next)) root.style.removeProperty(name)
  }
  for (const [name, value] of Object.entries(next)) {
    // Only custom properties, only from main's resolver. Belt and braces: the
    // value was already validated in shared/theme.ts.
    if (name.startsWith('--')) root.style.setProperty(name, value)
  }
  applied = Object.keys(next)

  // Drives the native bits CSS variables can't reach: form controls, the
  // scrollbar gutter, and the default text color of a page with no styles.
  root.style.colorScheme = theme.appearance
  root.dataset.theme = theme.id
  root.dataset.appearance = theme.appearance

  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(theme))
  } catch {
    // Private mode / quota — the cache is an optimization, not a requirement.
  }
}

/** Drop every property this module set, returning to the compiled defaults. */
export function clearTheme(): void {
  const root = document.documentElement
  for (const name of applied) root.style.removeProperty(name)
  applied = []
  root.style.colorScheme = ''
  delete root.dataset.theme
  delete root.dataset.appearance
}

/**
 * Apply the cached theme synchronously, before React mounts.
 *
 * Called from the module body of `main.tsx` so it runs during the initial
 * script evaluation — i.e. before the browser has painted anything. Without it
 * the window shows one frame of the built-in dark palette regardless of the
 * user's theme, which is the classic "flash of wrong theme" and is most obvious
 * on exactly the themes people notice: light ones.
 */
export function primeTheme(): void {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return
    const cached = JSON.parse(raw) as ResolvedTheme
    if (cached && typeof cached === 'object' && cached.vars) applyTheme(cached)
  } catch {
    // A corrupt cache must never stop the app booting — it just means one
    // frame of the default theme, which is what we had before this existed.
  }
}

/**
 * Fetch the active theme from main, apply it, and keep it in sync.
 *
 * Returns an unsubscribe function. The subscription is what makes a theme
 * change in the Themes page reach the chat window (and any other window)
 * without either of them polling. Never throws -- see below.
 */
export function startTheme(): () => void {
  // Defensive on purpose. This runs in the module body of the renderer entry,
  // BEFORE React mounts, so anything thrown here takes the whole app down to a
  // white screen -- and window.roxy.themes is genuinely absent in two real
  // situations: a dev session running against a stale preload build, and the
  // renderer loaded outside Electron. A .catch() alone would not be enough,
  // because the property access itself is what throws. Theming is cosmetic; it
  // must never be able to stop the app booting.
  const themes = api?.themes
  if (!themes) return () => undefined
  try {
    void themes
      .resolve()
      .then(applyTheme)
      .catch(() => {
        // Main is unreachable, or an older build has no handler: keep the
        // cached/compiled palette rather than blanking the UI.
      })
    return themes.onChanged(applyTheme) ?? (() => undefined)
  } catch {
    return () => undefined
  }
}
