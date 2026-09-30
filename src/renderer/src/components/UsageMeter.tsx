/**
 * The usage/cost "menubar" - a titlebar pill showing the active session's
 * provider's last-7-day API spend, opening a popover with that provider's
 * 7-day cost + tokens, top model, and a daily-spend bar graph.
 *
 * Data is real provider token `usage` where the API reports it (Claude/Gemini
 * always; most OpenAI-compatible providers via `stream_options.include_usage`),
 * and a ~chars/4 estimate otherwise - so the numbers exist regardless of
 * provider. Cost is priced from the models.dev catalog at record time.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ConnectedProvider, ProviderUsage, UsageDay } from '@shared/types'
import { localDay } from '@shared/cost'
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

/** Daily-spend bar graph, rendered with dither-kit's dithered `BarChart`.
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
    () => ({ spend: { label: t('usage.spend'), color: 'accent' } }),
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

/** Build the estimate/pricing caveat line for a panel. */
function noteFor(hasEstimates: boolean, hasUnpriced: boolean, t: TFunction): string {
  const parts: string[] = []
  if (hasUnpriced) parts.push(t('usage.noteUnpriced'))
  if (hasEstimates) parts.push(t('usage.noteEstimates'))
  if (parts.length === 0) return t('usage.noteNoParts')
  return t('usage.noteWith', { parts: parts.join('; ') })
}

/**
 * The titlebar spend pill, scoped to the provider the active session uses:
 * that provider's last-7-day API spend, opening its 7-day breakdown.
 *
 * Subscription connections never render this - their cost is a flat plan fee,
 * so an API-rate dollar figure would be fiction; `QuotaMeter` shows their
 * remaining allowance instead.
 */
export function UsageMeter({
  provider
}: {
  provider: Pick<ConnectedProvider, 'id' | 'name' | 'auth'>
}): JSX.Element | null {
  const usageStats = useRoxyStore((s) => s.usageStats)
  const refreshUsage = useRoxyStore((s) => s.refreshUsage)
  const { open, setOpen, ref } = usePopover()

  // Refresh whenever the popover opens, so it reflects the latest turn.
  useEffect(() => {
    if (open) void refreshUsage()
  }, [open, refreshUsage])

  if (!usageStats) return null
  // A pay-per-use key always shows its spend, $0 on a quiet week included, so
  // the bill is one glance away. Keyless local servers cost nothing and only
  // show once they have traffic.
  const paid = provider.auth === 'api-key'
  const p =
    usageStats.providers.find((x) => x.providerId === provider.id) ??
    (paid ? idleUsage(provider) : undefined)
  if (!p || (p.last7d.tokens === 0 && !paid)) return null
  return <SpendPill p={p} open={open} setOpen={setOpen} popoverRef={ref} />
}

/** An all-zero summary for a paid provider with no recorded calls yet. */
function idleUsage(provider: Pick<ConnectedProvider, 'id' | 'name'>): ProviderUsage {
  const zero = { tokens: 0, cost: 0, calls: 0 }
  const now = Date.now()
  const daily: UsageDay[] = []
  for (let i = 29; i >= 0; i--) daily.push({ date: localDay(now - i * DAY_MS), tokens: 0, cost: 0 })
  return {
    providerId: provider.id,
    name: provider.name,
    today: zero,
    last30d: zero,
    last7d: zero,
    topModel7d: null,
    topModel: null,
    daily,
    hasEstimates: false,
    hasUnpriced: false
  }
}

const DAY_MS = 24 * 60 * 60 * 1000

function SpendPill({
  p,
  open,
  setOpen,
  popoverRef: ref
}: {
  p: ProviderUsage
  open: boolean
  setOpen: (v: boolean) => void
  popoverRef: React.RefObject<HTMLDivElement>
}): JSX.Element {
  const { t } = useTranslation()
  const week = p.daily.slice(-7)
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        title={t('usage.pillTitle', { provider: p.name })}
        className={cn(
          // No leading icon and so no `gap`: the value is already a currency
          // amount, so the `$` says what it is.
          'press-scale flex h-7 items-center sq sq-lg sq-ring edge rounded-lg border px-2 text-xs tabular-nums transition-colors',
          open
            ? 'border-border-strong [--sq-ring:var(--edge-strong)] bg-elevated text-text'
            : 'border-border bg-surface text-text-muted hover:border-border-strong hover:[--sq-ring:var(--edge-strong)] hover:text-text'
        )}
      >
        <span>{formatUsd(p.last7d.cost)}</span>
      </button>

      {open && (
        <div className="animate-pop-in absolute right-0 top-full z-50 mt-2 w-80 origin-top-right overflow-hidden sq-frame sq-xl sq-fill-elevated sq-ring edge edge-strong edge-panel rounded-xl border border-border bg-elevated shadow-float">
          <div className="p-3.5">
            <div className="mb-3 border-b border-border pb-3">
              <div className="text-sm font-semibold text-text">{p.name}</div>
              <div className="mt-0.5 text-xs text-text-subtle">{t('usage.last7Days')}</div>
            </div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-3">
              <Figure label={t('usage.today')} value={formatUsd(p.today.cost)} />
              <Figure label={t('usage.cost7d')} value={formatUsd(p.last7d.cost)} />
              <Figure label={t('usage.tokens7d')} value={formatTokens(p.last7d.tokens)} />
              <Figure label={t('usage.calls7d')} value={p.last7d.calls.toLocaleString()} />
            </div>
            <div className="mt-4">
              <SpendGraph daily={week} />
            </div>
            {p.topModel7d && (
              <div className="mt-3 text-xs text-text-muted">
                <Trans
                  i18nKey="usage.topModel"
                  values={{ model: prettyModel(p.topModel7d) }}
                  components={{ 1: <span className="text-text" /> }}
                />
              </div>
            )}
            <div className="mt-1 text-[11px] leading-snug text-text-subtle">
              {noteFor(p.hasEstimates, p.hasUnpriced, t)}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
