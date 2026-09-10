import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent
} from 'react'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Sidebar } from '../components/Sidebar'
import { ChatView } from '../components/ChatView'
import { ChangesChip } from '../components/ChangesChip'
import { ReviewPane } from '../review/ReviewPane'
import { useRoxyStore } from '../lib/store'

const MIN_REVIEW_WIDTH = 360
const MAX_REVIEW_WIDTH = 1000
const REVIEW_SIBLING_MIN_WIDTH = 840

function Chat(): JSX.Element {
  const { t } = useTranslation()
  const activeChatId = useRoxyStore((state) => state.activeChatId)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [reviewWidth, setReviewWidth] = useState(520)
  const [contentWidth, setContentWidth] = useState(0)
  const contentRef = useRef<HTMLDivElement>(null)
  const reviewOverlay = contentWidth < REVIEW_SIBLING_MIN_WIDTH
  // Deliberately subscribe only to the active id. Transcript activity updates
  // chat rows frequently; reading the stable owner from the snapshot keeps
  // those updates from walking the ChatView subtree.
  const reviewSessionId = useMemo(() => {
    const chats = useRoxyStore.getState().chats
    const activeChat = chats.find((chat) => chat.id === activeChatId) ?? null
    const owner =
      activeChat?.kind === 'sub' && activeChat.parentId
        ? (chats.find((chat) => chat.id === activeChat.parentId) ?? null)
        : activeChat
    return owner?.workspacePath ? owner.id : null
  }, [activeChatId])

  useEffect(() => setReviewOpen(false), [activeChatId])

  useEffect(() => {
    const element = contentRef.current
    if (!element) return
    const measure = (): void => setContentWidth(element.getBoundingClientRect().width)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const toggleReview = useCallback(() => setReviewOpen((open) => !open), [])
  const startResize = (event: ReactMouseEvent): void => {
    if (reviewOverlay) return
    event.preventDefault()
    const startX = event.clientX
    const startWidth = reviewWidth
    const onMove = (move: MouseEvent): void => {
      const viewportMax = Math.max(MIN_REVIEW_WIDTH, contentWidth - 320)
      const next = startWidth - (move.clientX - startX)
      setReviewWidth(Math.min(Math.max(MIN_REVIEW_WIDTH, next), MAX_REVIEW_WIDTH, viewportMax))
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
      <div ref={contentRef} className="relative flex min-w-0 flex-1">
        <ChatView
          headerActions={
            <ChangesChip sessionId={reviewSessionId} open={reviewOpen} onToggle={toggleReview} />
          }
        />
        {reviewOpen && reviewSessionId && (
          <aside
            className={
              reviewOverlay
                ? 'absolute inset-y-0 right-0 z-30 flex min-h-0 flex-col border-l border-border bg-bg-app shadow-2xl'
                : 'relative flex min-h-0 shrink-0 flex-col border-l border-border bg-bg-app'
            }
            style={{
              width: reviewOverlay
                ? `min(100%, ${reviewWidth}px)`
                : Math.min(reviewWidth, Math.max(MIN_REVIEW_WIDTH, contentWidth - 320))
            }}
          >
            {!reviewOverlay && (
              <div
                onMouseDown={startResize}
                className="absolute -left-1 bottom-0 top-0 z-10 w-2 cursor-col-resize transition-colors hover:bg-accent/30"
              />
            )}
            <div className="titlebar h-12 shrink-0" />
            <ReviewPane
              sessionId={reviewSessionId}
              className="min-h-0 flex-1"
              action={
                <button
                  type="button"
                  onClick={() => setReviewOpen(false)}
                  title={t('common.close')}
                  className="press-scale flex h-7 w-7 items-center justify-center rounded-lg text-text-muted hover:bg-surface-2 hover:text-text"
                >
                  <X className="h-4 w-4" />
                </button>
              }
            />
          </aside>
        )}
      </div>
    </div>
  )
}

/* App keeps this route mounted behind secondary screens. Without memo, every
   location change would still walk the expensive transcript even though the
   component instance survived; Chat has no props, so only its own store
   subscriptions should make it render. */
export default memo(Chat)
