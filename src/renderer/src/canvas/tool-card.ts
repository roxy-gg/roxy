/**
 * Tool cards.
 *
 * One card per tool call, laid out as: a clickable header (chevron, icon, tool
 * name, title, status) and — when expanded — a body whose shape depends on the
 * tool. That dispatch is the same one the DOM version made, kept in the same
 * order so behaviour is unchanged:
 *
 *   diff        → a unified diff        (write / edit)
 *   read + done → syntax-highlighted    (a file's contents)
 *   bash        → a terminal pane       (ANSI, prompt line, exit footer)
 *   task        → a nested transcript   (the subagent's own steps) + its report
 *   otherwise   → plain monospace output
 *
 * with an inline image (a browser screenshot) drawn under whichever body ran, in
 * both the collapsed and the expanded state — a screenshot IS the result, so
 * hiding it behind a disclosure was never right.
 */

import type { TFunction } from 'i18next'
import type { MessagePart } from '@shared/types'
import type { Builder } from './builder'
import type { ViewState } from './scene'
import type { IconName } from './icons'
import { FONT_SIZE, SIZE, SPACE } from './metrics'
import { font } from './text'
import { alpha } from './theme'
import { layoutPlainText } from './prose'
import { layoutDiffViewer } from '../components/diff/layout'
import { createDiffState } from '../components/diff/model'
import { highlight, tokenColors } from './highlight'
import { ANSI_BG, ANSI_DEFAULT_FG, ANSI_PROMPT, parseAnsi } from './ansi'

/**
 * Tool → icon. Carried over verbatim from the DOM's `TOOL_ICON`, plus entries
 * for the tools that were falling through to the wrench (`skill`, `lsp`, `mcp`,
 * `change_session_metadata`) — they have icons now because a transcript full of
 * identical wrenches tells you nothing about what happened.
 */
const TOOL_ICON: Record<string, IconName> = {
  bash: 'terminal',
  bash_list: 'terminal',
  bash_output: 'terminal',
  bash_kill: 'terminal',
  read: 'fileText',
  write: 'filePen',
  edit: 'code',
  list: 'listTree',
  glob: 'search',
  grep: 'search',
  webfetch: 'globe',
  task: 'hammer',
  browser_open: 'globe',
  browser_screenshot: 'camera',
  browser_read: 'scanText',
  browser_console: 'terminal',
  browser_close: 'globe',
  browser_click: 'globe',
  browser_scroll: 'globe',
  browser_type: 'scanText',
  browser_tabs: 'listTree',
  browser_new_tab: 'globe',
  browser_activate_tab: 'globe',
  loop_create: 'repeat',
  loop_list: 'repeat',
  loop_enable: 'repeat',
  loop_disable: 'repeat',
  loop_remove: 'repeat',
  skill: 'bookOpen',
  skill_manage: 'bookOpen',
  lsp: 'circleAlert',
  mcp: 'network',
  change_session_metadata: 'listTree'
}

export function toolIcon(tool: string): IconName {
  if (TOOL_ICON[tool]) return TOOL_ICON[tool]
  // An MCP tool arrives namespaced as `mcp__<server>__<tool>`; it is still an
  // MCP call and should read as one rather than as an unknown wrench.
  if (tool.startsWith('mcp__')) return 'network'
  return 'wrench'
}

/** A tool part plus the view state the transcript keeps for it. */
export interface ToolCardInput {
  part: Extract<MessagePart, { type: 'tool' }>
  /** Stable identity for expand state and hit regions. */
  id: string
  open: boolean
  /** Whether this card's own turn is still live. */
  live: boolean
  /** Set when a cancel is genuinely available for this call. */
  cancellable: boolean
  view: ViewState
  /** Renders a subagent's transcript. Supplied by the transcript layout. */
  renderNested?: (
    builder: Builder,
    parts: MessagePart[],
    x: number,
    y: number,
    width: number,
    live: boolean,
    idPrefix: string
  ) => number
}

const HEADER_HEIGHT = 28

/** Lay out one card. Returns the height it consumed, including its margins. */
export function layoutToolCard(
  builder: Builder,
  input: ToolCardInput,
  x: number,
  y: number,
  width: number
): number {
  const { part, id, open, live } = input
  const palette = builder.palette
  const top = y + SPACE.cardMarginY
  const body = open ? (part.output ?? '').trimEnd() : ''
  const nested = part.children && part.children.length > 0 ? part.children : undefined
  const showNested = Boolean(nested && input.renderNested)

  // The card's frame has to paint UNDER its body but can only be measured once
  // the body is laid out — its height IS the body's height. So the frame takes a
  // reserved slot here and is filled in at the end.
  const frame = builder.slot()
  // Broad controls register first so the cancel button can win hit testing.
  builder.region(
    x,
    top,
    width,
    HEADER_HEIGHT,
    { type: 'toggle', id },
    {
      hover: 'card',
      title: builder.t(open ? 'transcript.collapse' : 'transcript.expand')
    }
  )

  let cursor = top + HEADER_HEIGHT
  const contentWidth = width - 2

  if (showNested && live && !open) {
    cursor += layoutActivityLine(builder, nested!, x, cursor, width)
  }

  if (open) {
    if (part.diff) {
      let state = input.view.diffs.get(id)
      if (
        !state ||
        state.document.before !== part.diff.before ||
        state.document.after !== part.diff.after ||
        state.document.path !== part.diff.path
      ) {
        state = createDiffState(part.diff.path, part.diff.before, part.diff.after)
        input.view.diffs.set(id, state)
      }
      cursor += layoutDiffViewer(builder, id, state, input.view, x + 1, cursor, contentWidth)
    } else if (part.tool === 'read' && part.state === 'done' && body && !part.image) {
      cursor += layoutFileBody(builder, part.title ?? 'file.txt', body, x + 1, cursor, contentWidth)
    } else if (part.tool === 'bash' || part.tool === 'bash_output') {
      cursor += layoutTerminalBody(builder, body, part.state, x + 1, cursor, contentWidth)
    } else if (showNested) {
      cursor += layoutNestedBody(builder, input, body, x + 1, cursor, contentWidth)
    } else {
      cursor += layoutOutputBody(builder, body, part.state, x + 1, cursor, contentWidth)
    }
  }

  if (part.image) {
    cursor += layoutImageBody(builder, part.image, x + 1, cursor, contentWidth)
  }

  const height = cursor - top

  frame({
    kind: 'rect',
    x,
    y: top,
    w: width,
    h: height,
    radius: SPACE.radiusLg,
    fill: palette.surface2,
    border: palette.border
  })

  layoutHeader(builder, input, x, top, width)

  return height + SPACE.cardMarginY * 2
}

/** The card header: chevron, icon, tool name, title, right-hand rail. */
function layoutHeader(
  builder: Builder,
  input: ToolCardInput,
  x: number,
  y: number,
  width: number
): void {
  const { part, open, live, id } = input
  const palette = builder.palette
  const centerY = y + HEADER_HEIGHT / 2
  let cursor = x + SPACE.cardPadX

  // Chevron — rotated 90° when open, the same affordance as the DOM's
  // `rotate-90`. Rotation is instant rather than animated: a 200ms transform on
  // canvas would mean repainting the whole transcript for a fifth of a second to
  // move fourteen pixels of chevron.
  builder.icon(cursor, centerY - SIZE.iconSm / 2, SIZE.iconSm, 'chevronRight', palette.textSubtle, {
    rotate: open ? Math.PI / 2 : 0
  })
  cursor += SIZE.iconSm + SPACE.headerGap

  const iconColor = live && part.tool === 'task' ? palette.accent : palette.textMuted
  builder.icon(cursor, centerY - SIZE.icon / 2, SIZE.icon, toolIcon(part.tool), iconColor)
  cursor += SIZE.icon + SPACE.headerGap

  const nameFont = font(FONT_SIZE.small, 500, 'sans')
  const nameWidth = builder.metrics.measure(part.tool, nameFont)
  builder.text(
    cursor,
    centerY - builder.metrics.lineHeight(nameFont) / 2,
    part.tool,
    nameFont,
    palette.text
  )
  cursor += nameWidth + SPACE.headerGap

  // The right rail is measured first so the title knows how much room is left.
  const rail = measureRail(builder, input)
  const titleRoom = x + width - SPACE.cardPadX - rail.width - cursor - SPACE.headerGap
  if (part.title && titleRoom > 24) {
    const titleFont = font(FONT_SIZE.small, 400, 'mono')
    builder.text(
      cursor,
      centerY - builder.metrics.lineHeight(titleFont) / 2,
      part.title,
      titleFont,
      palette.textMuted,
      { maxWidth: titleRoom }
    )
  }

  layoutRail(builder, input, x + width - SPACE.cardPadX - rail.width, centerY, rail)
  void id
}

interface Rail {
  width: number
  stepLabel: string | null
  stepWidth: number
  showCancel: boolean
}

function measureRail(builder: Builder, input: ToolCardInput): Rail {
  const { part, live } = input
  const nested = part.children
  const stepCount = nested ? nested.reduce((n, p) => (p.type === 'tool' ? n + 1 : n), 0) : 0
  const showSteps = Boolean(nested && input.renderNested) && !live && stepCount > 0
  const stepLabel = showSteps ? builder.t('transcript.step', { count: stepCount }) : null
  const stepWidth = stepLabel
    ? builder.metrics.measure(stepLabel, font(FONT_SIZE.micro, 400, 'mono'))
    : 0
  // The DOM delayed a non-`task` cancel by 1200ms so it could not strobe through
  // a fast turn. On canvas the same rule is applied by the transcript, which
  // knows when the call started; here it is just a flag.
  const showCancel = input.cancellable
  const gap = 6
  let width = SIZE.iconSm
  if (stepLabel) width += stepWidth + gap
  if (showCancel) width += 20 + gap
  return { width, stepLabel, stepWidth, showCancel }
}

function layoutRail(
  builder: Builder,
  input: ToolCardInput,
  x: number,
  centerY: number,
  rail: Rail
): void {
  const { part, id } = input
  const palette = builder.palette
  let cursor = x

  if (rail.stepLabel) {
    const f = font(FONT_SIZE.micro, 400, 'mono')
    builder.text(
      cursor,
      centerY - builder.metrics.lineHeight(f) / 2,
      rail.stepLabel,
      f,
      palette.textSubtle
    )
    cursor += rail.stepWidth + 6
  }

  if (rail.showCancel) {
    const size = 20
    builder.rect(cursor, centerY - size / 2, size, size, SPACE.radiusBase, undefined, undefined)
    builder.iconFill(cursor + 5, centerY - 5, 10, 'square', palette.textSubtle)
    builder.region(
      cursor,
      centerY - size / 2,
      size,
      size,
      { type: 'cancel', id },
      {
        hover: 'subtle',
        title:
          part.tool === 'task'
            ? builder.t('transcript.cancelSubagent')
            : builder.t('transcript.cancelCall', { tool: part.tool })
      }
    )
    cursor += size + 6
  }

  const statusY = centerY - SIZE.iconSm / 2
  if (part.state === 'running') {
    builder.push({
      kind: 'spinner',
      x: cursor,
      y: statusY,
      size: SIZE.iconSm,
      color: palette.textSubtle
    })
    builder.animate()
  } else if (part.state === 'done') {
    builder.icon(cursor, statusY, SIZE.iconSm, 'check', palette.success)
  } else {
    // Grey, not red. A failed tool is part of how the agent works — a grep that
    // finds nothing, a build run precisely to surface its errors. The shape
    // already distinguishes it; red would make routine debugging read as an
    // incident.
    builder.icon(cursor, statusY, SIZE.iconSm, 'triangleAlert', palette.textMuted)
  }
}

/**
 * The live one-liner under a running `task` header — what the delegate is doing
 * right now, and how many steps it has taken.
 */
function layoutActivityLine(
  builder: Builder,
  parts: MessagePart[],
  x: number,
  y: number,
  width: number
): number {
  const palette = builder.palette
  const height = 22
  builder.hairline(x + 1, y, width - 2, alpha(palette.border, 0.6))
  const { label } = activity(parts, builder.t)
  const steps = parts.reduce((n, p) => (p.type === 'tool' ? n + 1 : n), 0)
  const f = font(FONT_SIZE.tiny, 400, 'mono')
  const centerY = y + height / 2
  // pl-8 in the DOM: aligns the spinner under the header's tool icon so the
  // strip reads as a continuation of the card, not a new row.
  const textX = x + 32
  builder.push({
    kind: 'braille',
    x: textX - 14,
    y: centerY - builder.metrics.lineHeight(f) / 2,
    font: f,
    color: palette.accent
  })
  builder.animate()

  const countFont = font(FONT_SIZE.micro, 400, 'mono')
  const countLabel = steps > 0 ? builder.t('transcript.step', { count: steps }) : ''
  const countWidth = countLabel ? builder.metrics.measure(countLabel, countFont) : 0
  const room = width - (textX - x) - SPACE.cardPadX - (countWidth ? countWidth + 8 : 0)
  builder.text(textX, centerY - builder.metrics.lineHeight(f) / 2, label, f, palette.textSubtle, {
    maxWidth: Math.max(20, room)
  })
  if (countLabel) {
    builder.text(
      x + width - SPACE.cardPadX - countWidth,
      centerY - builder.metrics.lineHeight(countFont) / 2,
      countLabel,
      countFont,
      palette.textSubtle
    )
  }
  return height
}

/** What a subagent is doing now, from the last part of its transcript. */
function activity(parts: MessagePart[], t: TFunction): { label: string; step: number } {
  const step = parts.length - 1
  const last = parts[step]
  if (!last) return { label: t('transcript.activityStarting'), step: -1 }
  if (last.type === 'tool') {
    return { label: [last.tool, last.title].filter(Boolean).join(' '), step }
  }
  if (last.type === 'reasoning') return { label: t('transcript.activityThinking'), step }
  if (last.type === 'image') return { label: t('transcript.activityImage'), step }
  // Prose: the delegate is writing its report — show its last line so the
  // conclusion can be watched forming rather than a static "writing…".
  const line = last.text.trim().split('\n').filter(Boolean).pop()
  return { label: line ? line.slice(0, 120) : t('transcript.activityWriting'), step }
}

/** A `read` card's contents, syntax-highlighted. */
function layoutFileBody(
  builder: Builder,
  name: string,
  contents: string,
  x: number,
  y: number,
  width: number
): number {
  const palette = builder.palette
  const codeFont = font(FONT_SIZE.small, 400, 'mono')
  const lineHeight = builder.metrics.lineHeight(codeFont)
  const rows = highlight(contents, name)
  const colors = tokenColors(builder.theme.appearance)
  const gutterWidth =
    builder.metrics.advance(font(FONT_SIZE.micro, 400, 'mono')) * String(rows.length).length + 20
  const height = Math.min(SIZE.diffMax, rows.length * lineHeight + SPACE.bodyPadY * 2)

  builder.hairline(x, y, width, palette.border)
  builder.rect(x, y + 1, width, height, 0, palette.surface)
  builder.clipped(x, y + 1, width, height, 0, () => {
    builder.push({
      kind: 'code',
      x: x + gutterWidth,
      y: y + 1 + SPACE.bodyPadY,
      w: width - gutterWidth - SPACE.bodyPadX,
      lineHeight,
      font: codeFont,
      rows,
      colors,
      gutter: { width: gutterWidth, color: palette.textSubtle, start: 1 }
    })
  })

  const advance = builder.metrics.advance(codeFont)
  const visible = Math.ceil(height / lineHeight)
  rows.slice(0, visible).forEach((tokens, i) => {
    const text = tokens.map((t) => t.text).join('')
    let cursor = 0
    const runs = tokens.map((token) => {
      const w = advance * token.text.length
      const run = {
        text: token.text,
        font: codeFont,
        color: colors[token.kind],
        x: cursor,
        width: w,
        offset: 0
      }
      cursor += w
      return run
    })
    builder.selectableRow(
      x + gutterWidth,
      y + 1 + SPACE.bodyPadY + i * lineHeight,
      lineHeight,
      runs,
      text,
      { clip: { x, y: y + 1, w: width, h: height } }
    )
  })
  return 1 + height
}

/**
 * Shell output as a terminal pane — prompt line, ANSI body, status footer.
 *
 * Same three-part split as the DOM's TerminalOutput, including the deliberate
 * grey footer: `[exit 1]` in an agent's shell is ordinary (a build run to see
 * what breaks, a grep that misses), and colouring it red made a normal
 * transcript read like a disaster log.
 */
const FOOTER_RE = /^\[(exit \d+|timed out[\s\S]*|error:[\s\S]*)\]$/
const FOOTER_COLOR = '#9a9aa3'

function layoutTerminalBody(
  builder: Builder,
  text: string,
  state: 'running' | 'done' | 'error',
  x: number,
  y: number,
  width: number
): number {
  const palette = builder.palette
  let prompt = ''
  let body = text
  if (body.startsWith('$ ')) {
    const nl = body.indexOf('\n')
    prompt = nl === -1 ? body : body.slice(0, nl)
    body = nl === -1 ? '' : body.slice(nl + 1)
  }
  let footer = ''
  const split = body.split('\n')
  const lastLine = split[split.length - 1]
  if (lastLine && FOOTER_RE.test(lastLine)) {
    footer = lastLine
    body = split.slice(0, -1).join('\n')
  }
  const trimmed = body.replace(/[\r\n]+$/, '')

  const codeFont = font(FONT_SIZE.small, 400, 'mono')
  const lineHeight = builder.metrics.lineHeight(codeFont)
  const rows = trimmed === '' ? [] : parseAnsi(trimmed)
  const empty = !prompt && !trimmed && !footer

  let lineCount = rows.length
  if (prompt) lineCount += 1
  if (footer) lineCount += 1
  if (empty) lineCount = 1

  const height = Math.min(SIZE.outputMax, lineCount * lineHeight + SPACE.bodyPadY * 2)

  builder.hairline(x, y, width, palette.border)
  // The terminal keeps its own near-black background in both appearances: a
  // terminal is a terminal, and the ANSI palette is calibrated against dark.
  builder.rect(x, y + 1, width, height, 0, ANSI_BG)

  builder.clipped(x, y + 1, width, height, 0, () => {
    let cursor = y + 1 + SPACE.bodyPadY
    if (prompt) {
      builder.push({
        kind: 'text',
        x: x + SPACE.bodyPadX,
        y: cursor,
        text: prompt,
        font: codeFont,
        color: ANSI_PROMPT
      })
      cursor += lineHeight
    }
    if (rows.length > 0) {
      builder.push({
        kind: 'ansi',
        x: x + SPACE.bodyPadX,
        y: cursor,
        w: width - SPACE.bodyPadX * 2,
        lineHeight,
        font: codeFont,
        rows,
        defaultColor: ANSI_DEFAULT_FG
      })
      cursor += rows.length * lineHeight
    }
    if (footer) {
      builder.push({
        kind: 'text',
        x: x + SPACE.bodyPadX,
        y: cursor,
        text: footer,
        font: codeFont,
        color: FOOTER_COLOR
      })
    }
    if (empty) {
      builder.push({
        kind: 'text',
        x: x + SPACE.bodyPadX,
        y: cursor,
        text: builder.t(state === 'running' ? 'transcript.running' : 'transcript.noOutput'),
        font: codeFont,
        color: FOOTER_COLOR
      })
    }
  })

  // Selectable rows, capped at what is visible.
  const advance = builder.metrics.advance(codeFont)
  let selY = y + 1 + SPACE.bodyPadY
  const bottom = y + 1 + height
  const addRow = (value: string, color: string): void => {
    if (selY > bottom) return
    builder.selectableRow(
      x + SPACE.bodyPadX,
      selY,
      lineHeight,
      [{ text: value, font: codeFont, color, x: 0, width: advance * value.length, offset: 0 }],
      value,
      { clip: { x, y: y + 1, w: width, h: height } }
    )
    selY += lineHeight
  }
  if (prompt) addRow(prompt, ANSI_PROMPT)
  for (const row of rows) addRow(row.map((s) => s.text).join(''), ANSI_DEFAULT_FG)
  if (footer) addRow(footer, FOOTER_COLOR)

  if (state === 'running') builder.animate()
  return 1 + height
}

/** A `task` card's nested transcript, plus the delegate's report. */
function layoutNestedBody(
  builder: Builder,
  input: ToolCardInput,
  report: string,
  x: number,
  y: number,
  width: number
): number {
  const palette = builder.palette
  const nested = input.part.children ?? []
  builder.hairline(x, y, width, palette.border)
  let cursor = y + 1
  builder.rect(x, cursor, width, 0, 0, palette.surface)

  const railX = x + SPACE.bodyPadX
  const innerX = railX + 12
  const innerWidth = width - (innerX - x) - SPACE.bodyPadX
  const top = cursor + SPACE.bodyPadY
  const used = input.renderNested!(
    builder,
    nested,
    innerX,
    top,
    innerWidth,
    input.live,
    `${input.id}/`
  )
  // A rail down the side, so a delegate's work reads as a separate agent's
  // rather than as more of the parent's.
  builder.vrule(railX, top, used, palette.border, 2)
  cursor = top + used + SPACE.bodyPadY

  if (report && !input.live) {
    builder.hairline(x, cursor, width, palette.border)
    cursor += 1
    const labelFont = font(FONT_SIZE.micro, 500, 'sans')
    builder.text(
      x + SPACE.bodyPadX,
      cursor + 6,
      builder.t('transcript.report').toUpperCase(),
      labelFont,
      palette.textSubtle
    )
    cursor += 22
    const bodyHeight = layoutPlainText(
      builder,
      report,
      x + SPACE.bodyPadX,
      cursor,
      width - SPACE.bodyPadX * 2,
      { color: palette.textMuted, size: FONT_SIZE.small },
      'mono'
    )
    cursor += bodyHeight + SPACE.bodyPadY
  }
  return cursor - y
}

/** Plain output — everything without a richer view. */
function layoutOutputBody(
  builder: Builder,
  body: string,
  state: 'running' | 'done' | 'error',
  x: number,
  y: number,
  width: number
): number {
  const palette = builder.palette
  const text = body || builder.t(state === 'running' ? 'transcript.running' : 'transcript.noOutput')
  const codeFont = font(FONT_SIZE.small, 400, 'mono')
  const lineHeight = builder.metrics.lineHeight(codeFont)

  builder.hairline(x, y, width, palette.border)
  const top = y + 1

  // Wrapped, not clipped: unlike code, tool output is prose-shaped (a grep
  // result, an error, a JSON blob) and losing its right-hand side is worse than
  // losing its alignment.
  const measured = wrapMeasure(builder, text, codeFont, width - SPACE.bodyPadX * 2)
  const height = Math.min(SIZE.outputMax, measured * lineHeight + SPACE.bodyPadY * 2)
  builder.rect(x, top, width, height, 0, palette.surface)
  builder.clipped(x, top, width, height, 0, () => {
    builder.paragraph(
      [{ text, font: codeFont, color: palette.textMuted, offset: 0 }],
      x + SPACE.bodyPadX,
      top + SPACE.bodyPadY,
      width - SPACE.bodyPadX * 2
    )
  })
  if (state === 'running') builder.animate()
  return 1 + height
}

/** Line count a string will wrap to, without emitting anything. */
function wrapMeasure(
  builder: Builder,
  text: string,
  f: ReturnType<typeof font>,
  width: number
): number {
  const advance = builder.metrics.advance(f)
  const perLine = Math.max(1, Math.floor(width / advance))
  let count = 0
  for (const line of text.split('\n')) {
    count += Math.max(1, Math.ceil(line.length / perLine))
    // A single enormous line (a minified bundle in an error) must not be allowed
    // to claim thousands of rows; the pane caps out long before this matters.
    if (count > 400) return 400
  }
  return count
}

/** An inline image — a browser screenshot, or an image a tool returned. */
function layoutImageBody(
  builder: Builder,
  src: string,
  x: number,
  y: number,
  width: number
): number {
  const palette = builder.palette
  builder.hairline(x, y, width, palette.border)
  const pad = 8
  const top = y + 1 + pad
  const boxWidth = width - pad * 2
  const height = SIZE.diffMax
  builder.push({
    kind: 'image',
    x: x + pad,
    y: top,
    w: boxWidth,
    h: height,
    src,
    radius: SPACE.radiusMd,
    border: palette.border
  })
  builder.region(
    x + pad,
    top,
    boxWidth,
    height,
    { type: 'image', src },
    { hover: 'none', title: builder.t('transcript.openImage') }
  )
  return 1 + pad * 2 + height
}
