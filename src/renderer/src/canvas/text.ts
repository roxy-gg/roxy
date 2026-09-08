/**
 * Text measurement and wrapping for the canvas transcript.
 *
 * This is the hot path. A transcript is mostly text, canvas has no layout
 * engine, and `measureText` is a real cost — enough that measuring every word of
 * every message on every frame is the difference between a smooth pane and a
 * janky one. So: measure once, cache by (font, string), and never measure during
 * paint. Layout measures; paint only draws.
 *
 * Two caches, because the two kinds of text behave differently:
 *
 *   - MONOSPACE is measured once per font and then multiplied. Code, terminal
 *     output and diffs are the bulk of a transcript's characters, and for those
 *     a width is `advance * length` — no per-string measurement at all. (Guarded:
 *     the advance is only trusted for plain ASCII, since a CJK or emoji run in a
 *     mono font is genuinely wider than one cell.)
 *   - PROPORTIONAL text is cached per word. Prose re-wraps whenever the pane
 *     resizes, but the same words keep coming back, so a word cache turns a
 *     re-wrap into arithmetic.
 */

import type { CanvasTheme } from './theme'

export type FontWeight = 400 | 500 | 600 | 700
export type FontStyle = 'normal' | 'italic'

export interface Font {
  size: number
  weight: FontWeight
  /** `mono` picks the monospace stack AND the fast measurement path. */
  family: 'sans' | 'mono'
  style: FontStyle
}

/** Terse constructor — fonts are written inline all over the layout code. */
export function font(
  size: number,
  weight: FontWeight = 400,
  family: 'sans' | 'mono' = 'sans',
  style: FontStyle = 'normal'
): Font {
  return { size, weight, family, style }
}

/** The exact string assigned to `ctx.font`. */
export function fontCss(f: Font, theme: CanvasTheme): string {
  const stack = f.family === 'mono' ? theme.mono : theme.sans
  return `${f.style === 'italic' ? 'italic ' : ''}${f.weight} ${f.size}px ${stack}`
}

const fontKey = (f: Font): string => `${f.family}|${f.size}|${f.weight}|${f.style}`

/** Only ASCII is guaranteed to be one cell wide in a monospace face. */
// eslint-disable-next-line no-control-regex
const ASCII = /^[\x20-\x7e]*$/

/**
 * Owns the measurement context and its caches.
 *
 * One instance per transcript. It is rebuilt when the theme's `epoch` changes,
 * because a different font stack invalidates every cached width — that is the
 * whole reason `epoch` exists.
 */
export class TextMetrics {
  private readonly ctx: CanvasRenderingContext2D
  readonly theme: CanvasTheme
  /** (fontKey → (word → width)). Bounded; see `measure`. */
  private readonly words = new Map<string, Map<string, number>>()
  /** fontKey → the advance of one ASCII cell, for monospace fonts. */
  private readonly advances = new Map<string, number>()
  private currentFont = ''

  constructor(theme: CanvasTheme) {
    this.theme = theme
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2d context unavailable')
    this.ctx = ctx
  }

  private select(f: Font): void {
    const css = fontCss(f, this.theme)
    if (css !== this.currentFont) {
      this.ctx.font = css
      this.currentFont = css
    }
  }

  /** The width of one character cell in a monospace font. */
  advance(f: Font): number {
    const key = fontKey(f)
    const hit = this.advances.get(key)
    if (hit !== undefined) return hit
    this.select(f)
    // 'M' over '0': digits are tabular in proportional faces too, so a digit
    // would under-report the cell if this were ever called with a sans font.
    const width = this.ctx.measureText('MMMMMMMMMM').width / 10
    this.advances.set(key, width)
    return width
  }

  /** Width of a string in a given font. Cached. */
  measure(text: string, f: Font): number {
    if (text === '') return 0
    if (f.family === 'mono' && ASCII.test(text)) return this.advance(f) * text.length
    const key = fontKey(f)
    let cache = this.words.get(key)
    if (!cache) {
      cache = new Map()
      this.words.set(key, cache)
    }
    // Only cache things that will recur. A whole paragraph is measured once and
    // would just evict words; individual words are what a re-wrap asks for again.
    const cacheable = text.length <= 32
    if (cacheable) {
      const hit = cache.get(text)
      if (hit !== undefined) return hit
    }
    this.select(f)
    const width = this.ctx.measureText(text).width
    if (cacheable) {
      // Bounded so a session full of unique identifiers cannot grow this without
      // limit. Wholesale clear rather than LRU bookkeeping: it refills from the
      // visible text within a frame, and tracking recency per word would cost
      // more than the misses it saves.
      if (cache.size > 8000) cache.clear()
      cache.set(text, width)
    }
    return width
  }

  /**
   * Line height for a font. Fixed multiplier rather than font metrics: real
   * ascent/descent varies per face, so rows would shift height when a fallback
   * font is substituted mid-transcript.
   */
  lineHeight(f: Font): number {
    return Math.round(f.size * (f.family === 'mono' ? 1.55 : 1.5))
  }

  /**
   * The baseline offset within a line box. Canvas draws from the baseline, so
   * every paint call needs this to sit text in the middle of its row.
   */
  baseline(f: Font): number {
    return Math.round(this.lineHeight(f) * 0.5 + f.size * 0.36)
  }

  /**
   * Truncate to fit, with an ellipsis — the `truncate` class, by hand.
   *
   * Binary search rather than a character walk: a long tool title against a
   * narrow card is otherwise O(n) measurements every time the pane resizes.
   */
  ellipsize(text: string, f: Font, maxWidth: number): { text: string; width: number } {
    const full = this.measure(text, f)
    if (full <= maxWidth) return { text, width: full }
    const dots = this.measure('…', f)
    const room = maxWidth - dots
    if (room <= 0) return { text: '', width: 0 }
    let lo = 0
    let hi = text.length
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (this.measure(text.slice(0, mid), f) <= room) lo = mid
      else hi = mid - 1
    }
    const cut = text.slice(0, lo)
    return { text: cut + '…', width: this.measure(cut, f) + dots }
  }
}

/** One piece of a wrapped line: a string, its font, and where it sits. */
export interface TextRun {
  text: string
  font: Font
  color: string
  x: number
  width: number
  /** Underline (links, `<u>`) — drawn as a rule under the run. */
  underline?: boolean
  /** Strikethrough (`~~text~~`). */
  strike?: boolean
  /** An inline-code chip is painted behind the run before the glyphs. */
  chipColor?: string
  /** Set when the run is a link, so a click can open it. */
  href?: string
  /**
   * Where this run's first character sits in the source string. Text selection
   * maps a click back to an offset through this, so copying a selection yields
   * the original text rather than the wrapped fragments.
   */
  offset: number
  /** Intraline diff background, separate from inline-code chips. */
  background?: string
}

export interface WrappedLine {
  runs: TextRun[]
  /** Distance from the top of the block to the top of this line's box. */
  y: number
  height: number
  width: number
  breakAfter?: boolean
}

/** An unwrapped piece of styled text, as the markdown parser produces it. */
export interface InlineSpan {
  text: string
  font: Font
  color: string
  underline?: boolean
  strike?: boolean
  chipColor?: string
  href?: string
  offset: number
  background?: string
}

/**
 * Greedy word wrap over styled spans.
 *
 * Greedy (not Knuth-Plass) on purpose: this runs on every resize and on every
 * streamed token, and the optimal algorithm's quality difference is invisible at
 * a 768px column of UI text. Breaks happen at spaces, after hyphens, and — for
 * an unbroken run longer than the line, which is what a URL or a minified blob
 * is — mid-word, because the alternative is text painted past the card's edge.
 */
export function wrapSpans(
  spans: InlineSpan[],
  maxWidth: number,
  metrics: TextMetrics,
  lineGap = 0
): { lines: WrappedLine[]; height: number } {
  maxWidth = Math.max(1, maxWidth)
  const lines: WrappedLine[] = []
  let runs: TextRun[] = []
  let x = 0
  let lineHeight = 0
  let y = 0

  const flush = (breakAfter = false): void => {
    // An empty line still occupies a row (a blank line in a code block).
    const height = (lineHeight || (spans[0] ? metrics.lineHeight(spans[0].font) : 16)) + lineGap
    lines.push({ runs, y, height, width: x, breakAfter })
    y += height
    runs = []
    x = 0
    lineHeight = 0
  }

  for (const span of spans) {
    if (span.text === '') continue
    // Explicit newlines split before anything else is considered.
    const paragraphs = span.text.split('\n')
    let paragraphOffset = span.offset
    for (let p = 0; p < paragraphs.length; p++) {
      if (p > 0) {
        flush(true)
        paragraphOffset += paragraphs[p - 1].length + 1
      }
      const chunk = paragraphs[p]
      if (chunk === '') {
        lineHeight = Math.max(lineHeight, metrics.lineHeight(span.font))
        continue
      }
      // Keep the trailing space attached to its word, so a break consumes it
      // rather than leaving it dangling at the start of the next line.
      const tokens = chunk.match(/\S+\s*|\s+/g) ?? []
      let cursor = 0
      for (const token of tokens) {
        const tokenOffset = paragraphOffset + cursor
        cursor += token.length
        const trimmed = token.replace(/\s+$/, '')
        // Measured without its trailing space: a word that only overflows
        // because of the space it is followed by still fits on the line.
        const solidWidth = metrics.measure(trimmed, span.font)
        const fullWidth = metrics.measure(token, span.font)
        if (x > 0 && x + solidWidth > maxWidth) flush()
        if (solidWidth > maxWidth) {
          // Longer than a whole line even on its own — break it by character.
          let rest = token
          let restOffset = tokenOffset
          while (rest !== '') {
            const room = maxWidth - x
            // Grow a bounded prefix instead of repeatedly measuring half of a megabyte-long token.
            let lo = 1
            let hi = Math.min(16, rest.length)
            while (hi < rest.length && metrics.measure(rest.slice(0, hi), span.font) <= room) {
              lo = hi
              hi = Math.min(rest.length, hi * 2)
            }
            while (lo < hi) {
              const mid = (lo + hi + 1) >> 1
              if (metrics.measure(rest.slice(0, mid), span.font) <= room) lo = mid
              else hi = mid - 1
            }
            let take = Math.max(1, lo)
            if (take < rest.length && /[\uD800-\uDBFF]/.test(rest[take - 1]))
              take = take === 1 ? 2 : take - 1
            const piece = rest.slice(0, take)
            const width = metrics.measure(piece, span.font)
            if (width > room && x > 0) {
              flush()
              continue
            }
            runs.push({ ...span, text: piece, x, width, offset: restOffset })
            x += width
            lineHeight = Math.max(lineHeight, metrics.lineHeight(span.font))
            rest = rest.slice(take)
            restOffset += take
            if (rest !== '') flush()
          }
          continue
        }
        runs.push({ ...span, text: token, x, width: fullWidth, offset: tokenOffset })
        x += fullWidth
        lineHeight = Math.max(lineHeight, metrics.lineHeight(span.font))
      }
    }
  }
  if (runs.length > 0 || lines.length === 0 || spans[spans.length - 1]?.text.endsWith('\n'))
    flush(true)
  return { lines, height: y }
}
