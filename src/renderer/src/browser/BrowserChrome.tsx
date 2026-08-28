import { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Cookie,
  FileDiff,
  Globe,
  Plus,
  RotateCw,
  Search,
  X
} from 'lucide-react'
import type { BrowserState, BrowserTab } from '@shared/api'
import { BROWSER_CHROME_H } from '@shared/browser'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { CookiePanel } from '../components/CookiePanel'
import {
  ContextMenuRow,
  ContextMenuSurface,
  CONTEXT_MENU_PAD,
  CONTEXT_ROW_H
} from '../components/ContextMenu'
import { ReviewPane } from '../review/ReviewPane'

const BLANK: BrowserState = {
  url: '',
  title: '',
  canGoBack: false,
  canGoForward: false,
  loading: false
}

/**
 * The Roxy browser's chrome — a real React tab strip + URL bar (themed to match
 * the app), rendered into the browser window's own webContents. It talks to the
 * main process purely through `window.roxy.browser.*`; the agent still drives
 * the active page tab from main, and this just reflects/controls it.
 *
 * Tabs are not all websites. A 'review' tab shows the session's diff, drawn by
 * this React tree rather than by a page — so review is a tab you keep beside
 * your pages instead of a panel that covers one.
 */
export function BrowserChrome(): JSX.Element {
  const [tabs, setTabs] = useState<BrowserTab[]>([])
  const [nav, setNav] = useState<BrowserState>(BLANK)
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(false)
  const [dragId, setDragId] = useState<string | null>(null)
  const [cookiesOpen, setCookiesOpen] = useState(false)
  // Where the new-tab menu was summoned from, or null when it's closed.
  const [newTabMenu, setNewTabMenu] = useState<{ x: number; y: number } | null>(null)
  // The chat this window belongs to. Asked once: a browser window is opened BY
  // a session and stays that session's for its whole life.
  const [sessionId, setSessionId] = useState<string | null>(null)

  const activeTab = tabs.find((t) => t.active)
  const onReview = activeTab?.kind === 'review'
  // There is only ever one review tab, so once it exists the menu drops the
  // row rather than offering an action that would just re-focus it.
  const hasReview = tabs.some((t) => t.kind === 'review')
  const newTabMenuH = (hasReview ? 1 : 2) * CONTEXT_ROW_H + CONTEXT_MENU_PAD

  // The host the cookie panel scopes to -- the active tab's, like the
  // Cookie-Editor popup. Undefined on a blank tab, which shows the whole jar.
  const host = useMemo(() => {
    try {
      return new URL(nav.url).hostname || undefined
    } catch {
      return undefined
    }
  }, [nav.url])

  // A BrowserView always paints ABOVE the window's own webContents, so neither
  // the review tab nor the cookie panel can simply overlay a page: main has to
  // shrink the page view out of the way first. Growing the reserved chrome
  // height does exactly that, and 0 hands the space back.
  const ownsWindow = cookiesOpen || onReview
  // A panel takes the whole window; the new-tab menu takes only the strip it
  // actually covers, since claiming the rest would blank the page behind a
  // two-row dropdown.
  const reserved = ownsWindow
    ? window.innerHeight
    : newTabMenu
      ? Math.max(BROWSER_CHROME_H, newTabMenu.y + newTabMenuH)
      : 0
  useEffect(() => {
    void api.browser.setChromeHeight(reserved)
  }, [reserved])

  // Reserved height is absolute pixels, so a window resize while the chrome
  // owns the window would leave the page peeking out below it.
  useEffect(() => {
    if (!ownsWindow) return
    const onResize = (): void => void api.browser.setChromeHeight(window.innerHeight)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [ownsWindow])

  // Which chat opened this window. The browser session key IS the session id,
  // and main resolves it from this webContents.
  useEffect(() => {
    void api.review
      .ownSession()
      .then(setSessionId)
      .catch(() => setSessionId(null))
  }, [])

  // Ctrl/Cmd+Shift+G opens the review tab, the way an IDE opens its source
  // control view. Bound on the chrome's own document, so it only fires while
  // the chrome has focus - pages keep their own shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'g') {
        e.preventDefault()
        void api.browser.newReviewTab()
        setCookiesOpen(false)
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 't') {
        e.preventDefault()
        void api.browser.newTab()
      }
      if (e.key === 'Escape') setCookiesOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    const offState = api.browser.onState(setNav)
    const offTabs = api.browser.onTabs(setTabs)
    return () => {
      offState()
      offTabs()
    }
  }, [])

  // Mirror the live URL into the input unless the user is editing it.
  useEffect(() => {
    if (!editing) setDraft(nav.url && nav.url !== 'about:blank' ? nav.url : '')
  }, [nav.url, editing])

  const go = (): void => {
    void api.browser.navigate(draft)
    setEditing(false)
  }

  const reloadOrStop = (): void => {
    if (nav.loading) void api.browser.stop()
    else void api.browser.reload()
  }

  const secure = nav.url.startsWith('https://')

  return (
    <div className="flex h-screen w-screen select-none flex-col overflow-hidden bg-surface text-text">
      {/* Tab strip — doubles as the draggable title bar; native controls overlay it. */}
      <div className="titlebar reserve-controls-left reserve-controls-right flex items-end gap-0.5 overflow-x-auto px-2 pt-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((t) => {
          const review = t.kind === 'review'
          const Icon = review ? FileDiff : Globe
          return (
            <div
              key={t.id}
              draggable
              onClick={() => void api.browser.activateTab(t.id)}
              onDragStart={(e) => {
                setDragId(t.id)
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', t.id)
              }}
              onDragOver={(e) => {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
              }}
              onDrop={(e) => {
                e.preventDefault()
                if (dragId && dragId !== t.id) {
                  void api.browser.moveTab(
                    dragId,
                    tabs.findIndex((x) => x.id === t.id)
                  )
                }
                setDragId(null)
              }}
              onDragEnd={() => setDragId(null)}
              // A review tab has no URL to preview, so its tooltip says what it is.
              title={review ? 'Review changes' : t.url}
              className={cn(
                'group relative flex h-7 min-w-[120px] max-w-[220px] shrink-0 cursor-default items-center gap-2 rounded-t-lg px-3 text-xs transition-colors [-webkit-app-region:no-drag]',
                dragId === t.id && 'opacity-50',
                t.active
                  ? 'bg-elevated text-text'
                  : 'bg-surface-2/50 text-text-muted hover:bg-surface-2 hover:text-text'
              )}
            >
              <Icon
                className={cn('h-3.5 w-3.5 shrink-0', review ? 'text-accent' : 'text-text-subtle')}
              />
              <span className="min-w-0 flex-1 truncate">{t.title || 'New tab'}</span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  void api.browser.closeTab(t.id)
                }}
                title="Close tab"
                className={cn(
                  'flex h-5 w-5 shrink-0 items-center justify-center sq sq-md rounded-md text-text-subtle transition-colors hover:bg-border-strong hover:text-text',
                  t.active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                )}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )
        })}
        {/* A tab is no longer always a website, so + asks WHICH kind - the way
            the main window's + does. Anchored under the button rather than at
            the cursor, since this one is a menu on a control, not a
            right-click. */}
        <button
          type="button"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            setNewTabMenu((m) => (m ? null : { x: r.left, y: r.bottom + 6 }))
          }}
          title="New tab menu"
          aria-haspopup="menu"
          aria-expanded={!!newTabMenu}
          className={cn(
            'press-scale mb-0.5 ml-0.5 flex h-7 w-7 shrink-0 items-center justify-center sq sq-lg rounded-lg text-text-muted hover:bg-surface-2 hover:text-text',
            newTabMenu && 'bg-surface-2 text-text'
          )}
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      {/* Nav + URL bar. On the review tab there is no page to navigate, so the
          page controls go away rather than sit there dead. */}
      <div className="flex items-center gap-1 border-b border-border px-2.5 pb-2 pt-1">
        {onReview ? (
          <div className="flex h-8 flex-1 items-center gap-2 px-1 text-xs text-text-muted">
            <FileDiff className="h-3.5 w-3.5 text-accent" />
            <span>Review changes</span>
          </div>
        ) : (
          <>
            <NavButton
              onClick={() => void api.browser.back()}
              disabled={!nav.canGoBack}
              title="Back"
            >
              <ArrowLeft className="h-4 w-4" />
            </NavButton>
            <NavButton
              onClick={() => void api.browser.forward()}
              disabled={!nav.canGoForward}
              title="Forward"
            >
              <ArrowRight className="h-4 w-4" />
            </NavButton>
            <NavButton onClick={reloadOrStop} title={nav.loading ? 'Stop' : 'Reload'}>
              {nav.loading ? <X className="h-4 w-4" /> : <RotateCw className="h-4 w-4" />}
            </NavButton>
            <div className="relative ml-1 flex-1">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-subtle">
                {!draft ? (
                  <Search className="h-3.5 w-3.5" />
                ) : (
                  <Globe className={cn('h-3.5 w-3.5', secure && 'text-success')} />
                )}
              </span>
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onFocus={() => setEditing(true)}
                onBlur={() => setEditing(false)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') go()
                }}
                placeholder="Search or enter a URL"
                spellCheck={false}
                autoComplete="off"
                className="h-8 w-full rounded-full border border-border bg-surface-2 pl-9 pr-3.5 text-xs text-text outline-none transition-colors placeholder:text-text-subtle focus:border-accent focus:bg-surface focus:ring-1 focus:ring-accent/35"
              />
            </div>
          </>
        )}
        <NavButton
          onClick={() => {
            void api.browser.newReviewTab()
            setCookiesOpen(false)
          }}
          title="Review changes (Ctrl+Shift+G)"
          active={onReview}
        >
          <FileDiff className="h-4 w-4" />
        </NavButton>
        <NavButton onClick={() => setCookiesOpen((v) => !v)} title="Cookies" active={cookiesOpen}>
          <Cookie className="h-4 w-4" />
        </NavButton>
      </div>

      {newTabMenu && (
        <ContextMenuSurface
          x={newTabMenu.x}
          y={newTabMenu.y}
          height={newTabMenuH}
          onClose={() => setNewTabMenu(null)}
        >
          <ContextMenuRow
            label="Browser"
            icon={Globe}
            accelerator="Ctrl+T"
            onSelect={() => {
              void api.browser.newTab()
              setNewTabMenu(null)
            }}
          />
          {!hasReview && (
            <ContextMenuRow
              label="Review"
              icon={FileDiff}
              accelerator="Ctrl+Shift+G"
              onSelect={() => {
                void api.browser.newReviewTab()
                setCookiesOpen(false)
                setNewTabMenu(null)
              }}
            />
          )}
        </ContextMenuSurface>
      )}

      {/* Both of these are rendered in the chrome rather than over the page,
          because a BrowserView can't be painted over -- main shrinks the page
          view to make room, so they genuinely sit on top. The cookie editor
          wins when open, since it's a transient popover over whatever tab
          you're on. */}
      {cookiesOpen ? (
        <CookiePanel
          host={host}
          className="min-h-0 flex-1"
          action={
            <NavButton onClick={() => setCookiesOpen(false)} title="Close cookies">
              <X className="h-3.5 w-3.5" />
            </NavButton>
          }
        />
      ) : (
        onReview && <ReviewPane sessionId={sessionId} className="min-h-0 flex-1" />
      )}
    </div>
  )
}

function NavButton({
  children,
  onClick,
  disabled,
  title,
  active
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
  title: string
  /** Held-down look, for buttons that toggle a panel open. */
  active?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'press-scale flex h-7 w-7 shrink-0 items-center justify-center sq sq-lg rounded-lg text-text-muted hover:bg-surface-2 hover:text-text disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-text-muted',
        active && 'bg-surface-2 text-text'
      )}
    >
      {children}
    </button>
  )
}
