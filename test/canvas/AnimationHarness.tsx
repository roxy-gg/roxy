import { useEffect, useState } from 'react'
import type { Message, MessagePart } from '../../src/shared/types'
import { CanvasTranscript } from '../../src/renderer/src/canvas/CanvasTranscript'
import { HISTORY_FIXTURES, STREAMING } from './fixtures'
import { createStreamPublisher } from '../../src/renderer/src/lib/stream-publisher'
import { MotionSettings } from '../../src/renderer/src/components/MotionSettings'
import { useRoxyStore } from '../../src/renderer/src/lib/store'

declare global {
  interface Window {
    __motionTest: { produced: number; painted: number; started: number; finished: number }
  }
}
window.__motionTest = { produced: 0, painted: 0, started: 0, finished: 0 }
const EMPTY_HISTORY: Message[] = []

export function AnimationHarness(): JSX.Element {
  const setMotion = useRoxyStore((state) => state.setMotion)
  const [mode, setMode] = useState<'thinking' | 'tools' | 'text' | 'done'>('thinking')
  const [large, setLarge] = useState(false)
  const [streaming, setStreaming] = useState<MessagePart[] | null>([])
  useEffect(() => {
    const original = CanvasRenderingContext2D.prototype.fillText
    CanvasRenderingContext2D.prototype.fillText = function (text: string, ...args: number[]) {
      if (this.canvas.closest('[data-canvas-surface]')) {
        for (const match of text.matchAll(/token([0-9]+)/g))
          window.__motionTest.painted = Math.max(window.__motionTest.painted, Number(match[1]))
      }
      Reflect.apply(original, this, [text, ...args])
    }
    return () => {
      CanvasRenderingContext2D.prototype.fillText = original
    }
  }, [])
  useEffect(() => {
    const publish = createStreamPublisher(setStreaming)
    if (mode === 'thinking') {
      publish([])
      return publish.cancel
    }
    if (mode === 'tools') {
      publish(STREAMING)
      return publish.cancel
    }
    if (mode === 'done') {
      publish(null)
      return
    }
    let count = 0
    const started = performance.now()
    window.__motionTest = { produced: 0, painted: 0, started, finished: 0 }
    const timer = setInterval(() => {
      count++
      window.__motionTest.produced = count
      publish([
        {
          type: 'text',
          text: Array.from(
            { length: count },
            (_, i) => `token${String(i + 1).padStart(3, '0')}`
          ).join(' ')
        }
      ])
      if (count === 80) {
        clearInterval(timer)
        window.__motionTest.finished = performance.now()
      }
    }, 16)
    return () => {
      clearInterval(timer)
      publish.cancel()
    }
  }, [mode])
  return (
    <>
      <div className="bar">
        <button id="motion-thinking" onClick={() => setMode('thinking')}>
          Thinking
        </button>
        <button id="motion-tools" onClick={() => setMode('tools')}>
          Running tools
        </button>
        <button id="motion-text" onClick={() => setMode('text')}>
          Steady tokens
        </button>
        <button id="motion-done" onClick={() => setMode('done')}>
          Finish
        </button>
        <button id="motion-large" onClick={() => setLarge(!large)}>
          Large history
        </button>
      </div>
      <div className="px-4 pt-3">
        <MotionSettings onChange={setMotion} />
      </div>
      <span data-motion-css className="animate-spin" aria-hidden />
      <CanvasTranscript
        messages={large ? HISTORY_FIXTURES : EMPTY_HISTORY}
        streaming={streaming}
        chatId="motion-test"
        onCancelSubagent={() => {}}
        onCancelTool={() => {}}
      />
    </>
  )
}
