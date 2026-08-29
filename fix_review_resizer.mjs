import fs from 'node:fs'
let text = fs.readFileSync('src/renderer/src/routes/Chat.tsx', 'utf8')

// Import useEffect, useRef
if (!text.includes('useRef')) {
  text = text.replace(
    /import \{ useRoxyStore \} from '\.\.\/lib\/store'\r?\n/,
    "import { useRoxyStore } from '../lib/store'\nimport { useRef, useEffect } from 'react'\n"
  )
}

// Add state and resizer
text = text.replace(
  /export default function Chat\(\): JSX\.Element \{\r?\n\s*const activeChatId = useRoxyStore\(\(s\) => s\.activeChatId\)\r?\n\s*const reviewPaneOpen = useRoxyStore\(\(s\) => s\.reviewPaneOpen\)\r?\n\s*const setReviewPaneOpen = useRoxyStore\(\(s\) => s\.setReviewPaneOpen\)\r?\n/,
  `export default function Chat(): JSX.Element {
  const activeChatId = useRoxyStore((s) => s.activeChatId)
  const reviewPaneOpen = useRoxyStore((s) => s.reviewPaneOpen)
  const setReviewPaneOpen = useRoxyStore((s) => s.setReviewPaneOpen)
  const reviewPaneWidth = useRoxyStore((s) => s.reviewPaneWidth)
  const setReviewPaneWidth = useRoxyStore((s) => s.setReviewPaneWidth)

  const resizerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const resizer = resizerRef.current
    if (!resizer) return

    let startX = 0
    let startWidth = 0

    const onPointerDown = (e: PointerEvent): void => {
      startX = e.clientX
      startWidth = reviewPaneWidth
      document.body.style.cursor = 'col-resize'
      resizer.setPointerCapture(e.pointerId)
      resizer.addEventListener('pointermove', onPointerMove)
      resizer.addEventListener('pointerup', onPointerUp)
    }

    const onPointerMove = (e: PointerEvent): void => {
      // Delta is negative if moving left, which INCREASES right-pane width.
      const newWidth = Math.min(Math.max(200, startWidth - (e.clientX - startX)), 1200)
      setReviewPaneWidth(newWidth)
    }

    const onPointerUp = (e: PointerEvent): void => {
      document.body.style.cursor = ''
      resizer.releasePointerCapture(e.pointerId)
      resizer.removeEventListener('pointermove', onPointerMove)
      resizer.removeEventListener('pointerup', onPointerUp)
    }

    resizer.addEventListener('pointerdown', onPointerDown)
    return () => resizer.removeEventListener('pointerdown', onPointerDown)
  }, [reviewPaneWidth, setReviewPaneWidth])
`
)

text = text.replace(
  /\{reviewPaneOpen && activeChatId && \(\r?\n\s*<div className="w-\[480px\] shrink-0 border-l border-border bg-bg-app flex flex-col min-h-0">/,
  `{reviewPaneOpen && activeChatId && (
        <div 
          className="shrink-0 border-l border-border bg-bg-app flex flex-col min-h-0 relative"
          style={{ width: reviewPaneWidth }}
        >
          <div
            ref={resizerRef}
            className="absolute -left-1 top-0 bottom-0 w-2 cursor-col-resize z-10 transition-colors hover:bg-accent/30"
          />`
)

fs.writeFileSync('src/renderer/src/routes/Chat.tsx', text, 'utf8')
