import { backgroundOpacity, type BackgroundSettings } from '@shared/background'
import { useBackground } from '../lib/background'
import { BackgroundMedia } from './BackgroundMedia'

export function ChatBackground({
  empty,
  settings: preview,
  fullStrength = false
}: {
  empty: boolean
  settings?: BackgroundSettings
  fullStrength?: boolean
}): JSX.Element | null {
  const background = useBackground()
  const settings = preview ?? background.settings
  const opacity = fullStrength ? 1 : backgroundOpacity(settings, empty)
  if (!background.rendered || opacity === 0) return null
  return (
    <div
      className="chat-wallpaper"
      aria-hidden="true"
      data-effect={settings.effect}
      style={{ opacity }}
    >
      <BackgroundMedia effect={settings.effect} />
      {settings.effect === 'haze' && <div className="chat-wallpaper-haze" />}
    </div>
  )
}
