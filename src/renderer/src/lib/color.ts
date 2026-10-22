/**
 * Color math for the theme color picker.
 *
 * A theme may hold ANY CSS color -- hex, `rgba()`, `oklch()`, `color-mix()` --
 * so the picker can't assume hex. Hex and `rgb[a]()` are parsed by hand (exact,
 * and no DOM needed); everything else is handed to the browser's own CSS parser
 * through a canvas, so the picker understands exactly what the app will paint
 * rather than a second, subtly different implementation of the color spec.
 */

export interface Rgba {
  r: number
  g: number
  b: number
  /** 0-1 */
  a: number
}

export interface Hsva {
  /** 0-360 */
  h: number
  /** 0-1 */
  s: number
  /** 0-1 */
  v: number
  /** 0-1 */
  a: number
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(v, hi))

function parseHex(input: string): Rgba | null {
  const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(input)
  if (!m) return null
  let hex = m[1]
  if (hex.length <= 4) {
    hex = hex
      .split('')
      .map((c) => c + c)
      .join('')
  }
  const n = (i: number): number => parseInt(hex.slice(i, i + 2), 16)
  return { r: n(0), g: n(2), b: n(4), a: hex.length === 8 ? n(6) / 255 : 1 }
}

function parseRgbFunction(input: string): Rgba | null {
  // The comma form the canvas serializes to: `rgb(1, 2, 3)` / `rgba(1, 2, 3, 0.5)`.
  const m =
    /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*(?:,\s*(\d*\.?\d+)\s*)?\)$/i.exec(
      input
    )
  if (!m) return null
  return {
    r: clamp(Math.round(Number(m[1])), 0, 255),
    g: clamp(Math.round(Number(m[2])), 0, 255),
    b: clamp(Math.round(Number(m[3])), 0, 255),
    a: m[4] === undefined ? 1 : clamp(Number(m[4]), 0, 1)
  }
}

let probe: CanvasRenderingContext2D | null | undefined

/**
 * Resolve any CSS color string to sRGB, or null when it isn't a color.
 *
 * `fillStyle` silently KEEPS its previous value when assigned garbage, which is
 * how invalid input is told apart from a color that merely equals the last one:
 * assign the same string after two different sentinels and see whether the
 * result still depends on the sentinel.
 */
export function parseCssColor(value: string): Rgba | null {
  const v = value.trim()
  if (!v) return null
  const direct = parseHex(v) ?? parseRgbFunction(v)
  if (direct) return direct

  if (probe === undefined) {
    probe =
      typeof document === 'undefined'
        ? null
        : document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  }
  const ctx = probe
  if (!ctx) return null

  ctx.fillStyle = '#000000'
  ctx.fillStyle = v
  const onBlack = ctx.fillStyle
  ctx.fillStyle = '#ffffff'
  ctx.fillStyle = v
  if (ctx.fillStyle !== onBlack) return null

  // sRGB colors serialize back as hex / rgba(), which keeps alpha exact.
  const serialized = String(ctx.fillStyle)
  const exact = parseHex(serialized) ?? parseRgbFunction(serialized)
  if (exact) return exact

  // Wide-gamut and relative colors (oklch, color-mix) serialize in their own
  // space; rasterize one pixel to get the sRGB value the screen would show.
  ctx.clearRect(0, 0, 1, 1)
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
  return { r, g, b, a: a / 255 }
}

export function rgbaToHsva({ r, g, b, a }: Rgba): Hsva {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const d = max - Math.min(rn, gn, bn)
  let h = 0
  if (d) {
    if (max === rn) h = ((gn - bn) / d) % 6
    else if (max === gn) h = (bn - rn) / d + 2
    else h = (rn - gn) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return { h, s: max ? d / max : 0, v: max, a }
}

export function hsvaToRgba({ h, s, v, a }: Hsva): Rgba {
  const hue = ((h % 360) + 360) % 360
  const c = v * s
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = v - c
  const [r, g, b] =
    hue < 60
      ? [c, x, 0]
      : hue < 120
        ? [x, c, 0]
        : hue < 180
          ? [0, c, x]
          : hue < 240
            ? [0, x, c]
            : hue < 300
              ? [x, 0, c]
              : [c, 0, x]
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
    a
  }
}

const hex2 = (n: number): string => n.toString(16).padStart(2, '0')

/**
 * Write a color the way theme files already do: `#rrggbb` when opaque, and the
 * `rgba(r, g, b, a)` form (as the built-in Claude and Codex themes use) when not.
 */
export function formatColor({ r, g, b, a }: Rgba): string {
  if (a >= 1) return `#${hex2(r)}${hex2(g)}${hex2(b)}`
  return `rgba(${r}, ${g}, ${b}, ${Math.round(a * 1000) / 1000})`
}
