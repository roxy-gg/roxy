// Shared seed palette for the dither chart family. Mirrors the seeds in
// `dither-chart.tsx` so a series rendered through the composable engine reads
// with the exact same fill / line / star hues as the legacy sparkline.

export type Rgb = [number, number, number]

/** A fixed hue baked into the palette below. */
export type DitherHue = 'green' | 'blue' | 'purple' | 'pink' | 'orange' | 'red' | 'grey'

/**
 * `accent` is not a fixed hue: it follows the active theme's `--color-accent`,
 * so a chart that represents "the app" (usage, spend) recolors with the theme
 * like every other accent surface instead of staying Roxy-default blue.
 */
export type DitherColor = DitherHue | 'accent'

export type Seed = { fill: Rgb; line: Rgb; star: Rgb }

// Each seed: the area-fill hue, the bright series line, and the star sparkle.
export const PALETTE: Record<DitherHue, Seed> = {
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

/** `accent` resolves to the seed passed in (see `useAccentSeed`); the fixed
 *  hues ignore it. Falls back to blue — the default theme's accent. */
export const seedOfColor = (color: DitherColor, accent?: Seed): Seed =>
  color === 'accent' ? (accent ?? PALETTE.blue) : PALETTE[color]

export const isDitherColor = (value: unknown): value is DitherColor =>
  typeof value === 'string' && (value === 'accent' || value in PALETTE)

const mixToWhite = ([r, g, b]: Rgb, t: number): Rgb => [
  Math.round(r + (255 - r) * t),
  Math.round(g + (255 - g) * t),
  Math.round(b + (255 - b) * t)
]

/**
 * A full seed from one base color, matching how the fixed hues are built: the
 * line and star are the fill lifted toward white (blue's line is ~50% lifted,
 * its star ~75%).
 */
export const seedFromRgb = (fill: Rgb): Seed => ({
  fill,
  line: mixToWhite(fill, 0.5),
  star: mixToWhite(fill, 0.75)
})
