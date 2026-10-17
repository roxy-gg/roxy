import { useEffect, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft } from 'lucide-react'
import { SidebarFrame, SidebarNavItem } from './SidebarFrame'
import { backgroundOpacity } from '@shared/background'
import { useBackground } from '../lib/background'
import { BackgroundFrame } from './BackgroundFrame'
import { ChatBackground } from './ChatBackground'

export function PageShell({
  title,
  subtitle,
  sidebar,
  onBack,
  onEscape,
  actions,
  contentKey,
  children
}: {
  title: string
  subtitle?: string
  sidebar?: ReactNode
  onBack: () => void
  onEscape?: () => boolean
  actions?: ReactNode
  contentKey?: string
  children: ReactNode
}): JSX.Element {
  const { t } = useTranslation()
  const background = useBackground()
  // Utility pages use the non-conversation opacity, independent of the hidden chat.
  const opacity = backgroundOpacity(background.settings, true)
  const wallpaper = !!background.rendered && opacity > 0
  const contentBackground = {
    className: 'chat-background-host relative isolate flex min-h-0 min-w-0 flex-1 flex-col bg-bg',
    'data-wallpaper': wallpaper || undefined,
    style: { '--chat-wallpaper-opacity': opacity } as CSSProperties
  }
  const media = background.settings.sidebarStyle === 'default' && <ChatBackground empty />
  const contentRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0
  }, [contentKey])
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
      <BackgroundFrame className="min-w-0 flex-col sm:flex-row">
        <SidebarFrame responsive>
          <div className="titlebar reserve-controls-left flex h-14 shrink-0 items-center px-3">
            <SidebarNavItem onClick={onBack} title={t('page.back')}>
              <ArrowLeft aria-hidden="true" className="h-4 w-4 shrink-0 opacity-80" />
              <span className="truncate">{t('page.back')}</span>
            </SidebarNavItem>
          </div>
          <div className="min-h-0 overflow-y-auto px-3 pb-3">{sidebar}</div>
        </SidebarFrame>
        <div {...contentBackground}>
          {media}
          <header className="titlebar reserve-controls-right flex h-14 shrink-0 items-center gap-3 px-4">
            <span className="truncate text-sm font-medium">{title}</span>
            {actions && <div className="ml-auto">{actions}</div>}
          </header>
          <div ref={contentRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-3xl px-6 py-8">
              {subtitle && <p className="mb-6 text-sm text-text-muted">{subtitle}</p>}
              {children}
            </div>
          </div>
        </div>
      </BackgroundFrame>
    )
  }
  return (
    <BackgroundFrame className="min-w-0 flex-col">
      <div {...contentBackground}>
        {media}
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
    </BackgroundFrame>
  )
}
