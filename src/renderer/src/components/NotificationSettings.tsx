import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown, Play, Upload, X } from 'lucide-react'
import { Button, Switch } from './ui'
import { useRoxyStore } from '../lib/store'
import { showCompletionNotification, stopNotificationSound } from '../lib/notify'
import { api } from '../lib/api'
import { useMenuAnchor } from '../lib/useMenuAnchor'
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
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const anchor = useMenuAnchor(triggerRef, open, 280, { side: 'bottom', fixed: true })

  useEffect(() => {
    if (!open) return
    menuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus()
    const onDown = (event: MouseEvent): void => {
      if (
        !triggerRef.current?.contains(event.target as Node) &&
        !menuRef.current?.contains(event.target as Node)
      )
        setOpen(false)
    }
    window.addEventListener('mousedown', onDown, true)
    return () => window.removeEventListener('mousedown', onDown, true)
  }, [open])

  function closeMenu(): void {
    setOpen(false)
    triggerRef.current?.focus()
  }

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
    closeMenu()
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
            {t('settings.notifications.completeHint')}
          </p>
        </div>
        <Switch
          label={t('settings.notifications.completeTitle')}
          checked={settings?.notifyOnComplete ?? false}
          onChange={(value) => void setNotifyOnComplete(value)}
        />
      </div>

      <div className="mt-4 border-t border-border pt-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <label
              id="notification-sound-label"
              htmlFor="notification-sound"
              className="text-sm font-medium text-text"
            >
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
            <button
              ref={triggerRef}
              type="button"
              id="notification-sound"
              disabled={!library}
              aria-disabled={busy || !library}
              aria-labelledby="notification-sound-label notification-sound-value"
              aria-haspopup="menu"
              aria-expanded={open}
              aria-controls={open ? 'notification-sound-menu' : undefined}
              className="sq sq-lg sq-ring flex h-9 min-w-0 flex-1 items-center gap-3 rounded-lg border border-border bg-surface-2 px-3 text-sm text-text outline-none focus-visible:border-accent/70 sm:w-44"
              onClick={() => {
                if (!busy) setOpen(!open)
              }}
              onKeyDown={(event) => {
                if (busy) return
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault()
                  setOpen(true)
                }
              }}
            >
              <span id="notification-sound-value" className="flex-1 truncate text-left">
                {selected?.name ?? t('settings.notifications.defaultSound')}
              </span>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-muted" />
            </button>
            <Button
              size="sm"
              className="h-9"
              disabled={busy}
              aria-label={t('settings.notifications.testNotification')}
              title={t('settings.notifications.testNotification')}
              onClick={() => {
                const { chats, activeChatId } = useRoxyStore.getState()
                void showCompletionNotification(chats.find((chat) => chat.id === activeChatId))
              }}
            >
              <Play className="h-3.5 w-3.5" />
              {t('settings.notifications.testSound')}
            </Button>
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
      {open &&
        library &&
        createPortal(
          <div
            ref={menuRef}
            id="notification-sound-menu"
            role="menu"
            aria-labelledby="notification-sound-label"
            style={anchor}
            className="sq-frame sq-lg sq-fill-elevated sq-ring edge edge-strong edge-panel animate-pop-in fixed z-50 overflow-y-auto rounded-lg border border-border bg-elevated p-1 shadow-float"
            onBlur={(event) => {
              if (
                !event.currentTarget.contains(event.relatedTarget as Node) &&
                !triggerRef.current?.contains(event.relatedTarget as Node)
              )
                setOpen(false)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                closeMenu()
              } else if (event.key === 'Tab') {
                closeMenu()
              } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                event.preventDefault()
                const items = Array.from(
                  event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
                )
                const current = items.indexOf(document.activeElement as HTMLButtonElement)
                const next =
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? items.length - 1
                      : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) %
                        items.length
                items[next]?.focus()
              }
            }}
          >
            {[{ id: null, name: t('settings.notifications.defaultSound') }, ...library.sounds].map(
              (sound) => (
                <div
                  key={sound.id ?? 'default'}
                  role="none"
                  className="flex items-center gap-1 rounded-md focus-within:bg-white/5 hover:bg-white/5"
                >
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={library.selectedId === sound.id}
                    tabIndex={-1}
                    disabled={busy}
                    title={sound.name}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-text outline-none focus-visible:ring-1 focus-visible:ring-accent"
                    onClick={() => void change(() => api.notifications.selectSound(sound.id))}
                  >
                    <span className="h-3.5 w-3.5 shrink-0">
                      {library.selectedId === sound.id && (
                        <Check className="h-3.5 w-3.5 text-accent" />
                      )}
                    </span>
                    <span className="truncate">{sound.name}</span>
                  </button>
                  {sound.id && (
                    <button
                      type="button"
                      role="menuitem"
                      tabIndex={-1}
                      disabled={busy}
                      aria-label={t('settings.notifications.deleteSound', { name: sound.name })}
                      title={t('settings.notifications.deleteSound', { name: sound.name })}
                      className="shrink-0 rounded-md p-2 text-text-subtle outline-none hover:text-danger focus-visible:text-danger focus-visible:ring-1 focus-visible:ring-accent"
                      onClick={() => void change(() => api.notifications.deleteSound(sound.id!))}
                    >
                      <X className="h-3 w-3" strokeWidth={1.5} />
                    </button>
                  )}
                </div>
              )
            )}
          </div>,
          document.body
        )}
    </section>
  )
}
