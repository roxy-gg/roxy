import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Play, Trash2, Upload } from 'lucide-react'
import { Button, Switch } from './ui'
import { useRoxyStore } from '../lib/store'
import { showCompletionNotification, stopNotificationSound } from '../lib/notify'
import { api } from '../lib/api'
import {
  SOUND_MAX_COUNT,
  type NotificationSoundError,
  type NotificationSoundLibrary,
  type NotificationSoundResult
} from '@shared/notification-sounds'

export function NotificationSettings(): JSX.Element {
  const { t } = useTranslation()
  const settings = useRoxyStore((s) => s.settings)
  const setNotifyOnComplete = useRoxyStore((s) => s.setNotifyOnComplete)
  const [library, setLibrary] = useState<NotificationSoundLibrary | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Exclude<NotificationSoundError, 'cancelled'> | null>(null)

  useEffect(() => {
    let active = true
    let changed = false
    const unsubscribe = api.notifications.onSoundsChanged((state) => {
      changed = true
      if (active) setLibrary(state)
    })
    void api.notifications
      .soundLibrary()
      .then((state) => {
        if (active && !changed) setLibrary(state)
      })
      .catch(() => {
        if (active) setError('readFailed')
      })
    return () => {
      active = false
      unsubscribe()
      stopNotificationSound()
    }
  }, [])

  async function change(operation: () => Promise<NotificationSoundResult>): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    stopNotificationSound()
    try {
      const result = await operation()
      if (result.ok) setLibrary(result.state)
      else if (result.error !== 'cancelled') setError(result.error)
    } catch {
      setError('saveFailed')
    } finally {
      setBusy(false)
    }
  }

  const selected = library?.sounds.find((sound) => sound.id === library.selectedId)

  return (
    <section
      className="sq sq-xl sq-ring rounded-xl border border-border bg-surface p-4"
      aria-busy={busy}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
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
            onClick={() => {
              const { chats, activeChatId } = useRoxyStore.getState()
              void showCompletionNotification(chats.find((chat) => chat.id === activeChatId))
            }}
          >
            <Play className="h-3.5 w-3.5" />
            {t('settings.notifications.testNotification')}
          </Button>
          <Switch
            label={t('settings.notifications.completeTitle')}
            checked={settings?.notifyOnComplete ?? false}
            onChange={(value) => void setNotifyOnComplete(value)}
          />
        </div>
      </div>

      <div className="mt-4 border-t border-border pt-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <label htmlFor="notification-sound" className="text-sm font-medium text-text">
              {t('settings.notifications.soundsTitle')}
            </label>
            <p
              className="mt-0.5 text-xs text-text-muted"
              title={t('settings.notifications.soundLimits')}
            >
              {t('settings.notifications.soundHint')}
            </p>
          </div>
          <div className="flex min-w-0 items-center gap-1.5 sm:max-w-[60%]">
            <select
              id="notification-sound"
              value={library?.selectedId ?? ''}
              disabled={busy || !library}
              className="sq sq-lg sq-ring h-9 min-w-0 flex-1 rounded-lg border border-border bg-surface-2 px-3 text-sm text-text outline-none focus:border-accent/70 sm:w-44"
              onChange={(event) => {
                const id = event.target.value || null
                void change(() => api.notifications.selectSound(id))
              }}
            >
              <option value="">{t('settings.notifications.defaultSound')}</option>
              {library?.sounds.map((sound) => (
                <option key={sound.id} value={sound.id}>
                  {sound.name}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || !library || library.sounds.length >= SOUND_MAX_COUNT}
              aria-label={t('settings.notifications.importSound')}
              title={t(
                library && library.sounds.length >= SOUND_MAX_COUNT
                  ? 'settings.notifications.soundErrors.libraryFull'
                  : 'settings.notifications.importSound'
              )}
              onClick={() => void change(() => api.notifications.importSound())}
            >
              <Upload className="h-3.5 w-3.5" />
            </Button>
            {selected && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                aria-label={t('settings.notifications.deleteSound', { name: selected.name })}
                title={t('settings.notifications.deleteSound', { name: selected.name })}
                onClick={() => void change(() => api.notifications.deleteSound(selected.id))}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>
        {error && (
          <p role="alert" className="mt-3 text-xs text-danger">
            {t(`settings.notifications.soundErrors.${error}`)}
          </p>
        )}
        {!library && error && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void change(async () => ({
                ok: true,
                state: await api.notifications.soundLibrary()
              }))
            }
          >
            {t('common.retry')}
          </Button>
        )}
      </div>
    </section>
  )
}
