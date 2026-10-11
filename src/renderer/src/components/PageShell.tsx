import { useEffect, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft } from 'lucide-react'
import { SidebarFrame, SidebarNavItem } from './SidebarFrame'

export function PageShell({
  title,
  subtitle,
  sidebar,
  onBack,
  onEscape,
  actions,
  children
}: {
  title: string
  subtitle?: string
  sidebar?: ReactNode
  onBack: () => void
  onEscape?: () => boolean
  actions?: ReactNode
  children: ReactNode
}): JSX.Element {
  const { t } = useTranslation()
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        document.querySelector('dialog[open], [role="dialog"], [role="menu"]')
      )
        return
      event.preventDefault()
      if (!onEscape?.()) onBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onBack, onEscape])

  if (sidebar) {
    return (
      <div className="flex h-full w-full min-w-0 flex-col bg-bg sm:flex-row">
        <SidebarFrame responsive>
          <div className="titlebar reserve-controls-left flex h-14 shrink-0 items-center px-3">
            <SidebarNavItem onClick={onBack} title={t('page.back')}>
              <ArrowLeft aria-hidden="true" className="h-4 w-4 shrink-0 opacity-80" />
              <span className="truncate">{t('page.back')}</span>
            </SidebarNavItem>
          </div>
          <div className="min-h-0 overflow-y-auto px-3 pb-3">{sidebar}</div>
        </SidebarFrame>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="titlebar reserve-controls-right flex h-14 shrink-0 items-center gap-3 px-4">
            <span className="truncate text-sm font-medium">{title}</span>
            {actions && <div className="ml-auto">{actions}</div>}
          </header>
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-3xl px-6 py-8">
              {subtitle && <p className="mb-6 text-sm text-text-muted">{subtitle}</p>}
              {children}
            </div>
          </div>
        </div>
      </div>
    )
  }
  return (
    <div className="flex h-full w-full min-w-0 flex-col bg-bg">
      <header className="titlebar reserve-controls-left reserve-controls-right flex h-12 shrink-0 items-center gap-3 px-4">
        <button
          onClick={onBack}
          title={t('page.back')}
          className="press-scale flex h-7 w-7 items-center justify-center sq sq-lg rounded-lg text-text-muted hover:bg-white/5 hover:text-text"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <span className="text-sm font-medium">{title}</span>
        {actions && <div className="ml-auto">{actions}</div>}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto border-t border-border">
        <div className="mx-auto max-w-3xl px-6 py-8">
          {subtitle && <p className="mb-6 text-sm text-text-muted">{subtitle}</p>}
          {children}
        </div>
      </div>
    </div>
  )
}
