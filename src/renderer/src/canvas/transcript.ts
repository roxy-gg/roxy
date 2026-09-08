/**
 * The transcript: messages, turns, and the parts inside them.
 *
 * This is the top of the layout tree. It turns a list of `Message` (plus the
 * live streaming turn) into `Block`s with absolute geometry, which the renderer
 * then paints and hit-tests.
 *
 * Layout is INCREMENTAL. A settled message's parts array is a stable reference —
 * it comes straight off the SQLite row and is never rebuilt — so its block is
 * cached by identity and reused untouched while a live turn streams above it.
 * Without that, every token would re-wrap every paragraph of every message in
 * the window, which is the same trap the DOM version solved with `memo`.
 */

import type { TFunction } from 'i18next'
import type { Message, MessagePart } from '@shared/types'
import { Builder } from './builder'
import type { Block, Scene, ViewState } from './scene'
import { TextMetrics, font } from './text'
import type { CanvasTheme } from './theme'
import { alpha } from './theme'
import { FONT_SIZE, SIZE, SPACE } from './metrics'
import { layoutMarkdown, layoutPlainText } from './prose'
import { layoutToolCard, type ToolCardInput } from './tool-card'
import { PROMPT_GUTTER } from './prompt-history'
import { TranscriptWindow } from './transcript-window'

export interface LayoutInput {
  messages: Message[]
  /** The live turn's parts, or null when nothing is streaming. */
  streaming: MessagePart[] | null
  width: number
  metrics: TextMetrics
  theme: CanvasTheme
  view: ViewState
  now: number
  language?: string
  viewport?: {
    top: number
    height: number
    tail: boolean
    targetId?: string
    selectionKeys?: string[]
  }
  /** Which calls can actually be cancelled (the store knows; layout does not). */
  canCancel: (part: Extract<MessagePart, { type: 'tool' }>) => boolean
  /**
   * The translator, threaded down to every block.
   *
   * Layout is plain functions, not components, so it cannot call
   * `useTranslation` — and should not: a hook here would bind the layout tree to
   * React's render phase, which is exactly what moving to canvas was meant to
   * escape. The component resolves `t` once and passes it in.
   */
  t: TFunction
}

/** How long a call must run before its cancel button appears. */
const CANCEL_REVEAL_MS = 1200

export function layoutTranscript(input: LayoutInput, cache: BlockCache): Scene {
  const { messages, streaming, width, theme, view } = input
  const availableWidth =
    width - (messages.some((message) => message.role === 'user') ? PROMPT_GUTTER : 0)
  const column = Math.max(1, Math.min(SPACE.columnMax, availableWidth - SPACE.columnPadX * 2))
  const x = Math.max(SPACE.columnPadX, (availableWidth - column) / 2)
  if (input.viewport && cache.windowed(input.messages, input.streaming))
    return cache.window.layout(input, x, column)

  const blocks: Block[] = []
  let y = SPACE.columnPadTop
  const counter = { value: 0 }

  for (const message of messages) {
    const cached = cache.get(message, availableWidth, theme.epoch, view, input.t)
    if (cached) {
      // Reuse, but re-place: an earlier message growing shifts everything below
      // it, and only `y` changes — the node geometry inside is relative to the
      // block's own origin, so a shifted block is still correct.
      const moved = shiftBlock(cached, y - cached.y, counter.value)
      blocks.push(moved)
      y += moved.height
      counter.value += moved.selectable.length
      continue
    }
    const block = layoutMessage(input, message, x, y, column, counter)
    cache.store(message, availableWidth, theme.epoch, view, block, input.t)
    blocks.push(block)
    y += block.height
  }

  if (streaming !== null) {
    const block = layoutMessage(
      input,
      {
        id: '__streaming__',
        chatId: '',
        role: 'assistant',
        content: '',
        parts: streaming,
        createdAt: 0
      },
      x,
      y,
      column,
      counter,
      true
    )
    blocks.push(block)
    y += block.height
  }

  return { blocks, height: y + SPACE.columnPadBottom, width }
}

/** Move a cached block to a new vertical origin. */
function shiftBlock(block: Block, delta: number, firstLine: number): Block {
  if (delta === 0 && (block.selectable[0]?.index ?? firstLine) === firstLine) return block
  return {
    ...block,
    y: block.y + delta,
    // Geometry inside a block is absolute (it was built at a known y), so a move
    // has to translate it. Done by wrapping in one offset group rather than
    // deep-copying every node: the painter applies the offset once, which is
    // O(1) instead of O(nodes).
    nodes: [{ kind: 'group', children: block.nodes, offsetY: delta }],
    regions: block.regions.map((r) => ({ ...r, y: r.y + delta })),
    selectable: block.selectable.map((l, index) => ({
      ...l,
      index: firstLine + index,
      y: l.y + delta,
      clip: l.clip ? { ...l.clip, y: l.clip.y + delta } : undefined
    })),
    scrollRegions: block.scrollRegions.map((r) => ({ ...r, y: r.y + delta }))
  }
}

/** One message — avatar, name, then its parts. */
function layoutMessage(
  input: LayoutInput,
  message: Message,
  x: number,
  y: number,
  width: number,
  counter: { value: number },
  streaming = false
): Block {
  const builder = new Builder(input.metrics, input.theme, counter, input.t)
  const body = layoutMessageHeader(builder, message.role === 'user', x, y, width)
  let cursor = body.y
  if (message.role === 'user') {
    cursor += layoutUserBody(builder, message.parts, body.x, cursor, body.width)
  } else {
    cursor += layoutParts(
      builder,
      message.parts,
      body.x,
      cursor,
      body.width,
      input,
      streaming,
      `${message.id}/`
    )
  }
  const height = cursor - y + SPACE.messagePadY
  return { ...builder.finish(message.id, y, height), copyText: () => partsText(message.parts) }
}

export function layoutMessageHeader(
  builder: Builder,
  isUser: boolean,
  x: number,
  y: number,
  width: number
): { x: number; y: number; width: number } {
  const palette = builder.palette
  const top = y + SPACE.messagePadY
  const bodyX = x + SPACE.messagePadX + SPACE.avatar + SPACE.avatarGap
  const bodyWidth = Math.max(1, width - SPACE.messagePadX * 2 - SPACE.avatar - SPACE.avatarGap)

  // Avatar.
  const avatarY = top + 2
  if (isUser) {
    builder.rect(
      x + SPACE.messagePadX,
      avatarY,
      SPACE.avatar,
      SPACE.avatar,
      SPACE.radiusLg,
      palette.surface2,
      palette.border
    )
    builder.icon(x + SPACE.messagePadX + 6, avatarY + 6, SIZE.icon, 'user', palette.textMuted)
  } else {
    builder.push({
      kind: 'image',
      x: x + SPACE.messagePadX,
      y: avatarY,
      w: SPACE.avatar,
      h: SPACE.avatar,
      src: '__roxy__',
      radius: SPACE.radiusLg,
      border: palette.border
    })
  }

  const nameFont = font(FONT_SIZE.small, 500, 'sans')
  builder.text(
    bodyX,
    top,
    builder.t(isUser ? 'transcript.you' : 'transcript.assistant'),
    nameFont,
    palette.textMuted
  )
  return { x: bodyX, y: top + builder.metrics.lineHeight(nameFont) + 2, width: bodyWidth }
}

/** A user turn: attached images, then plain text. */
export function layoutUserBody(
  builder: Builder,
  parts: MessagePart[],
  x: number,
  y: number,
  width: number
): number {
  const palette = builder.palette
  let cursor = y
  const images = parts.filter(
    (p): p is Extract<MessagePart, { type: 'image' }> => p.type === 'image'
  )
  if (images.length > 0) {
    const thumb = 96
    let imageX = x
    let rowTop = cursor
    for (const image of images) {
      if (imageX + thumb > x + width) {
        imageX = x
        rowTop += thumb + 8
      }
      builder.push({
        kind: 'image',
        x: imageX,
        y: rowTop,
        w: thumb,
        h: thumb,
        src: image.dataUrl,
        radius: SPACE.radiusLg,
        border: palette.border
      })
      builder.region(
        imageX,
        rowTop,
        thumb,
        thumb,
        { type: 'image', src: image.dataUrl },
        {
          title: image.name ?? builder.t('transcript.openImage')
        }
      )
      imageX += thumb + 8
    }
    cursor = rowTop + thumb + 8
  }

  // A user message is shown verbatim, exactly as the DOM did — it is what you
  // typed, and running your own prompt through a markdown renderer would eat
  // the asterisks and backticks you meant literally.
  const text = parts
    .map((p) => (p.type === 'text' || p.type === 'reasoning' ? p.text : ''))
    .join('')
  if (text) {
    cursor += layoutPlainText(builder, text, x, cursor, width, {
      color: palette.text,
      size: FONT_SIZE.body
    })
  }
  return cursor - y
}

/**
 * An assistant turn: parts in the order they happened.
 *
 * Reasoning → tool → reasoning → text, interleaved, so the transcript reads as
 * the sequence of events it was rather than being grouped by kind.
 */
export function layoutParts(
  builder: Builder,
  parts: MessagePart[],
  x: number,
  y: number,
  width: number,
  input: LayoutInput,
  streaming: boolean,
  idPrefix: string,
  firstIndex = 0,
  indicator = true
): number {
  const palette = builder.palette
  let cursor = y

  parts.forEach((part, i) => {
    const isLast = i === parts.length - 1
    const id = `${idPrefix}${firstIndex + i}`

    if (part.type === 'tool') {
      const card: ToolCardInput = {
        part,
        id,
        open: input.view.open.has(id),
        live: part.state === 'running',
        cancellable: cancelReady(part, input),
        view: input.view,
        renderNested: (nestedBuilder, children, nx, ny, nw, live, prefix) =>
          layoutParts(nestedBuilder, children, nx, ny, nw, input, streaming && live, prefix)
      }
      cursor += layoutToolCard(builder, card, x, cursor, width)
      return
    }

    if (part.type === 'reasoning') {
      cursor += layoutReasoning(
        builder,
        part.text,
        id,
        input.view.open.has(id),
        streaming && isLast,
        x,
        cursor,
        width
      )
      cursor += SPACE.partGap
      return
    }

    if (part.type === 'image') {
      const box = Math.min(width, 288)
      builder.push({
        kind: 'image',
        x,
        y: cursor,
        w: box,
        h: 288,
        src: part.dataUrl,
        radius: SPACE.radiusLg,
        border: palette.border
      })
      builder.region(x, cursor, box, 288, { type: 'image', src: part.dataUrl })
      cursor += 288 + SPACE.partGap
      return
    }

    if (part.text.trim() === '') return
    cursor += layoutMarkdown(builder, part.text, x, cursor, width, {
      color: palette.text,
      size: FONT_SIZE.body
    })
    cursor += SPACE.partGap
  })

  // The thinking indicator: shown for the whole live turn EXCEPT when something
  // else is already signalling progress — a tool mid-execution has its own
  // spinner, and text actively arriving is its own evidence.
  const last = parts[parts.length - 1]
  const runningTool = last?.type === 'tool' && last.state === 'running'
  const liveText = (last?.type === 'text' || last?.type === 'reasoning') && last.text.trim() !== ''
  if (indicator && streaming && !runningTool && !liveText) {
    cursor += layoutThinking(
      builder,
      x,
      cursor,
      builder.t(last === undefined ? 'transcript.thinking' : 'transcript.working')
    )
  }

  return cursor - y
}

/** Whether a running call has been running long enough to offer a cancel. */
function cancelReady(part: Extract<MessagePart, { type: 'tool' }>, input: LayoutInput): boolean {
  if (part.state !== 'running') return false
  if (!input.canCancel(part)) return false
  // `task` is long-running by definition, so its button can never strobe and is
  // offered immediately. Everything else waits, so a `grep` that returns in
  // 200ms never flashes a button you could not have clicked.
  if (part.tool === 'task') return true
  const key = part.callId
  if (!key) return false
  let started = input.view.startedAt.get(key)
  if (started === undefined) {
    started = input.now
    input.view.startedAt.set(key, started)
  }
  return input.now - started >= CANCEL_REVEAL_MS
}

/** A collapsible reasoning block. */
function layoutReasoning(
  builder: Builder,
  text: string,
  id: string,
  open: boolean,
  streaming: boolean,
  x: number,
  y: number,
  width: number
): number {
  const palette = builder.palette
  // Streaming forces it open: watching the model think is the point while it is
  // happening, and reading it back afterwards rarely is.
  const expanded = open || streaming
  const headerHeight = 26
  const frame = builder.slot()

  let cursor = y + headerHeight
  if (expanded) {
    builder.hairline(x + 1, cursor, width - 2, alpha(palette.border, 0.6))
    cursor += 1 + SPACE.bodyPadY
    cursor += layoutPlainText(
      builder,
      text || '…',
      x + SPACE.bodyPadX,
      cursor,
      width - SPACE.bodyPadX * 2,
      { color: palette.textMuted, size: FONT_SIZE.small, italic: true }
    )
    cursor += SPACE.bodyPadY
  }
  const height = cursor - y

  frame({
    kind: 'rect',
    x,
    y,
    w: width,
    h: height,
    radius: SPACE.radiusLg,
    fill: alpha(palette.surface2, 0.4),
    border: alpha(palette.border, 0.6)
  })

  const centerY = y + headerHeight / 2
  const brainColor = streaming ? palette.accent : palette.textSubtle
  if (streaming) {
    builder.pulsing(() => {
      builder.icon(x + SPACE.cardPadX, centerY - SIZE.iconSm / 2, SIZE.iconSm, 'brain', brainColor)
    })
  } else {
    builder.icon(x + SPACE.cardPadX, centerY - SIZE.iconSm / 2, SIZE.iconSm, 'brain', brainColor)
  }

  const labelFont = font(FONT_SIZE.small, 500, 'sans')
  builder.text(
    x + SPACE.cardPadX + SIZE.iconSm + SPACE.headerGap,
    centerY - builder.metrics.lineHeight(labelFont) / 2,
    builder.t(streaming ? 'transcript.thinkingOpen' : 'transcript.reasoning'),
    labelFont,
    palette.textSubtle
  )
  builder.icon(
    x + width - SPACE.cardPadX - SIZE.iconSm,
    centerY - SIZE.iconSm / 2,
    SIZE.iconSm,
    'chevronRight',
    palette.textSubtle,
    { rotate: expanded ? Math.PI / 2 : 0 }
  )
  builder.region(x, y, width, headerHeight, { type: 'toggle', id }, { hover: 'subtle' })
  return height
}

/** The braille spinner + label shown while a turn is live but silent. */
function layoutThinking(builder: Builder, x: number, y: number, label: string): number {
  const palette = builder.palette
  const f = font(FONT_SIZE.body, 400, 'sans')
  const height = builder.metrics.lineHeight(f) + 8
  const centerY = y + height / 2
  builder.push({
    kind: 'braille',
    x,
    y: centerY - builder.metrics.lineHeight(f) / 2,
    font: font(FONT_SIZE.body + 2, 400, 'mono'),
    color: palette.accent
  })
  builder.pulsing(() => {
    builder.text(x + 20, centerY - builder.metrics.lineHeight(f) / 2, label, f, palette.textMuted)
  })
  builder.animate()
  return height
}

/**
 * Caches laid-out blocks by message identity.
 *
 * The key is the message's `parts` REFERENCE, not its id: a settled message's
 * array never changes, and the live turn's changes on every token, so identity
 * alone distinguishes "reuse this" from "re-lay this out" without diffing
 * anything. Width, theme epoch and the message's own view state are folded in
 * because each invalidates layout.
 */
export class BlockCache {
  readonly window = new TranscriptWindow()
  private messages: Message[] | null = null
  private units = 0
  private characters = 0

  windowed(messages: Message[], streaming: MessagePart[] | null): boolean {
    if (this.messages !== messages) {
      this.messages = messages
      this.units = messages.reduce((n, message) => n + message.parts.length + 2, 0)
      this.characters = messages.reduce(
        (n, message) =>
          n +
          message.parts.reduce(
            (size, part) => size + (part.type === 'text' ? part.text.length : 0),
            0
          ),
        0
      )
    }
    return (
      this.units + (streaming?.length ?? 0) > 128 ||
      this.characters > 60000 ||
      (streaming?.some((part) => part.type === 'text' && part.text.length > 60000) ?? false)
    )
  }
  private entries = new Map<
    string,
    { parts: MessagePart[]; key: string; block: Block; t: TFunction }
  >()

  private viewKey(message: Message, view: ViewState): string {
    // Only the cards belonging to THIS message matter; a card opening elsewhere
    // must not invalidate every block on screen.
    const prefix = `${message.id}/`
    const open: string[] = []
    for (const id of view.open) if (id.startsWith(prefix)) open.push(id)
    for (const [id, state] of view.diffs)
      if (id.startsWith(prefix)) open.push(`d${id}:${state.revision}`)
    for (const [id, scroll] of view.scroll)
      if (id.startsWith(prefix)) open.push(`s${id}:${scroll.left}:${scroll.top}`)
    return open.sort().join(',')
  }

  get(message: Message, width: number, epoch: number, view: ViewState, t: TFunction): Block | null {
    const hit = this.entries.get(message.id)
    if (!hit) return null
    if (hit.parts !== message.parts || hit.t !== t) return null
    if (hit.key !== `${width}|${epoch}|${this.viewKey(message, view)}`) return null
    return hit.block
  }

  store(
    message: Message,
    width: number,
    epoch: number,
    view: ViewState,
    block: Block,
    t: TFunction
  ): void {
    this.entries.set(message.id, {
      parts: message.parts,
      key: `${width}|${epoch}|${this.viewKey(message, view)}`,
      block,
      t
    })
  }

  /** Drop everything — a session switch, or a theme change. */
  clear(): void {
    this.entries.clear()
    this.window.clear()
  }

  detach(): void {
    this.entries.clear()
    this.messages = null
    this.window.detach()
  }

  /** Forget messages that are no longer in the transcript. */
  prune(messages: Message[]): void {
    const live = new Set(messages.map((m) => m.id))
    for (const id of this.entries.keys()) if (!live.has(id)) this.entries.delete(id)
  }
}

const recentLayouts = new Map<string, BlockCache>()
export function transcriptCache(session: string): BlockCache {
  let cache = recentLayouts.get(session)
  if (!cache) cache = new BlockCache()
  recentLayouts.delete(session)
  recentLayouts.set(session, cache)
  while (recentLayouts.size > 4) recentLayouts.delete(recentLayouts.keys().next().value!)
  return cache
}

export function partsText(parts: MessagePart[]): string {
  return parts
    .map((part) => {
      if (part.type === 'text' || part.type === 'reasoning') return part.text
      if (part.type === 'image') return part.name ?? ''
      return [
        part.tool,
        part.title,
        part.output,
        part.diff?.before,
        part.diff?.after,
        part.children && partsText(part.children)
      ]
        .filter(Boolean)
        .join('\n')
    })
    .filter(Boolean)
    .join('\n\n')
}
