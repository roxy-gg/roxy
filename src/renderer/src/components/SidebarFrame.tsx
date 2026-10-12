import {
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode
} from 'react'
import { useTranslation } from 'react-i18next'
import { create } from 'zustand'
import { cn } from '../lib/cn'

const MIN_WIDTH = 220
const MAX_WIDTH = 480
const DEFAULT_WIDTH = 288
const WIDTH_KEY = 'roxy.sidebar.width'
const useSidebarWidth = create<{ width: number; setWidth: (width: number) => void }>((set) => {
  let width = DEFAULT_WIDTH
  try {
    const saved = Number(localStorage.getItem(WIDTH_KEY))
    if (Number.isFinite(saved) && saved >= MIN_WIDTH && saved <= MAX_WIDTH) width = saved
  } catch {
    /* Sizing remains usable when local storage is unavailable. */
  }
  return {
    width,
    setWidth: (value) => {
      if (!Number.isFinite(value)) return
      const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, value))
      set({ width })
      try {
        localStorage.setItem(WIDTH_KEY, String(width))
      } catch {
        /* In-memory preference is enough. */
      }
    }
  }
})

/** Shared by chat and secondary navigation, including the user's saved width. */
export function SidebarFrame({
  children,
  responsive = false
}: {
  children: ReactNode
  responsive?: boolean
}): JSX.Element {
  const { t } = useTranslation()
  const { width, setWidth } = useSidebarWidth()
  const drag = useRef<{ x: number; width: number; cursor: string; userSelect: string } | null>(null)
  const stopResize = (): void => {
    if (!drag.current) return
    document.body.style.cursor = drag.current.cursor
    document.body.style.userSelect = drag.current.userSelect
    drag.current = null
  }
  useEffect(() => () => stopResize(), [])
  return (
    <aside
      data-sidebar-frame
      style={{ '--sidebar-width': `${width}px` } as CSSProperties}
      className={cn(
        'relative flex min-h-0 shrink-0 flex-col border-border bg-surface',
        responsive
          ? 'w-full sm:h-full sm:w-[var(--sidebar-width)] sm:border-r'
          : 'h-full w-[var(--sidebar-width)] border-r'
      )}
    >
      {children}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('sidebar.resizeHandle')}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        aria-valuenow={width}
        tabIndex={0}
        title={t('sidebar.resizeHandle')}
        onPointerDown={(e) => {
          if (e.button !== 0 || !e.isPrimary) return
          e.preventDefault()
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = {
            x: e.clientX,
            width,
            cursor: document.body.style.cursor,
            userSelect: document.body.style.userSelect
          }
          document.body.style.cursor = 'col-resize'
          document.body.style.userSelect = 'none'
        }}
        onPointerMove={(e) => {
          if (drag.current) setWidth(drag.current.width + e.clientX - drag.current.x)
        }}
        onPointerUp={stopResize}
        onPointerCancel={stopResize}
        onLostPointerCapture={stopResize}
        onDoubleClick={() => setWidth(DEFAULT_WIDTH)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault()
            setWidth(width + (e.key === 'ArrowLeft' ? -10 : 10))
          } else if (e.key === 'Home' || e.key === 'End') {
            e.preventDefault()
            setWidth(e.key === 'Home' ? MIN_WIDTH : MAX_WIDTH)
          }
        }}
        className={cn(
          'absolute inset-y-0 right-0 z-20 w-1 touch-none cursor-col-resize transition-colors hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none',
          responsive && 'hidden sm:block'
        )}
      />
    </aside>
  )
}

export function SidebarNavItem({
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        'press-scale flex min-w-0 items-center gap-2.5 sq sq-lg rounded-lg px-2 py-1.5 text-left text-sm focus-visible:outline-2 focus-visible:outline-accent',
        props['aria-current'] === 'page'
          ? 'bg-elevated text-text'
          : 'text-text-muted hover:bg-white/5 hover:text-text',
        className
      )}
    />
  )
}
