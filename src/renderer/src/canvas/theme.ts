/**
 * The canvas transcript's palette — the same design tokens the DOM uses, read
 * back as concrete colors a 2D context can accept.
 *
 * Canvas has no cascade. `ctx.fillStyle = 'var(--color-text)'` is not a color,
 * it is a parse error that silently leaves the previous fill in place, so every
 * token has to be resolved to an actual value before it can be painted. The
 * tokens are set at runtime on <html> by lib/theme.ts (and a user theme file can
 * change any of them), which makes `getComputedStyle` the only correct source —
 * hardcoding the dark palette here would freeze the transcript on one theme
 * while the rest of the app followed the user's choice.
 *
 * `color-mix()` is resolved the same way: the computed value of a custom
 * property is its *specified* value, so mixes come back as the literal string
 * `color-mix(in srgb, ...)`. Canvas cannot parse that either, so anything
 * derived is flattened through a probe element the browser has actually
 * resolved (see `flatten`).
 */

/** Every color the transcript can paint, named after the design token it follows. */
export interface CanvasPalette {
  bg: string
  surface: string
  surface2: string
  elevated: string
  border: string
  borderStrong: string
  text: string
  textMuted: string
  textSubtle: string
  accent: string
  accentHover: string
  success: string
  warning: string
  danger: string
  /** Polarity: the hover-wash / primary-fill color. NEAR-BLACK in a light theme. */
  white: string
  /** Polarity: what sits ON the primary fill. NEAR-WHITE in a light theme. */
  black: string
}

export interface CanvasTheme {
  palette: CanvasPalette
  /** 'dark' | 'light' — picks code themes and decides how washes are blended. */
  appearance: 'dark' | 'light'
  /** Resolved font stacks, ready to drop into `ctx.font`. */
  sans: string
  mono: string
  /**
   * Bumped whenever anything above changes. Layout caches key on it, so a theme
   * switch invalidates measured text (a different font stack measures
   * differently) without anything having to diff the palette by hand.
   */
  epoch: number
}

/**
 * A wash over a surface — `hover:bg-white/5` and friends, precomputed.
 *
 * Canvas can do this with globalAlpha, but that would also fade whatever the
 * wash is drawn over when the two are in the same layer, so the blend is done
 * up front in sRGB against the surface it lands on.
 */
export function mix(a: string, b: string, amount: number): string {
  const x = parseColor(a)
  const y = parseColor(b)
  if (!x || !y) return a
  const t = Math.max(0, Math.min(1, amount))
  const ch = (i: number): number => Math.round(x[i] + (y[i] - x[i]) * t)
  const alpha = x[3] + (y[3] - x[3]) * t
  return alpha >= 1
    ? `rgb(${ch(0)}, ${ch(1)}, ${ch(2)})`
    : `rgba(${ch(0)}, ${ch(1)}, ${ch(2)}, ${alpha.toFixed(3)})`
}

/** Same color, forced to an alpha — for rails, tints and disabled states. */
export function alpha(color: string, a: number): string {
  const c = parseColor(color)
  if (!c) return color
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${(c[3] * a).toFixed(3)})`
}

/**
 * Parse the color forms the browser hands back from `getComputedStyle` —
 * `rgb()`, `rgba()`, and hex (which a theme file may specify directly and which
 * survives untouched in a custom property's computed value).
 */
function parseColor(input: string): [number, number, number, number] | null {
  const value = input.trim()
  if (value.startsWith('#')) {
    const hex = value.slice(1)
    const wide = hex.length === 3 || hex.length === 4
    const size = wide ? 1 : 2
    const at = (i: number): number => {
      const part = hex.slice(i * size, i * size + size)
      const n = parseInt(wide ? part + part : part, 16)
      return Number.isNaN(n) ? 0 : n
    }
    if (hex.length !== 3 && hex.length !== 4 && hex.length !== 6 && hex.length !== 8) return null
    return [at(0), at(1), at(2), hex.length === 4 || hex.length === 8 ? at(3) / 255 : 1]
  }
  const m = value.match(/^rgba?\(([^)]+)\)$/i)
  if (!m) return null
  // Both the legacy comma syntax and the modern space syntax (`rgb(0 0 0 / 50%)`).
  const parts = m[1].split(/[\s,/]+/).filter(Boolean)
  if (parts.length < 3) return null
  const num = (s: string): number => (s.endsWith('%') ? (parseFloat(s) / 100) * 255 : parseFloat(s))
  const a =
    parts[3] === undefined
      ? 1
      : parts[3].endsWith('%')
        ? parseFloat(parts[3]) / 100
        : parseFloat(parts[3])
  return [num(parts[0]), num(parts[1]), num(parts[2]), Number.isNaN(a) ? 1 : a]
}

/**
 * Resolve a CSS value the browser understands but canvas does not.
 *
 * A custom property's computed value is its specified text, so `--edge`
 * (a `color-mix`) never arrives as a color. Assigning it to a real property on
 * a detached probe forces the browser to compute it, and reading THAT back
 * gives an `rgb()` string. The probe is created once and reused; it is never
 * attached to the document, so it costs no layout.
 */
let probe: HTMLElement | null = null
function flatten(value: string, fallback: string): string {
  if (!value) return fallback
  const direct = parseColor(value)
  if (direct) return value
  if (!probe) probe = document.createElement('span')
  probe.style.color = ''
  probe.style.color = value
  // An invalid value leaves the property empty rather than throwing.
  const computed = probe.style.color
  return computed ? computed : fallback
}

const TOKENS: Record<keyof CanvasPalette, [cssVar: string, fallback: string]> = {
  bg: ['--color-bg', '#0a0a0a'],
  surface: ['--color-surface', '#0f0f10'],
  surface2: ['--color-surface-2', '#161618'],
  elevated: ['--color-elevated', '#1d1d20'],
  border: ['--color-border', '#232326'],
  borderStrong: ['--color-border-strong', '#303035'],
  text: ['--color-text', '#ededed'],
  textMuted: ['--color-text-muted', '#9a9aa3'],
  textSubtle: ['--color-text-subtle', '#6a6a73'],
  accent: ['--color-accent', '#4d8dff'],
  accentHover: ['--color-accent-hover', '#6aa0ff'],
  success: ['--color-success', '#3fb950'],
  warning: ['--color-warning', '#d9a441'],
  danger: ['--color-danger', '#f0556a'],
  white: ['--color-white', '#ffffff'],
  black: ['--color-black', '#000000']
}

let epoch = 0
let lastTheme: CanvasTheme | undefined
let fontEpoch = 0
let lastKey = ''

/** Read the live tokens off <html> into a paintable theme. */
export function readTheme(): CanvasTheme {
  const root = document.documentElement
  const style = getComputedStyle(root)
  const palette = {} as CanvasPalette
  for (const key of Object.keys(TOKENS) as (keyof CanvasPalette)[]) {
    const [cssVar, fallback] = TOKENS[key]
    palette[key] = flatten(style.getPropertyValue(cssVar).trim(), fallback)
  }
  // Read the stacks rather than naming Geist: macOS re-points both to the system
  // faces (see `[data-platform='darwin']` in main.css), and a theme may set its
  // own. Canvas wants the same string CSS would use.
  const sans =
    style.getPropertyValue('--font-sans').trim() || 'ui-sans-serif, system-ui, sans-serif'
  const mono = style.getPropertyValue('--font-mono').trim() || 'ui-monospace, monospace'
  const appearance = root.dataset.appearance === 'light' ? 'light' : 'dark'
  const key = JSON.stringify([palette, appearance, sans, mono, fontEpoch, document.fonts.status])
  if (lastTheme && key === lastKey) return lastTheme
  lastKey = key
  lastTheme = { palette, appearance, sans, mono, epoch: ++epoch }
  return lastTheme
}

/**
 * Watch for theme changes.
 *
 * `applyTheme` writes tokens onto `document.documentElement.style` and sets
 * `data-appearance`, so observing that one element's attributes catches every
 * switch — including a user theme file reloading — without coupling this to the
 * IPC layer or to the store.
 */
export function observeTheme(onChange: (theme: CanvasTheme) => void): () => void {
  const observer = new MutationObserver(() => onChange(readTheme()))
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style', 'data-appearance', 'data-theme', 'data-platform']
  })
  // Fonts load after first paint; Geist arriving changes every measurement, so
  // re-read once the face is actually available.
  const fonts = (document as Document & { fonts?: FontFaceSet }).fonts
  const onFonts = (): void => {
    fontEpoch++
    onChange(readTheme())
  }
  fonts?.addEventListener?.('loadingdone', onFonts)
  return () => {
    observer.disconnect()
    fonts?.removeEventListener?.('loadingdone', onFonts)
  }
}
