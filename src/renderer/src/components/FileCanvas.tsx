import { useCallback, useMemo } from 'react'
import { CanvasSurface, type CanvasLayoutContext } from '../canvas/CanvasSurface'
import { Builder } from '../canvas/builder'
import { highlight, tokenColors } from '../canvas/highlight'
import { font, type TextMetrics, type WrappedLine } from '../canvas/text'
import { sourceLines } from './diff/model'

export function FileCanvas({ path, content }: { path: string; content: string }): JSX.Element {
  const lines = useMemo(() => sourceLines(content), [content])
  const tokens = useMemo(() => highlight(content.replace(/\r\n?/g, '\n'), path), [content, path])
  const layouts = useMemo(
    () => new WeakMap<TextMetrics, { widest: number; rows: Map<number, WrappedLine> }>(),
    [lines, tokens]
  )
  const buildScene = useCallback(
    (context: CanvasLayoutContext) => {
      const builder = new Builder(context.metrics, context.theme, { value: 0 }, context.t)
      const colors = tokenColors(context.theme.appearance)
      const codeFont = font(12, 400, 'mono')
      const numberFont = font(10, 400, 'mono')
      const lineHeight = 20
      const gutter = Math.max(40, context.metrics.measure(String(lines.length), numberFont) + 24)
      const contentHeight = Math.max(context.height, lines.length * lineHeight + 24)
      let cached = layouts.get(context.metrics)
      if (!cached) {
        cached = {
          widest: lines.reduce(
            (width, line) =>
              Math.max(width, context.metrics.measure(line.text.replace(/\t/g, '    '), codeFont)),
            0
          ),
          rows: new Map()
        }
        layouts.set(context.metrics, cached)
      }
      const contentWidth = Math.max(context.width, gutter + cached.widest + 24)
      const left = Math.min(
        context.view.scroll.get('file')?.left ?? 0,
        contentWidth - context.width
      )
      context.view.scroll.set('file', { left, top: 0 })
      const start = Math.max(0, context.viewport.top - context.height)
      const end = context.viewport.top + context.height * 2
      const first = Math.max(0, Math.floor((start - 12) / lineHeight))
      const last = Math.min(lines.length, Math.ceil((end - 12) / lineHeight))
      const visible = new Set<number>()
      for (let i = first; i < last; i++) visible.add(i)
      for (const key of context.viewport.selectionKeys ?? []) {
        const index = Number(key.slice('file:'.length))
        if (
          key.startsWith('file:') &&
          Number.isInteger(index) &&
          index >= 0 &&
          index < lines.length
        )
          visible.add(index)
      }
      if (!lines.length)
        builder.text(16, 12, context.t('inspector.emptyFile'), codeFont, builder.palette.textSubtle)
      const rows = [...visible].sort((a, b) => a - b)
      for (const i of rows) {
        if (cached.rows.has(i)) continue
        let cursor = 0
        let offset = 0
        const runs = (tokens[i] ?? [{ text: lines[i].text, kind: 'plain' as const }]).flatMap(
          (token) =>
            token.text
              .split(/(\t)/)
              .filter(Boolean)
              .map((value) => {
                const width = context.metrics.measure(value === '\t' ? '    ' : value, codeFont)
                const run = {
                  text: value,
                  font: codeFont,
                  color: colors[token.kind],
                  x: cursor,
                  width,
                  offset
                }
                cursor += width
                offset += value.length
                return run
              })
        )
        cached.rows.set(i, { runs, y: 0, height: lineHeight, width: cursor })
      }
      for (const i of rows) {
        builder.text(
          8,
          14 + i * lineHeight,
          String(i + 1),
          numberFont,
          builder.palette.textSubtle,
          { align: 'right', maxWidth: gutter - 20 }
        )
      }
      builder.clipped(gutter, 0, Math.max(1, context.width - gutter), contentHeight, 0, () => {
        for (const i of rows) {
          builder.lines(gutter - left, 12 + i * lineHeight, [cached.rows.get(i)!])
        }
      })
      if (cached.rows.size > 2000) {
        for (const index of cached.rows.keys()) if (!visible.has(index)) cached.rows.delete(index)
      }
      builder.scrollRegion({
        id: 'file',
        x: 0,
        y: context.viewport.top,
        w: context.width,
        h: context.height - 10,
        contentWidth,
        contentHeight: context.height - 10,
        left,
        top: 0,
        copyActions: [{ label: context.t('inspector.copy'), text: content }]
      })
      if (contentWidth > context.width) {
        const track = context.width - 16
        const thumb = Math.max(24, (track * context.width) / contentWidth)
        builder.rect(
          8 + (left / (contentWidth - context.width)) * (track - thumb),
          context.viewport.top + context.height - 7,
          thumb,
          4,
          2,
          builder.palette.borderStrong
        )
      }
      const block = builder.finish('file', 0, contentHeight)
      block.selectable.forEach((line, index) => {
        line.key = 'file:' + rows[index]
      })
      return {
        width: context.width,
        height: contentHeight,
        blocks: [block],
        copyText: () => content,
        window: { start, end, scrollTop: context.viewport.top }
      }
    },
    [content, lines, tokens, layouts]
  )
  return <CanvasSurface sceneKey={path} buildScene={buildScene} followTail={false} />
}
