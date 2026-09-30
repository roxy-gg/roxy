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

export const seedOfColor = (color: DitherColor): Seed =>
  color === 'accent' ? accentSeed() : PALETTE[color]

export const isDitherColor = (value: unknown): value is DitherColor =>
  typeof value === 'string' && (value === 'accent' || value in PALETTE)

/** Move a channel triple toward white by 	 (0-1). */
const lighten = ([r, g, b]: Rgb, t: number): Rgb => [
  r + (255 - r) * t,
  g + (255 - g) * t,
  b + (255 - b) * t
]

let accentKey = ''
let accentCache: Seed = PALETTE.blue

/**
 * The theme's accent as a seed. Canvas can't read ar(), so the live token is
 * resolved off <html> (where a theme writes it) and normalised by a 2D context,
 * which accepts any CSS color and hands it back as #rrggbb or 
gba(). Cached
 * on the raw value, so repeated paints cost one style read.
 */
function accentSeed(): Seed {
  if (typeof document === 'undefined') return PALETTE.blue
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim()
  if (raw === accentKey) return accentCache
  accentKey = raw
  const fill = raw ? parseCss(raw) : null
  accentCache = fill ? { fill, line: lighten(fill, 0.45), star: lighten(fill, 0.7) } : PALETTE.blue
  return accentCache
}

let probe: CanvasRenderingContext2D | null = null
function parseCss(value: string): Rgb | null {
  probe ??= document.createElement('canvas').getContext('2d')
  if (!probe) return null
  // An invalid color leaves fillStyle unchanged, so start from a sentinel.
  probe.fillStyle = '#000001'
  probe.fillStyle = value
  const out = String(probe.fillStyle)
  if (out === '#000001') return null
  const hex = /^#([0-9a-f]{6})$/i.exec(out)
  if (hex) {
    const n = parseInt(hex[1], 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(out)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}
