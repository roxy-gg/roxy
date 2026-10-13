import { memo, type CSSProperties } from 'react'
import { useBackground } from '../lib/background'
import { Sidebar } from '../components/Sidebar'
import { ChatView } from '../components/ChatView'
import { BackgroundMedia } from '../components/BackgroundMedia'

function Chat(): JSX.Element {
  const background = useBackground()
  const shared = !!background.rendered && background.settings.sidebarStyle !== 'default'
  return (
    <div
      className="relative isolate flex h-full w-full"
      data-sidebar-style={shared ? background.settings.sidebarStyle : undefined}
      style={{ '--sidebar-opacity': `${background.settings.sidebarOpacity}%` } as CSSProperties}
    >
      {shared && (
        <div className="chat-wallpaper-shared">
          <BackgroundMedia effect={background.settings.effect} />
          {background.settings.effect === 'haze' && <div className="chat-wallpaper-haze" />}
        </div>
      )}
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
