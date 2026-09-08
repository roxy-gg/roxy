import './bridge'
import { StrictMode, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/geist/index.css'
import '@fontsource-variable/geist-mono/index.css'
import '../../src/renderer/src/assets/main.css'
import '../../src/renderer/src/i18n'
import { CanvasTranscript } from '../../src/renderer/src/canvas/CanvasTranscript'
import { AppContextMenu } from '../../src/renderer/src/components/AppContextMenu'
import { DiffViewer } from '../../src/renderer/src/components/diff/DiffViewer'
import { FIXTURES, STREAMING, LARGE_DIFF, HISTORY_FIXTURES, TERMINAL_FIXTURES } from './fixtures'
import { PerformanceHarness } from './PerformanceHarness'
import { AnimationHarness } from './AnimationHarness'
import { startMotion } from '../../src/renderer/src/lib/motion'

document.documentElement.dataset.platform = 'win32'
const stopMotion = startMotion()
import.meta.hot?.dispose(stopMotion)

function Harness(): JSX.Element {
  const [streaming, setStreaming] = useState(false)
  const [light, setLight] = useState(false)
  const [standalone, setStandalone] = useState(false)
  const [pin, setPin] = useState(0)
  const [session, setSession] = useState(0)
  const [loading, setLoading] = useState(false)
  const [composerTall, setComposerTall] = useState(false)
  const [longHistory, setLongHistory] = useState(false)
  const [addedPrompt, setAddedPrompt] = useState(false)
  const [terminalCards, setTerminalCards] = useState(false)
  const messages = useMemo(() => {
    const base = terminalCards ? TERMINAL_FIXTURES : longHistory ? HISTORY_FIXTURES : FIXTURES
    return addedPrompt
      ? [
          ...base,
          {
            ...FIXTURES[0],
            id: 'added-prompt',
            createdAt: Date.now(),
            content: 'One more improvement.',
            parts: [{ type: 'text' as const, text: 'One more improvement.' }]
          }
        ]
      : base
  }, [longHistory, addedPrompt, terminalCards])
  useEffect(() => {
    if (!loading) return
    const timer = setTimeout(() => setLoading(false), 180)
    return () => clearTimeout(timer)
  }, [loading])
  useEffect(() => {
    const root = document.documentElement
    root.dataset.appearance = light ? 'light' : 'dark'
    const colors: Record<string, string> = {
      '--color-bg': '#ffffff',
      '--color-surface': '#f7f7f8',
      '--color-surface-2': '#efeff1',
      '--color-elevated': '#ffffff',
      '--color-border': '#e2e2e5',
      '--color-border-strong': '#c9c9cf',
      '--color-text': '#1a1a1c',
      '--color-text-muted': '#5c5c66',
      '--color-text-subtle': '#73737d',
      '--color-accent': '#2563eb',
      '--color-success': '#177d3c',
      '--color-danger': '#c81e3d',
      '--color-white': '#18181b',
      '--color-black': '#ffffff'
    }
    for (const [name, color] of Object.entries(colors)) {
      if (light) root.style.setProperty(name, color)
      else root.style.removeProperty(name)
    }
  }, [light])
  return (
    <>
      <AppContextMenu />
      <div className="bar">
        <button id="stream" onClick={() => setStreaming(!streaming)}>
          Streaming: {String(streaming)}
        </button>
        <button id="theme" onClick={() => setLight(!light)}>
          Theme: {light ? 'light' : 'dark'}
        </button>
        <button
          id="top"
          onClick={() => document.querySelector('[data-canvas-surface]')?.scrollTo({ top: 0 })}
        >
          Top
        </button>
        <button id="tail" onClick={() => setPin(pin + 1)}>
          Tail
        </button>
        <button id="standalone" onClick={() => setStandalone(!standalone)}>
          Standalone diff
        </button>
        <button id="session" onClick={() => setSession(session + 1)}>
          Switch session
        </button>
        <button
          id="delayed-session"
          onClick={() => {
            setLoading(true)
            setSession(session + 1)
          }}
        >
          Load session
        </button>
        <button id="resize-composer" onClick={() => setComposerTall(!composerTall)}>
          Resize composer
        </button>
        <button id="long-history" onClick={() => setLongHistory(!longHistory)}>
          Long history
        </button>
        <button id="add-prompt" onClick={() => setAddedPrompt(true)}>
          Add prompt
        </button>
        <button id="terminal-cards" onClick={() => setTerminalCards(!terminalCards)}>
          Bash cards
        </button>
      </div>
      {standalone ? (
        <DiffViewer {...LARGE_DIFF} height={600} />
      ) : loading ? (
        <div data-history-loading className="min-h-0 flex-1" />
      ) : (
        <CanvasTranscript
          messages={messages}
          streaming={streaming ? STREAMING : null}
          chatId={`harness-${session}-${longHistory}-${terminalCards}`}
          pinSignal={pin}
          onCancelSubagent={(id) => window.__canvasTest.cancelled.push(id)}
          onCancelTool={(id) => window.__canvasTest.cancelled.push(id)}
        />
      )}
      <textarea
        id="composer"
        aria-label="Test composer"
        placeholder="Focus/copy regression target"
        style={{ height: composerTall ? 150 : 40, flexShrink: 0 }}
      />
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {new URLSearchParams(location.search).has('animation') ? (
      <AnimationHarness />
    ) : new URLSearchParams(location.search).has('performance') ? (
      <PerformanceHarness />
    ) : (
      <Harness />
    )}
  </StrictMode>
)
