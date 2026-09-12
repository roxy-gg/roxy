import assert from 'node:assert/strict'
import { applyPatch } from 'diff'
import { createInstance, type TFunction } from 'i18next'
import {
  createDiffDocument,
  createDiffState,
  diffRows,
  diffPatch,
  sourceLines
} from '../../src/renderer/src/components/diff/model'
import { layoutDiffViewer } from '../../src/renderer/src/components/diff/layout'
import { Builder } from '../../src/renderer/src/canvas/builder'
import { font, wrapSpans, type TextMetrics } from '../../src/renderer/src/canvas/text'
import {
  hitTest,
  hitText,
  selectionText,
  wordSelection
} from '../../src/renderer/src/canvas/renderer'
import { layoutMarkdown, layoutPlainText } from '../../src/renderer/src/canvas/prose'
import { BlockCache, layoutTranscript } from '../../src/renderer/src/canvas/transcript'
import { linkUrl } from '../../src/renderer/src/canvas/links'
import { visibleImages, type Scene, type ViewState } from '../../src/renderer/src/canvas/scene'
import type { CanvasTheme } from '../../src/renderer/src/canvas/theme'
import source from '../../src/renderer/src/locales/default.json'
import { FIXTURES, LARGE_DIFF } from './fixtures'
import { activePrompt, promptEntries } from '../../src/renderer/src/canvas/prompt-history'
import type { Message, MessagePart } from '../../src/shared/types'
import { parseMarkdown } from '../../src/renderer/src/canvas/markdown'
import { ansiLineText, parseAnsi } from '../../src/renderer/src/canvas/ansi'
import { layoutToolCard } from '../../src/renderer/src/canvas/tool-card'
import { layoutTerminalBody } from '../../src/renderer/src/canvas/terminal'
import { createStreamPublisher } from '../../src/renderer/src/lib/stream-publisher'

let checks = 0
function check(name: string, run: () => void): void {
  run()
  checks++
  console.log(`  OK ${name}`)
}

const theme: CanvasTheme = {
  palette: {
    bg: '#101010',
    surface: '#171717',
    surface2: '#202020',
    elevated: '#272727',
    border: '#303030',
    borderStrong: '#505050',
    text: '#eeeeee',
    textMuted: '#999999',
    textSubtle: '#777777',
    accent: '#5588ff',
    accentHover: '#77aaff',
    success: '#00bb55',
    warning: '#eeaa33',
    danger: '#ee3355',
    white: '#ffffff',
    black: '#000000'
  },
  mono: 'monospace',
  sans: 'sans-serif',
  appearance: 'dark',
  epoch: 1
}
// Deterministic geometry for model/layout tests; real font metrics are tested in Electron.
const metrics = {
  measure: (text: string) => [...text].reduce((sum, char) => sum + (char === 'W' ? 12 : 6), 0),
  advance: () => 6,
  lineHeight: () => 20,
  ellipsize: (text: string, _font: unknown, width: number) => ({
    text: text.slice(0, Math.max(0, Math.floor(width / 6))),
    width
  })
} as unknown as TextMetrics
const view = (): ViewState => ({
  open: new Set(),
  startedAt: new Map(),
  images: new Map(),
  diffs: new Map(),
  scroll: new Map()
})
const i18n = createInstance()
void i18n.init({
  lng: 'en',
  fallbackLng: 'en',
  initImmediate: false,
  resources: { en: { translation: source } }
})
const t = i18n.t.bind(i18n) as TFunction
const sceneOf = (builder: Builder, height: number): Scene => ({
  blocks: [builder.finish('test', 0, height)],
  width: 600,
  height
})

check('source offsets preserve LF, CRLF, blank lines and final newline', () => {
  for (const text of ['', 'a', 'a\n', 'a\n\n', 'a\r\nb\r\n', '\n', 'a\rb']) {
    const lines = sourceLines(text)
    assert.equal(lines.map((line) => line.text + line.eol).join(''), text)
    for (const line of lines) assert.equal(text.slice(line.start, line.end), line.text)
  }
  assert.equal(sourceLines('a\n').length, 1)
  assert.equal(sourceLines('').length, 0)
})
check('line ending conversion does not mark every line as changed', () => {
  const doc = createDiffDocument('a.ts', 'a\r\nb\r\n', 'a\nb\n')
  assert.equal(doc.added + doc.removed, 0)
  assert.equal(doc.before, 'a\r\nb\r\n')
})
check('EOF-newline-only change remains visible', () => {
  const doc = createDiffDocument('a.ts', 'a\n', 'a')
  assert.equal(doc.added, 1)
  assert.equal(doc.removed, 1)
  assert.equal(doc.afterLines[0].eol, '')
})
check('new/deleted files report real line counts', () => {
  assert.equal(createDiffDocument('a', '', 'a\nb\n').added, 2)
  assert.equal(createDiffDocument('a', 'a\nb\n', '').removed, 2)
})
check('EOF changes render an explicit missing-newline label', () => {
  const state = createDiffState('a.ts', 'value\n', 'value')
  const builder = new Builder(metrics, theme, { value: 0 }, t)
  const height = layoutDiffViewer(builder, 'diff', state, view(), 0, 0, 600)
  const content = JSON.stringify(sceneOf(builder, height))
  assert.ok(content.includes('No newline at end of file'))
})
check('all projections preserve original and modified source rows', () => {
  const texts = ['', 'a', 'b', 'a\nb\na\n', 'a\na\nb\n', 'b\na\nb', '\n\na\n']
  for (const a of texts)
    for (const b of texts) {
      const state = createDiffState('a', a, b)
      state.showAll = true
      for (const mode of ['split', 'unified'] as const) {
        state.mode = mode
        const rows = diffRows(state).filter((row) => row.kind === 'line')
        assert.deepEqual(
          rows.filter((r) => r.before !== null).map((r) => r.before),
          sourceLines(a).map((_, i) => i)
        )
        assert.deepEqual(
          rows.filter((r) => r.after !== null).map((r) => r.after),
          sourceLines(b).map((_, i) => i)
        )
      }
    }
})
check('context gaps expand without discarding source', () => {
  const state = createDiffState(LARGE_DIFF.path, LARGE_DIFF.before, LARGE_DIFF.after)
  const before = diffRows(state)
  const gap = before.find((row) => row.kind === 'gap')!
  assert.ok(gap)
  state.expanded.add(gap.section)
  const after = diffRows(state)
  assert.equal(after.length, before.length - 1 + gap.count)
  assert.equal(state.document.afterLines.length, 160)
})
check('identical full files remain expandable', () => {
  const state = createDiffState('a', LARGE_DIFF.before, LARGE_DIFF.before)
  assert.ok(diffRows(state).some((row) => row.kind === 'gap'))
  state.showAll = true
  assert.equal(diffRows(state).length, 160)
})
check('large low-distance diff keeps alignment', () => {
  const lines = Array.from({ length: 12000 }, (_, i) => `line-${i}`)
  const edited = [...lines]
  edited.splice(5, 0, 'new-1')
  edited[edited.length - 2] = 'changed'
  const doc = createDiffDocument('large.txt', lines.join('\n'), edited.join('\n'), 100)
  assert.equal(doc.coarse, false)
  assert.equal(doc.added, 2)
  assert.equal(doc.removed, 1)
})
check('budget fallback retains all lines and identifies coarse output', () => {
  const before = Array.from({ length: 10000 }, (_, i) => `old-${i}`).join('\n')
  const after = Array.from({ length: 10000 }, (_, i) => `new-${i}`).join('\n')
  const started = performance.now()
  const doc = createDiffDocument('large.txt', before, after, -1)
  assert.ok(doc.coarse)
  assert.equal(doc.added, 10000)
  assert.equal(doc.removed, 10000)
  assert.ok(performance.now() - started < 1000)
})
check('inline ranges identify edits within paired lines', () => {
  const doc = createDiffDocument('a.ts', 'const value = 1\n', 'const value = 2\n')
  assert.deepEqual(
    doc.inlineBefore.get(0)?.map((r) => doc.beforeLines[0].text.slice(r.start, r.end)),
    ['1']
  )
  assert.deepEqual(
    doc.inlineAfter.get(0)?.map((r) => doc.afterLines[0].text.slice(r.start, r.end)),
    ['2']
  )
})
check('exported patch round-trips exact original contents', () => {
  for (const [before, after] of [
    ['a\n', 'b\n'],
    ['a\r\nb\r\n', 'a\r\nc'],
    ['', 'new'],
    ['gone\n', '']
  ]) {
    const patch = diffPatch(createDiffDocument('a.txt', before, after))
    assert.ok(patch)
    assert.equal(applyPatch(before, patch), after)
  }
})
check('unsafe and relative hrefs are not activatable', () => {
  for (const href of [
    'javascript:alert(1)',
    'file:///C:/foo',
    'data:text/html,x',
    '/relative',
    '#hash'
  ])
    assert.equal(linkUrl(href), null)
  assert.equal(linkUrl('www.example.com'), 'https://www.example.com/')
})
check('wrapped and inline-code links register hit targets', () => {
  const builder = new Builder(metrics, theme, { value: 0 }, t)
  const height = layoutMarkdown(
    builder,
    '[a lengthy wrapped link](https://example.com) [`API`](https://example.com/api)',
    0,
    0,
    65,
    { size: 14, color: theme.palette.text }
  )
  const scene = sceneOf(builder, height)
  const links = scene.blocks[0].regions.filter((r) => r.action.type === 'link')
  assert.ok(links.length > 3)
  for (const r of links) assert.equal(hitTest(scene, r.x + 1, r.y + 1)?.action.type, 'link')
  assert.ok(links.some((r) => r.action.type === 'link' && r.action.href.endsWith('/api')))
})
check('text selection retains hard newlines, not soft wraps', () => {
  const builder = new Builder(metrics, theme, { value: 0 }, t)
  const text = 'one two three\n\nfour\n'
  const height = layoutPlainText(builder, text, 0, 0, 50, { size: 14, color: '#fff' })
  const scene = sceneOf(builder, height)
  const lines = scene.blocks[0].selectable
  assert.equal(
    selectionText(scene, {
      startLine: 0,
      startChar: 0,
      endLine: lines.length - 1,
      endChar: lines.at(-1)!.text.length
    }),
    text
  )
  assert.equal(hitText(scene, 500, 2, metrics), null)
})
check('selection measures proportional glyphs instead of average widths', () => {
  const builder = new Builder(metrics, theme, { value: 0 }, t)
  builder.selectableRow(
    0,
    0,
    20,
    [{ text: 'Wi', font: font(14), color: '#fff', x: 0, width: 18, offset: 0 }],
    'Wi'
  )
  assert.equal(hitText(sceneOf(builder, 20), 5, 4, metrics)?.char, 0)
  assert.equal(hitText(sceneOf(builder, 20), 7, 4, metrics)?.char, 1)
})
check('double-click selection uses native word boundaries', () => {
  const builder = new Builder(metrics, theme, { value: 0 }, t)
  const text = "alpha can't 日本語, omega"
  builder.selectableRow(
    0,
    0,
    20,
    [{ text, font: font(14), color: '#fff', x: 0, width: metrics.measure(text, font(14)), offset: 0 }],
    text,
    { group: 'after' }
  )
  const scene = sceneOf(builder, 20)
  const selection = wordSelection(scene, { line: 0, char: 8, group: 'after' })
  assert.ok(selection)
  assert.equal(selectionText(scene, selection), "can't")
  assert.equal(selection.group, 'after')
})
check('clipping limits both link and selectable hit regions', () => {
  const builder = new Builder(metrics, theme, { value: 0 }, t)
  builder.clipped(10, 10, 30, 20, 0, () => {
    builder.paragraph(
      [
        {
          text: 'a link outside',
          href: 'https://example.com',
          font: font(14),
          color: '#fff',
          offset: 0
        }
      ],
      0,
      0,
      100
    )
  })
  const scene = sceneOf(builder, 100)
  assert.equal(hitTest(scene, 5, 5), null)
  assert.equal(hitText(scene, 5, 5, metrics), null)
  assert.ok(hitTest(scene, 20, 12))
})
check('cache repositions blocks and rebases selection ordinals', () => {
  const cache = new BlockCache()
  const state = view()
  const input = {
    messages: FIXTURES,
    streaming: null,
    width: 600,
    metrics,
    theme,
    view: state,
    now: 0,
    canCancel: () => true,
    t
  }
  const first = layoutTranscript(input, cache)
  state.open.add('m2/1')
  const second = layoutTranscript(input, cache)
  const lines = second.blocks.flatMap((b) => b.selectable)
  assert.deepEqual(
    lines.map((l) => l.index),
    lines.map((_, i) => i)
  )
  assert.ok(second.blocks[2].y > first.blocks[2].y)
  const row = second.blocks[2].selectable[0]
  assert.equal(hitText(second, row.x + 2, row.y + 4, metrics)?.line, row.index)
})
check('diff wrapping, scroll limits, and split selection share geometry', () => {
  const state = createDiffState(LARGE_DIFF.path, LARGE_DIFF.before, LARGE_DIFF.after)
  const ui = view()
  state.showAll = true
  state.mode = 'split'
  const layout = (): Scene => {
    const builder = new Builder(metrics, theme, { value: 0 }, t)
    return sceneOf(builder, layoutDiffViewer(builder, 'diff', state, ui, 0, 0, 400))
  }
  let scene = layout()
  assert.ok(scene.blocks[0].scrollRegions[0].contentHeight > 3000)
  assert.equal(scene.blocks[0].scrollRegions[0].contentWidth, 400)
  ui.scroll.set('diff', { top: 100000, left: 0 })
  scene = layout()
  const region = scene.blocks[0].scrollRegions[0]
  assert.equal(region.top, region.contentHeight - region.h)
  const last = scene.blocks[0].selectable.find(
    (line) => line.group === 'diff:after' && line.text.includes('item159')
  )!
  assert.ok(last.y >= region.y && last.y + last.height <= region.y + region.h)
  state.wrap = false
  state.revision++
  scene = layout()
  assert.ok(scene.blocks[0].scrollRegions[0].contentWidth > 400)
})

check('prompt history contains only user-authored message previews', () => {
  const entries = promptEntries(FIXTURES)
  assert.deepEqual(
    entries.map((entry) => entry.id),
    ['m1', 'm3']
  )
  assert.equal(entries[0].text, 'Replace the DOM transcript with canvas.')
  assert.equal(entries[1].images, 1)
  assert.equal(entries[1].createdAt, FIXTURES[2].createdAt)
  assert.deepEqual(promptEntries([]), [])
})
check('prompt summaries handle image-only and bounded long requests', () => {
  const image = { ...FIXTURES[2], content: '', parts: [FIXTURES[2].parts[0]] }
  const long = { ...FIXTURES[0], parts: [{ type: 'text' as const, text: 'abc '.repeat(2000) }] }
  assert.deepEqual(promptEntries([image])[0], {
    id: image.id,
    text: '',
    images: 1,
    createdAt: image.createdAt
  })
  assert.equal(promptEntries([long])[0].text.length, 400)
})
check('active prompt covers the answer until the next user prompt', () => {
  const anchors = [
    { id: 'a', y: 16 },
    { id: 'b', y: 1000 },
    { id: 'c', y: 1200 }
  ]
  assert.equal(activePrompt([], 0, false), null)
  assert.equal(activePrompt(anchors, -20, false), 'a')
  assert.equal(activePrompt(anchors, 600, false), 'a')
  assert.equal(activePrompt(anchors, 984, false), 'b')
  assert.equal(activePrompt(anchors, 1100, true), 'c')
})

const longMessages: Message[] = Array.from({ length: 150 }, (_, i) => ({
  id: `long-${i}`,
  chatId: 'long',
  role: i % 2 ? 'assistant' : 'user',
  content: `Message ${i}`,
  parts: [{ type: 'text', text: `Message ${i}: ` + 'a long readable line '.repeat(60) }],
  createdAt: i
}))
const longInput = (messages: Message[], state = view()) => ({
  messages,
  streaming: null as MessagePart[] | null,
  width: 800,
  metrics,
  theme,
  view: state,
  now: 0,
  canCancel: () => true,
  t,
  viewport: { top: 0, height: 600, tail: true, targetId: undefined as string | undefined }
})

check('cold long history measures the tail, not every message', () => {
  const scene = layoutTranscript(longInput(longMessages), new BlockCache())
  assert.equal(scene.blocks.length, 150)
  assert.ok(scene.window)
  assert.equal(scene.window.scrollTop, scene.height - 600)
  assert.ok(scene.blocks.filter((b) => b.nodes.length).length < 15)
  assert.ok(scene.blocks.at(-1)!.selectable.some((line) => line.text.includes('Message 149')))
})
check('old prompts measure on demand and keep their reading anchor', () => {
  const input = longInput(longMessages)
  const cache = new BlockCache()
  layoutTranscript(input, cache)
  input.viewport = { top: 0, height: 600, tail: false, targetId: 'long-60' }
  const scene = layoutTranscript(input, cache)
  assert.equal(scene.window!.scrollTop, scene.blocks[60].y - 16)
  assert.ok(scene.blocks[60].selectable.some((line) => line.text.includes('Message 60')))
  input.viewport = { ...input.viewport, targetId: undefined, top: scene.window!.scrollTop + 300 }
  const next = layoutTranscript(input, cache)
  assert.ok(next.window!.start <= next.window!.scrollTop)
  assert.ok(next.window!.end >= next.window!.scrollTop + 600)
})
check('returning to an identical IPC snapshot reuses measured text', () => {
  let calls = 0
  const counted = {
    ...metrics,
    measure: (value: string, f: ReturnType<typeof font>) => {
      calls++
      return metrics.measure(value, f)
    }
  } as unknown as TextMetrics
  const cache = new BlockCache()
  const input = { ...longInput(longMessages), metrics: counted }
  layoutTranscript(input, cache)
  const initialCalls = calls
  calls = 0
  layoutTranscript({ ...input, messages: structuredClone(longMessages) }, cache)
  assert.ok(calls < initialCalls / 3, `revisit ${calls} versus cold ${initialCalls}`)
})
check('changed text invalidates cached parts despite stable message ids', () => {
  const cache = new BlockCache()
  const input = longInput(longMessages)
  layoutTranscript(input, cache)
  const changed = structuredClone(longMessages)
  changed[149].parts = [{ type: 'text', text: 'Updated final answer.' }]
  const scene = layoutTranscript({ ...input, messages: changed }, cache)
  assert.ok(scene.blocks[149].selectable.some((line) => line.text.includes('Updated final answer')))
})
check('one agent message with hundreds of steps is windowed by part', () => {
  const parts: MessagePart[] = Array.from({ length: 600 }, (_, i) => ({
    type: 'text',
    text: `Step ${i}: ` + 'output '.repeat(35)
  }))
  const message = { ...longMessages[1], id: 'agent-many-steps', parts }
  const scene = layoutTranscript(longInput([message]), new BlockCache())
  assert.ok(scene.blocks[0].selectable.length < 250)
  assert.ok(scene.blocks[0].selectable.some((line) => line.text.includes('Step 599')))
  assert.ok(scene.copyText!().includes('Step 0:'))
  assert.ok(
    selectionText(scene, {
      startLine: 0,
      startChar: 0,
      endLine: 1,
      endChar: 1,
      all: true
    }).includes('Step 599:')
  )
})
check('hidden tool payloads are not flattened or measured during arrival', () => {
  let reads = 0
  const part = {
    type: 'tool',
    tool: 'read',
    state: 'done',
    title: 'big.log',
    get output() {
      reads++
      return 'data'.repeat(100000)
    }
  } as MessagePart
  const message = { ...longMessages[1], parts: [part] }
  const scene = layoutTranscript(longInput([message]), new BlockCache())
  assert.equal(reads, 0)
  assert.ok(scene.blocks[0].copyText!().includes('data'))
  assert.equal(reads, 1)
})
check('image loading respects offscreen and clipped nested content', () => {
  const builder = new Builder(metrics, theme, { value: 0 }, t)
  const image = (src: string, y: number) => ({
    kind: 'image' as const,
    x: 0,
    y,
    w: 100,
    h: 100,
    src,
    radius: 0
  })
  builder.push(image('offscreen', 0))
  builder.push({ kind: 'group', offsetY: 1000, children: [image('visible', 0)] })
  builder.clipped(0, 1000, 100, 50, 0, () => builder.push(image('clipped-out', 1100)))
  assert.deepEqual([...visibleImages(sceneOf(builder, 2000), 1000, 100)], ['visible'])
})
check('virtual nested diff responds to controls and source updates', () => {
  const message = {
    ...FIXTURES[1],
    id: 'nested',
    parts: [
      ...Array.from({ length: 150 }, (): MessagePart => ({ type: 'text', text: 'Previous step.' })),
      FIXTURES[1].parts[10]
    ]
  }
  const state = view()
  state.open.add('nested/150')
  state.open.add('nested/150/4')
  const input = longInput([message], state)
  const cache = new BlockCache()
  let scene = layoutTranscript(input, cache)
  const diff = state.diffs.get('nested/150/4')!
  assert.ok(diff)
  diff.mode = 'split'
  diff.revision++
  scene = layoutTranscript(input, cache)
  assert.ok(scene.blocks[0].selectable.some((line) => line.group === 'nested/150/4:after'))
  const region = scene.blocks[0].scrollRegions[0]
  state.scroll.set(region.id, { left: 0, top: 999999 })
  scene = layoutTranscript(input, cache)
  const next = scene.blocks[0].scrollRegions[0]
  assert.equal(next.top, Math.max(0, next.contentHeight - next.h))
})
check('long tokens never measure a huge remainder for every wrapped line', () => {
  let work = 0
  const counted = {
    ...metrics,
    measure: (text: string) => {
      work += text.length
      return text.length * 6
    }
  } as unknown as TextMetrics
  const text = 'x'.repeat(100000)
  const { lines } = wrapSpans(
    [{ text, font: font(12, 400, 'mono'), color: '#fff', offset: 0 }],
    300,
    counted
  )
  assert.equal(lines.map((line) => line.runs.map((run) => run.text).join('')).join(''), text)
  assert.ok(
    work < text.length * 20,
    `Measured ${work} characters for ${text.length} input characters`
  )
})
check('markdown thematic-break detection handles huge mixed lines without backtracking', () => {
  const start = performance.now()
  const parsed = parseMarkdown('-'.repeat(10000) + ' not a rule')
  assert.equal(parsed[0].type, 'paragraph')
  assert.ok(performance.now() - start < 500)
})
check('unfinished markdown boundaries always advance the parser', () => {
  for (const text of ['# ', '###\t', '# \nfollowing text', '~~~']) {
    const parsed = parseMarkdown(text)
    assert.ok(Array.isArray(parsed))
  }
})
check('large markdown replies only lay out nearby sections', () => {
  const content = Array.from(
    { length: 400 },
    (_, i) => `### Section ${i}\n\n` + 'Readable prose '.repeat(20)
  ).join('\n\n')
  const input = longInput([
    { ...longMessages[1], id: 'report', parts: [{ type: 'text', text: content }] }
  ])
  const scene = layoutTranscript(input, new BlockCache())
  assert.ok(scene.window)
  assert.ok(scene.blocks[0].selectable.length < 250)
  assert.ok(scene.blocks[0].selectable.some((line) => line.text.includes('Section 399')))
})
check('window coverage and anchor survive large estimate corrections', () => {
  const messages: Message[] = Array.from({ length: 140 }, (_, i) => ({
    ...longMessages[1],
    id: `estimate-${i}`,
    parts: [
      {
        type: 'text',
        text:
          i % 3 === 0
            ? '# Title\n\n' + '**value** '.repeat(100)
            : i % 3 === 1
              ? '\n\n'.repeat(120)
              : 'tiny'
      }
    ]
  }))
  const cache = new BlockCache()
  let input = longInput(messages)
  let scene = layoutTranscript(input, cache)
  for (let i = 0; i < 40; i++) {
    const top = Math.min(scene.height - 600, (scene.height * ((i * 17) % 39)) / 39)
    input = { ...input, viewport: { top, height: 600, tail: false, targetId: undefined } }
    scene = layoutTranscript(input, cache)
    assert.ok(Number.isFinite(scene.window!.scrollTop))
    assert.ok(
      scene.window!.start <= scene.window!.scrollTop &&
        scene.window!.end >= Math.min(scene.height, scene.window!.scrollTop + 600),
      `Uncovered viewport ${JSON.stringify(scene.window)}`
    )
  }
})
check('resizing a windowed transcript preserves the current message', () => {
  const cache = new BlockCache()
  const input = longInput(longMessages)
  layoutTranscript(input, cache)
  const scene = layoutTranscript(
    { ...input, viewport: { top: 0, height: 600, tail: false, targetId: 'long-80' } },
    cache
  )
  const narrowed = layoutTranscript(
    {
      ...input,
      width: 420,
      viewport: { top: scene.window!.scrollTop, height: 600, tail: false, targetId: undefined }
    },
    cache
  )
  assert.ok(
    narrowed.blocks[80].y >= narrowed.window!.scrollTop &&
      narrowed.blocks[80].y < narrowed.window!.scrollTop + 300
  )
})
check('a new canvas host cannot reuse stale expanded diff controls', () => {
  const message = {
    ...FIXTURES[1],
    id: 'host-diff',
    parts: [
      ...Array.from({ length: 150 }, (): MessagePart => ({ type: 'text', text: 'Earlier.' })),
      FIXTURES[1].parts[4]
    ]
  }
  const cache = new BlockCache()
  const state = view()
  state.open.add('host-diff/150')
  layoutTranscript(longInput([message], state), cache)
  cache.detach()
  const fresh = view()
  fresh.open.add('host-diff/150')
  const scene = layoutTranscript(longInput([message], fresh), cache)
  assert.ok(fresh.diffs.has('host-diff/150'))
  assert.ok(scene.blocks[0].scrollRegions.length > 0)
})
check('an empty streaming turn remains visible beside windowed history', () => {
  const state = view()
  const input = { ...longInput(longMessages, state), streaming: [], now: 1234 }
  const scene = layoutTranscript(input, new BlockCache())
  assert.ok(scene.blocks.at(-1)!.animated)
  assert.ok(JSON.stringify(scene.blocks.at(-1)!.nodes).includes('braille'))
  assert.ok(JSON.stringify(scene.blocks.at(-1)!.nodes).includes('elapsed'))
  assert.equal(state.startedAt.get('__turn__'), 1234)
  layoutTranscript({ ...input, streaming: null, now: 5000 }, new BlockCache())
  assert.equal(state.startedAt.has('__turn__'), false)
})
check('a quiet live turn restores working after visible prose', () => {
  const input = {
    ...longInput(longMessages),
    streaming: [{ type: 'text' as const, text: 'I found the integration issue.' }]
  }
  const active = layoutTranscript(input, new BlockCache())
  assert.equal(JSON.stringify(active.blocks.at(-1)!.nodes).includes('braille'), false)

  const quiet = layoutTranscript({ ...input, quiet: true }, new BlockCache())
  assert.ok(quiet.blocks.at(-1)!.animated)
  assert.ok(JSON.stringify(quiet.blocks.at(-1)!.nodes).includes('braille'))
})
check('live reasoning starts collapsed and can be toggled closed again', () => {
  const state = view()
  const input = {
    ...longInput([], state),
    streaming: [{ type: 'reasoning' as const, text: 'Private planning details.' }],
    viewport: undefined
  }
  const closed = layoutTranscript(input, new BlockCache())
  const toggle = closed.blocks[0].regions.find((region) => region.action.type === 'toggle')
  assert.deepEqual(toggle?.action, { type: 'toggle', id: '__streaming__/0' })
  assert.equal(closed.blocks[0].selectable.some((line) => line.text.includes('Private planning')), false)

  state.open.add('__streaming__/0')
  const opened = layoutTranscript(input, new BlockCache())
  assert.ok(opened.blocks[0].height > closed.blocks[0].height)
  assert.ok(opened.blocks[0].selectable.some((line) => line.text.includes('Private planning')))

  state.open.delete('__streaming__/0')
  const closedAgain = layoutTranscript(input, new BlockCache())
  assert.equal(closedAgain.blocks[0].height, closed.blocks[0].height)
})
check('a dragged selection retains its source rows across viewport boundaries', () => {
  const cache = new BlockCache()
  const input = longInput(longMessages)
  const first = layoutTranscript(
    { ...input, viewport: { top: 0, height: 600, tail: false } },
    cache
  )
  const anchor = first.blocks[0].selectable[0].key!
  const next = layoutTranscript(
    { ...input, viewport: { top: 5000, height: 600, tail: false, selectionKeys: [anchor] } },
    cache
  )
  assert.ok(next.blocks[0].selectable.some((line) => line.key === anchor))
  assert.ok(next.window!.end >= next.window!.scrollTop + 600)
})

check('Windows terminal lines survive CRLF and ANSI style changes', () => {
  assert.deepEqual(parseAnsi('first\r\nsecond\r\n').map(ansiLineText), ['first', 'second', ''])
  assert.deepEqual(parseAnsi('\u001b[31merror\r\u001b[0m\nnext').map(ansiLineText), [
    'error',
    'next'
  ])
  assert.deepEqual(parseAnsi('10%\r20%\r\u001b[32m100%\r').map(ansiLineText), ['100%'])
})

check('short bash cards do not reserve blank ANSI output space', () => {
  const part: Extract<MessagePart, { type: 'tool' }> = {
    type: 'tool',
    tool: 'bash',
    state: 'done',
    title: 'pwd',
    output: '$ pwd\n' + '\u001b[0m\r\n'.repeat(40)
  }
  const builder = new Builder(metrics, theme, { value: 0 }, t)
  const height = layoutToolCard(
    builder,
    { part, id: 'bash', view: view(), open: true, live: false, cancellable: false },
    0,
    0,
    600
  )
  assert.ok(height < 90, `One command occupied ${height}px`)
})

check('long bash commands wrap completely instead of being clipped', () => {
  const command = 'Copy-Item ' + '"C:\\long folder\\file.txt" '.repeat(12) + '-Force'
  const part: Extract<MessagePart, { type: 'tool' }> = {
    type: 'tool',
    tool: 'bash',
    state: 'done',
    input: { command },
    title: command,
    output: `$ ${command}\n`
  }
  const builder = new Builder(metrics, theme, { value: 0 }, t)
  const height = layoutToolCard(
    builder,
    { part, id: 'bash', view: view(), open: true, live: false, cancellable: false },
    0,
    0,
    300
  )
  const scene = sceneOf(builder, height)
  const rows = scene.blocks[0].selectable
  assert.ok(rows.length > 1)
  assert.ok(rows.every((row) => row.runs.every((run) => row.x + run.x + run.width <= 288)))
  assert.equal(
    selectionText(scene, {
      startLine: 0,
      startChar: 0,
      endLine: rows.length - 1,
      endChar: rows.at(-1)!.text.length
    }),
    `$ ${command}`
  )
})

check('terminal wrapping retains ANSI styles, tabs and graphemes', () => {
  const part: Extract<MessagePart, { type: 'tool' }> = {
    type: 'tool',
    tool: 'bash_output',
    state: 'done',
    output:
      '\u001b[1;3;4;31;44m' +
      'red\t'.repeat(8) +
      '\u001b[0m\r\n' +
      '\u6f22\u{1f600}'.repeat(20) +
      '\r\n[exit 1]\r\n'
  }
  const builder = new Builder(metrics, theme, { value: 0 }, t)
  const height = layoutTerminalBody(builder, part, 'ansi', view(), 0, 0, 180)
  const scene = sceneOf(builder, height)
  const rows = scene.blocks[0].selectable
  const runs = rows.flatMap((row) => row.runs)
  assert.ok(
    runs.some(
      (run) =>
        run.color === '#f87171' &&
        run.background === '#60a5fa' &&
        run.underline &&
        run.font.weight === 700 &&
        run.font.style === 'italic'
    )
  )
  assert.ok(
    runs.filter((run) => run.text === '\t').every((run) => run.width > 0 && run.width <= 24)
  )
  assert.ok(runs.every((run) => !/[\uD800-\uDBFF]$/.test(run.text)))
  assert.equal(
    selectionText(scene, {
      startLine: 0,
      startChar: 0,
      endLine: rows.length - 1,
      endChar: rows.at(-1)!.text.length
    }),
    'red\t'.repeat(8) + '\n' + '\u6f22\u{1f600}'.repeat(20) + '\n[exit 1]'
  )
})

check('long terminal output scrolls to every wrapped row without remeasuring', () => {
  const part: Extract<MessagePart, { type: 'tool' }> = {
    type: 'tool',
    tool: 'bash_output',
    state: 'done',
    output:
      Array.from({ length: 100 }, (_, i) => `row ${i}\t${'payload '.repeat(15)}`).join('\r\n') +
      '\r\n[exit 0]\r\n'
  }
  const state = view()
  const layout = (m = metrics): Scene => {
    const builder = new Builder(m, theme, { value: 0 }, t)
    return sceneOf(builder, layoutTerminalBody(builder, part, 'terminal', state, 0, 0, 200))
  }
  let scene = layout()
  const start = scene.blocks[0].scrollRegions[0]
  assert.equal(start.h, 288)
  assert.equal(start.contentWidth, start.w)
  assert.ok(start.contentHeight > 2000)
  state.scroll.set('terminal', { top: 999999, left: 500 })
  scene = layout({
    ...metrics,
    measure: () => {
      throw new Error('Rewrapped during a scroll')
    }
  } as unknown as TextMetrics)
  const end = scene.blocks[0].scrollRegions[0]
  const row = scene.blocks[0].selectable.at(-1)!
  assert.equal(end.left, 0)
  assert.equal(end.top, end.contentHeight - end.h)
  assert.equal(row.text, '[exit 0]')
  assert.ok(row.y >= end.y && row.y + row.height <= end.y + end.h)
  assert.equal(hitText(scene, 20, end.y - 5, metrics), null)
})

check('multiline commands and terminal copies use full input without duplicates', () => {
  const command = 'first-command\n  second-command --argument "literal spaces"'
  const part: Extract<MessagePart, { type: 'tool' }> = {
    type: 'tool',
    tool: 'bash',
    state: 'done',
    title: 'first-command...',
    input: { command },
    output: `$ ${command}\nok\r\n\r\n[exit 1]\r\n`
  }
  const builder = new Builder(metrics, theme, { value: 0 }, t)
  const height = layoutTerminalBody(builder, part, 'multi', view(), 0, 0, 210)
  const block = sceneOf(builder, height).blocks[0]
  assert.equal(
    block.scrollRegions[0].copyActions?.find((action) => action.label === 'Copy command')?.text,
    command
  )
  assert.equal(
    block.scrollRegions[0].copyActions?.find((action) => action.label === 'Copy output')?.text,
    'ok\n[exit 1]'
  )
  assert.equal(
    block.selectable
      .map((row) => row.text)
      .join('')
      .split('second-command').length,
    2
  )
})

check('terminal cache updates streamed output and shrinks short completed results', () => {
  const part: Extract<MessagePart, { type: 'tool' }> = {
    type: 'tool',
    tool: 'bash',
    state: 'running',
    title: 'pwd'
  }
  const state = view()
  const render = (): Scene => {
    const builder = new Builder(metrics, theme, { value: 0 }, t)
    return sceneOf(builder, layoutTerminalBody(builder, part, 'stream', state, 0, 0, 300))
  }
  assert.equal(render().height, 37)
  part.output = '$ pwd\n' + 'line\r\n'.repeat(100)
  assert.equal(render().height, 289)
  state.scroll.set('stream', { left: 0, top: 500 })
  part.state = 'done'
  part.output = '$ pwd\nC:\\workspace\r\n'
  const scene = render()
  assert.equal(scene.height, 57)
  assert.equal(scene.blocks[0].scrollRegions[0].top, 0)
  assert.ok(scene.blocks[0].selectable.some((row) => row.text === 'C:\\workspace'))
})

check('stream publishing stays frame-coalesced with a non-resetting timer fallback', () => {
  const original = {
    raf: globalThis.requestAnimationFrame,
    cancel: globalThis.cancelAnimationFrame,
    timeout: globalThis.setTimeout,
    clear: globalThis.clearTimeout
  }
  const frames = new Map<number, FrameRequestCallback>()
  const timers = new Map<number, () => void>()
  let id = 0
  globalThis.requestAnimationFrame = (cb) => {
    frames.set(++id, cb)
    return id
  }
  globalThis.cancelAnimationFrame = (id) => {
    frames.delete(id)
  }
  globalThis.setTimeout = ((cb: () => void, delay: number) => {
    assert.equal(delay, 50)
    timers.set(++id, cb)
    return id
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((id: number) => {
    timers.delete(id)
  }) as unknown as typeof clearTimeout
  try {
    const output: (MessagePart[] | null)[] = []
    const publish = createStreamPublisher((parts) => output.push(parts))
    const first: MessagePart[] = [{ type: 'text', text: 'a' }]
    const latest: MessagePart[] = [{ type: 'text', text: 'abc' }]
    publish(first)
    publish(latest)
    assert.equal(frames.size, 1)
    assert.equal(timers.size, 1)
    assert.equal(output.length, 0)
    frames.values().next().value!(16)
    assert.deepEqual(output, [latest])
    assert.equal(timers.size, 0)
    publish(first)
    const timer = timers.values().next().value!
    publish(latest)
    assert.equal(timers.values().next().value, timer)
    timer()
    assert.equal(output[1], latest)
    assert.equal(frames.size, 0)
    publish(first)
    const cancelledFrame = frames.values().next().value!
    const cancelledTimer = timers.values().next().value!
    publish(null)
    cancelledFrame(50)
    cancelledTimer()
    assert.equal(output.length, 3)
    assert.equal(output[2], null)
    assert.equal(frames.size + timers.size, 0)
    publish(first)
    publish.cancel()
    assert.equal(frames.size + timers.size, 0)
  } finally {
    globalThis.requestAnimationFrame = original.raf
    globalThis.cancelAnimationFrame = original.cancel
    globalThis.setTimeout = original.timeout
    globalThis.clearTimeout = original.clear
  }
})

console.log(`DIFF/CANVAS MODEL OK - ${checks} checks passed`)
