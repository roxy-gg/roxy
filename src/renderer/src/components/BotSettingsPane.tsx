import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pencil, Plus, Trash2, X } from 'lucide-react'
import type { Bot, BotJob, BotSchedule } from '@shared/bots'
import { api } from '../lib/api'
import { useRoxyStore } from '../lib/store'
import { BotAvatar } from './BotAvatar'
import { Button, Input, Textarea } from './ui'

const fieldClass = 'flex flex-col gap-1.5 text-xs text-text-muted'
const selectClass =
  'h-9 w-full rounded-lg border border-border bg-surface-2 px-2 text-sm text-text outline-none focus:border-accent'
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Settings stay alongside the existing chat; jobs are configuration, not a second chat stack. */
export function BotSettingsPane({ bot, onClose }: { bot: Bot; onClose: () => void }): JSX.Element {
  const { t } = useTranslation()
  const refreshBots = useRoxyStore((s) => s.refreshBots)
  const removeBot = useRoxyStore((s) => s.removeBot)
  const [username, setUsername] = useState(bot.username)
  const [instructions, setInstructions] = useState(bot.instructions)
  const [jobs, setJobs] = useState<BotJob[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [editingJob, setEditingJob] = useState<BotJob | 'new' | null>(null)

  useEffect(() => {
    let live = true
    const reload = async (): Promise<void> => {
      try {
        const next = await api.bots.jobs(bot.id)
        if (live) setJobs(next)
      } catch (e) {
        if (live) setError(message(e))
      } finally {
        if (live) setLoading(false)
      }
    }
    void reload()
    const off = api.bots.onChanged(() => void reload())
    return () => {
      live = false
      off()
    }
  }, [bot.id])

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside
      aria-label={t('bots.settings')}
      className="absolute bottom-0 right-0 top-12 z-30 flex w-96 max-w-full flex-col border-l border-border bg-surface shadow-2xl"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <div className="flex items-center gap-2">
          <BotAvatar username={bot.username} size={24} />
          <h2 className="text-sm font-medium">{t('bots.settings')}</h2>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} title={t('bots.close')}>
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            void run(async () => {
              await api.bots.update(bot.id, { username, instructions })
              await refreshBots()
              setSaved(true)
            })
          }}
        >
          <label className={fieldClass}>
            {t('bots.username')}
            <Input
              value={username}
              onChange={(e) => {
                setUsername(e.target.value.replace(/^@/, ''))
                setSaved(false)
              }}
              maxLength={32}
              pattern={'[a-zA-Z][a-zA-Z0-9_\\x2d]{1,31}'}
              required
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
          <label className={fieldClass}>
            {t('bots.instructions')}
            <Textarea
              rows={5}
              value={instructions}
              onChange={(e) => {
                setInstructions(e.target.value)
                setSaved(false)
              }}
              placeholder={t('bots.instructionsHint')}
            />
          </label>
          <div className="flex items-center justify-end gap-2">
            {saved && (
              <span role="status" className="text-xs text-success">
                {t('bots.saved')}
              </span>
            )}
            <Button size="sm" type="submit" disabled={busy || username.toLowerCase() === 'roxy'}>
              {t('common.save')}
            </Button>
          </div>
        </form>
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
        <section className="border-t border-border pt-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-medium">{t('bots.schedules')}</h3>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setEditingJob('new')}
              disabled={editingJob !== null}
            >
              <Plus className="h-3.5 w-3.5" />
              {t('bots.addSchedule')}
            </Button>
          </div>
          {editingJob !== null ? (
            <BotJobEditor
              key={editingJob === 'new' ? 'new' : editingJob.id}
              botId={bot.id}
              job={editingJob === 'new' ? undefined : editingJob}
              onCancel={() => setEditingJob(null)}
              onSaved={async () => {
                setJobs(await api.bots.jobs(bot.id))
                setEditingJob(null)
              }}
            />
          ) : (
            <div className="flex flex-col gap-3">
              {loading ? (
                <p className="text-xs text-text-subtle">{t('bots.loading')}</p>
              ) : (
                !jobs.length && <p className="text-xs text-text-subtle">{t('bots.noSchedules')}</p>
              )}
              {jobs.map((job) => (
                <div key={job.id} className="rounded-lg border border-border bg-surface-2 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0 break-words text-sm font-medium">{job.name}</span>
                    <div className="flex shrink-0 gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        title={t('bots.editSchedule')}
                        onClick={() => setEditingJob(job)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        title={t('bots.deleteSchedule')}
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await api.bots.removeJob(job.id)
                            setJobs(await api.bots.jobs(bot.id))
                          })
                        }
                      >
                        <Trash2 className="h-3.5 w-3.5 text-danger" />
                      </Button>
                    </div>
                  </div>
                  <p className="mt-1 break-words text-xs text-text-muted">
                    {job.schedule.kind === 'interval'
                      ? t('bots.everyMinutes', { count: job.schedule.minutes })
                      : job.schedule.kind === 'cron'
                        ? `${job.schedule.expression} · ${job.schedule.timezone}`
                        : t('bots.atTimes', { count: job.schedule.timestamps.length })}
                  </p>
                  <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-xs text-text-muted">
                    {job.prompt}
                  </p>
                  <dl className="mt-2 space-y-1 text-[11px] text-text-subtle">
                    <div>
                      <dt className="inline">{t('bots.nextRun')} </dt>
                      <dd className="inline">
                        {job.nextRunAt ? new Date(job.nextRunAt).toLocaleString() : t('bots.none')}
                      </dd>
                    </div>
                    <div>
                      <dt className="inline">{t('bots.lastRun')} </dt>
                      <dd className="inline">
                        {job.lastRunAt ? new Date(job.lastRunAt).toLocaleString() : t('bots.never')}
                      </dd>
                    </div>
                    {job.remainingRuns !== null && (
                      <div>{t('bots.runsLeft', { count: job.remainingRuns })}</div>
                    )}
                  </dl>
                  <Button
                    className="mt-2"
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await api.bots.saveJob(
                          {
                            botId: job.botId,
                            name: job.name,
                            prompt: job.prompt,
                            schedule: job.schedule,
                            enabled: !job.enabled,
                            remainingRuns: job.remainingRuns
                          },
                          job.id
                        )
                        setJobs(await api.bots.jobs(bot.id))
                        await api.automation.wake()
                      })
                    }
                  >
                    {job.enabled ? t('bots.pause') : t('bots.enable')}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </section>
        <div className="mt-auto border-t border-border pt-4">
          {confirmDelete ? (
            <>
              <p className="mb-3 text-xs text-text-muted">
                {t('bots.deleteConfirm', { username: bot.username })}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="danger"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await removeBot(bot.id)
                      onClose()
                    })
                  }
                >
                  {t('bots.delete')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                  {t('common.cancel')}
                </Button>
              </div>
            </>
          ) : (
            <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="h-3.5 w-3.5" />
              {t('bots.delete')}
            </Button>
          )}
        </div>
      </div>
    </aside>
  )
}

function localDateTime(timestamp: number): string {
  const date = new Date(timestamp)
  return new Date(timestamp - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}

function BotJobEditor({
  botId,
  job,
  onCancel,
  onSaved
}: {
  botId: string
  job?: BotJob
  onCancel: () => void
  onSaved: () => Promise<void>
}): JSX.Element {
  const { t } = useTranslation()
  const [name, setName] = useState(job?.name ?? '')
  const [prompt, setPrompt] = useState(job?.prompt ?? '')
  const [kind, setKind] = useState<BotSchedule['kind']>(job?.schedule.kind ?? 'interval')
  const [minutes, setMinutes] = useState(
    job?.schedule.kind === 'interval' ? String(job.schedule.minutes) : '60'
  )
  const [cron, setCron] = useState(
    job?.schedule.kind === 'cron' ? job.schedule.expression : '0 9 * * *'
  )
  const [timezone, setTimezone] = useState(
    job?.schedule.kind === 'cron'
      ? job.schedule.timezone
      : Intl.DateTimeFormat().resolvedOptions().timeZone
  )
  const [times, setTimes] = useState(
    job?.schedule.kind === 'timestamps' ? job.schedule.timestamps.map(localDateTime) : ['']
  )
  const [runs, setRuns] = useState(job?.remainingRuns == null ? '' : String(job.remainingRuns))
  const [enabled, setEnabled] = useState(job?.enabled ?? true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface-2 p-3"
      onSubmit={async (e) => {
        e.preventDefault()
        if (busy) return
        setBusy(true)
        setError('')
        try {
          const schedule: BotSchedule =
            kind === 'interval'
              ? { kind, minutes: Number(minutes) }
              : kind === 'cron'
                ? { kind, expression: cron.trim(), timezone: timezone.trim() }
                : { kind, timestamps: times.map((time) => new Date(time).getTime()) }
          if (
            kind === 'timestamps' &&
            times.some((time) => !time || !Number.isFinite(new Date(time).getTime()))
          )
            throw new Error(t('bots.invalidTimes'))
          await api.bots.saveJob(
            {
              botId,
              name: name.trim(),
              prompt: prompt.trim(),
              schedule,
              enabled,
              remainingRuns: runs === '' ? null : Number(runs)
            },
            job?.id
          )
          await api.automation.wake()
          await onSaved()
        } catch (e) {
          setError(message(e))
        } finally {
          setBusy(false)
        }
      }}
    >
      <label className={fieldClass}>
        {t('bots.scheduleName')}
        <Input autoFocus required value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className={fieldClass}>
        {t('bots.prompt')}
        <Textarea rows={3} required value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </label>
      <label className={fieldClass}>
        {t('bots.scheduleType')}
        <select
          className={selectClass}
          value={kind}
          onChange={(e) => setKind(e.target.value as BotSchedule['kind'])}
        >
          <option value="interval">{t('bots.interval')}</option>
          <option value="cron">{t('bots.cron')}</option>
          <option value="timestamps">{t('bots.timestamps')}</option>
        </select>
      </label>
      {kind === 'interval' && (
        <label className={fieldClass}>
          {t('bots.minutes')}
          <Input
            type="number"
            required
            min={1}
            max={525600}
            step="any"
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
          />
        </label>
      )}
      {kind === 'cron' && (
        <>
          <label className={fieldClass}>
            {t('bots.expression')}
            <Input
              required
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              placeholder="0 9 * * *"
            />
          </label>
          <label className={fieldClass}>
            {t('bots.timezone')}
            <Input
              required
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              placeholder="America/New_York"
            />
          </label>
          <p className="text-[11px] text-text-subtle">{t('bots.cronHint')}</p>
        </>
      )}
      {kind === 'timestamps' && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-text-muted">{t('bots.localTimes')}</p>
          {times.map((time, index) => (
            <div key={index} className="flex items-center gap-1">
              <Input
                aria-label={t('bots.runAt')}
                type="datetime-local"
                required
                value={time}
                onChange={(e) =>
                  setTimes((old) => old.map((value, i) => (i === index ? e.target.value : value)))
                }
              />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                title={t('bots.removeTime')}
                disabled={times.length === 1}
                onClick={() => setTimes((old) => old.filter((_, i) => i !== index))}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setTimes((old) => [...old, ''])}
          >
            {t('bots.addTime')}
          </Button>
        </div>
      )}
      <label className={fieldClass}>
        {t('bots.remainingRuns')}
        <Input
          type="number"
          min={0}
          step={1}
          placeholder={t('bots.unlimited')}
          value={runs}
          onChange={(e) => setRuns(e.target.value)}
        />
      </label>
      <label className="flex items-center gap-2 text-xs text-text-muted">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        {t('bots.enabled')}
      </label>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button
          type="submit"
          size="sm"
          variant="primary"
          disabled={busy || !name.trim() || !prompt.trim()}
        >
          {t('common.save')}
        </Button>
      </div>
    </form>
  )
}
