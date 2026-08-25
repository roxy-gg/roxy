import { type ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'
import { cn } from '../lib/cn'

export function PageShell({
  title,
  subtitle,
  onBack,
  actions,
  wide = false,
  children
}: {
  title: string
  subtitle?: string
  onBack: () => void
  actions?: ReactNode
  /** Widen the column for grid/browse pages (Marketplace) instead of prose. */
  wide?: boolean
  children: ReactNode
}): JSX.Element {
  return (
    <div className="flex h-full w-full flex-col bg-bg">
      <header className="titlebar reserve-controls-left reserve-controls-right flex h-12 shrink-0 items-center gap-3 px-4">
        <button
          onClick={onBack}
          title="Back"
          className="press-scale flex h-7 w-7 items-center justify-center sq sq-lg rounded-lg text-text-muted hover:bg-white/5 hover:text-text"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <span className="text-sm font-medium">{title}</span>
        {actions && <div className="ml-auto">{actions}</div>}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto border-t border-border">
        <div className={cn('mx-auto px-6 py-8', wide ? 'max-w-5xl' : 'max-w-3xl')}>
          {subtitle && <p className="mb-6 text-sm text-text-muted">{subtitle}</p>}
          {children}
        </div>
      </div>
    </div>
  )
}
