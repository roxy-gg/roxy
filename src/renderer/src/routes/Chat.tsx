import { memo } from 'react'
import { Sidebar } from '../components/Sidebar'
import { ChatView } from '../components/ChatView'
import { BackgroundFrame } from '../components/BackgroundFrame'

function Chat(): JSX.Element {
  return (
    <BackgroundFrame>
      <Sidebar />
      <ChatView />
    </BackgroundFrame>
  )
}

/* App keeps this route mounted behind secondary screens. Without memo, every
   location change would still walk the expensive transcript even though the
   component instance survived; Chat has no props, so only its own store
   subscriptions should make it render. */
export default memo(Chat)
