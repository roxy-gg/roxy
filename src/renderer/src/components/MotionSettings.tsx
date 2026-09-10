import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { normalizeMotion, type MotionPreference } from '@shared/motion'
import { useMotion } from '../lib/motion'

export function MotionSettings({
  onChange
}: {
  onChange: (preference: MotionPreference) => Promise<void>
}): JSX.Element {
  const { t } = useTranslation()
  const { preference } = useMotion()
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-subtle">
        {t('settings.motion.heading')}
      </h2>
      <div className="flex flex-col gap-3 sq sq-xl sq-ring rounded-xl border border-border bg-surface p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <label htmlFor="motion" className="text-sm font-medium text-text">
            {t('settings.motion.label')}
          </label>
          <p id="motion-description" className="mt-0.5 text-xs text-text-muted">
            {t('settings.motion.description')}
          </p>
          {failed && (
            <p role="alert" className="mt-2 text-xs text-danger">
              {t('settings.motion.saveFailed')}
            </p>
          )}
        </div>
        <select
          id="motion"
          value={preference}
          aria-describedby="motion-description"
          disabled={saving}
          className="h-9 shrink-0 sq sq-lg sq-ring rounded-lg border border-border bg-surface-2 px-3 text-sm text-text outline-none transition-colors focus:border-accent/70"
          onChange={async (event) => {
            setSaving(true)
            setFailed(false)
            try {
              await onChange(normalizeMotion(event.target.value))
            } catch {
              setFailed(true)
            } finally {
              setSaving(false)
            }
          }}
        >
          <option value="on">{t('settings.motion.on')}</option>
          <option value="system">{t('settings.motion.system')}</option>
          <option value="reduced">{t('settings.motion.reduced')}</option>
        </select>
      </div>
    </section>
  )
}
