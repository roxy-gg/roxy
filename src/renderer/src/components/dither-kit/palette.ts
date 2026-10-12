// Shared seed palette for the dither chart family. Mirrors the seeds in
// `dither-chart.tsx` so a series rendered through the composable engine reads
// with the exact same fill / line / star hues as the legacy sparkline.

export type Rgb = [number, number, number]

/** A fixed hue, or `accent` for the active theme's accent (`--color-accent`). */
export type DitherColor =
  | 'accent'
  | 'green'
  | 'blue'
  | 'purple'
  | 'pink'
  | 'orange'
  | 'red'
  | 'grey'

type FixedColor = Exclude<DitherColor, 'accent'>

export type Seed = { fill: Rgb; line: Rgb; star: Rgb }

// Each seed: the area-fill hue, the bright series line, and the star sparkle.
export const PALETTE: Record<FixedColor, Seed> = {
  green: { fill: [40, 210, 110], line: [150, 255, 180], star: [200, 255, 220] },
  blue: { fill: [53, 143, 243], line: [150, 200, 255], star: [205, 228, 255] },
  purple: {
    fill: [150, 110, 255],
    line: [200, 175, 255],
    star: [225, 210, 255]
  },
  pink: { fill: [240, 90, 190], line: [255, 170, 220], star: [255, 205, 235] },
  orange: {
    fill: [255, 150, 50],
    line: [255, 195, 130],
    star: [255, 220, 175]
  },
  red: { fill: [240, 70, 70], line: [255, 150, 140], star: [255, 195, 185] },
  // No-data: a muted grey so empty metrics read as "nothing here".
  grey: { fill: [92, 92, 100], line: [140, 140, 150], star: [165, 165, 175] }
}

export const rgb = ([r, g, b]: Rgb, k = 1, a = 1) =>
  `rgba(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)},${a})`

/**
 * `accent` resolves to the seed passed in when the caller tracks it live (see
 * `useAccentSeed`), otherwise to a one-off read of the current theme.
 */
export const seedOfColor = (color: DitherColor, accent?: Seed): Seed =>
  color === 'accent' ? (accent ?? accentSeed()) : PALETTE[color]

export const isDitherColor = (value: unknown): value is DitherColor =>
  typeof value === 'string' && (value === 'accent' || value in PALETTE)

/** Move a channel triple toward white by `t` (0-1). */
const lighten = ([r, g, b]: Rgb, t: number): Rgb => [
  Math.round(r + (255 - r) * t),
  Math.round(g + (255 - g) * t),
  Math.round(b + (255 - b) * t)
]

let probe: CanvasRenderingContext2D | null | undefined

/**
 * Resolve any CSS color to sRGB bytes by painting one pixel.
 *
 * A theme may set `--color-accent` as hex, `rgb()`, `oklch()`, or anything
 * else CSS accepts, and the custom property's computed value is just that
 * text. Reading `fillStyle` back is not enough -- Chromium returns `oklch()`
 * and `color()` values verbatim -- so let the canvas rasterize it and read the
 * pixel. `willReadFrequently` keeps the tiny canvas on the CPU.
 */
function toRgb(color: string): Rgb | null {
  if (!color) return null
  if (probe === undefined) {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    probe = canvas.getContext('2d', { willReadFrequently: true })
  }
  if (!probe) return null
  probe.clearRect(0, 0, 1, 1)
  // An unparseable value leaves fillStyle unchanged. Reset to a fully
  // transparent sentinel first, so a failed parse paints alpha 0 and falls
  // back -- an opaque sentinel would be indistinguishable from a real accent.
  probe.fillStyle = 'rgba(0, 0, 0, 0)'
  probe.fillStyle = color
  probe.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data
  return a === 0 ? null : [r, g, b]
}

let accentKey = ''
let accentCache: Seed = PALETTE.blue

/**
 * The active theme's accent as a seed, read off <html> (where a theme writes
 * it). The line and star are the fill lifted toward white, like the fixed
 * hues. Cached on the raw token, so repeated reads cost one style lookup.
 * Falls back to blue -- the default theme's accent.
 */
export function accentSeed(): Seed {
  if (typeof document === 'undefined') return PALETTE.blue
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim()
  if (raw === accentKey) return accentCache
  accentKey = raw
  const fill = toRgb(raw)
  accentCache = fill ? { fill, line: lighten(fill, 0.45), star: lighten(fill, 0.7) } : PALETTE.blue
  return accentCache
}
