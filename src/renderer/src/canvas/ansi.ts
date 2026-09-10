/**
 * ANSI SGR parsing for the canvas terminal block.
 *
 * `lib/ansi.tsx` does this for the DOM, producing React spans. Canvas needs the
 * same information as plain data — and, unlike the DOM version, it has to be
 * LINE-AWARE: a canvas terminal is laid out row by row so it can be virtualized,
 * so a color that opens on one line and closes three lines later has to be
 * carried across rows explicitly rather than left to an enclosing element.
 *
 * The palette and the escape grammar are deliberately identical to the DOM
 * version's, so a `bash` card looks the same after the move.
 */

const BASIC16 = [
  '#52525b',
  '#f87171',
  '#4ade80',
  '#fbbf24',
  '#60a5fa',
  '#c084fc',
  '#22d3ee',
  '#d4d4d4',
  '#71717a',
  '#fca5a5',
  '#86efac',
  '#fde047',
  '#93c5fd',
  '#d8b4fe',
  '#67e8f9',
  '#ffffff'
]

/** The terminal block's own foreground — matches the DOM's `text-[#d4d4d4]`. */
export const ANSI_DEFAULT_FG = '#d4d4d4'
/** The terminal block's background — the DOM used a literal `bg-[#0b0b0d]`. */
export const ANSI_BG = '#0b0b0d'
/** The `$ command` prompt line's green. */
export const ANSI_PROMPT = '#4ade80'

export interface AnsiStyle {
  color?: string
  background?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  dim?: boolean
}

export interface AnsiSpan extends AnsiStyle {
  text: string
}

function basicColor(code: number): string {
  if (code >= 30 && code <= 37) return BASIC16[code - 30]
  if (code >= 90 && code <= 97) return BASIC16[code - 90 + 8]
  if (code >= 40 && code <= 47) return BASIC16[code - 40]
  if (code >= 100 && code <= 107) return BASIC16[code - 100 + 8]
  return ''
}

function xterm256(n: number): string {
  if (n < 16) return BASIC16[n] ?? ''
  if (n >= 232) {
    const v = 8 + (n - 232) * 10
    return `rgb(${v}, ${v}, ${v})`
  }
  const i = n - 16
  const r = Math.floor(i / 36)
  const g = Math.floor((i % 36) / 6)
  const b = i % 6
  const ch = (x: number): number => (x === 0 ? 0 : 55 + x * 40)
  return `rgb(${ch(r)}, ${ch(g)}, ${ch(b)})`
}

/** Fold one SGR parameter list into a style. */
function applySgr(prev: AnsiStyle, codeStr: string): AnsiStyle {
  const codes = codeStr.split(';').map((c) => (c === '' ? 0 : Number(c)))
  let s: AnsiStyle = { ...prev }
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]
    if (c === 0) s = {}
    else if (c === 1) s.bold = true
    else if (c === 2) s.dim = true
    else if (c === 3) s.italic = true
    else if (c === 4) s.underline = true
    else if (c === 22) {
      delete s.bold
      delete s.dim
    } else if (c === 23) delete s.italic
    else if (c === 24) delete s.underline
    else if (c === 39) delete s.color
    else if (c === 49) delete s.background
    else if (c === 38 || c === 48) {
      const mode = codes[i + 1]
      if (mode === 5) {
        const col = xterm256(codes[i + 2] ?? 0)
        if (c === 38) s.color = col
        else s.background = col
        i += 2
      } else if (mode === 2) {
        const col = `rgb(${codes[i + 2] ?? 0}, ${codes[i + 3] ?? 0}, ${codes[i + 4] ?? 0})`
        if (c === 38) s.color = col
        else s.background = col
        i += 4
      }
    } else {
      const col = basicColor(c)
      if (col) {
        if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) s.color = col
        else s.background = col
      }
    }
  }
  return s
}

// SGR color sequence (captured) | OSC | other CSI / charset escapes.
// eslint-disable-next-line no-control-regex
const TOKEN = /\x1b\[([0-9;]*)m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[[(][0-9;?]*[A-Za-z]/g

/**
 * Parse ANSI text into styled spans, split into lines.
 *
 * Carriage returns are handled the way a terminal would: `\r` without a newline
 * rewinds the line, so a progress bar that repaints itself renders as its FINAL
 * state instead of as fifty stacked copies. The DOM version simply dropped them,
 * which is why long installs produced enormous cards.
 */
export function parseAnsi(text: string): AnsiSpan[][] {
  const lines: AnsiSpan[][] = []
  let current: AnsiSpan[] = []
  let style: AnsiStyle = {}
  let carriageReturn = false

  /** Append a run of plain text, honouring newlines and carriage returns. */
  const pushText = (chunk: string): void => {
    if (chunk === '') return
    for (const part of chunk.split(/([\r\n])/)) {
      if (part === '\r') {
        // A CR only overwrites when more text follows. CRLF (even across SGR spans) ends the line.
        carriageReturn = true
      } else if (part === '\n') {
        lines.push(current)
        current = []
        carriageReturn = false
      } else if (part !== '') {
        if (carriageReturn) current = []
        carriageReturn = false
        const last = current[current.length - 1]
        if (last && sameStyle(last, style)) last.text += part
        else current.push({ ...style, text: part })
      }
    }
  }

  let lastIndex = 0
  let m: RegExpExecArray | null
  TOKEN.lastIndex = 0
  while ((m = TOKEN.exec(text)) !== null) {
    if (m.index > lastIndex) pushText(text.slice(lastIndex, m.index))
    lastIndex = TOKEN.lastIndex
    if (m[1] !== undefined) style = applySgr(style, m[1])
  }
  if (lastIndex < text.length) pushText(text.slice(lastIndex))
  lines.push(current)
  return lines
}

function sameStyle(a: AnsiStyle, b: AnsiStyle): boolean {
  return (
    a.color === b.color &&
    a.background === b.background &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.dim === b.dim
  )
}

/** Plain text of a parsed line — for copy and for measurement. */
export function ansiLineText(spans: AnsiSpan[]): string {
  return spans.map((s) => s.text).join('')
}
