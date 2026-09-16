import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Brain, Check, ChevronsUpDown, Search, Wrench, X } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { Trans, useTranslation } from 'react-i18next'
import { buildModelIndex, buildProviderModelRows, countMatchesByProvider } from '../lib/modelRows'
import { modelLabel, resolveProviderModel } from '@shared/models'
import { useRoxyStore } from '../lib/store'
import { resolveSessionConfig } from '@shared/session-config'
import { ProviderLogo } from '../lib/providerLogos'
import { triggerClass } from './InferenceControls'
import { useMenuAnchor } from '../lib/useMenuAnchor'
import { rowOffsets, visibleRange } from '../lib/windowing'
import { cn } from '../lib/cn'

/**
 * A cute, searchable model picker: the active provider's logo + model on the
 * trigger, and a popover with a horizontal provider carousel on top and the
 * active provider's available models windowed below.
 *
 * PERFORMANCE, and why this file looks the way it does
 * ----------------------------------------------------
 * The catalogs behind this are not small. A gateway provider (roxy.gg,
 * OpenRouter) reports 300-600 models, and switching tabs or searching needs to
 * stay instant. Measured with the real component and real catalog sizes:
 * mounting ~450 rows in a single commit caused ~200ms of React commit plus
 * ~60ms of layout to open, and ~100ms per keystroke in the search field.
 *
 * Three things fix it, in order of how much they matter:
 *
 *   1. WINDOWING (`useWindow` + `lib/windowing`). The menu is height-capped at
 *      380px and rows have known heights, so at most ~14 can ever be visible.
 *      We take the current provider's model list and mount only the visible slice
 *      plus a small overscan, with spacer divs holding the scrollbar honest. Cost
 *      becomes a function of the WINDOW, not the catalog — opening is O(20 rows)
 *      whether the provider has 30 models or 3000.
 *
 *   2. INDEXING (`index`). Every row used to run `models[provider].find(...)`
 *      two or three times to resolve its own label and capabilities — quadratic
 *      in the catalog. One memoized Map keyed `provider:model` makes each
 *      lookup O(1).
 *
 *   3. MEMOIZING THE SEARCH. Filtering lowercased every model name on every
 *      keystroke. Names are lowercased once when the catalog loads, and the
 *      filtered result is memoized on the query.
 *
 * The fixed row height is the load-bearing assumption for (1): it is what lets
 * us compute the visible slice arithmetically instead of measuring. ROW_H
 * must therefore match the button's classes below.
 */
const MENU_W = 320
/** Row height in px for each model row. */
const ROW_H = 32

/**
 * Track a scroll container's visible band, in px.
 *
 * Deliberately not throttled to rAF: the handler only reads `scrollTop` and
 * sets a number, and React already batches the resulting render. Adding a frame
 * of latency here would make the list visibly lag the scrollbar.
 *
 * `reset` exists because a scroll set programmatically (jumping back to the top
 * when the query changes) fires its `scroll` event ASYNCHRONOUSLY. Without it
 * we would render one frame with the new, shorter row list against the old
 * scroll offset — a flash of blank menu on the first keystroke.
 */
function useWindow(
  ref: React.RefObject<HTMLElement>,
  open: boolean
): { band: { top: number; height: number }; reset: () => void } {
  const [band, setBand] = useState({ top: 0, height: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!open || !el) return
    setBand({ top: el.scrollTop, height: el.clientHeight })
    const onScroll = (): void => setBand({ top: el.scrollTop, height: el.clientHeight })
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [ref, open])
  const reset = useCallback((): void => {
    const el = ref.current
    if (!el) return
    el.scrollTop = 0
    setBand((b) => (b.top === 0 ? b : { top: 0, height: el.clientHeight || b.height }))
  }, [ref])
  return { band, reset }
}

export function ModelPicker(): JSX.Element {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const providers = useRoxyStore((s) => s.providers)
  const settings = useRoxyStore((s) => s.settings)
  // Only the ACTIVE chat's config matters here, and it is the sole reason this
  // component ever needed `chats`. Subscribing to the whole array re-rendered
  // the open menu on every sidebar tick and every streamed title update.
  const activeChat = useRoxyStore((s) => s.chats.find((c) => c.id === s.activeChatId))
  const selectModel = useRoxyStore((s) => s.selectModel)
  const models = useRoxyStore((s) => s.modelCatalog)
  const modelsTried = useRoxyStore((s) => s.modelsTried)
  const ensureModels = useRoxyStore((s) => s.ensureModels)
  const hiddenModels = useRoxyStore((s) => s.hiddenModels)
  const ensureHiddenModels = useRoxyStore((s) => s.ensureHiddenModels)

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const carouselRef = useRef<HTMLDivElement>(null)
  const activeTabRef = useRef<HTMLButtonElement>(null)

  const anchor = useMenuAnchor(rootRef, open, MENU_W, { gap: 8, maxHeight: 380 })
  const { band, reset: resetScroll } = useWindow(listRef, open)

  const config = useMemo(() => resolveSessionConfig(activeChat, settings), [activeChat, settings])
  const activeProvider = useMemo(
    () => providers.find((p) => p.id === config.providerId) ?? providers[0] ?? null,
    [providers, config.providerId]
  )
  const selectedModel = activeProvider?.id === config.providerId ? config.model : null
  const activeModel =
    activeProvider?.id === 'github-copilot'
      ? resolveProviderModel(activeProvider, models[activeProvider.id] ?? [], selectedModel)
      : selectedModel

  const [selectedProviderId, setSelectedProviderId] = useState<string>('')

  // Sync selected provider tab with active provider when popover opens
  useEffect(() => {
    if (open) {
      setSelectedProviderId(activeProvider?.id ?? providers[0]?.id ?? '')
    }
  }, [open, activeProvider?.id, providers])

  const currentProvider = useMemo(
    () =>
      providers.find((p) => p.id === selectedProviderId) ?? activeProvider ?? providers[0] ?? null,
    [providers, selectedProviderId, activeProvider]
  )

  // Lazy-load every connected provider's models into shared caches
  useEffect(() => {
    void ensureHiddenModels()
    providers.forEach((p) => {
      void ensureModels(p.id)
    })
  }, [providers, ensureModels, ensureHiddenModels])

  useEffect(() => {
    if (!open) return
    void ensureModels('github-copilot')
    if (selectedProviderId) void ensureModels(selectedProviderId)
  }, [open, selectedProviderId, ensureModels])

  // Close on outside click / Escape
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Reset scroll when query or provider tab changes
  useLayoutEffect(() => {
    resetScroll()
  }, [query, selectedProviderId, resetScroll])

  // Auto-scroll the active tab into view in the carousel
  useLayoutEffect(() => {
    const tab = activeTabRef.current
    const rail = carouselRef.current
    if (!open || !tab || !rail) return
    rail.scrollLeft = tab.offsetLeft - rail.clientWidth / 2 + tab.clientWidth / 2
  }, [open, selectedProviderId])

  const handleCarouselWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (e.deltaY !== 0) {
      e.currentTarget.scrollLeft += e.deltaY
    }
  }, [])

  const index = useMemo(() => buildModelIndex(models), [models])
  const q = query.trim().toLowerCase()

  const currentCatalog = useMemo(
    () => (currentProvider ? (models[currentProvider.id] ?? []) : []),
    [currentProvider, models]
  )

  const rows = useMemo(() => {
    if (!currentProvider) return []
    return buildProviderModelRows({
      provider: currentProvider,
      catalog: currentCatalog,
      index,
      query,
      hidden: hiddenModels
    })
  }, [currentProvider, currentCatalog, index, query, hiddenModels])

  const matchCounts = useMemo(() => {
    if (!q) return {}
    return countMatchesByProvider({
      providers,
      catalogs: models,
      index,
      query,
      hidden: hiddenModels
    })
  }, [providers, models, index, query, hiddenModels, q])

  const otherMatches = useMemo(() => {
    if (!q) return []
    return providers
      .filter((p) => p.id !== currentProvider?.id && (matchCounts[p.id] ?? 0) > 0)
      .map((p) => ({
        id: p.id,
        name: p.name,
        count: matchCounts[p.id] ?? 0
      }))
  }, [q, providers, currentProvider?.id, matchCounts])

  const offsets = useMemo(
    () => rowOffsets(new Array<number>(rows.length).fill(ROW_H)),
    [rows.length]
  )
  const totalH = offsets.length ? offsets[offsets.length - 1] : 0
  const { first, last } = useMemo(
    () =>
      visibleRange(offsets, rows.length, band.top, band.height || Number(anchor.maxHeight) || 360),
    [offsets, rows.length, band.top, band.height, anchor.maxHeight]
  )
  const visibleRows = rows.slice(first, last)

  const loading = Boolean(
    currentProvider && !models[currentProvider.id] && !modelsTried[currentProvider.id]
  )

  const allHidden = Boolean(
    currentProvider && (models[currentProvider.id] ?? []).length > 0 && rows.length === 0
  )

  const triggerLabel = useMemo(() => {
    if (!activeModel) return t('models.selectModel')
    if (!activeProvider) return activeModel
    const name = index.get(`${activeProvider.id}:${activeModel}`)?.info.name
    return name ? modelLabel(activeProvider.id, name, activeModel) : activeModel
  }, [activeModel, activeProvider, index, t])

  const pick = useCallback(
    async (providerId: string, modelId: string): Promise<void> => {
      // Close FIRST. `selectModel` awaits two IPC round trips (session config,
      // then the refreshed recents), and leaving the menu up until they resolve
      // is what made a click feel like it hadn't registered.
      setOpen(false)
      setQuery('')
      await selectModel(providerId, modelId)
    },
    [selectModel]
  )

  if (providers.length === 0) {
    return <span className="px-1 text-xs text-text-subtle">{t('models.noProvider')}</span>
  }

  return (
    <div ref={rootRef} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} className={triggerClass}>
        {activeProvider && (
          <ProviderLogo id={activeProvider.id} name={activeProvider.name} size={14} />
        )}
        <span className="max-w-[200px] truncate">{triggerLabel}</span>
        <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-60" />
      </button>

      {open && (
        <div
          className="animate-pop-in absolute bottom-full z-50 mb-2 flex flex-col overflow-hidden sq-frame sq-xl sq-fill-elevated sq-ring edge edge-strong edge-panel rounded-xl border border-border bg-elevated shadow-float origin-bottom-left"
          style={anchor}
        >
          {/* Provider Carousel */}
          <div className="relative border-b border-border/70 bg-surface/40">
            <div
              ref={carouselRef}
              onWheel={handleCarouselWheel}
              className="flex items-center gap-1 overflow-x-auto px-2 py-1.5 scroll-smooth [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              {providers.map((p) => {
                const isSelected = p.id === currentProvider?.id
                const count = matchCounts[p.id]
                const hasQuery = Boolean(q)
                const hasMatches = (count ?? 0) > 0

                return (
                  <button
                    key={p.id}
                    ref={isSelected ? activeTabRef : undefined}
                    type="button"
                    onClick={() => {
                      setSelectedProviderId(p.id)
                      void ensureModels(p.id)
                    }}
                    title={p.name}
                    className={cn(
                      'group relative flex shrink-0 flex-col items-center justify-center rounded-lg p-1 transition-all',
                      isSelected ? 'text-text' : 'text-text-subtle hover:text-text',
                      hasQuery && !hasMatches && !isSelected && 'opacity-40 hover:opacity-75'
                    )}
                  >
                    <div
                      className={cn(
                        'relative flex h-9 w-9 items-center justify-center rounded-lg transition-all',
                        isSelected
                          ? 'bg-accent/15 ring-1 ring-accent/30 shadow-xs'
                          : 'bg-white/[0.04] hover:bg-white/[0.08]'
                      )}
                    >
                      <ProviderLogo id={p.id} name={p.name} size={20} />
                      {hasQuery && count !== undefined && count > 0 && (
                        <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent/90 px-1.5 py-0.5 text-[10px] font-semibold text-white shadow-xs">
                          {count > 99 ? '99+' : count}
                        </span>
                      )}
                    </div>
                    {/* Active indicator bar */}
                    <div
                      className={cn(
                        'mt-1 h-[2.5px] rounded-full transition-all duration-150',
                        isSelected ? 'w-5 bg-accent opacity-100' : 'w-0 bg-transparent opacity-0'
                      )}
                    />
                  </button>
                )
              })}
            </div>
          </div>

          {/* Search Input (above model list) */}
          <div className="flex shrink-0 items-center gap-2 border-b border-border/70 px-3 py-2 bg-surface/20">
            <Search className="h-3.5 w-3.5 shrink-0 text-text-subtle" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('models.search')}
              className="w-full bg-transparent text-xs text-text outline-none placeholder:text-text-subtle"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="rounded p-0.5 text-text-subtle transition hover:bg-white/10 hover:text-text"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>

          {/* No vertical padding on the scroller: `scrollTop` is measured from
              the padding box, so any padding here would offset every row
              against the windowing math that positions them. */}
          <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
            {rows.length > 0 && (
              // Spacers stand in for the rows we didn't mount, so the scrollbar
              // reflects the full list and the visible slice lands at the right
              // offset.
              <>
                <div style={{ height: offsets[first] }} />
                {visibleRows.map((row) => {
                  const isCurrentActive =
                    row.providerId === activeProvider?.id && row.modelId === activeModel
                  return (
                    <button
                      key={row.key}
                      type="button"
                      onClick={() => pick(row.providerId, row.modelId)}
                      style={{ height: ROW_H }}
                      className={cn(
                        'group flex w-full items-center gap-2 px-3 text-left text-xs transition',
                        isCurrentActive
                          ? 'bg-accent/15 font-medium text-text'
                          : 'text-text-muted hover:bg-white/5 hover:text-text'
                      )}
                    >
                      <Check
                        className={cn(
                          'h-3.5 w-3.5 shrink-0',
                          isCurrentActive ? 'text-accent' : 'opacity-0'
                        )}
                      />
                      <span className="min-w-0 flex-1 truncate" title={row.label}>
                        {row.label}
                      </span>
                      {row.info?.reasoning && (
                        <span title={t('models.reasoning')}>
                          <Brain className="h-3 w-3 shrink-0 text-accent" />
                        </span>
                      )}
                      {row.info?.toolCall && (
                        <span title={t('models.tools')}>
                          <Wrench className="h-3 w-3 shrink-0 text-success" />
                        </span>
                      )}
                    </button>
                  )
                })}
                <div style={{ height: totalH - offsets[last] }} />
              </>
            )}

            {rows.length === 0 && loading && (
              <div className="px-3 py-4 text-center text-xs text-text-subtle">
                {t('models.loading')}
              </div>
            )}

            {rows.length === 0 && !loading && q && (
              <div className="px-3 py-3 text-xs text-text-subtle">
                <div>
                  {t('models.noMatchInProvider', {
                    query,
                    provider: currentProvider?.name ?? ''
                  })}
                </div>
                {otherMatches.length > 0 && (
                  <div className="mt-2.5">
                    <div className="text-[11px] font-medium text-text-subtle">
                      {t('models.matchesInOther')}
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {otherMatches.map((other) => (
                        <button
                          key={other.id}
                          type="button"
                          onClick={() => {
                            setSelectedProviderId(other.id)
                            void ensureModels(other.id)
                          }}
                          className="flex items-center gap-1.5 rounded-md border border-border/60 bg-white/[0.04] px-2 py-1 text-xs text-text transition hover:bg-white/10"
                        >
                          <ProviderLogo id={other.id} name={other.name} size={13} />
                          <span>{other.name}</span>
                          <span className="rounded-full bg-accent/20 px-1 py-0.5 text-[10px] font-semibold text-accent">
                            {other.count}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {rows.length === 0 && !loading && !q && allHidden && (
              <div className="px-3 py-3 text-xs text-text-subtle">
                <Trans
                  i18nKey="models.allHidden"
                  components={{
                    settings: (
                      <button
                        type="button"
                        onClick={() => {
                          setOpen(false)
                          navigate('/settings')
                        }}
                        className="text-accent hover:underline"
                      />
                    )
                  }}
                />
              </div>
            )}

            {rows.length === 0 && !loading && !q && !allHidden && (
              <div className="px-3 py-3 text-xs text-text-subtle">
                {currentProvider?.id === 'github-copilot'
                  ? t('models.copilotUnavailable')
                  : t('models.loadFailed')}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
