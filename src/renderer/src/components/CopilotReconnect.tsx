import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, X } from 'lucide-react'
import { CopilotSetup } from './CopilotSetup'

/** Kept outside the canvas so recovery stays keyboard-accessible and visible. */
export function CopilotReconnect({
  connectionId,
  needed,
  onConnected
}: {
  connectionId: string
  needed: boolean
  onConnected: () => Promise<void>
}): JSX.Element | null {
  const { t } = useTranslation()
  const [connected, setConnected] = useState(false)
  if (!needed && !connected) return null
  return (
    <section aria-label={t('chat.copilotReconnect')} className="bg-bg px-4 pt-2">
      <div className="mx-auto max-h-[45vh] max-w-3xl overflow-y-auto rounded-xl border border-border bg-surface p-4">
        {needed ? (
          <CopilotSetup
            connectionId={connectionId}
            reconnect
            onConnected={async () => {
              await onConnected()
              setConnected(true)
            }}
          />
        ) : (
          <div className="flex items-start gap-2 text-sm text-text-muted">
            <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-success" />
            <p role="status" className="min-w-0 flex-1">
              {t('chat.copilotReconnected')}
            </p>
            <button
              type="button"
              aria-label={t('common.close')}
              onClick={() => setConnected(false)}
              className="press-scale rounded p-1 text-text-subtle hover:text-text focus-visible:outline focus-visible:outline-accent"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>
    </section>
  )
}
