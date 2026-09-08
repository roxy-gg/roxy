import {
  ANSI_BG,
  ANSI_DEFAULT_FG,
  ANSI_PROMPT,
  ansiLineText,
  parseAnsi,
  type AnsiSpan
} from './ansi'
import type { Builder } from './builder'
import type { MessagePart } from '@shared/types'
import type { ViewState } from './scene'
import { font, type TextMetrics, type TextRun, type WrappedLine } from './text'
import { alpha } from './theme'
import { FONT_SIZE, SIZE, SPACE } from './metrics'

type ToolPart = Extract<MessagePart, { type: 'tool' }>
type TerminalLayout = {
  width: number
  epoch: number
  source: string
  command: string
  emptyLabel: string
  lines: WrappedLine[]
  output: string
  copyCommand: string
}
const layouts = new WeakMap<ToolPart, TerminalLayout>()
const FOOTER = /^\[(exit -?\d+|timed out[\s\S]*|error:[\s\S]*|stopped|cancelled)\]$/
const FOOTER_COLOR = '#9a9aa3'
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Wrap terminal columns without losing whitespace, ANSI styling, or logical copy boundaries. */
function wrapRows(rows: AnsiSpan[][], width: number, metrics: TextMetrics): WrappedLine[] {
  const base = font(FONT_SIZE.small, 400, 'mono')
  const height = metrics.lineHeight(base)
  const lines: WrappedLine[] = []
  for (const row of rows) {
    let runs: TextRun[] = []
    let x = 0
    let offset = 0
    const flush = (breakAfter: boolean): void => {
      lines.push({ runs, width: x, y: lines.length * height, height, breakAfter })
      runs = []
      x = 0
    }
    for (const span of row) {
      const f = font(base.size, span.bold ? 700 : 400, 'mono', span.italic ? 'italic' : 'normal')
      const advance = metrics.advance(f)
      const color = span.dim
        ? alpha(span.color ?? ANSI_DEFAULT_FG, 0.7)
        : (span.color ?? ANSI_DEFAULT_FG)
      const ascii = /^[\x20-\x7e\t]*$/.test(span.text)
      const characters = ascii
        ? span.text
        : Array.from(graphemes.segment(span.text), (item) => item.segment)
      for (const text of characters) {
        const tab = text === '\t'
        let size = tab
          ? (4 - (Math.round(x / advance) % 4)) * advance
          : ascii
            ? advance
            : metrics.measure(text, f)
        if (x > 0 && x + size > width + 0.001) {
          flush(false)
          if (tab) size = 4 * advance
        }
        if (tab) size = Math.min(size, width)
        const last = runs[runs.length - 1]
        if (!tab && last?.font === f && last.text !== '\t') {
          last.text += text
          last.width += size
        } else {
          runs.push({
            text,
            font: f,
            color,
            x,
            width: size,
            offset,
            background: span.background,
            underline: span.underline
          })
        }
        x += size
        offset += text.length
      }
    }
    flush(true)
  }
  return lines
}

/** Content-sized shell output; only long logs need an inner vertical viewport. */
export function layoutTerminalBody(
  builder: Builder,
  part: ToolPart,
  id: string,
  view: ViewState,
  x: number,
  y: number,
  width: number
): number {
  const source = part.output ?? ''
  const command =
    part.tool === 'bash'
      ? typeof part.input?.command === 'string'
        ? part.input.command
        : (part.title ?? '')
      : ''
  const emptyLabel = builder.t(
    part.state === 'running' ? 'transcript.running' : 'transcript.noOutput'
  )
  let cached = layouts.get(part)
  if (
    !cached ||
    cached.width !== width ||
    cached.epoch !== builder.theme.epoch ||
    cached.source !== source ||
    cached.command !== command ||
    cached.emptyLabel !== emptyLabel
  ) {
    let body = source.replace(/\r\n/g, '\n')
    let prompt = command ? `$ ${command.replace(/\r\n/g, '\n')}` : ''
    let copyCommand = command
    if (prompt && (body === prompt || body.startsWith(prompt + '\n'))) {
      body = body.slice(prompt.length).replace(/^\n/, '')
    } else if (body.startsWith('$ ')) {
      const end = body.indexOf('\n')
      prompt = end < 0 ? body : body.slice(0, end)
      copyCommand = prompt.slice(2)
      body = end < 0 ? '' : body.slice(end + 1)
    }
    const rows = parseAnsi(body)
    const trimEmptyTail = (): void => {
      while (rows.length && !ansiLineText(rows[rows.length - 1]).trim()) rows.pop()
    }
    // Measure what is actually visible, not escape-only lines or trailing terminal padding.
    trimEmptyTail()
    const last = rows.length ? ansiLineText(rows[rows.length - 1]).trim() : ''
    if (FOOTER.test(last)) {
      rows.pop()
      trimEmptyTail()
      rows.push([{ text: last, color: FOOTER_COLOR }])
    }
    const output = rows.map(ansiLineText).join('\n')
    if (prompt) rows.unshift(...prompt.split('\n').map((text) => [{ text, color: ANSI_PROMPT }]))
    if (!rows.length) rows.push([{ text: emptyLabel, color: FOOTER_COLOR }])
    const lines = wrapRows(rows, Math.max(1, width - SPACE.bodyPadX * 2), builder.metrics)
    cached = {
      width,
      epoch: builder.theme.epoch,
      source,
      command,
      emptyLabel,
      lines,
      output,
      copyCommand
    }
    layouts.set(part, cached)
  }

  const { lines } = cached
  const lineHeight = builder.metrics.lineHeight(font(FONT_SIZE.small, 400, 'mono'))
  const contentHeight = lines.length * lineHeight + SPACE.bodyPadY * 2
  const height = Math.min(SIZE.outputMax, contentHeight)
  const top = Math.max(0, Math.min(view.scroll.get(id)?.top ?? 0, contentHeight - height))
  view.scroll.set(id, { left: 0, top })
  const copyActions = [{ label: builder.t('transcript.copyOutput'), text: cached.output }]
  if (cached.copyCommand)
    copyActions.unshift({ label: builder.t('transcript.copyCommand'), text: cached.copyCommand })
  builder.scrollRegion({
    id,
    x,
    y: y + 1,
    w: width,
    h: height,
    contentWidth: width,
    contentHeight,
    left: 0,
    top,
    copyActions
  })
  builder.hairline(x, y, width, builder.palette.border)
  builder.rect(x, y + 1, width, height, 0, ANSI_BG)
  const textY = y + 1 + SPACE.bodyPadY - top
  const first = Math.max(0, Math.floor((top - SPACE.bodyPadY) / lineHeight))
  const last = Math.min(lines.length, Math.ceil((top + height - SPACE.bodyPadY) / lineHeight))
  builder.clipped(x, y + 1, width, height, 0, () => {
    builder.lines(x + SPACE.bodyPadX, textY, lines.slice(first, last), false)
  })
  for (const line of lines) {
    builder.selectableRow(
      x + SPACE.bodyPadX,
      textY + line.y,
      line.height,
      line.runs,
      line.runs.map((run) => run.text).join(''),
      {
        clip: {
          x: x + SPACE.bodyPadX,
          y: y + 1,
          w: Math.max(1, width - SPACE.bodyPadX * 2),
          h: height
        },
        breakAfter: line.breakAfter
      }
    )
  }
  if (height < contentHeight) {
    const thumb = Math.max(24, (height * height) / contentHeight)
    builder.rect(
      x + width - 7,
      y + 1 + (top / (contentHeight - height)) * (height - thumb),
      4,
      thumb,
      2,
      FOOTER_COLOR
    )
  }
  return height + 1
}
