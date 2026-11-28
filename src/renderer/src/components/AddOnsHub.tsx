import { useTranslation } from 'react-i18next'
import { ADDON_CARDS } from '../lib/settings-navigation'

export function AddOnsHub({ onOpen }: { onOpen: (id: string) => void }): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-text">{t('settings.navigation.addons')}</h2>
        <p className="mt-1 text-sm leading-relaxed text-text-muted">{t('settings.addons.body')}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {ADDON_CARDS.map((card) => {
          const Icon = card.icon
          return (
            <button
              key={card.id}
              type="button"
              data-addon-card={card.id}
              onClick={() => onOpen(card.id)}
              className="flex items-start gap-3 rounded-xl border border-border bg-surface p-4 text-left transition-colors hover:bg-elevated focus-visible:outline-2 focus-visible:outline-accent"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-2">
                <Icon aria-hidden="true" className="h-5 w-5 text-text-muted" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium text-text">{t(card.label)}</span>
                <span className="mt-1 block text-xs leading-relaxed text-text-muted">
                  {t(card.description)}
                </span>
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
