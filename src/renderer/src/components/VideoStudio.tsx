import { Clapperboard } from 'lucide-react'
import { useTranslation } from 'react-i18next'

const PIPELINE = ['script', 'voice', 'timing', 'scenes', 'render', 'review'] as const

export function VideoStudio(): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="space-y-5" data-video-studio>
      <header>
        <h2 id="settings-video-title" className="text-sm font-semibold text-text">
          {t('videoStudio.title')}
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-text-muted">{t('videoStudio.overview')}</p>
      </header>
      <section className="space-y-3 rounded-xl border border-border bg-surface p-4">
        <div className="flex items-center gap-3">
          <Clapperboard aria-hidden="true" className="h-5 w-5 shrink-0 text-accent" />
          <h3 className="min-w-0 flex-1 text-sm font-medium text-text">{t('videoStudio.title')}</h3>
          <span className="rounded-full border border-border bg-surface-2 px-2 py-0.5 text-xs text-text-muted">
            {t('videoStudio.comingSoon')}
          </span>
        </div>
        <p className="text-xs leading-relaxed text-text-muted">{t('videoStudio.comingSoonBody')}</p>
      </section>
      <section className="space-y-3 rounded-xl border border-border bg-surface p-4">
        <h3 className="text-sm font-medium text-text">{t('videoStudio.pipeline')}</h3>
        <ol className="space-y-3">
          {PIPELINE.map((step, index) => (
            <li key={step} className="flex gap-3" data-video-step={step}>
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border text-xs text-text-muted">
                {index + 1}
              </span>
              <span className="min-w-0">
                <span className="block text-xs font-medium text-text">
                  {t(`videoStudio.steps.${step}.title`)}
                </span>
                <span className="block text-xs leading-relaxed text-text-muted">
                  {t(`videoStudio.steps.${step}.body`)}
                </span>
              </span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
}
