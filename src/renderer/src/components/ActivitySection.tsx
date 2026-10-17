import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ActivityStats } from '@shared/types'
import { api } from '../lib/api'
import { useRoxyStore } from '../lib/store'
import { ContributionGraph } from './ContributionGraph'

export function ActivitySection(): JSX.Element {
  const { t, i18n } = useTranslation()
  const [stats, setStats] = useState<ActivityStats | null>(null)
  const [failed, setFailed] = useState(false)
  // Usage refreshes after every completed turn, keeping this ledger-backed view live.
  const usageStats = useRoxyStore((s) => s.usageStats)

  useEffect(() => {
    let alive = true
    setFailed(false)
    api.activity
      .stats()
      .then((data) => {
        if (alive) setStats(data)
      })
      .catch(() => {
        if (alive) setFailed(true)
      })
    return () => {
      alive = false
    }
  }, [usageStats])

  if (failed)
    return (
      <p role="alert" className="text-sm text-text-muted">
        {t('settings.activity.failed')}
      </p>
    )
  if (!stats)
    return (
      <p role="status" className="text-sm text-text-muted">
        {t('common.loading')}
      </p>
    )

  const number = new Intl.NumberFormat(i18n.language)
  const date = (value: string): string => {
    const [year, month, day] = value.split('-').map(Number)
    return new Intl.DateTimeFormat(i18n.language, {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    }).format(new Date(year, month - 1, day))
  }
  const recent = stats.days.slice(-7).reverse()
  const recentTotal = recent.reduce((total, day) => total + day.count, 0)
  const summaries = [
    { label: 'settings.activity.total', value: stats.total, unit: 'turns' },
    { label: 'settings.activity.activeDays', value: stats.activeDays, unit: 'days' },
    { label: 'settings.activity.currentStreak', value: stats.currentStreak, unit: 'days' },
    { label: 'settings.activity.longestStreak', value: stats.longestStreak, unit: 'days' }
  ] as const

  return (
    <section className="@container mb-8">
      <h2 className="text-sm font-medium text-text">{t('settings.navigation.activity')}</h2>
      <p className="mt-1 mb-4 text-xs text-text-muted">{t('settings.activity.description')}</p>
      {/* The tooltip must be able to escape the graph card's rounded frame. */}
      <div className="sq-frame sq-xl sq-ring sq-fill-surface rounded-xl border border-border bg-surface p-4">
        <ContributionGraph data={stats} />
        {stats.days.length > 0 && (
          <p className="mt-3 text-[11px] text-text-subtle">
            {t('settings.activity.period', {
              start: date(stats.days[0].date),
              end: date(stats.days[stats.days.length - 1].date)
            })}
          </p>
        )}
      </div>
      {stats.total === 0 && (
        <p className="mt-4 text-sm text-text-muted">{t('settings.navigation.activityEmpty')}</p>
      )}
      <dl className="mt-4 grid grid-cols-2 gap-3 @min-[600px]:grid-cols-4">
        {summaries.map(({ label, value, unit }) => (
          <div
            key={label}
            className="min-w-0 sq sq-xl sq-ring rounded-xl border border-border bg-surface p-4"
          >
            <dt className="text-xs text-text-muted">{t(label)}</dt>
            <dd className="mt-2 text-2xl font-semibold tracking-tight tabular-nums text-text">
              {number.format(value)}
            </dd>
            <dd className="mt-1 text-[11px] text-text-subtle">
              {unit === 'turns'
                ? t('settings.activity.turns', { count: value })
                : t('settings.activity.days', { count: value })}
            </dd>
          </div>
        ))}
      </dl>
      <section className="mt-8" aria-labelledby="activity-recent-heading">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h3 id="activity-recent-heading" className="text-sm font-medium text-text">
            {t('settings.activity.recent')}
          </h3>
          <span className="text-xs text-text-muted">
            {t('settings.activity.turnCount', {
              count: recentTotal,
              value: number.format(recentTotal)
            })}
          </span>
        </div>
        <div className="overflow-hidden sq sq-xl sq-ring rounded-xl border border-border bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-text-subtle">
                <th scope="col" className="px-4 py-3 text-start font-medium">
                  {t('settings.activity.date')}
                </th>
                <th scope="col" className="px-4 py-3 text-end font-medium">
                  {t('settings.activity.total')}
                </th>
              </tr>
            </thead>
            <tbody>
              {recent.map((day) => (
                <tr key={day.date} className="border-b border-border last:border-0">
                  <th scope="row" className="px-4 py-3 text-start font-normal text-text-muted">
                    <time dateTime={day.date}>{date(day.date)}</time>
                  </th>
                  <td className="px-4 py-3 text-end tabular-nums text-text">
                    {number.format(day.count)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-text-subtle">
          {t('settings.activity.peak', { count: stats.max, value: number.format(stats.max) })}
        </p>
      </section>
    </section>
  )
}
