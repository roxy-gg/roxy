import { diffArrays, diffWordsWithSpace, createTwoFilesPatch } from 'diff'

export type DiffMode = 'unified' | 'split'
export type DiffCommand = 'unified' | 'split' | 'wrap' | 'context' | 'gap' | 'patch'
export type DiffSide = 'before' | 'after'

export interface SourceLine {
  text: string
  start: number
  end: number
  eol: string
}

export interface InlineChange {
  start: number
  end: number
}

export interface DiffSection {
  before: number
  after: number
  removed: number
  added: number
  changed: boolean
}

export interface DiffDocument {
  path: string
  before: string
  after: string
  beforeLines: SourceLine[]
  afterLines: SourceLine[]
  sections: DiffSection[]
  removed: number
  added: number
  coarse: boolean
  inlineBefore: Map<number, InlineChange[]>
  inlineAfter: Map<number, InlineChange[]>
}

export type DiffRow =
  | { kind: 'line'; before: number | null; after: number | null; changed: boolean; hunk: number }
  | { kind: 'gap'; section: number; count: number }

export interface SyntaxToken {
  text: string
  dark?: string
  light?: string
}

export interface DiffSyntax {
  before: SyntaxToken[][]
  after: SyntaxToken[][]
}

export interface DiffViewState {
  document: DiffDocument
  mode: DiffMode
  wrap: boolean
  showAll: boolean
  expanded: Set<number>
  revision: number
  syntax?: DiffSyntax
}

/** Keep the original offsets/EOLs for copying; a final newline is not a phantom row. */
export function sourceLines(source: string): SourceLine[] {
  let start = 0
  return (source.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? []).map((raw) => {
    const eol = raw.match(/(?:\r\n|\r|\n)$/)?.[0] ?? ''
    const text = raw.slice(0, raw.length - eol.length)
    const line = { text, start, end: start + text.length, eol }
    start += raw.length
    return line
  })
}

/** Bounded headless diffing. A budget fallback keeps every source line available. */
export function createDiffDocument(
  path: string,
  before: string,
  after: string,
  budget = 30
): DiffDocument {
  const beforeLines = sourceLines(before)
  const afterLines = sourceLines(after)
  // Ignore CRLF versus LF for alignment, but retain missing final-newline changes.
  const a = beforeLines.map((line) => line.text + (line.eol ? '\n' : ''))
  const b = afterLines.map((line) => line.text + (line.eol ? '\n' : ''))
  const changes = diffArrays(a, b, { timeout: budget, maxEditLength: 4096 })
  const sections: DiffSection[] = []
  let oldLine = 0
  let newLine = 0
  let added = 0
  let removed = 0
  const groups = changes ?? [
    { value: a, removed: true, added: false },
    { value: b, removed: false, added: true }
  ]
  for (const change of groups) {
    if (!change.value.length) continue
    const changed = change.added || change.removed
    const oldCount = change.added ? 0 : change.value.length
    const newCount = change.removed ? 0 : change.value.length
    const last = sections[sections.length - 1]
    if (changed && last?.changed) {
      last.removed += oldCount
      last.added += newCount
    } else {
      sections.push({
        before: oldLine,
        after: newLine,
        removed: oldCount,
        added: newCount,
        changed
      })
    }
    if (changed) {
      removed += oldCount
      added += newCount
    }
    oldLine += oldCount
    newLine += newCount
  }

  const inlineBefore = new Map<number, InlineChange[]>()
  const inlineAfter = new Map<number, InlineChange[]>()
  const deadline = Date.now() + 15
  for (const section of sections) {
    if (!section.changed || !changes) continue
    for (let i = 0; i < Math.min(section.removed, section.added, 100); i++) {
      if (Date.now() >= deadline) break
      const oldText = beforeLines[section.before + i].text
      const newText = afterLines[section.after + i].text
      if (oldText.length + newText.length > 4000) continue
      const words = diffWordsWithSpace(oldText, newText, {
        timeout: Math.max(1, deadline - Date.now()),
        maxEditLength: 256
      })
      if (!words) continue
      const oldRanges: InlineChange[] = []
      const newRanges: InlineChange[] = []
      let oldOffset = 0
      let newOffset = 0
      for (const word of words) {
        if (word.removed) oldRanges.push({ start: oldOffset, end: oldOffset + word.value.length })
        if (word.added) newRanges.push({ start: newOffset, end: newOffset + word.value.length })
        if (!word.added) oldOffset += word.value.length
        if (!word.removed) newOffset += word.value.length
      }
      inlineBefore.set(section.before + i, oldRanges)
      inlineAfter.set(section.after + i, newRanges)
    }
  }
  return {
    path,
    before,
    after,
    beforeLines,
    afterLines,
    sections,
    added,
    removed,
    coarse: !changes,
    inlineBefore,
    inlineAfter
  }
}

export function createDiffState(path: string, before: string, after: string): DiffViewState {
  return {
    document: createDiffDocument(path, before, after),
    mode: 'unified',
    wrap: true,
    showAll: false,
    expanded: new Set(),
    revision: 0
  }
}

/** Projections collapse context, never the underlying source or changes. */
export function diffRows(state: DiffViewState, context = 3): DiffRow[] {
  const rows: DiffRow[] = []
  let hunk = -1
  const { sections } = state.document
  sections.forEach((section, index) => {
    if (section.changed) {
      hunk++
      if (state.mode === 'split') {
        for (let i = 0; i < Math.max(section.removed, section.added); i++) {
          rows.push({
            kind: 'line',
            before: i < section.removed ? section.before + i : null,
            after: i < section.added ? section.after + i : null,
            changed: true,
            hunk
          })
        }
      } else {
        for (let i = 0; i < section.removed; i++) {
          rows.push({ kind: 'line', before: section.before + i, after: null, changed: true, hunk })
        }
        for (let i = 0; i < section.added; i++) {
          rows.push({ kind: 'line', before: null, after: section.after + i, changed: true, hunk })
        }
      }
      return
    }
    const count = section.removed
    const leading = index > 0 ? context : 0
    const trailing = index < sections.length - 1 ? context : 0
    const collapsed = !state.showAll && !state.expanded.has(index) && count > leading + trailing + 2
    for (let i = 0; i < count; i++) {
      if (collapsed && i === leading) {
        rows.push({ kind: 'gap', section: index, count: count - leading - trailing })
        i = count - trailing - 1
      } else {
        rows.push({
          kind: 'line',
          before: section.before + i,
          after: section.after + i,
          changed: false,
          hunk: -1
        })
      }
    }
  })
  return rows
}

/** Patch export uses the original snapshots, including their line endings. */
export function diffPatch(document: DiffDocument): string | null {
  return (
    createTwoFilesPatch(
      document.path,
      document.path,
      document.before,
      document.after,
      undefined,
      undefined,
      { context: 3, timeout: 100, maxEditLength: 4096 }
    ) ?? null
  )
}
