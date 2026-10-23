import { Fragment, useEffect, useRef } from 'react'
import { ArrowUpRight, Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../lib/cn'
import {
  settingsSearchRanges,
  type SettingsSearchEntry,
  type SettingsSearchResult
} from '../lib/settings-search'

function Match({ text, query }: { text: string; query: string }): JSX.Element {
  const ranges = settingsSearchRanges(text, query)
  let end = 0
  return (
    <>
      {ranges.map(([start, next], index) => {
        const prefix = text.slice(end, start)
        end = next
        return (
          <Fragment key={index}>
            {prefix}
            <mark className="settings-search-match">{text.slice(start, next)}</mark>
          </Fragment>
        )
      })}
      {text.slice(end)}
    </>
  )
}

export function SettingsSearchResults({
  query,
  results,
  active,
  onActive,
  onSelect
}: {
  query: string
  results: SettingsSearchResult[]
  active: number
  onActive: (index: number) => void
  onSelect: (entry: SettingsSearchEntry) => void
}): JSX.Element {
  const { t } = useTranslation()
  const listRef = useRef<HTMLUListElement>(null)
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active, query])
  return (
    <section aria-labelledby="settings-search-heading" className="pb-1">
      <div className="mb-2 flex items-baseline justify-between gap-2 px-2">
        <h2
          id="settings-search-heading"
          className="text-[11px] font-semibold uppercase tracking-wide text-text-subtle"
        >
          {t('settings.search.heading')}
        </h2>
        <span role="status" aria-live="polite" className="text-[11px] tabular-nums text-text-muted">
          <span aria-hidden>{results.length}</span>
          <span className="sr-only">{t('settings.search.results', { count: results.length })}</span>
        </span>
      </div>
      <ul
        ref={listRef}
        id="settings-search-results"
        role="listbox"
        aria-label={t('settings.search.heading')}
        className="flex max-h-[32dvh] flex-col gap-0.5 overflow-y-auto sm:max-h-none sm:overflow-visible"
      >
        {results.map(({ entry, title, description, location, matchedTitle }, index) => (
          <li role="none" key={entry.section + entry.title}>
            <button
              id={'settings-search-result-' + index}
              type="button"
              role="option"
              aria-selected={index === active}
              tabIndex={-1}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => {
                if (index !== active) onActive(index)
              }}
              onClick={() => onSelect(entry)}
              title={description}
              className={cn(
                'group sq sq-lg flex w-full items-start gap-2 rounded-lg px-2.5 py-2.5 text-start transition-colors focus-visible:outline-2 focus-visible:outline-accent',
                index === active ? 'bg-elevated text-text' : 'text-text-muted hover:bg-surface-2'
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-medium leading-relaxed text-text">
                  <Match text={title} query={query} />
                </span>
                {matchedTitle && (
                  <span dir="auto" className="mt-0.5 block text-[11px] text-text-muted">
                    <Match text={matchedTitle} query={query} />
                  </span>
                )}
                <span className="mt-1 block text-[10px] leading-relaxed text-text-subtle">
                  <Match text={location} query={query} />
                </span>
              </span>
              <ArrowUpRight
                aria-hidden
                className={cn(
                  'mt-0.5 h-3.5 w-3.5 shrink-0',
                  index === active ? 'text-accent' : 'text-text-subtle'
                )}
              />
            </button>
          </li>
        ))}
      </ul>
      {!results.length && (
        <div className="px-2 py-5 text-center">
          <Search aria-hidden className="mx-auto mb-3 h-4 w-4 text-text-subtle" />
          <p className="break-words text-xs text-text-muted">
            {t('settings.search.empty', { query })}
          </p>
          <p className="mt-2 text-[11px] leading-relaxed text-text-subtle">
            {t('settings.search.hint')}
          </p>
        </div>
      )}
      {!!results.length && (
        <p
          id="settings-search-help"
          className="mt-3 border-t border-border px-2 pt-3 text-[10px] leading-relaxed text-text-subtle"
        >
          {t('settings.search.keyboardHint')}
        </p>
      )}
    </section>
  )
}
