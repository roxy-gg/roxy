/**
 * Harness entry — mounts the real CanvasTranscript against the fixtures.
 *
 * Deliberately imports the SHIPPING component rather than a copy, so what you
 * look at here is what the app draws.
 *
 * It also self-checks. A canvas has no DOM to inspect, so "did it render?"
 * cannot be answered by reading the tree — the harness samples the backing
 * bitmap after a few frames and reports coverage, distinct colours and the
 * scene's own block/line counts into `#report` (and the console). That turns a
 * blank canvas from something you have to notice by eye into a failed check.
 */

import { StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/geist/index.css'
import '@fontsource-variable/geist-mono/index.css'
import '../../src/renderer/src/assets/main.css'
// Initialises i18next before the component renders — the transcript resolves
// every user-facing string through `t`, so without this it would draw raw keys.
import '../../src/renderer/src/i18n'
import { CanvasTranscript } from '../../src/renderer/src/canvas/CanvasTranscript'
import { installSquircle } from '../../src/renderer/src/lib/squircle'
import { FIXTURES, STREAMING } from './fixtures'

document.documentElement.dataset.platform = 'win32'
installSquircle()
installDump()

/**
 * Is requestAnimationFrame actually running?
 *
 * A page that is not being composited (a background tab, an offscreen or
 * headless window) never fires rAF, and the renderer's whole frame loop hangs
 * off it. Distinguishing "the renderer is broken" from "this page is not being
 * drawn" is otherwise guesswork, so the harness measures it directly.
 */
let rafTicks = 0
const countRaf = (): void => {
  rafTicks++
  requestAnimationFrame(countRaf)
}
requestAnimationFrame(countRaf)

/** Sample the canvas and describe what actually got painted. */
function inspect(): string {
  const canvas = document.querySelector('canvas')
  if (!canvas) return 'FAIL: no canvas'
  const ctx = canvas.getContext('2d')
  if (!ctx) return 'FAIL: no context'
  if (canvas.width === 0 || canvas.height === 0) {
    return `FAIL: canvas is ${canvas.width}x${canvas.height}`
  }
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const colors = new Set<number>()
  let lit = 0
  // The page background; anything else counts as drawn content.
  const bg = `${data[0]},${data[1]},${data[2]}`
  for (let i = 0; i < data.length; i += 4) {
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]
    colors.add(key)
    if (`${data[i]},${data[i + 1]},${data[i + 2]}` !== bg) lit++
  }
  const coverage = ((lit / (data.length / 4)) * 100).toFixed(1)
  // The corner pixel is the pane background: the fastest way to tell a theme
  // switch actually reached the canvas rather than only the surrounding DOM.
  const corner = `rgb(${data[0]},${data[1]},${data[2]})`
  const probe = (window as Window & { __canvasTranscript?: Probe }).__canvasTranscript
  const scene = probe?.scene()
  const size = probe?.size()
  const lines = scene?.blocks.reduce((n, b) => n + b.selectable.length, 0) ?? 0
  const regions = scene?.blocks.reduce((n, b) => n + b.regions.length, 0) ?? 0
  const ok = colors.size > 20 && lit > 5000
  const scroller = document.querySelector('.overflow-y-auto') as HTMLElement | null
  // Every child's contribution to scrollHeight, so a mismatch between the scene
  // and the scroll range points at the element responsible instead of being a
  // number to stare at.
  const children = scroller
    ? Array.from(scroller.children)
        .map((el) => {
          const r = (el as HTMLElement).getBoundingClientRect()
          return `${el.tagName.toLowerCase()}:${Math.round(r.height)}`
        })
        .join(' ')
    : ''
  return [
    ok ? 'PASS' : 'FAIL',
    `raf ${rafTicks}`,
    `canvas ${canvas.width}x${canvas.height}`,
    `size ${size ? `${Math.round(size.width)}x${Math.round(size.height)}` : '?'}`,
    `scrollTop ${Math.round(scroller?.scrollTop ?? -1)}`,
    `scrollH ${Math.round(scroller?.scrollHeight ?? -1)}`,
    `clientH ${Math.round(scroller?.clientHeight ?? -1)}`,
    `kids[${children}]`,
    `frames ${probe?.debug.frames ?? '?'}`,
    `layouts ${probe?.debug.layouts ?? '?'}`,
    `blocks ${scene?.blocks.length ?? '?'}`,
    `sceneH ${Math.round(scene?.height ?? 0)}`,
    `lines ${lines}`,
    `regions ${regions}`,
    `coverage ${coverage}%`,
    `bg ${corner}`,
    `${colors.size} colors`
  ].join(' · ')
}

/**
 * An ASCII rendering of the canvas.
 *
 * Coverage percentages prove that SOMETHING was drawn; they do not prove it was
 * drawn in the right place. Downsampling the bitmap to a character grid shows
 * the actual composition — where the cards are, whether text landed inside them,
 * whether anything overflowed the column — in a form that survives an
 * environment with no screenshots.
 */
function asciiPreview(cols = 100, rows = 44): string {
  const canvas = document.querySelector('canvas')
  const ctx = canvas?.getContext('2d')
  if (!canvas || !ctx) return ''
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const cellW = canvas.width / cols
  const cellH = canvas.height / rows
  const ramp = ' .:-=+*#%@'
  const lines: string[] = []
  for (let r = 0; r < rows; r++) {
    let line = ''
    for (let c = 0; c < cols; c++) {
      // Average luminance over the cell.
      let total = 0
      let count = 0
      const x0 = Math.floor(c * cellW)
      const x1 = Math.min(canvas.width, Math.ceil((c + 1) * cellW))
      const y0 = Math.floor(r * cellH)
      const y1 = Math.min(canvas.height, Math.ceil((r + 1) * cellH))
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          const i = (y * canvas.width + x) * 4
          total += (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000
          count++
        }
      }
      const mean = count > 0 ? total / count : 0
      // Scaled against a dark UI: most of the range sits under 64.
      const step = Math.min(ramp.length - 1, Math.floor((mean / 70) * (ramp.length - 1)))
      line += ramp[step]
    }
    lines.push(line)
  }
  return lines.join('\n')
}

interface Probe {
  debug: { frames: number; layouts: number }
  scene: () => {
    blocks: {
      selectable: unknown[]
      regions: { x: number; y: number; w: number; h: number; action: { type: string } }[]
    }[]
    height: number
  }
  size: () => { width: number; height: number }
}

/**
 * Dump the canvas as a PNG data URL.
 *
 * The point of a harness is to be looked at, and a headless browser cannot take
 * a screenshot of a page it is not compositing — but the BITMAP is real and can
 * be read back regardless. `window.__dumpCanvas()` returns it.
 */
function installDump(): void {
  ;(window as Window & { __dumpCanvas?: () => string }).__dumpCanvas = () => {
    const canvas = document.querySelector('canvas')
    return canvas ? canvas.toDataURL('image/png') : ''
  }
}

function Harness(): JSX.Element {
  const [streaming, setStreaming] = useState(true)
  const [light, setLight] = useState(false)
  const [pin, setPin] = useState(0)
  const [report, setReport] = useState('checking…')
  const timer = useRef(0)

  // Re-check a beat after every change, so toggling streaming or the theme
  // re-validates rather than leaving a stale PASS on screen.
  useEffect(() => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      const result = inspect()
      setReport(result)
      console.log('[canvas harness]', result)
      // Mirror the bitmap into an <img>. In a browser that is not compositing
      // the page (no rAF, no screenshots) this is the only way to actually SEE
      // what was drawn — the image survives where a screenshot does not.
      const dump = (window as Window & { __dumpCanvas?: () => string }).__dumpCanvas?.()
      const mirror = document.getElementById('mirror') as HTMLImageElement | null
      if (mirror && dump) mirror.src = dump
      const preview = document.getElementById('ascii')
      if (preview) preview.textContent = asciiPreview()
    }, 600)
    return () => window.clearTimeout(timer.current)
  }, [streaming, light, pin])

  const toggleTheme = (): void => {
    const next = !light
    setLight(next)
    const root = document.documentElement
    root.dataset.appearance = next ? 'light' : 'dark'
    // The same tokens lib/theme.ts writes, so the canvas reads a real switch.
    const vars: Record<string, string> = next
      ? {
          '--color-bg': '#ffffff',
          '--color-surface': '#f7f7f8',
          '--color-surface-2': '#efeff1',
          '--color-elevated': '#ffffff',
          '--color-border': '#e2e2e5',
          '--color-border-strong': '#c9c9cf',
          '--color-text': '#1a1a1c',
          '--color-text-muted': '#5c5c66',
          '--color-text-subtle': '#8a8a94',
          '--color-accent': '#2563eb',
          '--color-success': '#177d3c',
          '--color-danger': '#c81e3d',
          '--color-white': '#18181b',
          '--color-black': '#ffffff'
        }
      : {}
    for (const name of [
      '--color-bg',
      '--color-surface',
      '--color-surface-2',
      '--color-elevated',
      '--color-border',
      '--color-border-strong',
      '--color-text',
      '--color-text-muted',
      '--color-text-subtle',
      '--color-accent',
      '--color-success',
      '--color-danger',
      '--color-white',
      '--color-black'
    ]) {
      if (vars[name]) root.style.setProperty(name, vars[name])
      else root.style.removeProperty(name)
    }
  }

  return (
    <>
      <div className="bar">
        <button onClick={() => setStreaming((s) => !s)}>
          streaming: {streaming ? 'on' : 'off'}
        </button>
        <button onClick={toggleTheme}>theme: {light ? 'light' : 'dark'}</button>
        <button onClick={() => setPin((n) => n + 1)}>pin to bottom</button>
        <button
          id="top"
          onClick={() => {
            const el = document.querySelector('.overflow-y-auto')
            el?.scrollTo({ top: 0 })
            // Re-preview after the scroll handler has painted.
            window.setTimeout(() => {
              const preview = document.getElementById('ascii')
              if (preview) preview.textContent = asciiPreview()
              setReport(inspect())
            }, 120)
          }}
        >
          scroll top
        </button>
        <button
          id="expand"
          onClick={() => {
            // Click the first tool card's header through the real hit path, so
            // this exercises hitTest → toggle → relayout rather than reaching
            // into the component's state.
            const probe = (window as Window & { __canvasTranscript?: Probe }).__canvasTranscript
            const scene = probe?.scene()
            const region = scene?.blocks
              .flatMap((b) => b.regions)
              .find((r) => r.action.type === 'toggle')
            const el = document.querySelector('.overflow-y-auto') as HTMLElement | null
            if (!region || !el) return
            const rect = el.getBoundingClientRect()
            const clientX = rect.left + region.x + region.w / 2
            const clientY = rect.top + region.y - el.scrollTop + region.h / 2
            for (const type of ['pointerdown', 'pointerup']) {
              el.dispatchEvent(
                new PointerEvent(type, {
                  clientX,
                  clientY,
                  bubbles: true,
                  button: 0,
                  buttons: type === 'pointerdown' ? 1 : 0,
                  // React's synthetic pointer events need a real pointer id and
                  // `isPrimary`, or the handler is never invoked.
                  pointerId: 1,
                  pointerType: 'mouse',
                  isPrimary: true
                })
              )
            }
            window.setTimeout(() => {
              const preview = document.getElementById('ascii')
              if (preview) preview.textContent = asciiPreview()
              setReport(inspect())
            }, 150)
          }}
        >
          expand first card
        </button>
        <span id="report">{report}</span>
        <span>drag to select · ⌘/Ctrl+C to copy · click a card to expand</span>
      </div>
      <CanvasTranscript
        messages={FIXTURES}
        streaming={streaming ? STREAMING : null}
        chatId="harness"
        pinSignal={pin}
        onCancelSubagent={(id) => console.log('cancel subagent', id)}
        onCancelTool={(id) => console.log('cancel tool', id)}
      />
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Harness />
  </StrictMode>
)
