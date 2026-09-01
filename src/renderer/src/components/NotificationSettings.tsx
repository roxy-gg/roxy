import { useTranslation } from 'react-i18next'
import { Play } from 'lucide-react'
import { Button, Switch } from './ui'
import { useRoxyStore } from '../lib/store'
import { playNotificationSound } from '../lib/notify'

/**
 * Notification preferences: a single switch, plus a way to hear the chime.
 *
 * Deliberately one control and not four. Sound, OS toast and a never/unfocused/
 * always picker were separate ways of asking one question -- "tell me when it's
 * done" -- and their combinations (toast but no sound, sound only when
 * unfocused) are decisions nobody wants to make about a chime. Staying quiet
 * while the window is focused is not a preference either: it is what the
 * feature should always do, so it lives in `shouldNotify`.
 *
 * The play button stays: it is the only way to know what you signed up for, and
 * the click doubles as the gesture that unlocks Chromium's autoplay policy -- an
 * app that has never been clicked in cannot play audio, so without it the first
 * chime is swallowed. That is also why the button is never disabled: the person
 * who just switched notifications ON and touched nothing else is exactly the one
 * who needs to make that gesture.
 */
export function NotificationSettings(): JSX.Element {
  const { t } = useTranslation()
  const settings = useRoxyStore((s) => s.settings)
  const setNotifyOnComplete = useRoxyStore((s) => s.setNotifyOnComplete)
  const enabled = settings?.notifyOnComplete ?? true

  return (
    <div className="sq sq-xl sq-ring flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="text-sm font-medium text-text">
          {t('settings.notifications.completeTitle')}
        </div>
        <p className="mt-0.5 text-xs text-text-muted">
          {t('settings.notifications.completeDescription')}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <Button
          size="sm"
          aria-label={t('settings.notifications.preview')}
          onClick={() => void playNotificationSound()}
        >
          <Play className="h-3.5 w-3.5" />
          {t('settings.notifications.preview')}
        </Button>
        <Switch checked={enabled} onChange={(v) => void setNotifyOnComplete(v)} />
      </div>
    </div>
  )
}
