import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, ExternalLink, RefreshCw } from 'lucide-react'
import {
  ENGINEERING_TOOLS,
  ENGINEERING_TOOL_CALLS,
  ENGINEERING_SHARED_CALLS,
  engineeringName,
  engineeringToolCalls,
  engineeringCallSupported,
  type EngineeringState,
  type EngineeringPreferences,
  type EngineeringResult,
  type EngineeringToolId,
  type EngineeringError
} from '@shared/engineering-tools'
import { api } from '../lib/api'
import { Button, Switch } from './ui'

export function EngineeringTools({ active = true }: { active?: boolean }): JSX.Element {
  const { t } = useTranslation()
  const [state, setState] = useState<EngineeringState | null>(null)
  const [busy, setBusy] = useState(false)
  const [issue, setIssue] = useState<EngineeringError | null>(null)
  useEffect(() => {
    if (!active) return
    let disposed = false
    api.engineering
      .state()
      .then((next) => {
        if (!disposed) {
          setState(next)
          setIssue(null)
        }
      })
      .catch(() => {
        if (!disposed) setIssue('runtime')
      })
    const off = api.engineering.onChanged((next) => {
      if (!disposed) {
        setState(next)
        setIssue(null)
      }
    })
    return () => {
      disposed = true
      off()
    }
  }, [active])
  const perform = async (operation: () => Promise<EngineeringResult>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setIssue(null)
    try {
      const result = await operation()
      if (!result.ok) setIssue(result.error)
      setState(await api.engineering.state())
    } catch {
      setIssue('runtime')
    } finally {
      setBusy(false)
    }
  }
  const update = (patch: Partial<EngineeringPreferences>): void => {
    void perform(() => api.engineering.update(patch))
  }
  const refresh = (): void => {
    void perform(async () => ({ ok: true }))
  }
  if (!state)
    return (
      <div className="space-y-3">
        <p role="status" className="text-sm text-text-muted">
          {t('engineering.loading')}
        </p>
        {issue && <Button onClick={refresh}>{t('engineering.retry')}</Button>}
      </div>
    )
  const supportedTools = ENGINEERING_TOOLS.filter(({ id }) => !state.unsupported.includes(id))
  const ready = state.supported && supportedTools.every(({ id }) => state.installed.includes(id))
  const p = state.preferences
  const enabled = p.enabled && p.guidance
  const working = busy || !!state.job || !!state.batch
  const error = issue ?? state.error?.code
  const calls = engineeringToolCalls(state.installed, state.platform, p)
  const group = (id: EngineeringToolId, enabled: boolean): void =>
    update({
      groups: enabled ? [...new Set([...p.groups, id])] : p.groups.filter((item) => item !== id)
    })
  const toggleCall = (name: string, enabled: boolean): void =>
    update({
      disabledCalls: enabled
        ? p.disabledCalls.filter((item) => item !== name)
        : [...new Set([...p.disabledCalls, name])]
    })
  const needsSystem =
    !state.unsupported.includes('wireshark') && !state.installed.includes('wireshark')
  const progress = state.job?.total
    ? Math.min(100, Math.floor((state.job.received / state.job.total) * 100))
    : undefined
  return (
    <div className="space-y-5" data-engineering-tools>
      <header>
        <h2 className="text-sm font-semibold text-text">{t('engineering.heading')}</h2>
        <p className="mt-1 text-xs leading-relaxed text-text-muted">
          {t('engineering.description')}
        </p>
      </header>
      <section
        className="space-y-4 rounded-xl border border-border bg-surface p-4"
        data-engineering-control
      >
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0 flex-1 basis-56">
            <h3 className="text-sm font-medium text-text">{t('engineering.toggle')}</h3>
            <p className="mt-1 text-xs leading-relaxed text-text-muted">
              {ready
                ? t('engineering.toggleBody', { count: calls.length })
                : t('engineering.setupBody')}
            </p>
          </div>
          {ready ? (
            <Switch
              label={t('engineering.toggle')}
              checked={enabled}
              disabled={working}
              onChange={(value) =>
                update({
                  enabled: value,
                  guidance: value,
                  ...(value && !p.groups.length
                    ? { groups: supportedTools.map(({ id }) => id) }
                    : {})
                })
              }
            />
          ) : (
            <Button
              disabled={working || !state.supported}
              onClick={() => void perform(() => api.engineering.installAll(true))}
            >
              <Download className="h-3.5 w-3.5" />
              {t('engineering.downloadInstall')}
            </Button>
          )}
        </div>
        {needsSystem && (
          <p className="text-[11px] leading-relaxed text-text-subtle">
            {t('engineering.installNotice')}
          </p>
        )}
        {(state.job || state.batch) && (
          <div
            role="status"
            className="space-y-2 border-t border-border pt-3 text-xs text-text-muted"
          >
            {state.job && (
              <p>
                {t('engineering.progress', {
                  name: ENGINEERING_TOOLS.find(({ id }) => id === state.job?.id)?.name,
                  phase: t(`engineering.phases.${state.job.phase}`)
                })}
              </p>
            )}
            {state.batch && (
              <p>
                {t('engineering.batch', { current: state.batch.current, total: state.batch.total })}
              </p>
            )}
            <progress
              className="h-1.5 w-full accent-accent"
              max={100}
              value={progress}
              aria-label={t('engineering.installProgress')}
            />
            <Button size="sm" onClick={() => void api.engineering.cancel()}>
              {t('common.cancel')}
            </Button>
          </div>
        )}
      </section>
      {!state.supported && (
        <p role="alert" className="text-xs text-warning">
          {t('engineering.errors.unsupported')}
        </p>
      )}
      {error && (
        <div role="alert" className="space-y-2 text-xs text-danger">
          <p>{t(`engineering.errors.${error}`)}</p>
          {!issue && state.error?.detail && (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-[11px]">
              {state.error.detail}
            </pre>
          )}
        </div>
      )}
      <details className="space-y-3" data-engineering-detail>
        <summary className="cursor-pointer text-xs font-medium text-text-muted">
          {t('engineering.details')}
        </summary>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-text-subtle">
            {t('engineering.installedCount', {
              count: supportedTools.filter(({ id }) => state.installed.includes(id)).length,
              total: supportedTools.length
            })}
          </p>
          <Button variant="ghost" size="sm" disabled={working} onClick={refresh}>
            <RefreshCw className="h-3.5 w-3.5" />
            {t('engineering.refresh')}
          </Button>
        </div>
        {ENGINEERING_TOOLS.map((tool) => {
          const installed = state.installed.includes(tool.id)
          const unsupported = state.unsupported.includes(tool.id)
          const names = [
            ...new Set([...ENGINEERING_TOOL_CALLS[tool.id], ...ENGINEERING_SHARED_CALLS])
          ].filter((name) => engineeringCallSupported(name, state.platform))
          return (
            <article
              key={tool.id}
              className="space-y-3 rounded-xl border border-border bg-surface p-4"
              data-engineering-group={tool.id}
            >
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-medium text-text">{tool.name}</h3>
                <span className="font-mono text-[11px] text-text-subtle">{tool.version}</span>
                <span className="text-[11px] text-text-muted">
                  {t(
                    unsupported
                      ? 'engineering.unsupported'
                      : installed
                        ? 'engineering.installed'
                        : 'engineering.notInstalled'
                  )}
                </span>
                <div className="ml-auto flex items-center gap-3">
                  <button
                    title={t('engineering.vendor', { name: tool.name })}
                    onClick={() => void api.system.openExternal(tool.url)}
                  >
                    <ExternalLink className="h-3.5 w-3.5 text-text-muted" />
                  </button>
                  {tool.id !== 'wireshark' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={working || unsupported}
                      onClick={() =>
                        void perform(() => api.engineering.install(tool.id, false, true))
                      }
                    >
                      {t('engineering.repair')}
                    </Button>
                  )}
                  {installed ? (
                    <Switch
                      label={t('engineering.groupToggle', { name: tool.name })}
                      checked={p.groups.includes(tool.id)}
                      disabled={working || unsupported}
                      onChange={(value) => group(tool.id, value)}
                    />
                  ) : (
                    <Button
                      size="sm"
                      disabled={working || unsupported}
                      onClick={() => void perform(() => api.engineering.install(tool.id, true))}
                    >
                      {t('engineering.install')}
                    </Button>
                  )}
                </div>
              </div>
              <p className="text-xs leading-relaxed text-text-muted">
                {t(`engineering.descriptions.${tool.id}`)}
              </p>
              <p className="text-[11px] leading-relaxed text-text-subtle">
                {t(`engineering.dependencies.${tool.id}`)}
              </p>
              {tool.id === 'ghidra' && state.platform === 'win32' && (
                <p className="text-xs text-warning">{t('engineering.ghidraWindows')}</p>
              )}
              <details className="border-t border-border pt-3">
                <summary className="cursor-pointer text-xs text-text-muted">
                  {t('engineering.callCount', { count: names.length })}
                </summary>
                <div className="mt-3 space-y-2">
                  {names.map((name) => (
                    <div key={name} className="flex items-center justify-between gap-3">
                      <code className="min-w-0 break-all text-[11px] text-text-muted">
                        {engineeringName(name)}
                      </code>
                      <Switch
                        label={engineeringName(name)}
                        checked={!p.disabledCalls.includes(name)}
                        disabled={working || !installed}
                        onChange={(value) => toggleCall(name, value)}
                      />
                    </div>
                  ))}
                </div>
              </details>
            </article>
          )
        })}
        <p className="text-xs leading-relaxed text-text-subtle">{t('engineering.lifecycleBody')}</p>
      </details>
    </div>
  )
}
