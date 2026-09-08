import type { Message, MessagePart } from '@shared/types'
import { Builder } from './builder'
import type { Block, Scene } from './scene'
import { FONT_SIZE, SPACE } from './metrics'
import {
  layoutMessageHeader,
  messageBotUsername,
  layoutParts,
  layoutUserBody,
  partsText,
  type LayoutInput
} from './transcript'
import { parseMarkdown, type MdBlock } from './markdown'
import { layoutBlock } from './prose'

type Item = {
  id: string
  message: number
  part: number
  kind: 'header' | 'user' | 'part' | 'end'
  height: number
  markdown?: MdBlock
}
type Entry = { key: string; source: unknown; block: Block; weight: number }

/** Height index stays cheap; only the viewport's parts get fonts, markdown, and scene nodes. */
export class TranscriptWindow {
  private items: Item[] = []
  private offsets = new Float64Array(1)
  private messages: Message[] | null = null
  private live: MessagePart[] | null = null
  private format = ''
  private entries = new Map<string, Entry>()
  private begins: number[] = []
  private ends: number[] = []
  private markdown = new Map<string, { text: string; blocks: MdBlock[] }>()
  private view: LayoutInput['view'] | null = null

  detach(): void {
    this.messages = null
    this.live = null
    this.view = null
    this.markdown.clear()
    for (const item of this.items) item.markdown = undefined
    for (const [id, entry] of this.entries) {
      const source = entry.source as MessagePart | undefined
      if (
        Array.isArray(source) ||
        (source &&
          typeof source === 'object' &&
          source.type !== 'text' &&
          source.type !== 'reasoning')
      )
        this.entries.delete(id)
    }
  }

  clear(): void {
    this.messages = null
    this.live = null
    this.items = []
    this.entries.clear()
    this.markdown.clear()
    this.format = ''
  }

  layout(input: LayoutInput, x: number, width: number): Scene {
    const viewport = input.viewport!
    const oldTop = viewport.top
    let oldAnchor: { id: string; offset: number } | undefined
    if (!viewport.tail && !viewport.targetId) {
      for (let i = 0; i < this.items.length; i++) {
        if (this.offsets[i] <= oldTop && this.offsets[i + 1] > oldTop) {
          oldAnchor = { id: this.items[i].id, offset: oldTop - this.offsets[i] }
          break
        }
      }
    }
    const bodyX = x + SPACE.messagePadX + SPACE.avatar + SPACE.avatarGap
    const bodyWidth = Math.max(1, width - SPACE.messagePadX * 2 - SPACE.avatar - SPACE.avatarGap)
    const messages =
      input.streaming === null
        ? input.messages
        : [
            ...input.messages,
            {
              id: '__streaming__',
              chatId: '',
              role: 'assistant' as const,
              content: '',
              parts: input.streaming,
              createdAt: 0
            }
          ]
    const format = `${x}:${width}:${input.theme.epoch}:${input.language ?? ''}:${input.t('transcript.assistant')}:${input.t('transcript.reasoning')}`
    // A new host resets disclosures. Retain text measurements, not expanded tool geometry.
    if (this.view !== input.view) {
      for (const [id, entry] of this.entries) {
        const source = entry.source as MessagePart | undefined
        if (source?.type === 'tool') this.entries.delete(id)
      }
      this.view = input.view
    }
    const rebuilt =
      this.messages !== input.messages || this.live !== input.streaming || this.format !== format
    if (rebuilt) {
      const previous = new Map(this.items.map((item) => [item.id, item]))
      const sameFormat = this.format === format
      if (!sameFormat) this.entries.clear()
      this.messages = input.messages
      this.live = input.streaming
      this.format = format
      this.items = []
      this.begins = []
      this.ends = []
      messages.forEach((message, index) => {
        this.begins.push(this.items.length)
        const add = (
          kind: Item['kind'],
          part: number,
          height: number,
          block?: MdBlock,
          section = 0
        ): void => {
          const id = `${message.id}/${kind}/${part}${block ? `/section/${section}` : ''}`
          const old = previous.get(id)
          this.items.push({
            id,
            message: index,
            part,
            kind,
            height: sameFormat && old ? old.height : height,
            markdown: block
          })
        }
        add('header', -1, SPACE.messagePadY + 20)
        if (message.role === 'user') {
          const text = message.parts
            .filter((p) => p.type === 'text')
            .map((p) => p.text)
            .join('')
          const images = message.parts.filter((p) => p.type === 'image').length
          add(
            'user',
            -1,
            estimateText(text, bodyWidth) +
              (images ? Math.ceil(images / Math.max(1, Math.floor(bodyWidth / 104))) * 104 : 0)
          )
        } else {
          message.parts.forEach((part, i) => {
            if (part.type === 'text' && part.text.length > 12000) {
              const id = `${message.id}/${i}`
              let parsed = this.markdown.get(id)
              if (parsed?.text !== part.text) {
                parsed = { text: part.text, blocks: parseMarkdown(part.text) }
                this.markdown.set(id, parsed)
              }
              parsed.blocks.forEach((block, section) =>
                add(
                  'part',
                  i,
                  block.type === 'code'
                    ? block.code.split('\n').length * 19 + 40
                    : block.type === 'paragraph' || block.type === 'heading'
                      ? estimateText(block.text, bodyWidth) + 10
                      : 80,
                  block,
                  section
                )
              )
            } else
              add(
                'part',
                i,
                part.type === 'text'
                  ? estimateText(part.text, bodyWidth) + SPACE.partGap
                  : part.type === 'reasoning'
                    ? 30
                    : part.type === 'image'
                      ? 292
                      : part.image
                        ? 442
                        : 40
              )
          })
        }
        add('end', -1, SPACE.messagePadY)
        this.ends.push(this.items.length)
      })
      const ids = new Set(this.items.map((item) => item.id))
      for (const id of this.entries.keys()) if (!ids.has(id)) this.entries.delete(id)
      while (this.markdown.size > 16) this.markdown.delete(this.markdown.keys().next().value!)
      this.reindex()
    }
    const total = (): number => this.offsets[this.items.length] + SPACE.columnPadBottom
    const find = (y: number): number => {
      let low = 0,
        high = this.items.length - 1
      while (low < high) {
        const mid = (low + high) >>> 1
        if (this.offsets[mid + 1] <= y) low = mid + 1
        else high = mid
      }
      return low
    }
    const targetMessage = viewport.targetId
      ? messages.findIndex((message) => message.id === viewport.targetId)
      : -1
    const oldIndex = oldAnchor ? this.items.findIndex((item) => item.id === oldAnchor.id) : -1
    const anchor =
      targetMessage >= 0
        ? this.begins[targetMessage]
        : oldIndex >= 0
          ? oldIndex
          : find(viewport.top)
    const relative =
      targetMessage >= 0
        ? -16
        : oldIndex >= 0
          ? oldAnchor!.offset
          : viewport.top - this.offsets[anchor]
    const position = (): number =>
      Math.max(
        0,
        Math.min(
          total() - viewport.height,
          viewport.tail
            ? total() - viewport.height
            : this.offsets[anchor] + Math.min(relative, Math.max(0, this.items[anchor].height - 1))
        )
      )
    let top = position()
    let first = 0,
      last = 0
    let measured = new Map<number, Block>()
    const pinned = new Set(
      (viewport.selectionKeys ?? []).map((key) => key.slice(0, key.lastIndexOf(':')))
    )
    const pinnedIndices = this.items.flatMap((item, i) => (pinned.has(item.id) ? [i] : []))

    // Resolve the reading anchor first. Overscan above it may change height, but not the text under the pointer.
    for (let pass = 0; pass < this.items.length; pass++) {
      first = find(Math.max(0, top - viewport.height))
      last = Math.min(this.items.length, find(top + viewport.height * 2) + 1)
      // Selection is user-requested work: retain its endpoints and intervening text while scrolling.
      for (const index of pinnedIndices) {
        first = Math.min(first, index)
        last = Math.max(last, index + 1)
      }
      const positions = Array.from({ length: last - first }, (_, i) => first + i)
      if (viewport.tail) positions.reverse()
      let changed = false
      const next = new Map<number, Block>()
      for (const index of positions) {
        const item = this.items[index]
        const message = messages[item.message]
        const part = message.parts[item.part]
        const source =
          item.markdown ??
          (item.kind === 'user' ? message.parts : item.kind === 'header' ? message.role : part)
        const idPrefix = `${message.id}/${item.part}`
        const belongs = (id: string): boolean => id === idPrefix || id.startsWith(idPrefix + '/')
        const opened = [...input.view.open].filter(belongs).sort().join(',')
        const diffs = [...input.view.diffs]
          .filter(([id]) => belongs(id))
          .map(([id, state]) => `${id}:${state.revision}`)
          .join(',')
        const scrolls = [...input.view.scroll]
          .filter(([id]) => belongs(id))
          .map(([id, state]) => `${id}:${state.left}:${state.top}`)
          .join(',')
        const live = message.id === '__streaming__'
        const key = `${format}:${item.kind === 'header' ? (messageBotUsername(input, message) ?? '') : ''}:${opened}:${diffs}:${scrolls}:${live && item.part === message.parts.length - 1}:${part?.type === 'tool' ? part.state : ''}`
        const hit = this.entries.get(item.id)
        let block: Block
        if (!live && hit?.key === key && sameSource(hit.source, source)) {
          block = hit.block
          this.entries.delete(item.id)
          this.entries.set(item.id, hit)
        } else {
          const builder = new Builder(input.metrics, input.theme, { value: 0 }, input.t)
          let height: number
          if (item.kind === 'header') {
            const username = messageBotUsername(input, message)
            height = layoutMessageHeader(
              builder,
              message.role === 'user',
              x,
              0,
              width,
              username,
              username ? input.botAvatar?.(username) : undefined
            ).y
          } else if (item.kind === 'user')
            height = layoutUserBody(builder, message.parts, bodyX, 0, bodyWidth)
          else if (item.kind === 'end')
            height =
              SPACE.messagePadY +
              (live && !message.parts.length
                ? layoutParts(builder, [], bodyX, 0, bodyWidth, input, true, `${message.id}/`)
                : 0)
          else if (item.markdown)
            height =
              layoutBlock(builder, item.markdown, bodyX, 0, bodyWidth, {
                color: input.theme.palette.text,
                size: FONT_SIZE.body
              }) + 10
          else
            height = layoutParts(
              builder,
              [part],
              bodyX,
              0,
              bodyWidth,
              input,
              live && item.part === message.parts.length - 1,
              `${message.id}/`,
              item.part,
              item.part === message.parts.length - 1
            )
          block = builder.finish(item.id, 0, Math.max(0, height))
          const weight = block.selectable.reduce(
            (n, line) => n + line.text.length * 2 + line.runs.length * 120 + 160,
            block.nodes.length * 120
          )
          if (!live && weight < 200000) this.entries.set(item.id, { source, key, block, weight })
        }
        next.set(index, block)
        if (item.height !== block.height) {
          item.height = block.height
          changed = true
        }
      }
      measured = next
      if (!changed) break
      this.reindex()
      top = position()
      const checkFirst = find(Math.max(0, top - viewport.height))
      const checkLast = Math.min(this.items.length, find(top + viewport.height * 2) + 1)
      if (checkFirst >= first && checkLast <= last) break
    }
    const blocks: Block[] = messages.map((message, i) => ({
      id: message.id,
      y: this.offsets[this.begins[i]],
      height: this.offsets[this.ends[i]] - this.offsets[this.begins[i]],
      nodes: [],
      regions: [],
      selectable: [],
      scrollRegions: [],
      animated: false,
      copyText: () => partsText(message.parts)
    }))
    let lineIndex = 0
    for (const index of [...measured.keys()].sort((a, b) => a - b)) {
      const item = this.items[index]
      const content = measured.get(index)!
      const block = blocks[item.message]
      const y = this.offsets[index]
      block.nodes.push({ kind: 'group', offsetY: y, children: content.nodes })
      block.regions.push(...content.regions.map((region) => ({ ...region, y: region.y + y })))
      block.scrollRegions.push(
        ...content.scrollRegions.map((region) => ({ ...region, y: region.y + y }))
      )
      block.selectable.push(
        ...content.selectable.map((line, local) => ({
          ...line,
          key: `${item.id}:${local}`,
          index: lineIndex++,
          y: line.y + y,
          clip: line.clip ? { ...line.clip, y: line.clip.y + y } : undefined
        }))
      )
      block.animated ||= content.animated
    }
    let weight = [...this.entries.values()].reduce((n, entry) => n + entry.weight, 0)
    while (this.entries.size > 192 || weight > 2000000) {
      const id = this.entries.keys().next().value!
      weight -= this.entries.get(id)!.weight
      this.entries.delete(id)
    }
    return {
      blocks,
      width: input.width,
      height: total(),
      window: {
        start: first === 0 ? 0 : this.offsets[first],
        end: last === this.items.length ? total() : this.offsets[last],
        scrollTop: top
      },
      copyText: () => messages.map((message) => partsText(message.parts)).join('\n\n')
    }
  }

  private reindex(): void {
    this.offsets = new Float64Array(this.items.length + 1)
    this.offsets[0] = SPACE.columnPadTop
    for (let i = 0; i < this.items.length; i++)
      this.offsets[i + 1] = this.offsets[i] + this.items[i].height
  }
}

function estimateText(text: string, width: number): number {
  if (!text.trim()) return 0
  const rows = text.split('\n')
  const columns = Math.max(8, Math.floor(width / (FONT_SIZE.body * 0.5)))
  return Math.max(
    21,
    rows.reduce((height, line) => height + Math.max(1, Math.ceil(line.length / columns)) * 21, 0)
  )
}

function sameSource(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((part, i) => sameSource(part, b[i]))
  if (
    !a ||
    !b ||
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    Array.isArray(a) ||
    Array.isArray(b)
  )
    return false
  const x = a as MessagePart,
    y = b as MessagePart
  if (x.type !== y.type) return false
  if (x.type === 'image' && y.type === 'image') return x.dataUrl === y.dataUrl && x.name === y.name
  return (
    (x.type === 'text' || x.type === 'reasoning') &&
    (y.type === 'text' || y.type === 'reasoning') &&
    x.text === y.text
  )
}
