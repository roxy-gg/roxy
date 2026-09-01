import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Play } from 'lucide-react'
import { DEFAULT_NOTIFY_VOLUME, type NotifyCondition } from '@shared/types'
import { Button, Switch } from './ui'
import { useRoxyStore } from '../lib/store'

/**
 * Notification preferences: when a finished turn may interrupt you, and what it
 * sounds like.
 *
 * The condition is a `<select>` and not a switch because "only when I'm not
 * looking" is the useful default and the interesting middle case -- a boolean
 * would force everyone into either constant pings or nothing at all.
 */

const CONDITIONS = [
  { value: 'never', label: 'settings.notifications.conditionNever' },
  { value: 'unfocused', label: 'settings.notifications.conditionUnfocused' },
  { value: 'always', label: 'settings.notifications.conditionAlways' }
] as const satisfies readonly { value: NotifyCondition; label: string }[]

const PICK_ERRORS = {
  type: 'settings.notifications.errorType',
  size: 'settings.notifications.errorSize',
  read: 'settings.notifications.errorRead'
} as const

const CARD = 'sq sq-xl sq-ring rounded-xl border border-border bg-surface p-4'
const ROW = `${CARD} flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between`

export function NotificationSettings(): JSX.Element {
  const { t } = useTranslation()
  const settings = useRoxyStore((s) => s.settings)
  const setNotifyCondition = useRoxyStore((s) => s.setNotifyCondition)
  const setNotifySound = useRoxyStore((s) => s.setNotifySound)
  const setNotifyVolume = useRoxyStore((s) => s.setNotifyVolume)
  const setNotifySystemToast = useRoxyStore((s) => s.setNotifySystemToast)
  const pickNotifySound = useRoxyStore((s) => s.pickNotifySound)
  const clearNotifySound = useRoxyStore((s) => s.clearNotifySound)
  const previewNotifySound = useRoxyStore((s) => s.previewNotifySound)
  const [error, setError] = useState<keyof typeof PICK_ERRORS | null>(null)
  /**
   * The slider's live position while it's being dragged. `onChange` fires once
   * per step, so persisting from it would write ~20 rows and re-render the page
   * as many times for a single gesture; the value is committed on release
   * instead. Null means "not dragging -- show what's saved".
   */
  const [dragVolume, setDragVolume] = useState<number | null>(null)

  const condition = settings?.notifyCondition ?? 'unfocused'
  const soundOn = settings?.notifySound ?? true
  // Everything below the condition picker is dead weight when nothing can fire.
  const muted = condition === 'never'

  const choose = async (): Promise<void> => {
    const result = await pickNotifySound()
    // A cancelled dialog is a normal outcome, not something to report.
    setError(result && result !== 'cancelled' ? result : null)
  }

  return (
    <>
      <div className={ROW}>
        <div className="min-w-0">
          <label htmlFor="notify-condition" className="text-sm font-medium text-text">
            {t('settings.notifications.whenTitle')}
          </label>
          <p className="mt-0.5 text-xs text-text-muted">
            {t('settings.notifications.whenDescription')}
          </p>
        </div>
        <select
          id="notify-condition"
          value={condition}
          aria-label={t('settings.notifications.whenLabel')}
          onChange={(e) => void setNotifyCondition(e.target.value as NotifyCondition)}
          className="h-9 shrink-0 sq sq-lg sq-ring rounded-lg border border-border bg-surface-2 px-3 text-sm text-text outline-none transition-colors focus:border-accent/70"
        >
          {CONDITIONS.map((c) => (
            <option key={c.value} value={c.value}>
              {t(c.label)}
            </option>
          ))}
        </select>
      </div>

      <div className={`mt-3 ${ROW}`}>
        <div className="min-w-0">
          <div className="text-sm font-medium text-text">
            {t('settings.notifications.soundTitle')}
          </div>
          <p className="mt-0.5 text-xs text-text-muted">
            {t('settings.notifications.soundDescription')}
          </p>
        </div>
        <Switch checked={soundOn} disabled={muted} onChange={(v) => void setNotifySound(v)} />
      </div>

      <div className={`mt-3 ${ROW}`}>
        <div className="min-w-0">
          <div className="text-sm font-medium text-text">
            {t('settings.notifications.toastTitle')}
          </div>
          <p className="mt-0.5 text-xs text-text-muted">
            {t('settings.notifications.toastDescription')}
          </p>
        </div>
        <Switch
          checked={settings?.notifySystemToast ?? true}
          disabled={muted}
          onChange={(v) => void setNotifySystemToast(v)}
        />
      </div>

      <div className={`mt-3 ${CARD}`}>
        <div className="text-sm font-medium text-text">
          {t('settings.notifications.soundFileTitle')}
        </div>
        <p className="mt-0.5 text-xs text-text-muted">
          {t('settings.notifications.soundFileDescription')}
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {/* The stored value is a file name, not a path -- see AppSettings. */}
          <span className="min-w-0 flex-1 truncate text-sm text-text">
            {settings?.notifySoundName ?? t('settings.notifications.soundFileDefault')}
          </span>
          <Button size="sm" onClick={() => void previewNotifySound()} disabled={!soundOn || muted}>
            <Play className="mr-1.5 h-3.5 w-3.5" />
            {t('settings.notifications.preview')}
          </Button>
          <Button size="sm" onClick={() => void choose()}>
            {t('settings.notifications.choose')}
          </Button>
          {settings?.notifySoundName && (
            <Button
              size="sm"
              onClick={() => {
                setError(null)
                void clearNotifySound()
              }}
            >
              {t('settings.notifications.reset')}
            </Button>
          )}
        </div>

        {error && <p className="mt-2 text-xs text-danger">{t(PICK_ERRORS[error])}</p>}

        <div className="mt-4 flex items-center gap-3">
          <label htmlFor="notify-volume" className="text-xs text-text-muted">
            {t('settings.notifications.volumeLabel')}
          </label>
          <input
            id="notify-volume"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={dragVolume ?? settings?.notifyVolume ?? DEFAULT_NOTIFY_VOLUME}
            disabled={!soundOn || muted}
            onChange={(e) => setDragVolume(Number(e.target.value))}
            onPointerUp={() => {
              if (dragVolume === null) return
              void setNotifyVolume(dragVolume)
              setDragVolume(null)
            }}
            // Keyboard users never fire a pointer event, so commit on blur too.
            onBlur={() => {
              if (dragVolume === null) return
              void setNotifyVolume(dragVolume)
              setDragVolume(null)
            }}
            className="h-1 w-40 cursor-pointer accent-accent disabled:cursor-not-allowed disabled:opacity-40"
          />
        </div>
      </div>
    </>
  )
}
