import { Sidebar } from '../components/Sidebar'
import { ChatView } from '../components/ChatView'
import { ReviewPane } from '../review/ReviewPane'
import { useRoxyStore } from '../lib/store'


import { X } from 'lucide-react'

export default function Chat(): JSX.Element {
  const activeChatId = useRoxyStore((s) => s.activeChatId)
  const reviewPaneOpen = useRoxyStore((s) => s.reviewPaneOpen)
  const setReviewPaneOpen = useRoxyStore((s) => s.setReviewPaneOpen)

  return (
    <div className="flex h-full w-full">
      <Sidebar />
      <ChatView />
      {reviewPaneOpen && activeChatId && (
        <div className="w-[480px] shrink-0 border-l border-border bg-bg-app flex flex-col min-h-0 titlebar reserve-controls-right">
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
