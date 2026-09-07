/**
 * Drawing primitives shared by every canvas block.
 *
 * The app's visual language is squircles (a superellipse paint worklet, see
 * lib/squircle.ts), hairline borders that are really a translucent sheen, and a
 * small set of entrance animations. None of that survives into a canvas for
 * free, so it is reimplemented here — matching the CSS rather than approximating
 * it, so a card painted on canvas sits next to a DOM control without looking
 * like a different application.
 */

import type { CanvasTheme } from './theme'
import { alpha, mix } from './theme'

/**
 * The squircle exponent. The worklet uses the same superellipse; `4` is the
 * shape CSS `paint(squircle)` draws, and the radius scale that keeps visual
 * weight equal to a circular corner is 1.708 (derived in main.css).
 */
const SQ_N = 4
export const SQ_SCALE = 1.708

/**
 * Trace a superellipse-cornered rectangle.
 *
 * Sampled rather than approximated with cubics: the corner is
 * |x/r|^n + |y/r|^n = 1, and a fixed 8 segments per corner is under a pixel of
 * error at the radii used here (6-14px) while costing far less than solving for
 * control points. Falls back to a plain rect when there is no radius to draw.
 */
export function squirclePath(
  path: Path2D | CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number
): void {
  const r = Math.min(radius * SQ_SCALE, Math.min(w, h) / 2)
  if (r <= 0.5) {
    path.rect(x, y, w, h)
    return
  }
  const STEPS = 8
  // One corner's offsets from its own center, walked from the vertical axis to
  // the horizontal one.
  const corner: [number, number][] = []
  for (let i = 0; i <= STEPS; i++) {
    const t = (i / STEPS) * (Math.PI / 2)
    // Superellipse in polar-ish form: raise the unit circle to 2/n.
    const cx = Math.pow(Math.abs(Math.cos(t)), 2 / SQ_N) * r
    const cy = Math.pow(Math.abs(Math.sin(t)), 2 / SQ_N) * r
    corner.push([cx, cy])
  }
  const right = x + w
  const bottom = y + h
  path.moveTo(x + r, y)
  path.lineTo(right - r, y)
  // Top-right: start at the top edge, sweep to the right edge.
  for (let i = STEPS; i >= 0; i--) {
    const [cx, cy] = corner[i]
    path.lineTo(right - r + cx, y + r - cy)
  }
  path.lineTo(right, bottom - r)
  for (let i = 0; i <= STEPS; i++) {
    const [cx, cy] = corner[i]
    path.lineTo(right - r + cx, bottom - r + cy)
  }
  path.lineTo(x + r, bottom)
  for (let i = STEPS; i >= 0; i--) {
    const [cx, cy] = corner[i]
    path.lineTo(x + r - cx, bottom - r + cy)
  }
  path.lineTo(x, y + r)
  for (let i = 0; i <= STEPS; i++) {
    const [cx, cy] = corner[i]
    path.lineTo(x + r - cx, y + r - cy)
  }
  path.closePath()
}

/** A squircle as a reusable Path2D. */
export function squircle(x: number, y: number, w: number, h: number, radius: number): Path2D {
  const path = new Path2D()
  squirclePath(path, x, y, w, h, radius)
  return path
}

/** Filled squircle. */
export function fillSquircle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  color: string
): void {
  ctx.fillStyle = color
  ctx.fill(squircle(x, y, w, h, radius))
}

/**
 * A card: fill plus a hairline.
 *
 * The border is stroked on the half-pixel inset so it lands on a device pixel
 * rather than straddling two and rendering as a 2px blur — the canvas equivalent
 * of a crisp 1px CSS border.
 */
export function drawCard(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  fill: string | null,
  border: string | null
): void {
  if (fill) {
    ctx.fillStyle = fill
    ctx.fill(squircle(x, y, w, h, radius))
  }
  if (border) {
    ctx.strokeStyle = border
    ctx.lineWidth = 1
    ctx.stroke(squircle(x + 0.5, y + 0.5, w - 1, h - 1, radius))
  }
}

/** A crisp 1px rule. Snapped so it never lands between device pixels. */
export function hairline(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  color: string
): void {
  ctx.fillStyle = color
  ctx.fillRect(x, Math.round(y) + 0.5 - 0.5, w, 1)
}

/** A vertical rule — the rail a subagent transcript is indented behind. */
export function vrule(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  h: number,
  color: string,
  width = 1
): void {
  ctx.fillStyle = color
  ctx.fillRect(Math.round(x), y, width, h)
}

/**
 * The braille spinner, as a glyph.
 *
 * Same ten frames as ThinkingIndicator so the canvas and the DOM show the same
 * animation; the frame is derived from the clock rather than component state,
 * because canvas has none — every spinner on screen advances together, which is
 * also what the DOM version does by accident (they all mount at ~90ms intervals
 * and drift into sync).
 */
const BRAILLE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
export function brailleFrame(now: number): string {
  return BRAILLE[Math.floor(now / 90) % BRAILLE.length]
}

/**
 * The spinning arc that stands in for lucide's `Loader2`.
 *
 * Drawn rather than stroked from the icon path so it can spin: a 270° arc with
 * round caps, rotating once per second, which is what `animate-spin` does to the
 * SVG.
 */
export function drawSpinner(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string,
  now: number
): void {
  const cx = x + size / 2
  const cy = y + size / 2
  const r = size / 2 - size * 0.09
  const start = ((now % 1000) / 1000) * Math.PI * 2
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = Math.max(1.25, size * 0.115)
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.arc(cx, cy, r, start, start + Math.PI * 1.5)
  ctx.stroke()
  ctx.restore()
}

/** `animate-pulse` — the 2s ease-in-out opacity cycle Tailwind emits. */
export function pulseAlpha(now: number): number {
  const t = (now % 2000) / 2000
  return 0.55 + 0.45 * (0.5 + 0.5 * Math.cos(t * Math.PI * 2))
}

/**
 * Push a clip. Every scrollable region inside the transcript (a terminal pane,
 * a diff, a nested transcript) needs one, and forgetting the matching restore
 * leaks the clip into everything painted afterwards — so this returns the
 * restore rather than leaving it to the caller to remember.
 */
export function clip(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius = 0
): () => void {
  ctx.save()
  ctx.beginPath()
  if (radius > 0) squirclePath(ctx, x, y, w, h, radius)
  else ctx.rect(x, y, w, h)
  ctx.clip()
  return () => ctx.restore()
}

/**
 * The hover wash. `hover:bg-white/5` blended against the surface underneath,
 * because the polarity token is near-black in a light theme and a literal white
 * overlay would blow the card out.
 */
export function hoverWash(theme: CanvasTheme, surface: string, strength = 0.05): string {
  return mix(surface, theme.palette.white, strength)
}

/**
 * A translucent edge — the `--edge` sheen, resolved against its surface.
 * A flat `--color-border` is too heavy on `bg` and too faint on `elevated`;
 * this is the same trick main.css plays, done in sRGB.
 */
export function edge(theme: CanvasTheme, surface: string, strength = 0.06): string {
  return mix(surface, theme.palette.white, strength)
}

/**
 * Paint an image to fit a box, preserving aspect ratio — `object-contain`.
 * Returns the rect it actually covered so a border can be drawn around the
 * image rather than around its (usually larger) slot.
 */
export function drawContain(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  naturalW: number,
  naturalH: number,
  x: number,
  y: number,
  w: number,
  h: number
): { x: number; y: number; w: number; h: number } {
  if (naturalW <= 0 || naturalH <= 0) return { x, y, w: 0, h: 0 }
  const scale = Math.min(w / naturalW, h / naturalH)
  const dw = naturalW * scale
  const dh = naturalH * scale
  const dx = x + (w - dw) / 2
  const dy = y + (h - dh) / 2
  ctx.drawImage(img, dx, dy, dw, dh)
  return { x: dx, y: dy, w: dw, h: dh }
}

/**
 * A vertical gradient from a solid color to fully transparent — the fade that
 * dissolves the last line of the transcript into the composer.
 *
 * The transparent stop is the SAME color at alpha 0, not `transparent`. The CSS
 * keyword is `rgba(0,0,0,0)`, so interpolating to it darkens the midpoint —
 * visible here as a grey band through the fade. Matching the hue and only moving
 * alpha is what keeps it clean.
 */
export function fadeOut(
  ctx: CanvasRenderingContext2D,
  color: string,
  x: number,
  y: number,
  w: number,
  h: number,
  direction: 'up' | 'down'
): void {
  const grad = ctx.createLinearGradient(0, y, 0, y + h)
  const clear = alpha(color, 0)
  grad.addColorStop(0, direction === 'down' ? clear : color)
  grad.addColorStop(1, direction === 'down' ? color : clear)
  ctx.fillStyle = grad
  ctx.fillRect(x, y, w, h)
}
