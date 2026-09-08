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
import { hitTest, hitText, selectionText } from '../../src/renderer/src/canvas/renderer'
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
  const scene = layoutTranscript({ ...longInput(longMessages), streaming: [] }, new BlockCache())
  assert.ok(scene.blocks.at(-1)!.animated)
  assert.ok(JSON.stringify(scene.blocks.at(-1)!.nodes).includes('braille'))
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

check('bot replies use a round Facehash and username in both transcript layouts', () => {
  const own = {
    ...FIXTURES[1],
    id: 'own-bot-reply',
    parts: [{ type: 'text' as const, text: 'Ready.' }]
  }
  const attributed = { ...own, id: 'attributed-reply', botId: 'bot-1', botUsername: 'old-name' }
  const bot = {
    id: 'bot-1',
    username: 'helper',
    instructions: '',
    chatId: 'bot-chat',
    createdAt: 0
  }
  for (const messages of [[own], [attributed], [...longMessages, attributed]]) {
    const scene = layoutTranscript(
      {
        ...longInput(messages),
        botUsername: 'helper',
        bots: [bot],
        botAvatar: (name) => `data:image/svg+xml,${name}`
      },
      new BlockCache()
    )
    const last = scene.blocks.at(-1)!
    const nodes = JSON.stringify(last.nodes)
    assert.ok(nodes.includes('@helper'))
    assert.ok(nodes.includes('data:image/svg+xml,'))
    assert.ok(!nodes.includes('__roxy__'))
    assert.ok(!nodes.includes('@old-name'))
  }
  const live = layoutTranscript(
    { ...longInput(longMessages), streaming: [], botUsername: 'helper' },
    new BlockCache()
  )
  assert.ok(JSON.stringify(live.blocks.at(-1)!.nodes).includes('@helper'))
})

console.log(`DIFF/CANVAS MODEL OK - ${checks} checks passed`)
