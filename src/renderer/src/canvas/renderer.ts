/**
 * The painter: walks a laid-out scene and draws it.
 *
 * This does no measurement and allocates nothing per frame. Everything it needs
 * was decided during layout, which is what makes a scroll cost the same
 * regardless of how much transcript exists above the viewport.
 *
 * State changes on a 2D context are not free, so runs of text are drawn with the
 * font and fill set once per run rather than per glyph, and the context's
 * `font`/`fillStyle` are tracked so redundant assignments are skipped.
 */

import type { Block, HitRegion, Node, Rect, Scene, SelectableLine } from './scene'
import { fontCss, type Font, type TextRun, type TextMetrics } from './text'
import type { CanvasTheme } from './theme'
import { alpha, mix } from './theme'
import { drawIcon, fillIcon } from './icons'
import {
  brailleFrame,
  drawCard,
  drawContain,
  drawSpinner,
  fadeOut,
  pulseAlpha,
  squircle
} from './paint'

export interface PaintContext {
  ctx: CanvasRenderingContext2D
  theme: CanvasTheme
  /** Scroll offset — how far the transcript has moved up past the viewport. */
  scrollTop: number
  viewportHeight: number
  now: number
  reducedMotion?: boolean
  /** The region under the pointer, so it can be washed. */
  hovered: HitRegion | null
  /** Decoded images by src (the transcript keeps the cache). */
  images: Map<string, HTMLImageElement>
  /** Selection to highlight, in transcript space. */
  selection: SelectionRange | null
  metrics: TextMetrics
}

export interface SelectionRange {
  /** Selectable-line index where the selection starts. */
  startLine: number
  startChar: number
  endLine: number
  endChar: number
  group?: string
  all?: boolean
}

/** Track the last-assigned context state so redundant sets are skipped. */
class Pen {
  private font = ''
  private fill = ''
  constructor(private readonly ctx: CanvasRenderingContext2D) {}
  setFont(css: string): void {
    if (css !== this.font) {
      this.ctx.font = css
      this.font = css
    }
  }
  setFill(color: string): void {
    if (color !== this.fill) {
      this.ctx.fillStyle = color
      this.fill = color
    }
  }
  /** After a save/restore the context's state may have rolled back. */
  invalidate(): void {
    this.font = ''
    this.fill = ''
  }
}

export function paintScene(scene: Scene, paint: PaintContext): void {
  const { ctx, theme, scrollTop, viewportHeight } = paint
  ctx.save()
  ctx.fillStyle = theme.palette.bg
  ctx.fillRect(0, 0, scene.width, viewportHeight)

  ctx.translate(0, -scrollTop)
  const pen = new Pen(ctx)

  const top = scrollTop
  const bottom = scrollTop + viewportHeight

  for (const block of scene.blocks) {
    // Virtualization: a block outside the viewport is never touched.
    if (block.y + block.height < top || block.y > bottom) continue
    paintNodes(block.nodes, paint, pen)
  }

  // The hover wash goes over the block that owns it, not under: a card's fill is
  // opaque, so washing first would be invisible.
  if (paint.hovered && paint.hovered.hover !== 'none') paintHover(paint.hovered, paint, pen)
  if (paint.selection) paintSelection(scene, paint, pen)

  ctx.restore()
}

function paintHover(region: HitRegion, paint: PaintContext, pen: Pen): void {
  const { ctx, theme } = paint
  const wash = alpha(theme.palette.white, region.hover === 'card' ? 0.045 : 0.07)
  ctx.fillStyle = wash
  pen.invalidate()
  const radius = region.hover === 'card' ? 0 : 4
  if (radius > 0) ctx.fill(squircle(region.x, region.y, region.w, region.h, radius))
  else ctx.fillRect(region.x, region.y, region.w, region.h)
}

function paintNodes(nodes: Node[], paint: PaintContext, pen: Pen): void {
  for (const node of nodes) paintNode(node, paint, pen)
}

function paintNode(node: Node, paint: PaintContext, pen: Pen): void {
  const { ctx, theme } = paint
  switch (node.kind) {
    case 'rect':
      drawCard(
        ctx,
        node.x,
        node.y,
        node.w,
        node.h,
        node.radius,
        node.fill ?? null,
        node.border ?? null
      )
      pen.invalidate()
      return

    case 'hairline':
      pen.setFill(node.color)
      ctx.fillRect(node.x, Math.round(node.y), node.w, 1)
      return

    case 'vrule':
      pen.setFill(node.color)
      ctx.fillRect(Math.round(node.x), node.y, node.w, node.h)
      return

    case 'text': {
      pen.setFont(fontCss(node.font, theme))
      pen.setFill(node.color)
      // Baselines are computed once during layout and stored as the TOP of the
      // line box, so paint adds the ascent here rather than every layout site
      // remembering to.
      const baseline = node.y + baselineOffset(node.font)
      if (node.align === 'right' && node.maxWidth !== undefined) {
        ctx.textAlign = 'right'
        ctx.fillText(node.text, node.x + node.maxWidth, baseline)
        ctx.textAlign = 'left'
      } else if (node.align === 'center' && node.maxWidth !== undefined) {
        ctx.textAlign = 'center'
        ctx.fillText(node.text, node.x + node.maxWidth / 2, baseline)
        ctx.textAlign = 'left'
      } else {
        ctx.fillText(node.text, node.x, baseline)
      }
      return
    }

    case 'elapsed': {
      const seconds = Math.floor((paint.now - node.startedAt) / 1000)
      if (seconds < 1) return
      pen.setFont(fontCss(node.font, theme))
      pen.setFill(node.color)
      ctx.fillText(`${seconds}s`, node.x, node.y + baselineOffset(node.font))
      return
    }

    case 'lines': {
      for (const line of node.lines) {
        const y = node.y + line.y
        // Skip lines outside the viewport — a long message is mostly off screen.
        if (y + line.height < paint.scrollTop || y > paint.scrollTop + paint.viewportHeight)
          continue
        paintRuns(line.runs, node.x, y, line.height, paint, pen)
      }
      return
    }

    case 'icon':
      drawIcon(ctx, node.name, node.x, node.y, node.size, node.color, {
        rotate: node.rotate,
        opacity: node.opacity
      })
      pen.invalidate()
      return

    case 'iconFill':
      fillIcon(ctx, node.name, node.x, node.y, node.size, node.color)
      pen.invalidate()
      return

    case 'spinner':
      ctx.save()
      if (paint.reducedMotion) ctx.globalAlpha *= pulseAlpha(paint.now)
      drawSpinner(ctx, node.x, node.y, node.size, node.color, paint.reducedMotion ? 0 : paint.now)
      ctx.restore()
      pen.invalidate()
      return

    case 'braille':
      ctx.save()
      if (paint.reducedMotion) ctx.globalAlpha *= pulseAlpha(paint.now)
      pen.setFont(fontCss(node.font, theme))
      pen.setFill(node.color)
      ctx.fillText(
        brailleFrame(paint.reducedMotion ? 0 : paint.now),
        node.x,
        node.y + baselineOffset(node.font)
      )
      ctx.restore()
      pen.invalidate()
      return

    case 'image':
      paintImage(node, paint, pen)
      return

    case 'code':
      paintCode(node, paint, pen)
      return

    case 'ansi':
      paintAnsi(node, paint, pen)
      return

    case 'clip': {
      ctx.save()
      ctx.beginPath()
      ctx.clip(squircle(node.x, node.y, node.w, node.h, node.radius))
      pen.invalidate()
      const top = Math.max(paint.scrollTop, node.y)
      const bottom = Math.min(paint.scrollTop + paint.viewportHeight, node.y + node.h)
      if (bottom > top)
        paintNodes(node.children, { ...paint, scrollTop: top, viewportHeight: bottom - top }, pen)
      ctx.restore()
      pen.invalidate()
      return
    }

    case 'fade':
      fadeOut(ctx, node.color, node.x, node.y, node.w, node.h, node.direction)
      pen.invalidate()
      return

    case 'group': {
      if (node.offsetY) {
        ctx.save()
        ctx.translate(0, node.offsetY)
        paintNodes(node.children, { ...paint, scrollTop: paint.scrollTop - node.offsetY }, pen)
        ctx.restore()
        pen.invalidate()
      } else {
        paintNodes(node.children, paint, pen)
      }
      return
    }

    case 'pulse': {
      ctx.save()
      ctx.globalAlpha *= pulseAlpha(paint.now)
      paintNodes(node.children, paint, pen)
      ctx.restore()
      pen.invalidate()
      return
    }
  }
}

/** Draw one wrapped line's runs, including chips, underlines and strikes. */
function paintRuns(
  runs: TextRun[],
  x: number,
  y: number,
  lineHeight: number,
  paint: PaintContext,
  pen: Pen
): void {
  const { ctx, theme } = paint
  // Chips first: they sit behind their glyphs.
  for (const run of runs) {
    if (run.background) {
      pen.setFill(run.background)
      ctx.fillRect(x + run.x, y, run.width, lineHeight)
    }
    if (!run.chipColor) continue
    pen.setFill(run.chipColor)
    const pad = 3
    ctx.fillRect(x + run.x - pad, y + 1, run.width + pad * 2, lineHeight - 2)
  }
  for (const run of runs) {
    pen.setFont(fontCss(run.font, theme))
    pen.setFill(run.color)
    const baseline = y + baselineOffset(run.font, lineHeight)
    if (run.text !== '\t') ctx.fillText(run.text, x + run.x, baseline)
    if (run.underline) {
      pen.setFill(run.color)
      ctx.fillRect(x + run.x, baseline + 2, run.width, 1)
    }
    if (run.strike) {
      pen.setFill(run.color)
      ctx.fillRect(x + run.x, baseline - run.font.size * 0.3, run.width, 1)
    }
  }
}

/**
 * Where the baseline sits inside a line box.
 *
 * A fixed fraction rather than the font's own ascent: real metrics differ per
 * face, so a fallback substituting mid-transcript would shift rows by a pixel or
 * two, which is far more visible than a baseline that is not perfectly centred.
 */
function baselineOffset(f: Font, lineHeight?: number): number {
  const height = lineHeight ?? Math.round(f.size * (f.family === 'mono' ? 1.55 : 1.5))
  return Math.round(height * 0.5 + f.size * 0.36)
}

function paintImage(node: Extract<Node, { kind: 'image' }>, paint: PaintContext, pen: Pen): void {
  const { ctx, theme } = paint
  const img = paint.images.get(node.src)
  if (!img || !img.complete || img.naturalWidth === 0) {
    // A placeholder while the image decodes — same footprint, so nothing jumps
    // when it lands.
    drawCard(
      ctx,
      node.x,
      node.y,
      node.w,
      node.h,
      node.radius,
      theme.palette.surface2,
      node.border ?? null
    )
    if (node.src === '__roxy__') {
      ctx.font = fontCss({ size: 15, weight: 600, family: 'sans', style: 'normal' }, theme)
      ctx.fillStyle = theme.palette.textMuted
      ctx.textAlign = 'center'
      ctx.fillText('R', node.x + node.w / 2, node.y + node.h / 2 + 5)
      ctx.textAlign = 'left'
    }
    pen.invalidate()
    return
  }
  ctx.save()
  ctx.beginPath()
  const path = squircle(node.x, node.y, node.w, node.h, node.radius)
  ctx.clip(path)
  const rect = drawContain(
    ctx,
    img,
    img.naturalWidth,
    img.naturalHeight,
    node.x,
    node.y,
    node.w,
    node.h
  )
  ctx.restore()
  pen.invalidate()
  if (node.border) {
    ctx.strokeStyle = node.border
    ctx.lineWidth = 1
    ctx.stroke(squircle(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1, node.radius))
  }
}

function paintCode(node: Extract<Node, { kind: 'code' }>, paint: PaintContext, pen: Pen): void {
  const { ctx, theme } = paint
  pen.setFont(fontCss(node.font, theme))
  const baseline = baselineOffset(node.font, node.lineHeight)
  const top = paint.scrollTop
  const bottom = top + paint.viewportHeight
  const first = Math.max(0, Math.floor((top - node.y) / node.lineHeight))
  const last = Math.min(node.rows.length - 1, Math.ceil((bottom - node.y) / node.lineHeight))

  const advance = measureAdvance(ctx, node.font, theme)
  for (let i = first; i <= last; i++) {
    const rowY = node.y + i * node.lineHeight
    if (node.gutter) {
      pen.setFill(node.gutter.color)
      const label = String(node.gutter.start + i)
      ctx.textAlign = 'right'
      ctx.fillText(label, node.x - 8, rowY + baseline)
      ctx.textAlign = 'left'
    }
    let cursor = node.x
    for (const token of node.rows[i]) {
      const width = advance * token.text.length
      // Stop drawing once a row runs past the block's right edge — a minified
      // line is otherwise thousands of glyphs the clip would throw away anyway.
      if (cursor > node.x + node.w) break
      if (token.text.trim() !== '') {
        pen.setFill(node.colors[token.kind] ?? node.colors.plain)
        ctx.fillText(token.text, cursor, rowY + baseline)
      }
      cursor += width
    }
  }
}

function paintAnsi(node: Extract<Node, { kind: 'ansi' }>, paint: PaintContext, pen: Pen): void {
  const { ctx, theme } = paint
  const baseline = baselineOffset(node.font, node.lineHeight)
  const top = paint.scrollTop
  const bottom = top + paint.viewportHeight
  const first = Math.max(0, Math.floor((top - node.y) / node.lineHeight))
  const last = Math.min(node.rows.length - 1, Math.ceil((bottom - node.y) / node.lineHeight))
  const advance = measureAdvance(ctx, node.font, theme)

  for (let i = first; i <= last; i++) {
    const rowY = node.y + i * node.lineHeight
    let cursor = node.x
    for (const span of node.rows[i]) {
      const width = advance * span.text.length
      if (cursor > node.x + node.w) break
      if (span.background) {
        pen.setFill(span.background)
        ctx.fillRect(cursor, rowY, width, node.lineHeight)
      }
      if (span.text.trim() !== '') {
        const f: Font = {
          ...node.font,
          weight: span.bold ? 700 : node.font.weight,
          style: span.italic ? 'italic' : 'normal'
        }
        pen.setFont(fontCss(f, theme))
        const color = span.color ?? node.defaultColor
        pen.setFill(span.dim ? alpha(color, 0.7) : color)
        ctx.fillText(span.text, cursor, rowY + baseline)
        if (span.underline) ctx.fillRect(cursor, rowY + baseline + 2, width, 1)
      }
      cursor += width
    }
  }
  pen.setFont(fontCss(node.font, theme))
}

/**
 * Monospace advance, measured against the live context.
 *
 * Layout measured this too, but paint cannot reach the layout metrics object
 * without threading it through every node, and a cached measure on the paint
 * context is one `measureText` per font per frame at worst.
 */
const advanceCache = new Map<string, number>()
function measureAdvance(ctx: CanvasRenderingContext2D, f: Font, theme: CanvasTheme): number {
  const css = fontCss(f, theme)
  const key = `${theme.epoch}|${css}`
  const hit = advanceCache.get(key)
  if (hit !== undefined) return hit
  const previous = ctx.font
  ctx.font = css
  const width = ctx.measureText('MMMMMMMMMM').width / 10
  ctx.font = previous
  if (advanceCache.size > 64) advanceCache.clear()
  advanceCache.set(key, width)
  return width
}

/**
 * Paint the selection highlight.
 *
 * Drawn over the text with a translucent accent, the same way `::selection`
 * works — a solid fill under the glyphs would need the text repainted in an
 * inverted colour, which is a second pass over everything selected.
 */
function paintSelection(scene: Scene, paint: PaintContext, pen: Pen): void {
  const { ctx, theme, selection } = paint
  if (!selection || selectionCollapsed(selection)) return
  const color = alpha(mix(theme.palette.accent, theme.palette.white, 0.1), 0.28)
  const [from, to] = normalizeSelection(selection)
  ctx.fillStyle = color
  pen.invalidate()

  for (const block of scene.blocks) {
    if (block.y + block.height < paint.scrollTop) continue
    if (block.y > paint.scrollTop + paint.viewportHeight) break
    for (const line of block.selectable) {
      if (line.index < from.line || line.index > to.line) continue
      if (selection.group && line.group !== selection.group) continue
      const startChar = line.index === from.line ? from.char : 0
      const endChar = line.index === to.line ? to.char : Infinity
      const rect = charRange(line, startChar, endChar, paint.metrics)
      if (rect) {
        ctx.save()
        if (line.clip) {
          ctx.beginPath()
          ctx.rect(line.clip.x, line.clip.y, line.clip.w, line.clip.h)
          ctx.clip()
        }
        ctx.fillRect(rect.x, line.y, rect.w, line.height)
        ctx.restore()
      }
    }
  }
}

function normalizeSelection(
  s: SelectionRange
): [{ line: number; char: number }, { line: number; char: number }] {
  const a = { line: s.startLine, char: s.startChar }
  const b = { line: s.endLine, char: s.endChar }
  if (a.line < b.line || (a.line === b.line && a.char <= b.char)) return [a, b]
  return [b, a]
}

/** The pixel span of a character range within a selectable line. */
function charRange(
  line: SelectableLine,
  startChar: number,
  endChar: number,
  metrics: TextMetrics
): { x: number; w: number } | null {
  let consumed = 0
  let startX: number | null = null
  let endX: number | null = null
  for (const run of line.runs) {
    const runStart = consumed
    const runEnd = consumed + run.text.length
    if (startX === null && startChar <= runEnd) {
      startX = line.x + run.x + runAdvance(run, Math.max(0, startChar - runStart), metrics)
    }
    if (endChar <= runEnd) {
      endX = line.x + run.x + runAdvance(run, Math.max(0, endChar - runStart), metrics)
      break
    }
    endX = line.x + run.x + run.width
    consumed = runEnd
  }
  if (startX === null || endX === null) return null
  const w = endX - startX
  // An empty line still shows a sliver, so a multi-line selection reads as
  // continuous rather than skipping the blank rows inside it.
  return { x: startX, w: w > 0 ? w : 4 }
}

/** Which region a point lands in. Later regions win — they were drawn on top. */
export function hitTest(scene: Scene, x: number, y: number): HitRegion | null {
  for (let b = scene.blocks.length - 1; b >= 0; b--) {
    const block = scene.blocks[b]
    if (y < block.y || y > block.y + block.height) continue
    for (let i = block.regions.length - 1; i >= 0; i--) {
      const r = block.regions[i]
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r
    }
  }
  return null
}

/** The selectable line and character offset nearest a point. */
export function hitText(
  scene: Scene,
  x: number,
  y: number,
  metrics: TextMetrics,
  options: { nearest?: boolean; group?: string } = {}
): { line: number; char: number; group?: string } | null {
  let best: { line: SelectableLine; distance: number } | null = null
  for (const block of scene.blocks) {
    if (!options.nearest && (y < block.y || y > block.y + block.height)) continue
    for (const line of block.selectable) {
      if (options.group && line.group !== options.group) continue
      if (!options.nearest && (y < line.y || y > line.y + line.height)) continue
      const left = line.x + (line.runs[0]?.x ?? 0)
      const right = line.runs.reduce(
        (right, run) => Math.max(right, line.x + run.x + run.width),
        left + 1
      )
      const bounds: Rect = { x: left, y: line.y, w: right - left, h: line.height }
      if (line.clip) {
        const end = Math.min(bounds.y + bounds.h, line.clip.y + line.clip.h)
        bounds.y = Math.max(bounds.y, line.clip.y)
        bounds.h = end - bounds.y
        if (bounds.h <= 0) continue
      }
      if (
        !options.nearest &&
        (!contains(bounds, x, y) || (line.clip && !contains(line.clip, x, y)))
      )
        continue
      const dx = x < left ? left - x : Math.max(0, x - right)
      const dy = y < bounds.y ? bounds.y - y : Math.max(0, y - bounds.y - bounds.h)
      const distance = dy * 10000 + dx
      if (!best || distance < best.distance) best = { line, distance }
    }
  }
  if (!best) return null
  const clippedX = best.line.clip
    ? Math.max(best.line.clip.x, Math.min(x, best.line.clip.x + best.line.clip.w))
    : x
  return {
    line: best.line.index,
    char: charAt(best.line, clippedX, metrics),
    group: best.line.group
  }
}

/** Character offset within a line for an x coordinate. */
function charAt(line: SelectableLine, x: number, metrics: TextMetrics): number {
  let consumed = 0
  for (const run of line.runs) {
    const left = line.x + run.x
    const right = left + run.width
    if (x < left) return consumed
    if (x <= right) {
      if (run.font.family === 'mono' && /^[\x20-\x7e]+$/.test(run.text))
        return (
          consumed +
          Math.max(
            0,
            Math.min(run.text.length, Math.round((x - left) / (run.width / run.text.length)))
          )
        )
      let boundaries = graphemes.get(run)
      if (!boundaries) {
        boundaries = Array.from(segmenter.segment(run.text), (segment) => segment.index)
        boundaries.push(run.text.length)
        graphemes.set(run, boundaries)
      }
      let low = 0
      let high = boundaries.length - 1
      while (low < high) {
        const mid = Math.floor((low + high) / 2)
        const a = runAdvance(run, boundaries[mid], metrics)
        const b = runAdvance(run, boundaries[mid + 1], metrics)
        if (x - left < (a + b) / 2) high = mid
        else low = mid + 1
      }
      return consumed + boundaries[low]
    }
    consumed += run.text.length
  }
  return consumed
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' })
const graphemes = new WeakMap<TextRun, number[]>()

/** Select the word-like segment under a canvas text hit, matching native double-click selection. */
export function wordSelection(
  scene: Scene,
  hit: { line: number; char: number; group?: string }
): SelectionRange | null {
  const line = scene.blocks
    .flatMap((block) => block.selectable)
    .find((candidate) => candidate.index === hit.line && candidate.group === hit.group)
  if (!line?.text) return null
  const offset = Math.max(0, Math.min(hit.char, line.text.length))
  let last: { index: number; segment: string } | null = null
  for (const part of wordSegmenter.segment(line.text)) {
    last = part
    const end = part.index + part.segment.length
    if (offset >= part.index && offset < end) {
      return {
        startLine: line.index,
        startChar: part.index,
        endLine: line.index,
        endChar: end,
        group: line.group
      }
    }
  }
  if (!last || offset !== line.text.length) return null
  return {
    startLine: line.index,
    startChar: last.index,
    endLine: line.index,
    endChar: line.text.length,
    group: line.group
  }
}

/** The text of a selection, for the clipboard. */
export function selectionText(scene: Scene, selection: SelectionRange): string {
  if (selection.all && scene.copyText) return scene.copyText()
  const [from, to] = normalizeSelection(selection)
  const parts: string[] = []
  for (const block of scene.blocks) {
    for (const line of block.selectable) {
      if (line.index < from.line || line.index > to.line) continue
      if (selection.group && line.group !== selection.group) continue
      const start = line.index === from.line ? from.char : 0
      const end = line.index === to.line ? to.char : line.text.length
      parts.push(line.text.slice(start, Math.max(start, end)))
      // A wrapped paragraph is one logical line: only the LAST visual row of it
      // carries a break, so copying prose does not inherit the line breaks this
      // particular window width happened to produce.
      if (line.breakAfter && line.index !== to.line) parts.push('\n')
    }
  }
  return parts.join('')
}

export function selectionCollapsed(selection: SelectionRange): boolean {
  return selection.startLine === selection.endLine && selection.startChar === selection.endChar
}

function runAdvance(run: TextRun, offset: number, metrics: TextMetrics): number {
  if (offset >= run.text.length) return run.width
  if (offset <= 0) return 0
  return metrics.measure(run.text.slice(0, offset), run.font)
}

export function contains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h
}

/** Every block that needs continuous repaint (spinners, pulses, live text). */
export function hasAnimation(scene: Scene, scrollTop: number, viewportHeight: number): boolean {
  for (const block of scene.blocks) {
    if (block.y + block.height < scrollTop) continue
    if (block.y > scrollTop + viewportHeight) break
    if (block.animated) return true
  }
  return false
}

/** Unused import guard — `Block` is part of the public shape of a Scene. */
export type { Block }
