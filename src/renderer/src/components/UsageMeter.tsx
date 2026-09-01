/**
 * The usage/cost "menubar" — a titlebar pill showing today's spend, opening a
 * popover with an Overview tab plus one tab per provider. Each tab shows Today /
 * 30-day cost + tokens, the top model, and a 30-day daily-spend bar graph.
 *
 * Data is real provider token `usage` where the API reports it (Claude/Gemini
 * always; most OpenAI-compatible providers via `stream_options.include_usage`),
 * and a ~chars/4 estimate otherwise — so the numbers exist regardless of
 * provider. Cost is priced from the models.dev catalog at record time.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ProviderUsage, UsageDay, UsageStats } from '@shared/types'
import { useTranslation, Trans } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useRoxyStore } from '../lib/store'
import { cn } from '../lib/cn'
import { BarChart } from './dither-kit/bar-chart'
import { Bar } from './dither-kit/bar'
import type { ChartConfig } from './dither-kit/chart-context'

/** Close-on-outside-click / Escape for the popover. */
function usePopover(): {
  open: boolean
  setOpen: (v: boolean) => void
  ref: React.RefObject<HTMLDivElement>
} {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
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
  return { open, setOpen, ref }
}

/** Compact token count: 1.2M, 34K, 999. */
function formatTokens(n: number): string {
  if (n >= 1_000_000_000)
    return `${Number((n / 1_000_000_000).toFixed(n % 1_000_000_000 ? 1 : 0))}B`
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0))}M`
  if (n >= 1000) return `${Math.round(n / 1000)}K`
  return String(Math.round(n))
}

/** USD, with cents under $100 and whole dollars above (keeps the pill tidy). */
function formatUsd(n: number): string {
  if (n === 0) return '$0'
  if (n < 0.01) return '<$0.01'
  if (n < 100) return `$${n.toFixed(2)}`
  return `$${Math.round(n).toLocaleString()}`
}

/** Pretty a model id for the "Top model" line (drop a provider prefix if present). */
function prettyModel(id: string): string {
  const slash = id.lastIndexOf('/')
  return slash >= 0 ? id.slice(slash + 1) : id
}

/** A small labeled figure (e.g. "Today" / "$224.93"). */
function Figure({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-text-subtle">{label}</div>
      <div className="truncate text-[15px] font-semibold text-text tabular-nums">{value}</div>
    </div>
  )
}

/** 30-day daily-spend bar graph, rendered with dither-kit's dithered `BarChart`.
 *  Cost drives each bar's height, falling back to tokens when nothing is priced
 *  yet. A decorative "spark" — the `bloom="aura"` glow plus a hover lift — makes
 *  the fill shimmer without any crosshair/tooltip chrome. */
function SpendGraph({ daily }: { daily: UsageDay[] }): JSX.Element {
  const [hovered, setHovered] = useState(false)
  const priced = daily.some((d) => d.cost > 0)
  const val = (d: UsageDay): number => (priced ? d.cost : d.tokens)
  const peak = daily.reduce((a, b) => (val(b) > val(a) ? b : a), daily[0])

  // Memoize against `daily` — the dither engine compares `data`/`config` by
  // identity to drive its entrance replay, so a fresh array every render would
  // loop. Each row carries the value that drives bar height.
  const data = useMemo(
    () => daily.map((d) => ({ date: d.date, spend: val(d) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [daily, priced]
  )
  const { t } = useTranslation()
  // `t` in the deps: the identity change on a language switch is exactly when
  // the series label needs to be rebuilt.
  const config = useMemo<ChartConfig>(
    () => ({ spend: { label: t('usage.spend'), color: 'blue' } }),
    [t]
  )

  return (
    <div>
      <div className="mb-1 flex items-end justify-end">
        <span className="text-[11px] text-text-subtle tabular-nums">
          {priced ? formatUsd(peak ? peak.cost : 0) : formatTokens(peak ? peak.tokens : 0)}
        </span>
      </div>
      <div
        className="h-16 w-full"
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
      >
        <BarChart
          data={data}
          config={config}
          interactive={false}
          hovered={hovered}
          bloom="aura"
          margins={{ top: 4, right: 0, bottom: 0, left: 0 }}
        >
          <Bar dataKey="spend" variant="gradient" />
        </BarChart>
      </div>
    </div>
  )
}

/** The body of one tab (Overview or a provider) — the shared stat layout. */
function UsagePanel({
  title,
  subtitle,
  today,
  cost30,
  tokens30,
  latestTokens,
  topModel,
  daily,
  note
}: {
  title: string
  subtitle?: string
  today: number
  cost30: number
  tokens30: number
  latestTokens: number
  topModel: string | null
  daily: UsageDay[]
  note: string
}): JSX.Element {
  const { t } = useTranslation()
  const empty = tokens30 === 0
  return (
    <div className="p-3.5">
      <div className="mb-3 border-b border-border pb-3">
        <div className="text-sm font-semibold text-text">{title}</div>
        {subtitle && <div className="mt-0.5 text-xs text-text-subtle">{subtitle}</div>}
      </div>
      {empty ? (
        <div className="py-6 text-center text-xs text-text-subtle">{t('usage.empty')}</div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-x-6 gap-y-3">
            <Figure label={t('usage.today')} value={formatUsd(today)} />
            <Figure label={t('usage.cost30d')} value={formatUsd(cost30)} />
            <Figure label={t('usage.tokens30d')} value={formatTokens(tokens30)} />
            <Figure label={t('usage.latestTokens')} value={formatTokens(latestTokens)} />
          </div>
          <div className="mt-4">
            <SpendGraph daily={daily} />
          </div>
          {topModel && (
            <div className="mt-3 text-xs text-text-muted">
              <Trans
                i18nKey="usage.topModel"
                values={{ model: prettyModel(topModel) }}
                components={{ 1: <span className="text-text" /> }}
              />
            </div>
          )}
          <div className="mt-1 text-[11px] leading-snug text-text-subtle">{note}</div>
        </>
      )}
    </div>
  )
}

/** Build the estimate/pricing caveat line for a panel. */
function noteFor(hasEstimates: boolean, hasUnpriced: boolean, t: TFunction): string {
  const parts: string[] = []
  if (hasUnpriced) parts.push(t('usage.noteUnpriced'))
  if (hasEstimates) parts.push(t('usage.noteEstimates'))
  if (parts.length === 0) return t('usage.noteNoParts')
  return t('usage.noteWith', { parts: parts.join('; ') })
}

/** Latest-call token volume for a provider panel = today's tokens (a proxy for "recent"). */
function overviewPanel(stats: UsageStats, t: TFunction): JSX.Element {
  const o = stats.overview
  return (
    <UsagePanel
      title={t('usage.overview')}
      subtitle={t('usage.allProviders')}
      today={o.today.cost}
      cost30={o.last30d.cost}
      tokens30={o.last30d.tokens}
      latestTokens={o.today.tokens}
      topModel={o.topModel}
      daily={o.daily}
      note={noteFor(o.hasEstimates, o.hasUnpriced, t)}
    />
  )
}

function providerPanel(p: ProviderUsage, t: TFunction): JSX.Element {
  return (
    <UsagePanel
      title={p.name}
      subtitle={t('usage.last30Days')}
      today={p.today.cost}
      cost30={p.last30d.cost}
      tokens30={p.last30d.tokens}
      latestTokens={p.today.tokens}
      topModel={p.topModel}
      daily={p.daily}
      note={noteFor(p.hasEstimates, p.hasUnpriced, t)}
    />
  )
}

/**
 * The titlebar usage pill. Shows today's spend (or 30-day when today is $0) and
 * opens the dashboard popover. Hidden until there's any usage to show.
 */
export function UsageMeter(): JSX.Element | null {
  const { t } = useTranslation()
  const usageStats = useRoxyStore((s) => s.usageStats)
  const refreshUsage = useRoxyStore((s) => s.refreshUsage)
  const { open, setOpen, ref } = usePopover()
  const [tab, setTab] = useState<string>('overview')

  // Refresh whenever the popover opens, so it reflects the latest turn.
  useEffect(() => {
    if (open) void refreshUsage()
  }, [open, refreshUsage])

  if (!usageStats || usageStats.overview.last30d.tokens === 0) return null

  const o = usageStats.overview
  // Pill label: prefer today's cost; if nothing today, show the 30-day figure.
  const pillCost = o.today.cost > 0 ? o.today.cost : o.last30d.cost
  const pillTitle =
    o.today.cost > 0
      ? 'Spent today — click for usage & cost'
      : 'Spent in the last 30 days — click for usage & cost'

  const tabs = [
    { id: 'overview', label: 'Overview' },
    ...usageStats.providers.map((p) => ({ id: p.providerId, label: p.name }))
  ]
  const activeProvider = usageStats.providers.find((p) => p.providerId === tab)

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        title={pillTitle}
        className={cn(
          // No leading icon and so no `gap`: the value is already a currency
          // amount, so the `$` says what it is. A chart glyph beside it was
          // decoration competing with the number for the same job.
          'press-scale flex h-7 items-center sq sq-lg sq-ring edge rounded-lg border px-2 text-xs tabular-nums transition-colors',
          open
            ? 'border-border-strong [--sq-ring:var(--edge-strong)] bg-elevated text-text'
            : 'border-border bg-surface text-text-muted hover:border-border-strong hover:[--sq-ring:var(--edge-strong)] hover:text-text'
        )}
      >
        <span>{formatUsd(pillCost)}</span>
      </button>

      {open && (
        <div className="animate-pop-in absolute right-0 top-full z-50 mt-2 w-80 origin-top-right overflow-hidden sq-frame sq-xl sq-fill-elevated sq-ring edge edge-strong edge-panel rounded-xl border border-border bg-elevated shadow-float">
          <div className="border-b border-border p-2">
            <select
              value={tab}
              onChange={(e) => setTab(e.target.value)}
              aria-label="Usage provider"
              className="h-8 w-full cursor-pointer sq sq-lg sq-ring edge [--sq-bevel:transparent] rounded-lg border border-border bg-surface-2 px-2.5 text-xs font-medium text-text outline-none focus:[--sq-ring:var(--edge-strong)]"
            >
              {tabs.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          {tab === 'overview'
            ? overviewPanel(usageStats, t)
            : activeProvider
              ? providerPanel(activeProvider, t)
              : overviewPanel(usageStats, t)}
        </div>
      )}
    </div>
  )
}
