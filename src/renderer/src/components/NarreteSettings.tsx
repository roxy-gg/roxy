import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MousePointer2 } from 'lucide-react'
import { Switch } from './ui'
import { useRoxyStore } from '../lib/store'

export function NarreteSettings(): JSX.Element {
  const { t } = useTranslation()
  const enabled = useRoxyStore((state) => state.settings?.narreteEnabled ?? false)
  const save = useRoxyStore((state) => state.setNarreteEnabled)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  return (
    <>
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-subtle">
        {t('narrete.heading')}
      </h2>
      <div className="rounded-xl border border-border bg-surface p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h3 id="settings-narrete-enabled" className="text-sm font-medium">
              {t('narrete.enable')}
            </h3>
            <p className="mt-1 text-xs text-text-muted">{t('narrete.directDescription')}</p>
          </div>
          <Switch
            checked={enabled}
            disabled={busy}
            label={t('narrete.enable')}
            onChange={async (value) => {
              setBusy(true)
              setError(false)
              try {
                await save(value)
              } catch {
                setError(true)
              } finally {
                setBusy(false)
              }
            }}
          />
        </div>
        <div className="mt-5 flex items-start gap-3 border-t border-border pt-4 text-xs text-text-muted">
          <MousePointer2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          <p>{t('narrete.ctrlHowItWorks')}</p>
        </div>
        <p className="mt-3 text-xs text-text-subtle">{t('narrete.livePrivacy')}</p>
        {error && (
          <p role="alert" className="mt-3 text-xs text-danger">
            {t('narrete.errors.saveFailed')}
          </p>
        )}
      </div>
    </>
  )
}
