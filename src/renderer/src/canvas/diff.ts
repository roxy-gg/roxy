/**
 * Line diffing for the canvas transcript's write/edit cards.
 *
 * `@pierre/diffs` did this before, in shadow DOM. This computes the same thing —
 * a unified diff, collapsed to changed hunks plus three lines of context — as
 * plain data the layout can measure.
 *
 * The algorithm is Myers' O(ND) middle-snake, iterative rather than recursive
 * (a 200k-line file would otherwise blow the stack), with two guards that matter
 * for an agent's diffs specifically: identical prefixes/suffixes are trimmed
 * first, which makes the common "one line changed in a 2000-line file" case
 * nearly free, and past a size bound it degrades to a line-by-line comparison
 * rather than locking the frame.
 */

export type DiffOp = 'same' | 'add' | 'del'

export interface DiffLine {
  op: DiffOp
  text: string
  /** 1-based line number in the before file; null for an addition. */
  before: number | null
  /** 1-based line number in the after file; null for a deletion. */
  after: number | null
}

/** A run of diff lines, or the gap the collapser replaced. */
export type DiffRow =
  | { kind: 'line'; line: DiffLine }
  /** `label` is resolved during layout — the painter has no translator. */
  | { kind: 'gap'; count: number; label: string }

/** Above this many lines, fall back to a positional compare. */
const MYERS_LIMIT = 20_000

export function diffLines(beforeText: string, afterText: string): DiffLine[] {
  const a = beforeText === '' ? [] : beforeText.split('\n')
  const b = afterText === '' ? [] : afterText.split('\n')

  // Trim the common head and tail. Both are emitted as `same` at the end, so the
  // expensive part only ever sees the region that actually differs.
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++
  }

  const midA = a.slice(head, a.length - tail)
  const midB = b.slice(head, b.length - tail)

  const out: DiffLine[] = []
  for (let i = 0; i < head; i++) {
    out.push({ op: 'same', text: a[i], before: i + 1, after: i + 1 })
  }

  const core = midA.length + midB.length > MYERS_LIMIT ? naiveDiff(midA, midB) : myers(midA, midB)
  let ai = head
  let bi = head
  for (const [op, text] of core) {
    if (op === 'same') {
      out.push({ op, text, before: ai + 1, after: bi + 1 })
      ai++
      bi++
    } else if (op === 'del') {
      out.push({ op, text, before: ai + 1, after: null })
      ai++
    } else {
      out.push({ op, text, before: null, after: bi + 1 })
      bi++
    }
  }

  for (let i = 0; i < tail; i++) {
    out.push({
      op: 'same',
      text: a[a.length - tail + i],
      before: a.length - tail + i + 1,
      after: b.length - tail + i + 1
    })
  }
  return out
}

/**
 * Myers' diff via the greedy forward pass, keeping one V-array per D so the
 * path can be walked back afterwards. Memory is O(D^2) in the worst case, which
 * the size guard above bounds.
 */
function myers(a: string[], b: string[]): [DiffOp, string][] {
  const n = a.length
  const m = b.length
  if (n === 0) return b.map((line) => ['add', line] as [DiffOp, string])
  if (m === 0) return a.map((line) => ['del', line] as [DiffOp, string])

  const max = n + m
  const offset = max
  const v = new Int32Array(2 * max + 1)
  const trace: Int32Array[] = []

  let reached = -1
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      // Take whichever neighbour is further along: down (insert) or right (delete).
      const down = k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])
      let x = down ? v[k + 1 + offset] : v[k - 1 + offset] + 1
      let y = x - k
      // Slide along the diagonal for as long as the lines match.
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[k + offset] = x
      if (x >= n && y >= m) {
        reached = d
        break
      }
    }
    if (reached !== -1) break
  }
  if (reached === -1) return naiveDiff(a, b)

  // Walk the trace backwards to recover the edit script.
  const ops: [DiffOp, string][] = []
  let x = n
  let y = m
  for (let d = reached; d > 0; d--) {
    const prev = trace[d]
    const k = x - y
    const down = k === -d || (k !== d && prev[k - 1 + offset] < prev[k + 1 + offset])
    const prevK = down ? k + 1 : k - 1
    const prevX = prev[prevK + offset]
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push(['same', a[x - 1]])
      x--
      y--
    }
    if (down) {
      ops.push(['add', b[y - 1]])
      y--
    } else {
      ops.push(['del', a[x - 1]])
      x--
    }
  }
  while (x > 0 && y > 0) {
    ops.push(['same', a[x - 1]])
    x--
    y--
  }
  while (x > 0) {
    ops.push(['del', a[--x]])
  }
  while (y > 0) {
    ops.push(['add', b[--y]])
  }
  return ops.reverse()
}

/** Positional compare — the degraded path for files too big to diff properly. */
function naiveDiff(a: string[], b: string[]): [DiffOp, string][] {
  const ops: [DiffOp, string][] = []
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    if (i < a.length && i < b.length && a[i] === b[i]) ops.push(['same', a[i]])
    else {
      if (i < a.length) ops.push(['del', a[i]])
      if (i < b.length) ops.push(['add', b[i]])
    }
  }
  return ops
}

/**
 * Collapse unchanged regions to `context` lines either side of each change.
 *
 * This is what `expandUnchanged: false` did: a one-line edit in a big file
 * should show that line and its neighbours, not two thousand rows of identical
 * text. A gap is only worth collapsing if it saves more than it costs, so short
 * runs are left alone rather than replaced by a "… 2 lines" marker that is
 * taller than the lines it hides.
 */
export function collapse(
  lines: DiffLine[],
  context = 3,
  /**
   * Renders a gap's label. Passed in because the label is user-facing and this
   * module has no translator; resolving it during layout also keeps the painter,
   * which runs once per frame, free of any i18n lookup.
   */
  gapLabel: (count: number) => string = (count) => String(count)
): DiffRow[] {
  const keep = new Array<boolean>(lines.length).fill(false)
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].op === 'same') continue
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) {
      keep[j] = true
    }
  }
  // A file with no changes at all (an edit that rewrote identical content) still
  // has to show something.
  if (!keep.includes(true)) {
    return lines.slice(0, context * 2).map((line) => ({ kind: 'line', line }) as DiffRow)
  }

  const rows: DiffRow[] = []
  let run = 0
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) {
      if (run > 0) {
        // Under three lines, the marker is bigger than the gap. Emit the lines.
        if (run <= 2) {
          for (let j = i - run; j < i; j++) rows.push({ kind: 'line', line: lines[j] })
        } else {
          rows.push({ kind: 'gap', count: run, label: gapLabel(run) })
        }
        run = 0
      }
      rows.push({ kind: 'line', line: lines[i] })
    } else {
      run++
    }
  }
  if (run > 0) {
    if (run <= 2) {
      for (let j = lines.length - run; j < lines.length; j++) {
        rows.push({ kind: 'line', line: lines[j] })
      }
    } else rows.push({ kind: 'gap', count: run, label: gapLabel(run) })
  }
  return rows
}

/** Added/removed counts for a card's summary. */
export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of lines) {
    if (line.op === 'add') added++
    else if (line.op === 'del') removed++
  }
  return { added, removed }
}
