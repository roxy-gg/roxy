/**
 * Laying out parsed markdown into scene nodes.
 *
 * This is the canvas equivalent of the `.streamdown` prose styles: it decides
 * what a heading, a list, a table and a fenced code block look like, and returns
 * the height each consumes so the caller can stack them.
 */

import type { Builder } from './builder'
import type { MdBlock, MdInline } from './markdown'
import { parseMarkdown } from './markdown'
import { font, type Font, type InlineSpan } from './text'
import { FONT_SIZE, SPACE } from './metrics'
import { highlight, tokenColors, familyFor } from './highlight'
import { alpha, mix } from './theme'
import { linkUrl } from './links'

/** Gap after each block kind — the prose rhythm. */
const BLOCK_GAP = 10

export interface ProseStyle {
  /** Base text color. Muted inside a reasoning block, normal in prose. */
  color: string
  /** Base size. Tool output and nested transcripts render a step smaller. */
  size: number
  italic?: boolean
}

/**
 * Convert parsed inlines into styled spans the wrapper can lay out.
 *
 * Inline code becomes a chip: a tinted background behind mono text, which is
 * what `code` in the DOM prose styles is. The chip's padding is faked by
 * measuring the run and drawing slightly wider — canvas has no box model, so a
 * chip is a rect drawn behind a run rather than an element with padding.
 */
export function toSpans(
  inlines: MdInline[],
  style: ProseStyle,
  builder: Builder,
  baseFont?: Font
): InlineSpan[] {
  const palette = builder.palette
  const base = baseFont ?? font(style.size, 400, 'sans', style.italic ? 'italic' : 'normal')
  return inlines.map((frag) => {
    const href = frag.href ? (linkUrl(frag.href) ?? undefined) : undefined
    if (frag.code) {
      return {
        text: frag.text,
        // Mono runs a touch smaller than the prose around them: at equal size a
        // monospace face reads noticeably larger, which makes inline code shove
        // its line apart.
        font: font(Math.max(10, base.size - 1), 400, 'mono'),
        color: mix(style.color, palette.accent, 0.35),
        chipColor: alpha(palette.white, builder.theme.appearance === 'light' ? 0.06 : 0.07),
        href,
        underline: Boolean(href),
        offset: frag.offset
      }
    }
    const weight = frag.bold ? 600 : base.weight
    const italic = frag.italic || style.italic
    return {
      text: frag.text,
      font: font(
        base.size,
        weight as 400 | 500 | 600 | 700,
        base.family,
        italic ? 'italic' : 'normal'
      ),
      color: href ? palette.accent : style.color,
      underline: Boolean(href),
      strike: frag.strike,
      href,
      offset: frag.offset
    }
  })
}

/** Lay out a whole markdown document. Returns the height used. */
export function layoutMarkdown(
  builder: Builder,
  source: string,
  x: number,
  y: number,
  width: number,
  style: ProseStyle
): number {
  const blocks = parseMarkdown(source)
  let cursor = y
  blocks.forEach((block, i) => {
    cursor += layoutBlock(builder, block, x, cursor, width, style)
    if (i < blocks.length - 1) cursor += BLOCK_GAP
  })
  return cursor - y
}

export function layoutBlock(
  builder: Builder,
  block: MdBlock,
  x: number,
  y: number,
  width: number,
  style: ProseStyle
): number {
  const palette = builder.palette
  switch (block.type) {
    case 'paragraph':
      return builder.paragraph(toSpans(block.inlines, style, builder), x, y, width)

    case 'heading': {
      const sizes = [
        FONT_SIZE.h1,
        FONT_SIZE.h2,
        FONT_SIZE.h3,
        FONT_SIZE.h4,
        FONT_SIZE.h5,
        FONT_SIZE.h6
      ]
      const size = sizes[block.level - 1]
      const headingFont = font(size, block.level <= 2 ? 600 : 600, 'sans')
      // Headings sit tighter to what follows than to what precedes them, which
      // is what makes a document read as sections rather than as even rows.
      const lead = block.level <= 2 ? 6 : 3
      const spans = toSpans(
        block.inlines,
        { ...style, color: palette.text, size },
        builder,
        headingFont
      )
      const height = builder.paragraph(spans, x, y + lead, width)
      // An h1/h2 carries a rule under it, as the prose styles do.
      if (block.level <= 2) {
        builder.hairline(x, y + lead + height + 5, width, palette.border)
        return lead + height + 10
      }
      return lead + height
    }

    case 'code':
      return layoutCodeBlock(builder, block.code, block.lang, x, y, width)

    case 'list': {
      let cursor = y
      const markerFont = font(style.size, 400, 'sans')
      for (const item of block.items) {
        const indent = item.depth * 16
        const markerWidth = block.ordered ? builder.metrics.measure('99.', markerFont) + 6 : 14
        const textX = x + indent + markerWidth
        const textWidth = Math.max(40, width - indent - markerWidth)
        const spans = toSpans(item.inlines, style, builder)
        // Measured before the marker is drawn so the bullet can sit on the first
        // line's baseline rather than at the top of the item's box.
        const lineHeight = builder.metrics.lineHeight(font(style.size))
        builder.text(
          x + indent,
          cursor + (lineHeight - builder.metrics.lineHeight(markerFont)) / 2,
          item.marker,
          markerFont,
          block.ordered ? palette.textSubtle : palette.textMuted
        )
        cursor += builder.paragraph(spans, textX, cursor, textWidth)
        cursor += 2
      }
      return cursor - y
    }

    case 'quote': {
      const railX = x
      const innerX = x + 12
      const innerWidth = Math.max(40, width - 12)
      let cursor = y + 2
      const quoteStyle = { ...style, color: palette.textMuted }
      block.blocks.forEach((inner, i) => {
        cursor += layoutBlock(builder, inner, innerX, cursor, innerWidth, quoteStyle)
        if (i < block.blocks.length - 1) cursor += BLOCK_GAP
      })
      cursor += 2
      builder.vrule(railX, y, cursor - y, palette.borderStrong, 2)
      return cursor - y
    }

    case 'rule':
      builder.hairline(x, y + 6, width, palette.border)
      return 13

    case 'table':
      return layoutTable(builder, block, x, y, width, style)
  }
}

/**
 * A fenced code block: a surface, a hairline, and syntax-highlighted rows.
 *
 * Long lines are clipped, not wrapped. Wrapping code destroys its structure —
 * indentation stops meaning depth once a line can start halfway across — and the
 * DOM version scrolled horizontally for the same reason. Here the row is clipped
 * with a fade at the edge, which reads as "there is more" without adding a
 * second scroll axis to a block inside a scroller.
 */
export function layoutCodeBlock(
  builder: Builder,
  code: string,
  lang: string,
  x: number,
  y: number,
  width: number
): number {
  const palette = builder.palette
  const codeFont = font(FONT_SIZE.small, 400, 'mono')
  const lineHeight = builder.metrics.lineHeight(codeFont)
  const rows = highlight(code.replace(/\n$/, ''), lang)
  const colors = tokenColors(builder.theme.appearance)
  const padY = 8
  const padX = 12
  const labelHeight = lang ? 20 : 0
  const height = padY * 2 + labelHeight + rows.length * lineHeight

  builder.rect(x, y, width, height, SPACE.radiusMd, palette.surface, palette.border)
  if (lang) {
    builder.text(x + padX, y + 4, lang, font(FONT_SIZE.micro, 500, 'mono'), palette.textSubtle)
    builder.hairline(x + 1, y + labelHeight - 1, width - 2, palette.border)
    // Copying a block is the single most common thing anyone does with agent
    // output, so it gets an affordance rather than requiring a text selection.
    const label = builder.t('transcript.copy')
    const labelFont = font(FONT_SIZE.micro, 500, 'sans')
    const labelWidth = builder.metrics.measure(label, labelFont)
    builder.text(x + width - padX - labelWidth, y + 4, label, labelFont, palette.textSubtle)
    builder.region(
      x + width - padX - labelWidth - 6,
      y + 1,
      labelWidth + 12,
      labelHeight - 2,
      { type: 'copy', text: code },
      { hover: 'subtle', title: builder.t('transcript.copyCode') }
    )
  }

  const textTop = y + padY + labelHeight
  builder.clipped(x + 1, y + 1, width - 2, height - 2, SPACE.radiusMd, () => {
    builder.push({
      kind: 'code',
      x: x + padX,
      y: textTop,
      w: width - padX * 2,
      lineHeight,
      font: codeFont,
      rows,
      colors
    })
  })

  // Each row is its own selectable line so a copy preserves the source exactly.
  const advance = builder.metrics.advance(codeFont)
  rows.forEach((tokens, i) => {
    const text = tokens.map((t) => t.text).join('')
    let cursor = x + padX
    const runs = tokens.map((token) => {
      const w = advance * token.text.length
      const run = {
        text: token.text,
        font: codeFont,
        color: colors[token.kind],
        x: cursor - (x + padX),
        width: w,
        offset: 0
      }
      cursor += w
      return run
    })
    builder.selectableRow(x + padX, textTop + i * lineHeight, lineHeight, runs, text, {
      clip: { x: x + 1, y: y + 1, w: width - 2, h: height - 2 }
    })
  })
  return height
}

function layoutTable(
  builder: Builder,
  block: Extract<MdBlock, { type: 'table' }>,
  x: number,
  y: number,
  width: number,
  style: ProseStyle
): number {
  const palette = builder.palette
  const cols = Math.max(block.header.length, ...block.rows.map((r) => r.length), 1)
  const cellPad = 8
  const cellFont = font(FONT_SIZE.small, 400, 'sans')
  const headFont = font(FONT_SIZE.small, 600, 'sans')

  // Natural widths, then scaled to fit. A table wider than the column is squeezed
  // proportionally rather than clipped: every cell staying legible matters more
  // than any one keeping its ideal width.
  const natural = new Array<number>(cols).fill(0)
  const measureRow = (row: MdInline[][], f: typeof cellFont): void => {
    row.forEach((cell, i) => {
      const text = cell.map((frag) => frag.text).join('')
      natural[i] = Math.max(natural[i], builder.metrics.measure(text, f) + cellPad * 2)
    })
  }
  measureRow(block.header, headFont)
  for (const row of block.rows) measureRow(row, cellFont)
  const total = natural.reduce((a, b) => a + b, 0)
  const widths = total <= width ? natural : natural.map((w) => Math.max(40, (w / total) * width))

  let cursor = y
  const drawRow = (cells: MdInline[][], f: typeof cellFont, color: string): number => {
    let cellX = x
    let rowHeight = 0
    const heights: number[] = []
    cells.forEach((cell, i) => {
      const w = widths[i] ?? 60
      const spans = toSpans(cell, { ...style, color, size: f.size }, builder, f)
      const h = builder.paragraph(spans, cellX + cellPad, cursor + 5, Math.max(20, w - cellPad * 2))
      heights.push(h)
      rowHeight = Math.max(rowHeight, h)
      cellX += w
    })
    void heights
    return rowHeight + 10
  }

  const headHeight = drawRow(block.header, headFont, palette.text)
  builder.hairline(
    x,
    cursor + headHeight - 1,
    Math.min(
      width,
      widths.reduce((a, b) => a + b, 0)
    ),
    palette.border
  )
  cursor += headHeight
  for (const row of block.rows) {
    const h = drawRow(row, cellFont, palette.textMuted)
    cursor += h
    builder.hairline(
      x,
      cursor - 1,
      Math.min(
        width,
        widths.reduce((a, b) => a + b, 0)
      ),
      alpha(palette.border, 0.6)
    )
  }
  return cursor - y
}

/** Plain (non-markdown) text — a user message, a report body. */
export function layoutPlainText(
  builder: Builder,
  text: string,
  x: number,
  y: number,
  width: number,
  style: ProseStyle,
  family: 'sans' | 'mono' = 'sans'
): number {
  const f = font(style.size, 400, family, style.italic ? 'italic' : 'normal')
  return builder.paragraph([{ text, font: f, color: style.color, offset: 0 }], x, y, width)
}

/** Language family, exported so a `read` card can pick one from a file name. */
export { familyFor }
