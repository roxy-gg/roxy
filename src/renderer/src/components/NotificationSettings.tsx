import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Play, Square, Trash2, Upload } from 'lucide-react'
import { Button, Switch } from './ui'
import { useRoxyStore } from '../lib/store'
import {
  playNotificationSound,
  showCompletionNotification,
  stopNotificationSound
} from '../lib/notify'
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

  const entries = [
    {
      id: null,
      name: t('settings.notifications.defaultSound'),
      detail: t('settings.notifications.bundledSound')
    },
    ...(library?.sounds ?? []).map((sound) => ({
      id: sound.id,
      name: sound.name,
      detail: t('settings.notifications.soundDetails', {
        format: sound.format.toUpperCase(),
        seconds: sound.duration.toLocaleString(undefined, { maximumFractionDigits: 2 }),
        size: Math.ceil(sound.bytes / 1024)
      })
    }))
  ]

  return (
    <div className="flex flex-col gap-4">
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

      <section
        className="rounded-xl border border-border bg-surface p-4"
        aria-labelledby="notification-sounds-title"
        aria-busy={busy}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 id="notification-sounds-title" className="text-sm font-medium text-text">
              {t('settings.notifications.soundsTitle')}
            </h3>
            <p className="mt-1 text-xs text-text-muted">
              {t('settings.notifications.soundLimits')}
            </p>
          </div>
          <Button
            size="sm"
            disabled={busy || !library || library.sounds.length >= SOUND_MAX_COUNT}
            onClick={() => void change(() => api.notifications.importSound())}
          >
            <Upload className="h-3.5 w-3.5" />
            {t(busy ? 'settings.notifications.working' : 'settings.notifications.importSound')}
          </Button>
        </div>
        <p className="mt-3 text-xs text-text-muted">{t('settings.notifications.localCopy')}</p>
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
        <div
          className="mt-4 divide-y divide-border"
          role="radiogroup"
          aria-label={t('settings.notifications.soundsTitle')}
        >
          {entries.map((entry) => (
            <div key={entry.id ?? 'default'} className="flex items-center gap-2 py-3">
              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                <input
                  type="radio"
                  name="notification-sound"
                  value={entry.id ?? 'default'}
                  checked={!!library && library.selectedId === entry.id}
                  disabled={busy || !library}
                  className="shrink-0 accent-accent"
                  onChange={() => void change(() => api.notifications.selectSound(entry.id))}
                />
                <span className="min-w-0">
                  <span className="block truncate text-sm text-text" title={entry.name}>
                    {entry.name}
                  </span>
                  <span className="block text-xs text-text-muted">{entry.detail}</span>
                </span>
              </label>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || !library}
                aria-label={t('settings.notifications.listenTo', { name: entry.name })}
                title={t('settings.notifications.listenTo', { name: entry.name })}
                onClick={() => void playNotificationSound(entry.id)}
              >
                <Play className="h-3.5 w-3.5" />
              </Button>
              {entry.id && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  aria-label={t('settings.notifications.deleteSound', { name: entry.name })}
                  title={t('settings.notifications.deleteSound', { name: entry.name })}
                  onClick={() => void change(() => api.notifications.deleteSound(entry.id!))}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-text-muted">
            {t('settings.notifications.libraryCount', {
              count: library?.sounds.length ?? 0,
              max: SOUND_MAX_COUNT
            })}
          </span>
          <Button size="sm" variant="ghost" onClick={stopNotificationSound}>
            <Square className="h-3 w-3" />
            {t('settings.notifications.stopSound')}
          </Button>
        </div>
      </section>
    </div>
  )
}
