/**
 * A markdown parser that emits layout data instead of DOM.
 *
 * Streamdown renders React, so none of it survives the move to canvas. This is
 * a deliberately small CommonMark subset — the constructs an agent actually
 * emits (headings, paragraphs, fenced code, lists, quotes, tables, rules) with
 * inline emphasis, code, links and strikethrough — parsed straight into blocks
 * the layout engine can measure.
 *
 * It is written to be re-run on every streamed token, so it is a single pass
 * with no backtracking and no regex over the whole document. It also has to be
 * tolerant of INCOMPLETE input in a way a normal parser is not: mid-stream, a
 * fence is routinely unterminated and a link is routinely half-typed, and both
 * must render as something reasonable rather than as raw syntax that reflows
 * once the closing token arrives.
 */

/** A styled inline fragment — the atom the wrapper lays out. */
export interface MdInline {
  text: string
  bold?: boolean
  italic?: boolean
  code?: boolean
  strike?: boolean
  href?: string
  /** Offset of this fragment in the block's plain text, for selection/copy. */
  offset: number
}

export type MdBlock =
  | { type: 'paragraph'; inlines: MdInline[]; text: string }
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; inlines: MdInline[]; text: string }
  | { type: 'code'; lang: string; code: string }
  | {
      type: 'list'
      ordered: boolean
      items: { inlines: MdInline[]; text: string; depth: number; marker: string }[]
    }
  | { type: 'quote'; blocks: MdBlock[] }
  | { type: 'rule' }
  | { type: 'table'; header: MdInline[][]; rows: MdInline[][][]; align: ('l' | 'c' | 'r')[] }

/** Split a document into blocks. */
export function parseMarkdown(src: string): MdBlock[] {
  const lines = src.split('\n')
  const blocks: MdBlock[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    if (trimmed === '') {
      i++
      continue
    }

    // Fenced code. An unterminated fence runs to the end of the input on
    // purpose: while streaming, that is the normal state of the last block, and
    // treating it as a paragraph would show ``` and the raw source until the
    // closing fence arrived — a visible re-render on every code block.
    const fence = trimmed.match(/^(`{3,}|~{3,})\s*(\S*)/)
    if (fence) {
      const marker = fence[1][0]
      const len = fence[1].length
      const lang = fence[2] ?? ''
      const body: string[] = []
      i++
      while (i < lines.length) {
        const candidate = lines[i].trim()
        if (candidate.startsWith(marker.repeat(len)) && /^[`~]+\s*$/.test(candidate)) {
          i++
          break
        }
        body.push(lines[i])
        i++
      }
      blocks.push({ type: 'code', lang, code: body.join('\n') })
      continue
    }

    // ATX heading.
    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      const level = heading[1].length as 1 | 2 | 3 | 4 | 5 | 6
      const text = heading[2].replace(/\s+#+\s*$/, '')
      blocks.push({ type: 'heading', level, inlines: parseInline(text), text })
      i++
      continue
    }

    // Thematic break — checked before lists, since `***` and `---` are both.
    if (/^(\s*[-*_])(\s*\1?){2,}\s*$/.test(line) && /^[\s\-*_]+$/.test(trimmed)) {
      blocks.push({ type: 'rule' })
      i++
      continue
    }

    // Table: a header row followed by a delimiter row. Anything else that
    // contains a pipe is just a paragraph.
    if (trimmed.includes('|') && i + 1 < lines.length && isDelimiterRow(lines[i + 1])) {
      const header = splitRow(lines[i]).map(parseInline)
      const align = splitRow(lines[i + 1]).map((cell) => {
        const c = cell.trim()
        if (c.startsWith(':') && c.endsWith(':')) return 'c' as const
        if (c.endsWith(':')) return 'r' as const
        return 'l' as const
      })
      i += 2
      const rows: MdInline[][][] = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(splitRow(lines[i]).map(parseInline))
        i++
      }
      blocks.push({ type: 'table', header, rows, align })
      continue
    }

    // Block quote — collected then parsed recursively, so a quoted list or code
    // block keeps its structure instead of flattening to text.
    if (/^\s*>/.test(line)) {
      const body: string[] = []
      while (
        i < lines.length &&
        (/^\s*>/.test(lines[i]) || (lines[i].trim() !== '' && body.length > 0))
      ) {
        body.push(lines[i].replace(/^\s*>\s?/, ''))
        i++
      }
      blocks.push({ type: 'quote', blocks: parseMarkdown(body.join('\n')) })
      continue
    }

    // Lists. Consecutive items of the same kind become one block so the layout
    // can space them tightly; a blank line inside a list does not end it.
    const bullet = line.match(/^(\s*)([-*+])\s+(.*)$/)
    const ordered = line.match(/^(\s*)(\d{1,9})[.)]\s+(.*)$/)
    if (bullet || ordered) {
      const isOrdered = Boolean(ordered)
      const items: { inlines: MdInline[]; text: string; depth: number; marker: string }[] = []
      let counter = ordered ? parseInt(ordered[2], 10) : 1
      while (i < lines.length) {
        const b = lines[i].match(/^(\s*)([-*+])\s+(.*)$/)
        const o = lines[i].match(/^(\s*)(\d{1,9})[.)]\s+(.*)$/)
        const m = isOrdered ? o : b
        if (!m) {
          // A continuation line (indented, non-empty) joins the previous item.
          const cont = lines[i].match(/^\s{2,}(\S.*)$/)
          if (cont && items.length > 0) {
            const prev = items[items.length - 1]
            prev.text += ' ' + cont[1]
            prev.inlines = parseInline(prev.text)
            i++
            continue
          }
          break
        }
        const indent = m[1].replace(/\t/g, '  ').length
        const text = m[3]
        items.push({
          inlines: parseInline(text),
          text,
          depth: Math.min(4, Math.floor(indent / 2)),
          marker: isOrdered ? `${counter++}.` : '•'
        })
        i++
      }
      blocks.push({ type: 'list', ordered: isOrdered, items })
      continue
    }

    // Paragraph — runs until a blank line or the start of another construct.
    const body: string[] = []
    while (i < lines.length) {
      const l = lines[i]
      if (l.trim() === '') break
      if (/^\s*(#{1,6}\s|>|```|~~~)/.test(l)) break
      if (/^(\s*)([-*+])\s+/.test(l) || /^(\s*)\d{1,9}[.)]\s+/.test(l)) break
      body.push(l.trim())
      i++
    }
    const text = body.join(' ')
    if (text !== '') blocks.push({ type: 'paragraph', inlines: parseInline(text), text })
  }

  return blocks
}

function isDelimiterRow(line: string): boolean {
  const cells = splitRow(line)
  return cells.length > 0 && cells.every((c) => /^\s*:?-{1,}:?\s*$/.test(c))
}

function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  // Split on unescaped pipes only.
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|'
      i++
    } else if (s[i] === '|') {
      cells.push(cur)
      cur = ''
    } else cur += s[i]
  }
  cells.push(cur)
  return cells
}

/**
 * Inline parse: code spans, bold, italic, strikethrough, links, autolinks.
 *
 * Code spans win over everything, which is what makes `**not bold**` inside
 * backticks render literally. Emphasis is matched non-greedily and only when it
 * closes on the same line — a lone `*` mid-stream stays a `*` instead of
 * italicising the rest of the paragraph until its partner shows up.
 *
 * `offset` tracks the position in the ORIGINAL string, so a selection over
 * rendered text can be mapped back to source for copying.
 */
export function parseInline(src: string): MdInline[] {
  const out: MdInline[] = []
  let i = 0
  let plain = ''

  const flush = (): void => {
    if (plain === '') return
    out.push({ text: plain, offset: i - plain.length })
    plain = ''
  }
  const push = (frag: Omit<MdInline, 'offset'>, at: number): void => {
    flush()
    out.push({ ...frag, offset: at })
  }

  while (i < src.length) {
    const ch = src[i]

    if (ch === '\\' && i + 1 < src.length && /[\\`*_~[\]()#+\-.!>|]/.test(src[i + 1])) {
      plain += src[i + 1]
      i += 2
      continue
    }

    if (ch === '`') {
      let ticks = 0
      while (src[i + ticks] === '`') ticks++
      const close = src.indexOf('`'.repeat(ticks), i + ticks)
      if (close !== -1) {
        const inner = src.slice(i + ticks, close)
        push({ text: inner.replace(/^ | $/g, ''), code: true }, i + ticks)
        i = close + ticks
        continue
      }
    }

    // Image — rendered as its alt text with a link-ish tint. Inline images in an
    // agent's prose are rare and always remote; the real ones arrive as image
    // PARTS, which the transcript draws properly.
    if (ch === '!' && src[i + 1] === '[') {
      const link = matchLink(src, i + 1)
      if (link) {
        push({ text: link.label || link.href, href: link.href }, i + 2)
        i = link.end
        continue
      }
    }

    if (ch === '[') {
      const link = matchLink(src, i)
      if (link) {
        // The label carries its own emphasis, so parse it and stamp the href on
        // each fragment rather than flattening it to plain text.
        for (const frag of parseInline(link.label)) {
          push({ ...frag, href: link.href }, i + 1 + frag.offset)
        }
        i = link.end
        continue
      }
    }

    // Bare URL. Trailing punctuation is excluded so "see https://x.com." does
    // not put the full stop inside the link.
    if ((ch === 'h' || ch === 'w') && /^(https?:\/\/|www\.)/.test(src.slice(i))) {
      const m = src.slice(i).match(/^(?:https?:\/\/|www\.)[^\s<>()[\]]+[^\s<>()[\].,;:!?'"]/)
      if (m) {
        const url = m[0]
        push({ text: url, href: url.startsWith('www.') ? `https://${url}` : url }, i)
        i += url.length
        continue
      }
    }

    if (ch === '~' && src[i + 1] === '~') {
      const close = src.indexOf('~~', i + 2)
      if (close !== -1) {
        for (const frag of parseInline(src.slice(i + 2, close))) {
          push({ ...frag, strike: true }, i + 2 + frag.offset)
        }
        i = close + 2
        continue
      }
    }

    if (ch === '*' || ch === '_') {
      const double = src[i + 1] === ch
      const marker = double ? ch + ch : ch
      // `_` only opens at a word boundary, so snake_case identifiers in prose
      // are not silently italicised (a real problem in an agent's output).
      const boundaryOk = ch === '*' || i === 0 || /[\s([{'"]/.test(src[i - 1])
      if (boundaryOk) {
        const close = findClose(src, i + marker.length, marker)
        if (close !== -1) {
          const inner = src.slice(i + marker.length, close)
          if (inner.trim() !== '') {
            for (const frag of parseInline(inner)) {
              push(
                { ...frag, ...(double ? { bold: true } : { italic: true }) },
                i + marker.length + frag.offset
              )
            }
            i = close + marker.length
            continue
          }
        }
      }
    }

    plain += ch
    i++
  }
  flush()
  return out.filter((f) => f.text !== '')
}

/** Find a closing emphasis marker that is not preceded by whitespace. */
function findClose(src: string, from: number, marker: string): number {
  let i = from
  while (i < src.length) {
    const at = src.indexOf(marker, i)
    if (at === -1) return -1
    if (src[at - 1] === '\\') {
      i = at + 1
      continue
    }
    // A closing marker cannot follow a space (`a * b * c` is not emphasis), and
    // for `_` it must land on a word boundary for the same reason as opening.
    if (!/\s/.test(src[at - 1] ?? ' ')) {
      const after = src[at + marker.length]
      if (marker[0] === '*' || after === undefined || /[\s.,;:!?)\]}'"]/.test(after)) return at
    }
    i = at + 1
  }
  return -1
}

/** `[label](href)`, tolerating nested brackets in the label. */
function matchLink(
  src: string,
  start: number
): { label: string; href: string; end: number } | null {
  let depth = 0
  let i = start
  for (; i < src.length; i++) {
    if (src[i] === '\\') {
      i++
      continue
    }
    if (src[i] === '[') depth++
    else if (src[i] === ']') {
      depth--
      if (depth === 0) break
    }
  }
  if (depth !== 0 || src[i + 1] !== '(') return null
  const label = src.slice(start + 1, i)
  const close = src.indexOf(')', i + 2)
  if (close === -1) return null
  const href = src.slice(i + 2, close).split(/\s+/)[0]
  if (!href) return null
  return { label, href, end: close + 1 }
}

/** A block's plain text, for copy and for selection offsets. */
export function blockText(block: MdBlock): string {
  switch (block.type) {
    case 'paragraph':
    case 'heading':
      return block.text
    case 'code':
      return block.code
    case 'list':
      return block.items.map((it) => `${it.marker} ${it.text}`).join('\n')
    case 'quote':
      return block.blocks.map(blockText).join('\n')
    case 'rule':
      return '---'
    case 'table':
      return [block.header, ...block.rows]
        .map((row) => row.map((cell) => cell.map((f) => f.text).join('')).join('\t'))
        .join('\n')
  }
}
