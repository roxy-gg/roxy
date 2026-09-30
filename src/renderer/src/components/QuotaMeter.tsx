/**
 * Subscription usage limits for the active session's provider: a titlebar pill
 * showing how much of the tightest limit is left for the session's model, and a
 * popover listing every window/model allowance the upstream reports.
 *
 * Only shown for plan-billed connections - the sidecar subscriptions (ChatGPT,
 * Claude, Google) and GitHub Copilot. API-key providers get the spend pill.
 *
 * Copilot bills by premium requests: each prompt costs its model's multiplier
 * against a monthly allowance, overage billed per request. The popover shows
 * the allowance, the current model's multiplier, and any overage spend.
 *
 * The popover can browse every connected subscription account, and move the
 * session onto a sibling account of the same provider (e.g. a second ChatGPT
 * login when the first is nearly spent) without leaving the chat.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, ArrowRightLeft, Loader2, RotateCw } from 'lucide-react'
import type { ConnectedProvider } from '@shared/types'
import type { ModelCost } from '@shared/api'
import { upstreamFor } from '@shared/cliproxy'
import {
  bucketAppliesTo,
  bucketsForModel,
  copilotBucketsForModel,
  copilotOverageUsd,
  planSource,
  type ConnectionQuota,
  type PremiumUsage,
  type QuotaBucket
} from '@shared/quota'
import { api } from '../lib/api'
import { useRoxyStore } from '../lib/store'
import { cn } from '../lib/cn'

/** Background refresh. The main process caches for a minute, so this is cheap. */
const POLL_MS = 5 * 60_000

/** "3d 4h", "2h 5m", "12m" - short enough for a row, unambiguous in any locale. */
function formatDuration(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60_000))
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

/** Healthy reads in the theme's accent; only low headroom switches to the status colors. */
function tone(remaining: number): string {
  if (remaining <= 10) return 'bg-danger'
  if (remaining <= 30) return 'bg-warning'
  return 'bg-accent'
}

function Meter({ value, className }: { value: number; className?: string }): JSX.Element {
  return (
    <div className={cn('h-1.5 overflow-hidden rounded-full bg-white/10', className)}>
      <div
        className={cn('h-full rounded-full transition-[width] duration-300', tone(value))}
        style={{ width: `${value}%` }}
      />
    </div>
  )
}

function BucketRow({ bucket, now }: { bucket: QuotaBucket; now: number }): JSX.Element {
  const { t } = useTranslation()
  const reset =
    bucket.resetsAt === undefined
      ? null
      : bucket.resetsAt <= now
        ? t('quota.resetReady')
        : t('quota.resetsIn', { time: formatDuration(bucket.resetsAt - now) })
  return (
    <div className="py-1.5">
      <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
        <span className="truncate text-text">{bucket.label}</span>
        <span className="shrink-0 tabular-nums text-text-muted">
          {t('quota.left', { percent: bucket.remaining })}
        </span>
      </div>
      <Meter value={bucket.remaining} />
      {reset && <div className="mt-1 text-[11px] text-text-subtle tabular-nums">{reset}</div>}
    </div>
  )
}

const plan = (seedId: string): ReturnType<typeof planSource> => planSource(seedId, upstreamFor)

/** Copilot identities are stored as `<github id>:<login>`; show the login. */
function identityOf(p: ConnectedProvider): string {
  if (!p.identity) return `#${p.accountNumber}`
  return p.seedId === 'github-copilot' ? (p.identity.split(':')[1] ?? p.identity) : p.identity
}

/** "ChatGPT · fred@x.com", or the account number when no email was captured. */
function accountName(p: ConnectedProvider): string {
  return `${plan(p.seedId)?.accountLabel ?? p.name} · ${identityOf(p)}`
}

function formatUsd(n: number): string {
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD' })
}

function formatMultiplier(m: number): string {
  return `${Number.isInteger(m) ? m : m.toFixed(2).replace(/0+$/, '')}x`
}

/** "$1.75 in / $14 out per 1M" - the rate this model draws credits at. */
function formatTokenRate(cost: ModelCost): string | null {
  if (cost.input === undefined && cost.output === undefined) return null
  const f = (n: number | undefined): string =>
    n === undefined
      ? '-'
      : `$${n.toLocaleString(undefined, { maximumFractionDigits: n < 1 ? 3 : 2 })}`
  return `${f(cost.input)} / ${f(cost.output)}`
}

function Stat({
  label,
  value,
  tone
}: {
  label: string
  value: string
  tone?: 'warning' | 'danger'
}): JSX.Element {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-text-subtle">{label}</div>
      <div
        className={cn(
          'truncate tabular-nums',
          tone === 'warning' ? 'text-warning' : tone === 'danger' ? 'text-danger' : 'text-text'
        )}
      >
        {value}
      </div>
    </div>
  )
}

/**
 * Copilot billing. Usage-based plans draw AI credits ($0.01 each) at a
 * per-token rate that varies by model; legacy plans spend premium requests at a
 * per-model multiplier. Either way: allowance used, this model's rate, spend
 * past the allowance, and what Roxy has spent on this account recently.
 */
function PremiumPanel({
  premium,
  multiplier,
  tokenCost,
  spend7d
}: {
  premium: PremiumUsage
  multiplier: number | undefined
  tokenCost: ModelCost | undefined
  spend7d: number | undefined
}): JSX.Element {
  const { t } = useTranslation()
  if (premium.unlimited) {
    return <div className="py-1.5 text-xs text-text-muted">{t('quota.premiumUnlimited')}</div>
  }
  const credits = premium.unit === 'credits'
  const overage = copilotOverageUsd(premium)
  const fmt = (n: number): string => Math.round(n).toLocaleString()

  let rate = '-'
  if (credits) {
    const r = tokenCost && formatTokenRate(tokenCost)
    if (r) rate = t('quota.perMillion', { rate: r })
  } else if (multiplier !== undefined) {
    rate =
      multiplier === 0
        ? t('quota.included')
        : t('quota.perPrompt', { rate: formatMultiplier(multiplier) })
  }

  let status: string
  let statusTone: 'warning' | 'danger' | undefined
  if (premium.blocked) {
    status = t('quota.blocked')
    statusTone = 'danger'
  } else if (premium.remaining > 0) {
    status = t('quota.leftOf', { left: fmt(premium.remaining) })
  } else if (premium.overagePermitted) {
    status = t('quota.billingExtra')
    statusTone = 'warning'
  } else {
    status = t('quota.blocked')
    statusTone = 'danger'
  }

  return (
    <div className="mb-2 grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border border-border bg-white/[0.02] p-2.5 text-xs">
      <Stat
        label={credits ? t('quota.creditsUsed') : t('quota.premiumUsed')}
        value={t('quota.premiumOf', { used: fmt(premium.used), total: fmt(premium.entitlement) })}
      />
      <Stat label={t('quota.status')} value={status} tone={statusTone} />
      <Stat label={credits ? t('quota.modelRatePerM') : t('quota.modelRate')} value={rate} />
      <Stat
        label={t('quota.overage')}
        value={formatUsd(overage)}
        tone={overage > 0 ? 'warning' : undefined}
      />
      {spend7d !== undefined && <Stat label={t('quota.roxySpend7d')} value={formatUsd(spend7d)} />}
    </div>
  )
}

export function QuotaMeter({
  provider,
  model
}: {
  provider: ConnectedProvider | undefined
  model: string | null | undefined
}): JSX.Element | null {
  const { t } = useTranslation()
  const providers = useRoxyStore((s) => s.providers)
  const selectModel = useRoxyStore((s) => s.selectModel)
  const catalog = useRoxyStore((s) => s.modelCatalog)
  const usageStats = useRoxyStore((s) => s.usageStats)
  const activeId = provider && provider.enabled && plan(provider.seedId) ? provider.id : null

  /** Every usable subscription account, grouped by provider, active one's group first. */
  const accounts = useMemo(() => {
    const subs = providers.filter((p) => p.enabled && plan(p.seedId))
    const rank = (p: ConnectedProvider): number => (p.seedId === provider?.seedId ? 0 : 1)
    return subs.sort(
      (a, b) =>
        rank(a) - rank(b) || a.seedId.localeCompare(b.seedId) || a.accountNumber - b.accountNumber
    )
  }, [providers, provider?.seedId])

  // Which account the popover is showing; follows the session unless browsed away.
  const [viewId, setViewId] = useState<string | null>(activeId)
  const [quotas, setQuotas] = useState<Record<string, ConnectionQuota>>({})
  const [loading, setLoading] = useState<string | null>(null)
  const [switching, setSwitching] = useState(false)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const load = useCallback(async (connectionId: string, force = false) => {
    const target = useRoxyStore.getState().providers.find((p) => p.id === connectionId)
    const upstream = target ? plan(target.seedId)?.source : undefined
    if (!upstream) return
    setLoading(connectionId)
    let q: ConnectionQuota
    try {
      q = await api.cliproxy.quota(connectionId, force)
    } catch (e) {
      q = {
        connectionId,
        upstream,
        buckets: [],
        fetchedAt: Date.now(),
        error: e instanceof Error ? e.message : String(e)
      }
    }
    setQuotas((prev) => ({ ...prev, [connectionId]: q }))
    setLoading((cur) => (cur === connectionId ? null : cur))
  }, [])

  // A session (or account) switch snaps the view back to what the chat uses.
  useEffect(() => {
    setViewId(activeId)
    setOpen(false)
    if (!activeId) return
    void load(activeId)
    const timer = setInterval(() => void load(activeId), POLL_MS)
    return () => clearInterval(timer)
  }, [activeId, load])

  // Opening is when the user is actually looking: pick up the latest turn's spend.
  useEffect(() => {
    if (open && viewId) void load(viewId)
  }, [open, viewId, load])

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

  if (!activeId || !provider) return null

  // Pill: always the session's own account and model.
  const activeQuota = quotas[activeId]
  const multiplierOf = (connectionId: string, m: string | undefined): number | undefined =>
    m ? catalog[connectionId]?.find((x) => x.id === m)?.premiumMultiplier : undefined
  const scoped = (
    q: ConnectionQuota,
    connectionId: string,
    m: string | undefined
  ): QuotaBucket[] =>
    q.upstream === 'copilot'
      ? copilotBucketsForModel(q, multiplierOf(connectionId, m))
      : bucketsForModel(q, m)
  const tightest = activeQuota ? scoped(activeQuota, activeId, model ?? undefined)[0] : undefined
  const activeAccount = plan(provider.seedId)!.accountLabel

  // Popover: whichever account is being browsed.
  const viewed = accounts.find((a) => a.id === viewId) ?? provider
  const viewedSpec = plan(viewed.seedId)!
  const fresh = quotas[viewed.id] ?? null
  const isActive = viewed.id === activeId
  // Another provider's catalog won't have this model; scope only within a family.
  const scopeModel = viewed.seedId === provider.seedId ? (model ?? undefined) : undefined
  const applicable = fresh ? scoped(fresh, viewed.id, scopeModel) : []
  const others = fresh
    ? fresh.buckets.filter((b) =>
        fresh.upstream === 'copilot' ? !applicable.includes(b) : !bucketAppliesTo(b, scopeModel)
      )
    : []
  const hasData = !!fresh && (fresh.buckets.length > 0 || !!fresh.premium)
  const viewedMultiplier = multiplierOf(viewed.id, scopeModel)
  const viewedTokenCost = scopeModel
    ? catalog[viewed.id]?.find((x) => x.id === scopeModel)?.cost
    : undefined
  const viewedSpend7d = usageStats?.providers.find((x) => x.providerId === viewed.id)?.last7d.cost
  const canSwitch = !isActive && viewed.seedId === provider.seedId && !!model
  const now = Date.now()

  const pillTitle = tightest
    ? t('quota.pillTitle', { percent: tightest.remaining, account: activeAccount })
    : (activeQuota?.error ?? t('quota.title', { account: activeAccount }))

  const switchAccount = async (): Promise<void> => {
    if (!model) return
    setSwitching(true)
    try {
      // Same seed means the same catalog, so the session's model carries over.
      await selectModel(viewed.id, model)
    } finally {
      setSwitching(false)
    }
  }

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        title={pillTitle}
        aria-expanded={open}
        className={cn(
          'press-scale flex h-7 items-center gap-1.5 sq sq-lg sq-ring edge rounded-lg border px-2 text-xs tabular-nums transition-colors',
          open
            ? 'border-border-strong [--sq-ring:var(--edge-strong)] bg-elevated text-text'
            : 'border-border bg-surface text-text-muted hover:border-border-strong hover:[--sq-ring:var(--edge-strong)] hover:text-text'
        )}
      >
        {tightest ? (
          <>
            <Meter value={tightest.remaining} className="w-4" />
            <span>{tightest.remaining}%</span>
          </>
        ) : activeQuota?.error ? (
          <AlertCircle className="h-3.5 w-3.5" />
        ) : (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        )}
      </button>

      {open && (
        <div className="animate-pop-in absolute right-0 top-full z-50 mt-2 w-72 origin-top-right overflow-hidden sq-frame sq-xl sq-fill-elevated sq-ring edge edge-strong edge-panel rounded-xl border border-border bg-elevated shadow-float">
          {accounts.length > 1 && (
            <div className="border-b border-border p-2">
              <select
                value={viewed.id}
                onChange={(e) => setViewId(e.target.value)}
                aria-label={t('quota.account')}
                className="h-8 w-full cursor-pointer sq sq-lg sq-ring edge [--sq-bevel:transparent] rounded-lg border border-border bg-surface-2 px-2.5 text-xs font-medium text-text outline-none focus:[--sq-ring:var(--edge-strong)]"
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {accountName(a)}
                    {a.id === activeId ? ` - ${t('quota.inUse')}` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="flex items-start justify-between gap-2 border-b border-border p-3.5 pb-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-text">
                {t('quota.title', { account: viewedSpec.accountLabel })}
              </div>
              <div className="mt-0.5 truncate text-xs text-text-subtle">
                {[identityOf(viewed), fresh?.plan && t('quota.plan', { plan: fresh.plan })]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void load(viewed.id, true)}
              disabled={loading === viewed.id}
              title={t('quota.refresh')}
              aria-label={t('quota.refresh')}
              className="press-scale flex h-6 w-6 shrink-0 items-center justify-center sq sq-lg rounded-md text-text-muted hover:bg-white/5 hover:text-text disabled:opacity-50"
            >
              <RotateCw className={cn('h-3.5 w-3.5', loading === viewed.id && 'animate-spin')} />
            </button>
          </div>
          <div className="max-h-[60vh] overflow-y-auto p-3.5 pt-2">
            {!fresh ? (
              <div className="py-6 text-center text-xs text-text-subtle">{t('quota.loading')}</div>
            ) : !hasData ? (
              <div className="py-4 text-center text-xs">
                <div className="font-medium text-text">{t('quota.unavailable')}</div>
                {fresh.error && <div className="mt-1 text-text-subtle">{fresh.error}</div>}
              </div>
            ) : (
              <>
                {fresh.premium && (
                  <PremiumPanel
                    premium={fresh.premium}
                    multiplier={viewedMultiplier}
                    tokenCost={viewedTokenCost}
                    spend7d={viewedSpend7d}
                  />
                )}
                {applicable.length > 0 && scopeModel && (
                  <div className="mb-0.5 mt-1 text-[11px] text-text-subtle">
                    {t('quota.currentModel', { model: scopeModel })}
                  </div>
                )}
                {applicable.map((b) => (
                  <BucketRow key={b.id} bucket={b} now={now} />
                ))}
                {others.length > 0 && (
                  <>
                    <div className="mb-0.5 mt-3 border-t border-border pt-2 text-[11px] text-text-subtle">
                      {t('quota.otherModels')}
                    </div>
                    {others.map((b) => (
                      <BucketRow key={b.id} bucket={b} now={now} />
                    ))}
                  </>
                )}
              </>
            )}
          </div>
          {canSwitch && (
            <div className="border-t border-border p-2">
              <button
                type="button"
                onClick={() => void switchAccount()}
                disabled={switching}
                className="press-scale flex h-8 w-full items-center justify-center gap-1.5 sq sq-lg sq-ring edge rounded-lg border border-border bg-surface-2 text-xs font-medium text-text hover:border-border-strong disabled:opacity-50"
              >
                {switching ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ArrowRightLeft className="h-3.5 w-3.5" />
                )}
                {t('quota.useAccount')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
