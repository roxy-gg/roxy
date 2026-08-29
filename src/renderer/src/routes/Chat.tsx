import { Sidebar } from '../components/Sidebar'
import { ChatView } from '../components/ChatView'
import { ReviewPane } from '../review/ReviewPane'
import { useRoxyStore } from '../lib/store'
import type { MouseEvent as ReactMouseEvent } from 'react'


import { X } from 'lucide-react'

export default function Chat(): JSX.Element {
  const activeChatId = useRoxyStore((s) => s.activeChatId)
  const reviewPaneOpen = useRoxyStore((s) => s.reviewPaneOpen)
  const setReviewPaneOpen = useRoxyStore((s) => s.setReviewPaneOpen)
  const reviewPaneWidth = useRoxyStore((s) => s.reviewPaneWidth)
  const setReviewPaneWidth = useRoxyStore((s) => s.setReviewPaneWidth)

  
  const startResize = (e: ReactMouseEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startW = reviewPaneWidth
    
    // Moving mouse left (negative delta) means panel gets WIDER since it's on the right.
    const onMove = (ev: MouseEvent): void => {
      const delta = ev.clientX - startX
      const newWidth = Math.min(Math.max(360, startW - delta), 1200)
      setReviewPaneWidth(newWidth)
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
          className="shrink-0 border-l border-border bg-bg-app flex flex-col min-h-0 relative"
          style={{ width: reviewPaneWidth }}
        >
          <div
            onMouseDown={startResize}
            className="absolute -left-1 top-0 bottom-0 w-2 cursor-col-resize z-10 transition-colors hover:bg-accent/30"
          />
          <ReviewPane
            sessionId={activeChatId}
            className="flex-1"
            action={
              <button
                onClick={() => setReviewPaneOpen(false)}
                title="Close review pane"
                className="[-webkit-app-region:no-drag] press-scale sq sq-sm rounded-md text-text-muted hover:bg-white/5 hover:text-text transition-colors"
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
