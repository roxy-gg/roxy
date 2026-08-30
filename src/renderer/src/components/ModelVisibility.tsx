/**
 * Per-provider deny-list for the model picker, which lists 300-600 models per
 * gateway. Pinning promotes; this trims.
 *
 * A deny-list, not an allow-list: catalogs grow, and an allow-list would
 * withhold every future model until the user ticked it.
 *
 * Hiding is display-only — a session already on a hidden model keeps running
 * it. Windowed, since an expanded provider is ~600 rows.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, Eye, EyeOff, Search } from 'lucide-react'
import type { ModelInfo } from '@shared/api'
import { modelLabel } from '@shared/models'
import { useRoxyStore } from '../lib/store'
import { ProviderLogo } from '../lib/providerLogos'
import { rowOffsets, visibleRange } from '../lib/windowing'
import { Button } from './ui'
import { cn } from '../lib/cn'

/** Must match the row's rendered height — the window math assumes it. */
const ROW_H = 28
const LIST_H = 320

export function ModelVisibility(): JSX.Element {
  const { t } = useTranslation()
  const providers = useRoxyStore((s) => s.providers)
  const ensureModels = useRoxyStore((s) => s.ensureModels)
  const ensureHiddenModels = useRoxyStore((s) => s.ensureHiddenModels)

  useEffect(() => {
    void ensureHiddenModels()
    providers.forEach((p) => void ensureModels(p.id))
  }, [providers, ensureModels, ensureHiddenModels])

  if (providers.length === 0) {
    return <p className="text-xs text-text-muted">{t('settings.models.connectProvider')}</p>
  }

  return (
    <div className="flex flex-col gap-2">
      {providers.map((p) => (
        <ProviderModels key={p.id} providerId={p.id} providerName={p.name} />
      ))}
    </div>
  )
}

function ProviderModels({
  providerId,
  providerName
}: {
  providerId: string
  providerName: string
}): JSX.Element {
  const { t } = useTranslation()
  const catalog = useRoxyStore((s) => s.modelCatalog[providerId])
  const tried = useRoxyStore((s) => s.modelsTried[providerId])
  const hiddenModels = useRoxyStore((s) => s.hiddenModels)
  const setModelHidden = useRoxyStore((s) => s.setModelHidden)
  const setProviderHiddenModels = useRoxyStore((s) => s.setProviderHiddenModels)

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)

  // Collapsing unmounts the scroller, so a remembered scrollTop would window a
  // fresh (scrollTop 0) list to rows 200+ and render a screen of spacer.
  useEffect(() => {
    if (!open) setScrollTop(0)
  }, [open])

  const models = useMemo(() => catalog ?? [], [catalog])
  const hiddenCount = useMemo(
    () => models.reduce((n, m) => n + (hiddenModels.has(`${providerId}:${m.id}`) ? 1 : 0), 0),
    [models, hiddenModels, providerId]
  )
  const shown = models.length - hiddenCount

  /** Lowercased once per catalog, not per keystroke. */
  const searchable = useMemo(
    () =>
      models.map((m) => ({
        model: m,
        label: modelLabel(providerId, m.name, m.id),
        haystack: `${m.name.toLowerCase()}\u0000${m.id.toLowerCase()}`
      })),
    [models, providerId]
  )
  const q = query.trim().toLowerCase()
  const visible = useMemo(
    () => (q ? searchable.filter((e) => e.haystack.includes(q)) : searchable),
    [searchable, q]
  )

  const offsets = useMemo(
    () => rowOffsets(new Array<number>(visible.length).fill(ROW_H)),
    [visible.length]
  )
  const { first, last } = visibleRange(offsets, visible.length, scrollTop, LIST_H)

  const toggleAll = (hidden: boolean): void => {
    // Scoped to the search: "Hide all" under a query hides those matches, not
    // the whole catalog.
    const affected = visible.map((e) => e.model.id)
    const next = new Set(
      models.filter((m) => hiddenModels.has(`${providerId}:${m.id}`)).map((m) => m.id)
    )
    for (const id of affected) {
      if (hidden) next.add(id)
      else next.delete(id)
    }
    void setProviderHiddenModels(providerId, [...next])
  }

  return (
    <div className="overflow-hidden sq sq-xl sq-ring rounded-xl border border-border bg-surface">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={models.length === 0}
        aria-expanded={open}
        className="flex w-full items-center gap-3 p-3.5 text-left transition-colors hover:bg-white/5 disabled:hover:bg-transparent"
      >
        <ChevronRight
          className={cn(
            'h-4 w-4 shrink-0 text-text-subtle transition-transform duration-200 ease-out-quart',
            open && 'rotate-90'
          )}
        />
        <div className="flex h-8 w-8 items-center justify-center sq sq-lg sq-ring rounded-lg border border-border bg-surface-2">
          <ProviderLogo id={providerId} name={providerName} size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-text">{providerName}</div>
          <p className="mt-0.5 text-xs text-text-subtle">
            {models.length === 0
              ? tried
                ? t('settings.models.noneAvailable')
                : t('settings.models.loading')
              : hiddenCount === 0
                ? t('settings.models.allShown', { count: models.length })
                : t('settings.models.someHidden', {
                    shown,
                    total: models.length,
                    hidden: hiddenCount
                  })}
          </p>
        </div>
      </button>

      {open && models.length > 0 && (
        <div className="border-t border-border">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-text-subtle" />
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                // Or the filtered list opens scrolled into nothing.
                if (listRef.current) listRef.current.scrollTop = 0
                setScrollTop(0)
              }}
              placeholder={t('settings.models.searchPlaceholder', { count: models.length })}
              aria-label={t('settings.models.searchAria', { provider: providerName })}
              className="min-w-0 flex-1 bg-transparent text-xs text-text outline-none placeholder:text-text-subtle"
            />
            {/* The label states its scope, because the action is scoped to the
                search and "Hide all" over 14 matches would read as 600. */}
            <Button size="sm" variant="ghost" onClick={() => toggleAll(true)}>
              {q
                ? t('settings.models.hideCount', { count: visible.length })
                : t('settings.models.hideAll')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => toggleAll(false)}>
              {q
                ? t('settings.models.showCount', { count: visible.length })
                : t('settings.models.showAll')}
            </Button>
          </div>

          <div
            ref={listRef}
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
            style={{ maxHeight: LIST_H }}
            className="overflow-y-auto"
          >
            {visible.length === 0 ? (
              <div className="px-3 py-3 text-xs text-text-subtle">
                {t('models.noMatch', { query })}
              </div>
            ) : (
              <>
                <div style={{ height: offsets[first] }} />
                {visible.slice(first, last).map((entry) => (
                  <ModelToggle
                    key={entry.model.id}
                    info={entry.model}
                    label={entry.label}
                    hidden={hiddenModels.has(`${providerId}:${entry.model.id}`)}
                    onToggle={(hidden) => void setModelHidden(providerId, entry.model.id, hidden)}
                  />
                ))}
                <div style={{ height: offsets[visible.length] - offsets[last] }} />
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function ModelToggle({
  info,
  label,
  hidden,
  onToggle
}: {
  info: ModelInfo
  label: string
  hidden: boolean
  onToggle: (hidden: boolean) => void
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      onClick={() => onToggle(!hidden)}
      style={{ height: ROW_H }}
      title={info.id}
      className={cn(
        'group flex w-full items-center gap-2 px-3 text-left text-xs transition-colors hover:bg-white/5',
        hidden ? 'text-text-subtle' : 'text-text-muted hover:text-text'
      )}
    >
      <span className={cn('min-w-0 flex-1 truncate', hidden && 'line-through')}>{label}</span>
      {/* Right-aligned with Hide all / Show all so the pointer never crosses the
          row. Fixed width keeps the icon in one column as the word changes. */}
      <span
        className={cn(
          'w-14 shrink-0 text-right text-[11px] text-text-subtle transition-opacity',
          !hidden && 'opacity-0 group-hover:opacity-100'
        )}
      >
        {hidden ? t('settings.models.unhide') : t('settings.models.hide')}
      </span>
      {/* Only the acted-on state is accent: 600 accent eyes would read as the
          exception being the rule. */}
      {hidden ? (
        <EyeOff className="h-3.5 w-3.5 shrink-0 text-accent" />
      ) : (
        <Eye className="h-3.5 w-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
      )}
    </button>
  )
}
