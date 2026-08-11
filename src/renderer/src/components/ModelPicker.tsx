import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Brain, Check, ChevronsUpDown, Clock, Pin, Search, Wrench } from 'lucide-react'
import { buildModelIndex, buildModelRows } from '../lib/modelRows'
import { useRoxyStore } from '../lib/store'
import { resolveSessionConfig } from '@shared/session-config'
import { ProviderLogo } from '../lib/providerLogos'
import { triggerClass } from './InferenceControls'
import { useMenuAnchor } from '../lib/useMenuAnchor'
import { rowOffsets, visibleRange } from '../lib/windowing'
import { cn } from '../lib/cn'

/**
 * A cute, searchable model picker: the active provider's logo + model on the
 * trigger, and a popover grouped by every connected provider (with its icon)
 * listing the real models models.dev knows about. A PINNED section (a
 * deliberate, user-curated shortlist — for people juggling many providers or
 * a provider with a huge catalog) sits above everything when non-empty,
 * followed by a LATEST section per provider showing its last five distinct
 * picks. Hovering any row reveals a pin toggle; nothing pinned means the
 * section simply doesn't render, so the feature costs zero space unused.
 *
 * PERFORMANCE, and why this file looks the way it does
 * ----------------------------------------------------
 * The catalogs behind this are not small. A gateway provider (roxy.gg,
 * OpenRouter) reports 300-600 models, and the menu shows EVERY connected
 * provider at once — so the naive version mounted ~450 rows, each with a logo
 * and up to three icons, in a single commit. Measured with the real component
 * and real catalog sizes: ~200ms of React commit plus ~60ms of layout to open,
 * and ~100ms per keystroke in the search field. That is the "clunky, delayed"
 * feel; it is one long task on the main thread, so the popover's own open
 * animation drops most of its frames too.
 *
 * Three things fix it, in order of how much they matter:
 *
 *   1. WINDOWING (`useWindow` + `lib/windowing`). The menu is height-capped at
 *      360px and rows have known heights, so at most ~14 can ever be visible.
 *      We flatten the whole menu into one array of row descriptors and mount
 *      only the visible slice plus a small overscan, with spacer divs holding
 *      the scrollbar honest. Cost becomes a function of the WINDOW, not the
 *      catalog — opening is O(20 rows) whether the user has 30 models or 3000.
 *
 *   2. INDEXING (`index`). Every row used to run `models[provider].find(...)`
 *      two or three times to resolve its own label, capabilities and pinned
 *      state — quadratic in the catalog. One memoized Map keyed `provider:model`
 *      makes each lookup O(1).
 *
 *   3. MEMOIZING THE SEARCH. Filtering lowercased every model name on every
 *      keystroke. Names are lowercased once when the catalog loads, and the
 *      filtered result is memoized on the query.
 *
 * The fixed row height is the load-bearing assumption for (1): it is what lets
 * us compute the visible slice arithmetically instead of measuring. ROW_H and
 * HEADER_H must therefore match the classes below.
 */
const MENU_W = 320
/** Row height in px — `py-1.5` (12) + `text-xs`/`leading-4` (16). Must match the button's classes. */
const ROW_H = 28
/** Section header height in px — `pt-2 pb-1` (12) + 11px text at leading-4 (16). */
const HEADER_H = 28

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
    // Measure once on open: the anchor's maxHeight decides how tall we are, and
    // that isn't known until the element exists.
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
  const providers = useRoxyStore((s) => s.providers)
  const settings = useRoxyStore((s) => s.settings)
  // Only the ACTIVE chat's config matters here, and it is the sole reason this
  // component ever needed `chats`. Subscribing to the whole array re-rendered
  // the open menu on every sidebar tick and every streamed title update.
  const activeChat = useRoxyStore((s) => s.chats.find((c) => c.id === s.activeChatId))
  const selectModel = useRoxyStore((s) => s.selectModel)
  const models = useRoxyStore((s) => s.modelCatalog)
  const modelsTried = useRoxyStore((s) => s.modelsTried)
  const recentModels = useRoxyStore((s) => s.recentModels)
  const pinnedModels = useRoxyStore((s) => s.pinnedModels)
  const ensureModels = useRoxyStore((s) => s.ensureModels)
  const ensureRecentModels = useRoxyStore((s) => s.ensureRecentModels)
  const ensurePinnedModels = useRoxyStore((s) => s.ensurePinnedModels)
  const togglePinnedModel = useRoxyStore((s) => s.togglePinnedModel)

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // Leftmost control, so it only clips in a narrow window — but it clips the
  // same way, and one rule for all of them beats a special case.
  const anchor = useMenuAnchor(rootRef, open, MENU_W, { gap: 8 })
  const { band, reset: resetScroll } = useWindow(listRef, open)

  // The model shown is the OPEN SESSION's, not a global one: two sessions can
  // sit on different models at once, and each remembers its own across
  // restarts. A session with nothing pinned falls back to the last-used pair.
  const config = useMemo(() => resolveSessionConfig(activeChat, settings), [activeChat, settings])
  const activeProvider = useMemo(
    () => providers.find((p) => p.id === config.providerId) ?? providers[0] ?? null,
    [providers, config.providerId]
  )
  // Only show the session's model when it belongs to the provider we resolved.
  // A session pinned to a provider that was since disconnected falls back to
  // another one, and labelling that fallback with the old model would claim a
  // pairing the turn will not actually use (the send path picks the fallback
  // provider's own default instead).
  const activeModel = activeProvider?.id === config.providerId ? config.model : null

  // Lazy-load every connected provider's models and recents into shared caches.
  useEffect(() => {
    void ensurePinnedModels()
    providers.forEach((p) => {
      void ensureModels(p.id)
      void ensureRecentModels(p.id)
    })
  }, [providers, ensureModels, ensureRecentModels, ensurePinnedModels])

  // Close on outside click / Escape.
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

  // Reset the scroll position when the query changes, or a filtered list would
  // open scrolled into the middle of nothing.
  useLayoutEffect(() => {
    resetScroll()
  }, [query, resetScroll])

  // ---- derived data, all memoized ------------------------------------------

  /**
   * `providerId:modelId` -> model + pre-lowercased search text. Rebuilt only
   * when a catalog actually loads, not on every render.
   */
  const index = useMemo(() => buildModelIndex(models), [models])

  const q = query.trim().toLowerCase()

  /**
   * The whole menu as a flat list of rows. The only place that walks the
   * catalogs, and it re-runs only when the catalogs, pins, recents or the query
   * change - not when the popover re-renders for a scroll.
   */
  const rows = useMemo(
    () =>
      buildModelRows({
        providers,
        catalogs: models,
        recent: recentModels,
        pinned: pinnedModels,
        index,
        query
      }),
    [providers, models, recentModels, pinnedModels, index, query]
  )

  /**
   * Row offsets, so a header and a row can differ in height while the window
   * math stays a pair of binary searches. Cheap: one pass over the row list.
   */
  const offsets = useMemo(
    () => rowOffsets(rows.map((r) => (r.kind === 'header' ? HEADER_H : ROW_H))),
    [rows]
  )

  const totalH = offsets.length ? offsets[offsets.length - 1] : 0
  // Which rows the 360px viewport can actually see, plus overscan. `height` is
  // 0 on the very first paint (the element hasn't been measured yet), so fall
  // back to the anchor's ceiling rather than rendering nothing.
  const { first, last } = useMemo(
    () =>
      visibleRange(offsets, rows.length, band.top, band.height || Number(anchor.maxHeight) || 360),
    [offsets, rows.length, band.top, band.height, anchor.maxHeight]
  )

  // A provider is "loading" only until its own fetch settles. All-or-nothing
  // used to blank the entire menu — including already-loaded pinned entries —
  // behind whichever provider answered last.
  const loading = providers.length > 0 && providers.some((p) => !models[p.id] && !modelsTried[p.id])

  const triggerLabel = useMemo(() => {
    if (!activeModel) return 'Select a model'
    if (!activeProvider) return activeModel
    return index.get(`${activeProvider.id}:${activeModel}`)?.info.name ?? activeModel
  }, [activeModel, activeProvider, index])

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

  const togglePin = useCallback(
    (e: React.MouseEvent, providerId: string, modelId: string, pinned: boolean): void => {
      e.stopPropagation()
      void togglePinnedModel(providerId, modelId, !pinned)
    },
    [togglePinnedModel]
  )

  if (providers.length === 0) {
    return <span className="px-1 text-xs text-text-subtle">No provider connected</span>
  }

  const visible: JSX.Element[] = []
  for (let i = first; i < last; i++) {
    const row = rows[i]
    if (row.kind === 'header') {
      visible.push(
        <div
          key={row.key}
          style={{ height: HEADER_H }}
          className="flex items-center gap-1.5 px-3 text-[11px] font-medium uppercase tracking-wide text-text-subtle"
        >
          {row.icon === 'pin' && <Pin className="h-3 w-3 shrink-0 fill-current" />}
          {row.icon === 'clock' && <Clock className="h-3 w-3 shrink-0" />}
          {row.icon === 'provider' && (
            <ProviderLogo id={row.providerId} name={row.label} size={13} />
          )}
          {row.label}
        </div>
      )
      continue
    }
    const selected = row.providerId === activeProvider?.id && row.modelId === activeModel
    visible.push(
      <button
        key={row.key}
        type="button"
        onClick={() => pick(row.providerId, row.modelId)}
        style={{ height: ROW_H }}
        className={cn(
          'group flex w-full items-center gap-2 px-3 text-left text-xs transition',
          selected ? 'bg-accent/15 text-text' : 'text-text-muted hover:bg-white/5 hover:text-text'
        )}
      >
        <Check className={cn('h-3.5 w-3.5 shrink-0', selected ? 'text-accent' : 'opacity-0')} />
        <ProviderLogo id={row.providerId} name={row.providerName} size={14} />
        <span className="min-w-0 flex-1 truncate">{row.label}</span>
        {row.info?.reasoning && <Brain className="h-3 w-3 shrink-0 text-accent" />}
        {row.info?.toolCall && <Wrench className="h-3 w-3 shrink-0 text-success" />}
        {/* A <span> rather than a nested <button>: a button inside a button is
            invalid HTML, and the browser is free to drop the inner one. */}
        <span
          role="button"
          tabIndex={-1}
          title={row.pinned ? 'Unpin model' : 'Pin model'}
          onClick={(e) => togglePin(e, row.providerId, row.modelId, row.pinned)}
          className={cn(
            'shrink-0 rounded p-0.5 transition hover:bg-white/10',
            row.pinned ? 'text-accent' : 'text-text-subtle opacity-0 group-hover:opacity-100'
          )}
        >
          <Pin className={cn('h-3 w-3', row.pinned && 'fill-current')} />
        </span>
      </button>
    )
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
          className="animate-pop-in absolute bottom-full z-50 mb-2 flex flex-col overflow-hidden sq-frame sq-xl sq-fill-elevated sq-ring rounded-xl border border-border bg-elevated shadow-2xl origin-bottom-left"
          style={anchor}
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-text-subtle" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search models…"
              className="w-full bg-transparent text-xs text-text outline-none placeholder:text-text-subtle"
            />
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
                {visible}
                <div style={{ height: totalH - offsets[last] }} />
              </>
            )}
            {rows.length === 0 && loading && (
              <div className="px-3 py-3 text-xs text-text-subtle">Loading models…</div>
            )}
            {rows.length === 0 && !loading && q && (
              <div className="px-3 py-3 text-xs text-text-subtle">No models match “{query}”.</div>
            )}
            {rows.length === 0 && !loading && !q && (
              <div className="px-3 py-3 text-xs text-text-subtle">
                Couldn&apos;t load models from models.dev — you can still send with the current
                model.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
