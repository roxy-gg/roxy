import type { MouseEvent as ReactMouseEvent } from 'react'
import { X } from 'lucide-react'
import { Sidebar } from '../components/Sidebar'
import { ChatView } from '../components/ChatView'
import { ReviewPane } from '../review/ReviewPane'
import { useRoxyStore } from '../lib/store'

/** How narrow/wide the review pane may be dragged, in px. */
const MIN_REVIEW_WIDTH = 360
const MAX_REVIEW_WIDTH = 1200

export default function Chat(): JSX.Element {
  const activeChatId = useRoxyStore((s) => s.activeChatId)
  const reviewPaneOpen = useRoxyStore((s) => s.reviewPaneOpen)
  const setReviewPaneOpen = useRoxyStore((s) => s.setReviewPaneOpen)
  const reviewPaneWidth = useRoxyStore((s) => s.reviewPaneWidth)
  const setReviewPaneWidth = useRoxyStore((s) => s.setReviewPaneWidth)

  const startResize = (e: ReactMouseEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = reviewPaneWidth

    // The pane is anchored right, so dragging left (a negative delta) widens it.
    const onMove = (ev: MouseEvent): void => {
      const next = startWidth - (ev.clientX - startX)
      setReviewPaneWidth(Math.min(Math.max(MIN_REVIEW_WIDTH, next), MAX_REVIEW_WIDTH))
    }
    const onUp = (): void => {
      document.body.style.cursor = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }

    document.body.style.cursor = 'col-resize'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div className="flex h-full w-full">
      <Sidebar />
      <ChatView />
      {reviewPaneOpen && activeChatId && (
        <div
          className="relative flex min-h-0 shrink-0 flex-col border-l border-border bg-bg-app"
          style={{ width: reviewPaneWidth }}
        >
          <div
            onMouseDown={startResize}
            className="absolute -left-1 bottom-0 top-0 z-10 w-2 cursor-col-resize transition-colors hover:bg-accent/30"
          />
          {/* The window controls float over this corner, so the pane starts
              below them — level with "New project" in the sidebar. */}
          <div className="titlebar h-[56px] shrink-0" />
          <ReviewPane
            sessionId={activeChatId}
            className="min-h-0 flex-1"
            action={
              <button
                onClick={() => setReviewPaneOpen(false)}
                title="Close"
                className="press-scale flex h-6 w-6 items-center justify-center sq sq-lg rounded-lg text-text-muted hover:bg-white/5 hover:text-text"
              >
                <X className="h-4 w-4" />
              </button>
            }
          />
        </div>
      )}
    </div>
  )
}
