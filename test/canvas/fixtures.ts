/**
 * Fixture transcript for the canvas harness.
 *
 * Every branch the renderer can take is represented here, because the ones that
 * are not are the ones that ship broken: each tool card shape, an error state, a
 * diff, ANSI output with an exit footer, a nested subagent transcript, an image,
 * and markdown exercising headings, lists, tables, quotes and fenced code.
 */

import type { Message, MessagePart } from '../../src/shared/types'

const at = (n: number): number => 1_700_000_000_000 + n * 1000

const message = (
  id: string,
  role: 'user' | 'assistant',
  parts: MessagePart[],
  order: number
): Message => ({
  id,
  chatId: 'harness',
  role,
  content: parts.map((p) => (p.type === 'text' ? p.text : '')).join(''),
  parts,
  createdAt: at(order)
})

const BEFORE = `export function greet(name: string): string {
  // A greeting.
  const prefix = 'Hello'
  return prefix + ', ' + name
}

export const VERSION = 1
`

const AFTER = `export function greet(name: string, punctuation = '!'): string {
  // A greeting, now with punctuation.
  const prefix = 'Hello'
  return \`\${prefix}, \${name}\${punctuation}\`
}

export const VERSION = 2
`

const ANSI_OUTPUT = `$ npm run typecheck
\u001b[2m> roxy@0.0.94 typecheck\u001b[0m
\u001b[2m> tsc --noEmit\u001b[0m

\u001b[31msrc/app.ts\u001b[0m:\u001b[33m12\u001b[0m:\u001b[33m5\u001b[0m - \u001b[31merror\u001b[0m\u001b[90m TS2322: \u001b[0mType 'string' is not assignable to type 'number'.

\u001b[32m✓\u001b[0m 1 error found
[exit 1]`

const MARKDOWN = `## What I changed

I replaced the DOM transcript with a **canvas renderer**. The important part is
that layout is now *retained* — see \`src/renderer/src/canvas/\` for the pieces.

### Why

| Concern | Before | After |
| --- | --- | ---: |
| Cost model | grows with history | grows with viewport |
| Message cap | 30 | none |
| Streaming | re-parses every block | re-lays out one turn |

1. Layout runs only when content changes
2. Paint touches only visible blocks
3. Settled messages are cached by reference

> A settled message's parts array is a stable reference, so identity alone
> distinguishes "reuse this" from "re-lay this out".

\`\`\`ts
export function layoutTranscript(input: LayoutInput): Scene {
  const column = Math.min(768, input.width - 32)
  // Blocks carry absolute geometry in transcript space.
  return { blocks, height, width: input.width }
}
\`\`\`

- Nested list support
  - second level
  - with ~~strikethrough~~ and a [link](https://example.com)
- And a very long line that has to wrap somewhere sensible rather than running off the right-hand edge of the column and disappearing entirely

---

Done. See https://github.com/roxy-gg/roxy for the rest.`

const NESTED: MessagePart[] = [
  { type: 'reasoning', text: 'I should search for the layout entry point first.' },
  {
    type: 'tool',
    tool: 'grep',
    state: 'done',
    callId: 'n1',
    title: 'layoutTranscript',
    output:
      'src/renderer/src/canvas/transcript.ts:57\nsrc/renderer/src/canvas/CanvasTranscript.tsx:212'
  },
  {
    type: 'tool',
    tool: 'read',
    state: 'done',
    callId: 'n2',
    title: 'transcript.ts',
    output: BEFORE
  },
  { type: 'text', text: 'Found it — the entry point is `layoutTranscript`.' }
]

const longLines = Array.from(
  { length: 160 },
  (_, i) => `export const item${i} = '${'value'.repeat(i === 40 ? 70 : 1)}'`
)
export const LARGE_DIFF = {
  path: 'src/catalog.ts',
  before: longLines.join('\n') + '\n',
  after: longLines
    .map((line, i) => (i === 5 || i === 80 || i === 159 ? line.replace('const', 'let') : line))
    .join('\n')
}

export const FIXTURES: Message[] = [
  message('m1', 'user', [{ type: 'text', text: 'Replace the DOM transcript with canvas.' }], 1),
  message(
    'm2',
    'assistant',
    [
      {
        type: 'text',
        text: 'Visit [the docs](https://example.com/docs) and [`API`](https://example.com/api).\n\nhttps://example.com/guide'
      },
      { type: 'reasoning', text: 'The transcript is the hot path, so layout has to be cached.' },
      { type: 'text', text: "I'll start by reading the current renderer." },
      {
        type: 'tool',
        tool: 'read',
        state: 'done',
        callId: 'c1',
        title: 'src/greet.ts',
        output: BEFORE
      },
      {
        type: 'tool',
        tool: 'edit',
        state: 'done',
        callId: 'c2',
        title: 'src/greet.ts',
        output: 'ok',
        diff: { path: 'src/greet.ts', before: BEFORE, after: AFTER }
      },
      {
        type: 'tool',
        tool: 'edit',
        state: 'done',
        callId: 'large',
        title: LARGE_DIFF.path,
        diff: LARGE_DIFF,
        output: 'updated'
      },
      {
        type: 'tool',
        tool: 'bash',
        state: 'error',
        callId: 'c3',
        title: 'npm run typecheck',
        output: ANSI_OUTPUT
      },
      {
        type: 'tool',
        tool: 'glob',
        state: 'done',
        callId: 'c4',
        title: 'src/**/*.ts',
        output: 'src/a.ts\nsrc/b.ts\nsrc/c.ts'
      },
      {
        type: 'tool',
        tool: 'webfetch',
        state: 'done',
        callId: 'c5',
        title: 'https://example.com',
        output: '# Example Domain\n\nThis domain is for use in documentation.'
      },
      {
        type: 'tool',
        tool: 'mcp__main__deepwiki__ask_question',
        state: 'done',
        callId: 'c6',
        title: 'canvas rendering',
        output: 'Canvas is an immediate-mode API.'
      },
      {
        type: 'tool',
        tool: 'task',
        state: 'done',
        callId: 'c7',
        title: 'Find the layout entry point',
        subChatId: 'sub-1',
        children: [
          ...NESTED,
          {
            type: 'tool',
            tool: 'edit',
            state: 'done',
            callId: 'nested-diff',
            title: LARGE_DIFF.path,
            diff: LARGE_DIFF
          }
        ],
        output: 'The entry point is `layoutTranscript` in transcript.ts:57.'
      },
      { type: 'text', text: MARKDOWN }
    ],
    2
  ),
  message(
    'm3',
    'user',
    [
      {
        type: 'image',
        name: 'pixel.png',
        mediaType: 'image/png',
        dataUrl:
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP3sAAAAASUVORK5CYII='
      },
      { type: 'text', text: 'Now check the diff view and keep going.' }
    ],
    3
  )
]

/** A live turn — spinners, the activity strip, a running card. */
export const STREAMING: MessagePart[] = [
  { type: 'reasoning', text: 'Running the build to see what breaks.' },
  {
    type: 'tool',
    tool: 'bash',
    state: 'running',
    callId: 'live-1',
    cancellable: true,
    title: 'npm run build',
    output:
      '$ npm run build\n\u001b[2mvite v5.4.21 building for production...\u001b[0m\ntransforming...'
  },
  {
    type: 'tool',
    tool: 'task',
    state: 'running',
    callId: 'live-2',
    subChatId: 'sub-2',
    title: 'Audit the renderer',
    children: [
      { type: 'reasoning', text: 'Checking paint order.' },
      {
        type: 'tool',
        tool: 'read',
        state: 'done',
        callId: 'lz',
        title: 'renderer.ts',
        output: 'ok'
      },
      { type: 'tool', tool: 'grep', state: 'running', callId: 'lz2', title: 'paintNode' }
    ]
  }
]

/** Enough prompts to exercise a bounded rail rather than mounting the entire index. */
export const HISTORY_FIXTURES: Message[] = Array.from({ length: 80 }, (_, index) => {
  const text =
    index === 10
      ? ''
      : index === 11
        ? 'Check this multiline request.\n\n' + 'Keep the layout readable. '.repeat(40)
        : index === 79
          ? 'Wrap up the canvas improvements.'
          : `Question ${index + 1}: Make the chat experience feel more polished.`
  const parts: MessagePart[] = text ? [{ type: 'text', text }] : [FIXTURES[2].parts[0]]
  return [
    {
      ...message(`history-user-${index}`, 'user', parts, index * 2),
      createdAt: Date.now() - (79 - index) * 60_000
    },
    message(
      `history-assistant-${index}`,
      'assistant',
      [
        {
          type: 'text',
          text:
            'I will keep the change focused and check the result.\n\n' +
            'A considered response with enough detail to fill the conversation. '.repeat(3)
        }
      ],
      index * 2 + 1
    )
  ]
}).flat()
