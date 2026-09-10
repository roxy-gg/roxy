import type { Builder } from '../../canvas/builder'
import type { Rect, ViewState } from '../../canvas/scene'
import { font, type TextRun, type WrappedLine } from '../../canvas/text'
import { mix } from '../../canvas/theme'
import { rowOffsets, visibleRange } from '../../lib/windowing'
import {
  diffRows,
  type DiffRow,
  type DiffSide,
  type DiffViewState,
  type InlineChange
} from './model'

type DiffLayout = {
  key: string
  lines: Map<string, WrappedLine[]>
  rows: DiffRow[]
  heights: number[]
  offsets: Float64Array
  widest: number
}
const layoutCache = new WeakMap<DiffViewState, DiffLayout>()

/** Reusable canvas diff primitive. Both inline tool cards and DiffViewer call this. */
export function layoutDiffViewer(
  builder: Builder,
  id: string,
  state: DiffViewState,
  view: ViewState,
  x: number,
  y: number,
  width: number,
  maxHeight = 400
): number {
  const { palette: p, metrics, t } = builder
  const { document: doc } = state
  const f = font(12, 400, 'mono')
  const labelFont = font(11, 500)
  const numberFont = font(10, 400, 'mono')
  const lineHeight = 20
  const pad = 10
  const frame = builder.slot()
  const numberWidth = Math.max(
    24,
    metrics.measure(String(Math.max(doc.beforeLines.length, doc.afterLines.length)), numberFont) +
      12
  )
  const split = state.mode === 'split'
  const paneWidth = (width - 10) / (split ? 2 : 1)
  const gutter = numberWidth * (split ? 1 : 2) + 16
  const codeWidth = Math.max(12, paneWidth - gutter - pad)
  const key = `${codeWidth}:${state.revision}:${builder.theme.epoch}`
  const cached = layoutCache.get(state)
  const geometry = cached?.key === key ? cached : undefined
  const rows = geometry?.rows ?? diffRows(state)
  const lineLayouts = geometry?.lines ?? new Map<string, WrappedLine[]>()
  let widest = geometry?.widest ?? codeWidth
  const noNewline = (side: DiffSide, index: number | null): boolean =>
    index !== null && (side === 'before' ? doc.beforeLines : doc.afterLines)[index].eol === ''

  const layoutLine = (side: DiffSide, index: number): WrappedLine[] => {
    const key = `${side}:${index}`
    const cached = lineLayouts.get(key)
    if (cached) return cached
    const text = (side === 'before' ? doc.beforeLines : doc.afterLines)[index].text
    const tokens = state.syntax?.[side][index] ?? [{ text }]
    const ranges = (side === 'before' ? doc.inlineBefore : doc.inlineAfter).get(index) ?? []
    const background = mix(p.surface, side === 'before' ? p.danger : p.success, 0.27)
    const lines: WrappedLine[] = []
    let runs: TextRun[] = []
    let cursor = 0
    let offset = 0
    let column = 0
    let tokenIndex = 0
    let tokenEnd = tokens[0]?.text.length ?? 0
    const flush = (): void => {
      lines.push({ runs, y: lines.length * lineHeight, height: lineHeight, width: cursor })
      widest = Math.max(widest, cursor)
      runs = []
      cursor = 0
    }
    for (const item of segmenter.segment(text)) {
      const value = item.segment
      while (offset >= tokenEnd && tokenIndex < tokens.length - 1) {
        tokenIndex++
        tokenEnd += tokens[tokenIndex].text.length
      }
      const color = tokens[tokenIndex]?.[builder.theme.appearance] ?? p.text
      const cells = value === '\t' ? 4 - (column % 4) : 1
      const width = value === '\t' ? metrics.advance(f) * cells : metrics.measure(value, f)
      if (state.wrap && cursor > 0 && cursor + width > codeWidth) flush()
      const changed = ranges.some(
        (range: InlineChange) => offset < range.end && offset + value.length > range.start
      )
      const last = runs[runs.length - 1]
      const bg = changed ? background : undefined
      // Tabs are isolated runs so their painted advance and selection boundaries agree.
      if (
        last &&
        value !== '\t' &&
        !last.text.endsWith('\t') &&
        last.color === color &&
        last.background === bg
      ) {
        last.text += value
        last.width += width
      } else {
        runs.push({ text: value, font: f, color, x: cursor, width, offset, background: bg })
      }
      cursor += width
      column += cells
      offset += value.length
    }
    flush()
    lines[lines.length - 1].breakAfter = true
    lineLayouts.set(key, lines)
    return lines
  }

  const heights =
    geometry?.heights ??
    rows.map((row) => {
      if (row.kind === 'gap') return 28
      const before =
        row.before === null
          ? 0
          : layoutLine('before', row.before).length + Number(noNewline('before', row.before))
      const after =
        row.after === null
          ? 0
          : layoutLine('after', row.after).length + Number(noNewline('after', row.after))
      return Math.max(1, before, after) * lineHeight
    })
  const offsets = geometry?.offsets ?? rowOffsets(heights)
  if (!geometry) layoutCache.set(state, { key, lines: lineLayouts, rows, heights, offsets, widest })
  const contentHeight = Math.max(lineHeight, offsets[rows.length]) + 12
  const bodyHeight = Math.min(maxHeight, Math.max(56, contentHeight))
  const horizontal = !state.wrap && widest > codeWidth
  const viewportHeight = bodyHeight - (horizontal ? 10 : 0)
  const position = view.scroll.get(id) ?? { left: 0, top: 0 }
  const scrollTop = Math.min(Math.max(0, position.top), Math.max(0, contentHeight - viewportHeight))
  const scrollLeft = state.wrap
    ? 0
    : Math.min(Math.max(0, position.left), Math.max(0, widest - codeWidth))
  view.scroll.set(id, { left: scrollLeft, top: scrollTop })
  const copyActions = [
    { label: t('diff.copyBefore'), text: doc.before },
    { label: t('diff.copyAfter'), text: doc.after }
  ]
  builder.text(x + pad, y + 8, doc.path, labelFont, p.textMuted, {
    maxWidth: Math.max(20, width - 120)
  })
  builder.text(x + width - 104, y + 8, `+${doc.added}`, numberFont, p.success)
  builder.text(x + width - 54, y + 8, `-${doc.removed}`, numberFont, p.danger)

  let buttonX = x + 6
  let buttonY = y + 30
  const button = (
    label: string,
    command: Parameters<Builder['region']>[4],
    active = false
  ): void => {
    const w = Math.min(width - 12, metrics.measure(label, labelFont) + 16)
    if (buttonX + w > x + width - 6) {
      buttonX = x + 6
      buttonY += 24
    }
    if (active) builder.rect(buttonX, buttonY, w, 22, 4, p.surface2, p.border)
    builder.text(buttonX + 8, buttonY + 3, label, labelFont, active ? p.text : p.textSubtle, {
      maxWidth: w - 16
    })
    builder.region(buttonX, buttonY, w, 22, command, { hover: 'subtle', title: label })
    buttonX += w + 2
  }
  button(t('diff.unified'), { type: 'diff', id, command: 'unified' }, !split)
  button(t('diff.split'), { type: 'diff', id, command: 'split' }, split)
  button(t('diff.wrap'), { type: 'diff', id, command: 'wrap' }, state.wrap)
  button(t('diff.context'), { type: 'diff', id, command: 'context' }, state.showAll)
  const hunks: number[] = []
  rows.forEach((row, i) => {
    if (row.kind === 'line' && row.changed && hunks[row.hunk] === undefined)
      hunks[row.hunk] = offsets[i]
  })
  if (hunks.length) {
    button(t('diff.previous'), {
      type: 'scroll',
      id,
      top: hunks[findHunk(hunks, scrollTop, -1)],
      left: scrollLeft
    })
    button(t('diff.next'), {
      type: 'scroll',
      id,
      top: hunks[findHunk(hunks, scrollTop, 1)],
      left: scrollLeft
    })
  }
  button(t('diff.copyAfter'), { type: 'copy', text: doc.after })
  button(t('diff.copyPatch'), { type: 'diff', id, command: 'patch' })
  const toolbarHeight = buttonY - y + 50 + (split ? 20 : 0)
  const top = y + toolbarHeight
  frame({ kind: 'rect', x, y, w: width, h: toolbarHeight + bodyHeight, radius: 0, fill: p.surface })
  builder.hairline(x, y, width, p.border)
  builder.scrollRegion({
    id,
    x,
    y: top,
    w: width,
    h: viewportHeight,
    contentHeight,
    contentWidth: width + (state.wrap ? 0 : Math.max(0, widest - codeWidth)),
    left: scrollLeft,
    top: scrollTop,
    copyActions
  })
  builder.text(
    x + pad,
    top - (split ? 40 : 22),
    doc.coarse
      ? t('diff.coarse')
      : !doc.added && !doc.removed
        ? t('diff.noChanges')
        : t('diff.changeCount', { count: hunks.length }),
    numberFont,
    doc.coarse ? p.warning : p.textSubtle,
    { maxWidth: width - 2 * pad }
  )
  builder.hairline(x, top - 1, width, p.border)
  if (split) {
    builder.text(x + pad, top - 18, t('diff.before'), numberFont, p.textSubtle)
    builder.text(x + paneWidth + pad, top - 18, t('diff.after'), numberFont, p.textSubtle)
  }

  const viewport: Rect = { x, y: top, w: width - 10, h: viewportHeight }
  builder.clipped(viewport.x, viewport.y, viewport.w, viewport.h, 0, () => {
    if (split) builder.vrule(x + paneWidth, top, viewportHeight, p.border)
    const { first, last } = visibleRange(offsets, rows.length, scrollTop - 6, viewportHeight)
    for (let i = first; i < last; i++) {
      const row = rows[i]
      const rowY = top + 6 + offsets[i] - scrollTop
      if (row.kind === 'gap') {
        builder.rect(x, rowY, width, heights[i], 0, p.surface2)
        builder.text(
          x + gutter,
          rowY + 5,
          t('diff.expandLines', { count: row.count }),
          numberFont,
          p.textSubtle,
          { maxWidth: width - gutter - pad }
        )
        builder.region(
          x,
          rowY,
          width,
          heights[i],
          { type: 'diff', id, command: 'gap', gap: row.section },
          { hover: 'subtle' }
        )
        continue
      }
      const drawSide = (side: DiffSide, index: number | null, paneX: number): void => {
        const clip: Rect = { x: paneX, y: top, w: paneWidth, h: viewportHeight }
        const tone = side === 'before' ? p.danger : p.success
        if (row.changed)
          builder.rect(
            paneX,
            rowY,
            paneWidth,
            heights[i],
            0,
            index === null ? p.surface2 : mix(p.surface, tone, 0.09)
          )
        if (index === null) return
        const textX = paneX + gutter - scrollLeft
        const lines = layoutLine(side, index)
        builder.clipped(
          paneX + gutter,
          top,
          Math.max(1, paneWidth - gutter),
          viewportHeight,
          0,
          () => {
            builder.lines(textX, rowY, lines, false)
          }
        )
        builder.clipped(clip.x, clip.y, clip.w, clip.h, 0, () => {
          builder.rect(
            paneX,
            rowY,
            gutter - 2,
            heights[i],
            0,
            row.changed ? mix(p.surface, tone, 0.09) : p.surface
          )
          if (split)
            builder.text(paneX + 4, rowY + 2, String(index + 1), numberFont, p.textSubtle, {
              align: 'right',
              maxWidth: numberWidth - 8
            })
          else {
            if (row.before !== null)
              builder.text(paneX + 4, rowY + 2, String(row.before + 1), numberFont, p.textSubtle, {
                align: 'right',
                maxWidth: numberWidth - 8
              })
            if (row.after !== null)
              builder.text(
                paneX + numberWidth + 4,
                rowY + 2,
                String(row.after + 1),
                numberFont,
                p.textSubtle,
                { align: 'right', maxWidth: numberWidth - 8 }
              )
          }
          if (row.changed)
            builder.text(paneX + gutter - 14, rowY + 1, side === 'before' ? '-' : '+', f, tone)
          if (noNewline(side, index))
            builder.text(
              paneX + gutter,
              rowY + lines.length * lineHeight + 2,
              t('diff.noNewline'),
              numberFont,
              p.textSubtle,
              { maxWidth: paneWidth - gutter - pad }
            )
        })
      }
      if (split) {
        drawSide('before', row.before, x)
        drawSide('after', row.after, x + paneWidth)
      } else drawSide(row.after === null ? 'before' : 'after', row.after ?? row.before, x)
    }
  })

  // Register every projected row so dragging/copying remains stable while the inner viewport scrolls.
  rows.forEach((row, i) => {
    if (row.kind !== 'line') return
    const register = (side: DiffSide, index: number | null, paneX: number): void => {
      if (index === null) return
      const lines = layoutLine(side, index)
      lines.forEach((line, j) =>
        builder.selectableRow(
          paneX + gutter - scrollLeft,
          top + 6 + offsets[i] - scrollTop + line.y,
          lineHeight,
          line.runs,
          line.runs.map((r) => r.text).join(''),
          {
            clip: {
              x: paneX + gutter,
              y: top,
              w: Math.max(1, paneWidth - gutter),
              h: viewportHeight
            },
            group: split ? `${id}:${side}` : undefined,
            breakAfter: j === lines.length - 1
          }
        )
      )
    }
    if (split) {
      register('before', row.before, x)
      register('after', row.after, x + paneWidth)
    } else register(row.after === null ? 'before' : 'after', row.after ?? row.before, x)
  })

  if (contentHeight > viewportHeight) {
    const thumbHeight = Math.max(24, (viewportHeight * viewportHeight) / contentHeight)
    const thumbY =
      top + (scrollTop / (contentHeight - viewportHeight)) * (viewportHeight - thumbHeight)
    builder.rect(x + width - 7, thumbY, 4, thumbHeight, 2, p.borderStrong)
  }
  if (horizontal) {
    const thumbWidth = Math.max(24, ((width - 16) * codeWidth) / widest)
    const thumbX = x + 4 + (scrollLeft / (widest - codeWidth)) * (width - 16 - thumbWidth)
    builder.rect(thumbX, top + bodyHeight - 7, thumbWidth, 4, 2, p.borderStrong)
  }
  return toolbarHeight + bodyHeight
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function findHunk(hunks: number[], top: number, direction: number): number {
  if (direction > 0) {
    const next = hunks.findIndex((y) => y > top + 1)
    return next < 0 ? 0 : next
  }
  for (let i = hunks.length - 1; i >= 0; i--) if (hunks[i] < top - 1) return i
  return hunks.length - 1
}
