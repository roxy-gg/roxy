import type { CSSProperties, ReactNode } from 'react'
import { useBackground } from '../lib/background'
import { BackgroundMedia } from './BackgroundMedia'

export function BackgroundFrame({
  className = '',
  children
}: {
  className?: string
  children: ReactNode
}): JSX.Element {
  const background = useBackground()
  const shared = !!background.rendered && background.settings.sidebarStyle !== 'default'
  return (
    <div
      className={`relative isolate flex h-full w-full ${className}`}
      data-sidebar-style={shared ? background.settings.sidebarStyle : undefined}
      style={{ '--sidebar-opacity': `${background.settings.sidebarOpacity}%` } as CSSProperties}
    >
      {shared && (
        <div className="chat-wallpaper-shared" aria-hidden="true">
          <BackgroundMedia effect={background.settings.effect} />
          {background.settings.effect === 'haze' && <div className="chat-wallpaper-haze" />}
        </div>
      )}
      {children}
    </div>
  )
}
