import { backgroundOpacity, type BackgroundSettings } from '@shared/background'
import { useBackground } from '../lib/background'

export function ChatBackground({
  empty,
  settings: preview
}: {
  empty: boolean
  settings?: BackgroundSettings
}): JSX.Element | null {
  const background = useBackground()
  const settings = preview ?? background.settings
  const opacity = backgroundOpacity(settings, empty)
  if (!background.rendered || opacity === 0) return null
  return (
    <div
      className="chat-wallpaper"
      aria-hidden="true"
      data-effect={settings.effect}
      style={{ opacity }}
    >
      <img src={background.rendered} alt="" draggable={false} />
      {settings.effect === 'haze' && <div className="chat-wallpaper-haze" />}
    </div>
  )
}
