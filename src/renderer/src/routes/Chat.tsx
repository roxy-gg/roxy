import { memo } from 'react'
import { Sidebar } from '../components/Sidebar'
import { ChatView } from '../components/ChatView'

function Chat(): JSX.Element {
  return (
    <div className="flex h-full w-full">
      <Sidebar />
      <ChatView />
    </div>
  )
}

/* App keeps this route mounted behind secondary screens. Without memo, every
   location change would still walk the expensive transcript even though the
   component instance survived; Chat has no props, so only its own store
   subscriptions should make it render. */
export default memo(Chat)
