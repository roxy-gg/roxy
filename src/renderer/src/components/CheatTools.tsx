import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, ExternalLink, ScanLine } from 'lucide-react'
import {
  CHEAT_SOURCES,
  CHEAT_SCHEMAS,
  cheatGuidance,
  cheatSchemas,
  type CheatError,
  type CheatResult,
  type CheatState
} from '@shared/cheat'
import { api } from '../lib/api'
import { Button, Switch } from './ui'

export function CheatTools({ active = true }: { active?: boolean }): JSX.Element {
  const { t } = useTranslation()
  const [state, setState] = useState<CheatState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<CheatError | null>(null)
  useEffect(() => {
    if (!active) return
    let disposed = false
    const refresh = (): void => {
      api.cheat
        .state()
        .then((next) => {
          if (!disposed) setState(next)
        })
        .catch(() => {
          if (!disposed) setError('runtime')
        })
    }
    refresh()
    const off = api.cheat.onChanged((next) => {
      if (!disposed) setState(next)
    })
    const timer = setInterval(refresh, 5000)
    return () => {
      disposed = true
      off()
      clearInterval(timer)
    }
  }, [active])
  const perform = async (action: () => Promise<CheatResult>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await action()
      if (!result.ok) setError(result.error)
      setState(await api.cheat.state())
    } catch {
      setError('runtime')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-5" data-cheat-tools>
      <header>
        <h2 className="text-sm font-semibold text-text">{t('cheat.title')}</h2>
        <p className="mt-1 text-xs leading-relaxed text-text-muted">{t('cheat.directOverview')}</p>
      </header>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {t(`cheat.errors.${error}`)}
        </p>
      )}
      {!state ? (
        <Button disabled={busy} onClick={() => void perform(async () => ({ ok: true }))}>
          {t('cheat.refresh')}
        </Button>
      ) : (
        <>
          {!state.supported && (
            <p role="alert" className="text-xs text-warning">
              {t('cheat.errors.unsupported')}
            </p>
          )}
          <section
            className="space-y-3 rounded-xl border border-border bg-surface p-4"
            data-cheat-control
          >
            <div className="flex items-center gap-3">
              <ScanLine aria-hidden="true" className="h-5 w-5 shrink-0 text-accent" />
              <h3 className="min-w-0 flex-1 text-sm font-medium text-text">{t('cheat.title')}</h3>
              <Switch
                label={t('cheat.enable')}
                checked={state.preferences.enabled}
                disabled={busy || !state.supported}
                onChange={(enabled) => void perform(() => api.cheat.update({ enabled }))}
              />
            </div>
            <p className="text-xs leading-relaxed text-text-muted">{t('cheat.directAccess')}</p>
          </section>
          <section
            className="space-y-3 rounded-xl border border-border bg-surface p-4"
            data-cheat-catalog
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-sm font-medium text-text">{t('cheat.toolCatalog')}</h3>
              <p role="status" className="text-xs text-text-subtle">
                {t('cheat.activeCalls', {
                  count: cheatSchemas(state.supported ? 'win32' : '', state.preferences).length,
                  total: CHEAT_SCHEMAS.length
                })}
              </p>
            </div>
            <p className="text-xs leading-relaxed text-text-muted">{t('cheat.catalogHelp')}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={busy || !state.supported}
                onClick={() => void perform(() => api.cheat.update({ disabledCalls: [] }))}
              >
                {t('cheat.enableAll')}
              </Button>
              <Button
                size="sm"
                disabled={busy || !state.supported}
                onClick={() =>
                  void perform(() =>
                    api.cheat.update({
                      disabledCalls: CHEAT_SCHEMAS.map(({ function: f }) => f.name)
                    })
                  )
                }
              >
                {t('cheat.disableAll')}
              </Button>
            </div>
            <div className="divide-y divide-border">
              {CHEAT_SCHEMAS.map(({ function: f }) => (
                <article key={f.name} className="py-3" data-cheat-call={f.name}>
                  <div className="flex items-center justify-between gap-3">
                    <code className="min-w-0 break-all text-xs text-text">{f.name}</code>
                    <Switch
                      label={f.name}
                      checked={!state.preferences.disabledCalls.includes(f.name)}
                      disabled={busy || !state.supported}
                      onChange={(enabled) =>
                        void perform(() =>
                          api.cheat.update({
                            disabledCalls: enabled
                              ? state.preferences.disabledCalls.filter((name) => name !== f.name)
                              : [...new Set([...state.preferences.disabledCalls, f.name])]
                          })
                        )
                      }
                    />
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-text-muted">{f.description}</p>
                  <details className="mt-2">
                    <summary className="cursor-pointer text-[11px] text-text-subtle">
                      {t('cheat.exactSchema')}
                    </summary>
                    <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-[11px] text-text-subtle">
                      {JSON.stringify(f, null, 2)}
                    </pre>
                  </details>
                </article>
              ))}
            </div>
          </section>
          <section
            className="space-y-3 rounded-xl border border-border bg-surface p-4"
            data-cheat-prompt
          >
            <h3 className="text-sm font-medium text-text">{t('cheat.prompt')}</h3>
            <p className="text-xs text-text-muted">{t('cheat.promptHelp')}</p>
            {cheatGuidance(state.supported ? 'win32' : '', state.preferences) ? (
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-[11px] text-text-subtle">
                {cheatGuidance(state.supported ? 'win32' : '', state.preferences)}
              </pre>
            ) : (
              <p role="status" className="text-xs text-text-subtle">
                {t('cheat.promptInactive')}
              </p>
            )}
          </section>
          <details className="space-y-3" data-cheat-sources>
            <summary className="cursor-pointer text-xs font-medium text-text-muted">
              {t('cheat.optionalSources')}
            </summary>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-text-subtle">
              {t('cheat.sources')}
            </h3>
            <p className="text-xs leading-relaxed text-text-muted">{t('cheat.sourceNotice')}</p>
            {CHEAT_SOURCES.map((tool) => (
              <article
                key={tool.id}
                className="space-y-2 rounded-xl border border-border bg-surface p-4"
                data-cheat-source={tool.id}
              >
                <div className="flex flex-wrap items-center gap-3">
                  <h4 className="mr-auto text-sm font-medium text-text">{tool.name}</h4>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void api.system.openExternal(tool.url)}
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    {t('cheat.vendor')}
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy || !!state.downloading || !!state.sources[tool.id]}
                    onClick={() => {
                      setError(null)
                      void api.cheat
                        .download(tool.id)
                        .then((result) => {
                          if (!result.ok) setError(result.error)
                          return api.cheat.state()
                        })
                        .then(setState)
                        .catch(() => setError('runtime'))
                    }}
                  >
                    <Download className="h-3.5 w-3.5" />
                    {t(state.sources[tool.id] ? 'cheat.downloaded' : 'cheat.download')}
                  </Button>
                </div>
                <p className="text-xs leading-relaxed text-text-muted">
                  {t(`cheat.products.${tool.id}`)}
                </p>
                <p className="break-all font-mono text-[11px] text-text-subtle">{tool.commit}</p>
                {state.sources[tool.id] && (
                  <p className="break-all text-[11px] text-text-subtle">
                    {state.sources[tool.id]?.path}
                    <br />
                    {state.sources[tool.id]?.sha256}
                  </p>
                )}
              </article>
            ))}
            {state.downloading && (
              <div
                role="status"
                className="flex flex-wrap items-center gap-3 text-xs text-text-muted"
              >
                {t('cheat.downloading')}
                <Button size="sm" onClick={() => void api.cheat.cancel()}>
                  {t('common.cancel')}
                </Button>
              </div>
            )}
            <p className="text-xs leading-relaxed text-text-subtle">
              {t('cheat.products.debuggers')}
            </p>
            <div className="flex flex-wrap gap-3">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void api.system.openExternal('https://x64dbg.com/')}
              >
                x64dbg <ExternalLink className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void api.system.openExternal('https://hex-rays.com/ida-pro')}
              >
                IDA Pro <ExternalLink className="h-3.5 w-3.5" />
              </Button>
            </div>
          </details>
          <details className="space-y-3 rounded-xl border border-border bg-surface p-4">
            <summary className="cursor-pointer text-xs font-medium text-text-muted">
              {t('cheat.calls')}
            </summary>
            <p className="text-xs leading-relaxed text-text-muted">
              {t('cheat.runtimeBoundaries')}
            </p>
          </details>
        </>
      )}
    </div>
  )
}
