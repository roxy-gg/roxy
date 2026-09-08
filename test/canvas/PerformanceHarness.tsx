import { useMemo, useState } from 'react'
import type { Message, MessagePart } from '../../src/shared/types'
import { CanvasTranscript } from '../../src/renderer/src/canvas/CanvasTranscript'

function transcript(session: string, turns: number, tools: number): Message[] {
  const messages: Message[] = []
  for (let turn = 0; turn < turns; turn++) {
    messages.push({
      id: `${session}-user-${turn}`,
      chatId: session,
      role: 'user',
      content: `Implement change ${turn}.`,
      parts: [{ type: 'text', text: `Implement change ${turn}.` }],
      createdAt: turn * 2
    })
    const parts: MessagePart[] = []
    for (let step = 0; step < tools; step++) {
      const id = `${turn}_${step}`
      parts.push({
        type: 'text',
        text:
          `### Investigation ${id}\n\n` +
          `This step checks **renderer_${id}** and preserves the existing behavior. `.repeat(14) +
          '\n\n```ts\n' +
          Array.from({ length: 15 }, (_, i) => `const value_${id}_${i} = ${i} + 1`).join('\n') +
          '\n```'
      })
      parts.push({
        type: 'tool',
        tool: 'task',
        title: `Review ${id}`,
        state: 'done',
        children: [
          {
            type: 'tool',
            tool: 'read',
            state: 'done',
            title: `src/component_${id}.ts`,
            output: `export const data_${id} = 'payload'\n`.repeat(100),
            diff: {
              path: 'source.ts',
              before: 'before\n'.repeat(100),
              after: 'after\n'.repeat(100)
            }
          }
        ],
        output: `Review ${id} finished.`
      })
    }
    messages.push({
      id: `${session}-assistant-${turn}`,
      chatId: session,
      role: 'assistant',
      content: parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n'),
      parts,
      createdAt: turn * 2 + 1
    })
  }
  return messages
}

export function PerformanceHarness(): JSX.Element {
  const fixtures = useMemo(() => {
    const scale = Number(new URLSearchParams(location.search).get('scale')) || 1
    return {
      main: transcript('perf-main', 100 * scale, 3),
      agent: transcript('perf-agent', 1, 300 * scale)
    }
  }, [])
  const [current, setCurrent] = useState<'main' | 'agent' | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [revision, setRevision] = useState(0)
  const choose = (session: 'main' | 'agent'): void => {
    const next = structuredClone(fixtures[session])
    ;(window as Window & { __switchStarted?: number }).__switchStarted = performance.now()
    setMessages(next)
    setCurrent(session)
    setRevision((n) => n + 1)
  }
  return (
    <>
      <div className="bar">
        <button id="perf-main" onClick={() => choose('main')}>
          Open main history
        </button>
        <button id="perf-agent" onClick={() => choose('agent')}>
          Open agent history
        </button>
        <button
          id="perf-empty"
          onClick={() => {
            setCurrent(null)
            setMessages([])
          }}
        >
          Close session
        </button>
        <button
          id="perf-update"
          onClick={() =>
            setMessages((old) =>
              old.map((message, index) =>
                index === old.length - 1
                  ? {
                      ...message,
                      parts: [
                        ...message.parts,
                        { type: 'text', text: 'A fresh final result, not the cached answer.' }
                      ]
                    }
                  : message
              )
            )
          }
        >
          Append result
        </button>
      </div>
      {current ? (
        <CanvasTranscript
          key={revision}
          messages={messages}
          streaming={null}
          chatId={`perf-${current}`}
          onCancelSubagent={() => {}}
          onCancelTool={() => {}}
        />
      ) : (
        <div className="flex-1" />
      )}
    </>
  )
}
