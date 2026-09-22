/** Account-scoped deny-list. Windowed for large catalogs; never affects running sessions. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Search } from 'lucide-react'
import { modelLabel } from '@shared/models'
import { useRoxyStore } from '../lib/store'
import { rowOffsets, visibleRange } from '../lib/windowing'
import { Button } from './ui'
import { cn } from '../lib/cn'

const ROW_H = 36
const LIST_H = 320

export function ModelVisibility({
  providerId,
  seedId,
  providerName,
  open
}: {
  providerId: string
  seedId: string
  providerName: string
  open: boolean
}): JSX.Element {
  const { t } = useTranslation()
  const catalog = useRoxyStore((s) => s.modelCatalog[providerId])
  const hiddenModels = useRoxyStore((s) => s.hiddenModels)
  const setModelHidden = useRoxyStore((s) => s.setModelHidden)
  const setProviderHiddenModels = useRoxyStore((s) => s.setProviderHiddenModels)
  const [query, setQuery] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  useEffect(() => {
    if (!open) {
      setQuery('')
      setScrollTop(0)
      if (listRef.current) listRef.current.scrollTop = 0
    }
  }, [open])
  const searchable = useMemo(
    () =>
      (catalog ?? []).map((m) => ({
        model: m,
        label: modelLabel(seedId, m.name, m.id),
        haystack: `${m.name}\u0000${m.id}`.toLowerCase()
      })),
    [catalog, seedId]
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
  const allHidden =
    visible.length > 0 && visible.every((e) => hiddenModels.has(`${providerId}:${e.model.id}`))

  const saveVisibility = async (save: () => Promise<void>): Promise<void> => {
    if (saving) return
    const prefix = `${providerId}:`
    const previous = [...hiddenModels].filter((key) => key.startsWith(prefix))
    setSaving(true)
    setError(false)
    try {
      await save()
    } catch {
      // The store updates optimistically. Restore this account on failure,
      // without undoing changes to any other account.
      useRoxyStore.setState((s) => ({
        hiddenModels: new Set(
          [...s.hiddenModels].filter((key) => !key.startsWith(prefix)).concat(previous)
        )
      }))
      setError(true)
    } finally {
      setSaving(false)
    }
  }
  const toggleAll = (): void => {
    // Preserve hidden entries absent from the current catalog; only edit search matches.
    const prefix = `${providerId}:`
    const next = new Set(
      [...hiddenModels]
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length))
    )
    for (const entry of visible) {
      if (allHidden) next.delete(entry.model.id)
      else next.add(entry.model.id)
    }
    void saveVisibility(() => setProviderHiddenModels(providerId, [...next]))
  }
  if (!open) return <></>

  return (
    <div>
      <p className="px-4 pt-3 text-xs text-text-subtle">{t('settings.models.visibilityHint')}</p>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <label className="flex min-w-40 flex-1 items-center gap-2 rounded-md focus-within:ring-1 focus-within:ring-accent/50">
          <Search className="h-3.5 w-3.5 shrink-0 text-text-subtle" />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              if (listRef.current) listRef.current.scrollTop = 0
              setScrollTop(0)
            }}
            placeholder={t('settings.models.searchPlaceholder', { count: searchable.length })}
            aria-label={t('settings.models.searchAria', { provider: providerName })}
            className="h-8 min-w-0 flex-1 bg-transparent text-xs text-text outline-none placeholder:text-text-subtle"
          />
        </label>
        <Button
          size="sm"
          variant="ghost"
          aria-disabled={saving || visible.length === 0}
          onClick={() => {
            if (!saving && visible.length > 0) toggleAll()
          }}
        >
          {allHidden
            ? q
              ? t('settings.models.showCount', { count: visible.length })
              : t('settings.models.showAll')
            : q
              ? t('settings.models.hideCount', { count: visible.length })
              : t('settings.models.hideAll')}
        </Button>
      </div>
      {error && (
        <p role="alert" className="px-4 py-2 text-xs text-danger">
          {t('settings.models.saveFailed')}
        </p>
      )}
      <div
        ref={listRef}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        style={{ maxHeight: LIST_H }}
        className="overflow-y-auto"
      >
        {visible.length === 0 ? (
          <div className="px-4 py-3 text-xs text-text-subtle">{t('models.noMatch', { query })}</div>
        ) : (
          <>
            <div style={{ height: offsets[first] }} />
            {visible.slice(first, last).map(({ model, label }) => {
              const hidden = hiddenModels.has(`${providerId}:${model.id}`)
              return (
                <button
                  key={model.id}
                  type="button"
                  role="checkbox"
                  aria-checked={!hidden}
                  aria-label={label}
                  aria-disabled={saving}
                  onClick={() =>
                    void saveVisibility(() => setModelHidden(providerId, model.id, !hidden))
                  }
                  style={{ height: ROW_H }}
                  title={model.id}
                  className={cn(
                    'flex w-full items-center gap-3 px-4 text-left text-xs transition-colors hover:bg-white/5 focus-visible:bg-white/5 focus-visible:outline-none disabled:opacity-50',
                    hidden ? 'text-text-subtle' : 'text-text-muted hover:text-text'
                  )}
                >
                  <span
                    className={cn(
                      'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                      hidden ? 'border-border-strong' : 'border-text-muted bg-text-muted text-bg'
                    )}
                  >
                    {!hidden && <Check className="h-3 w-3" />}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                </button>
              )
            })}
            <div style={{ height: offsets[visible.length] - offsets[last] }} />
          </>
        )}
      </div>
    </div>
  )
}
