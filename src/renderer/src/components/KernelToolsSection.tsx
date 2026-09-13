import { useEffect, useState } from 'react'
import { CircleCheck, ShieldAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { KernelInstallResult, KernelStatus } from '@shared/kernel'
import { api } from '../lib/api'
import { Button } from './ui'

type ConfirmAction = 'install' | 'uninstall' | 'disableTestSigning' | 'enableAgentAccess'
type KernelAction = ConfirmAction | 'refresh' | 'start' | 'disableAgentAccess'

export function KernelToolsSection(): JSX.Element {
  const { t } = useTranslation()
  const [status, setStatus] = useState<KernelStatus | null>(null)
  const [action, setAction] = useState<KernelAction | null>(null)
  const [confirming, setConfirming] = useState<ConfirmAction | null>(null)
  const [result, setResult] = useState<KernelInstallResult | null>(null)

  const refresh = async (): Promise<void> => {
    try {
      setStatus(await api.kernel.status())
    } catch (error) {
      setResult({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        steps: []
      })
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const run = async (
    nextAction: KernelAction,
    operation: () => Promise<KernelInstallResult>
  ): Promise<void> => {
    setAction(nextAction)
    setConfirming(null)
    setResult(null)
    try {
      setResult(await operation())
      await refresh()
    } catch (error) {
      setResult({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        steps: []
      })
    } finally {
      setAction(null)
    }
  }

  const performConfirmedAction = (): void => {
    if (confirming === 'install') void run('install', () => api.kernel.install())
    if (confirming === 'uninstall') void run('uninstall', () => api.kernel.uninstall(false))
    if (confirming === 'disableTestSigning') {
      void run('disableTestSigning', () => api.kernel.toggleTestSigning(false))
    }
    if (confirming === 'enableAgentAccess') {
      void run('enableAgentAccess', () => api.kernel.setAgentAccess(true))
    }
  }

  const busy = action !== null
  const isWindows = status?.isWindows ?? true
  const installed = status?.installed ?? false
  const hasArtifacts = status?.hasArtifacts ?? false
  const driverRunning = status?.driverState === 'running'
  const agentAccess = status?.mcpRegistered ?? false

  return (
    <section className="mb-8">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-warning">
        {t('settings.kernel.heading')}
      </h2>
      <div className="sq sq-xl sq-ring rounded-xl border border-warning/30 bg-warning/5 p-4 [--sq-ring:var(--color-warning)]">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 sm:pr-6">
            <div className="flex items-center gap-2 text-sm font-medium text-text">
              <ShieldAlert className="h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
              {t('settings.kernel.title')}
            </div>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-text-subtle">
              {t('settings.kernel.description')}
            </p>

            {status && isWindows && (
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
                {installed && <StatusLine label={t('settings.kernel.statusInstalled')} />}
                {status.testSigning && (
                  <StatusLine label={t('settings.kernel.statusTestSigning')} tone="warning" />
                )}
                {installed && status.driverState === 'running' && (
                  <StatusLine label={t('settings.kernel.statusDriverRunning')} />
                )}
                {installed && status.driverState === 'stopped' && (
                  <StatusLine label={t('settings.kernel.statusDriverStopped')} tone="warning" />
                )}
                {installed && status.driverState === 'unknown' && (
                  <StatusLine label={t('settings.kernel.statusDriverUnknown')} tone="warning" />
                )}
                {agentAccess && <StatusLine label={t('settings.kernel.statusMCPRegistered')} />}
              </div>
            )}

            {result && (
              <div
                className={`mt-3 rounded-lg border px-3 py-2 text-xs leading-relaxed ${
                  result.ok
                    ? 'border-success/25 bg-success/5 text-text-muted'
                    : 'border-danger/30 bg-danger/5 text-danger'
                }`}
                role="status"
              >
                {result.error && <p>{t('settings.kernel.failed', { error: result.error })}</p>}
                {result.steps.length > 0 && (
                  <ul className="space-y-0.5">
                    {result.steps.map((step, index) => (
                      <li key={`${index}-${step}`}>{step}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          <div className="flex shrink-0 flex-col items-end gap-2 sm:w-64">
            {!isWindows && (
              <span className="text-right text-xs text-text-subtle">
                {t('settings.kernel.windowsOnly')}
              </span>
            )}

            {isWindows && !installed && !confirming && (
              <Button variant="danger" disabled={busy} onClick={() => setConfirming('install')}>
                {action === 'install'
                  ? t('settings.kernel.installing')
                  : t('settings.kernel.install')}
              </Button>
            )}

            {isWindows && hasArtifacts && !confirming && (
              <div className="flex w-full flex-wrap justify-end gap-2">
                {installed && !driverRunning && (
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void run('start', () => api.kernel.start())}
                  >
                    {action === 'start'
                      ? t('settings.kernel.starting')
                      : t('settings.kernel.start')}
                  </Button>
                )}
                {installed && !agentAccess && (
                  <Button
                    variant="secondary"
                    disabled={busy || !driverRunning}
                    onClick={() => setConfirming('enableAgentAccess')}
                  >
                    {action === 'enableAgentAccess'
                      ? t('settings.kernel.enablingAgentAccess')
                      : t('settings.kernel.enableAgentAccess')}
                  </Button>
                )}
                {agentAccess && (
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() =>
                      void run('disableAgentAccess', () => api.kernel.setAgentAccess(false))
                    }
                  >
                    {action === 'disableAgentAccess'
                      ? t('settings.kernel.disablingAgentAccess')
                      : t('settings.kernel.disableAgentAccess')}
                  </Button>
                )}
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => setConfirming('uninstall')}
                >
                  {action === 'uninstall'
                    ? t('settings.kernel.uninstalling')
                    : t('settings.kernel.uninstall')}
                </Button>
              </div>
            )}

            {isWindows && status?.testSigning && !hasArtifacts && !confirming && (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => setConfirming('disableTestSigning')}
              >
                {action === 'disableTestSigning'
                  ? t('settings.kernel.disablingTestSigning')
                  : t('settings.kernel.disableTestSigning')}
              </Button>
            )}

            {isWindows && confirming && (
              <div className="w-full text-left sm:text-right">
                <p className="text-xs leading-relaxed text-text-muted">
                  {confirming === 'install' && t('settings.kernel.confirmInstallDescription')}
                  {confirming === 'uninstall' && t('settings.kernel.confirmUninstallDescription')}
                  {confirming === 'disableTestSigning' &&
                    t('settings.kernel.confirmDisableTestSigningDescription')}
                  {confirming === 'enableAgentAccess' &&
                    t('settings.kernel.confirmEnableAgentAccessDescription')}
                </p>
                <div className="mt-2 flex justify-end gap-2">
                  <Button variant="ghost" disabled={busy} onClick={() => setConfirming(null)}>
                    {t('common.cancel')}
                  </Button>
                  <Button
                    variant={confirming === 'enableAgentAccess' ? 'secondary' : 'danger'}
                    disabled={busy}
                    onClick={performConfirmedAction}
                  >
                    {confirming === 'install' && t('settings.kernel.install')}
                    {confirming === 'uninstall' && t('settings.kernel.uninstall')}
                    {confirming === 'disableTestSigning' && t('settings.kernel.disableTestSigning')}
                    {confirming === 'enableAgentAccess' && t('settings.kernel.enableAgentAccess')}
                  </Button>
                </div>
              </div>
            )}

            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() =>
                void run('refresh', async () => {
                  await refresh()
                  return { ok: true, steps: [] }
                })
              }
            >
              {t('settings.kernel.refresh')}
            </Button>
          </div>
        </div>
      </div>
    </section>
  )
}

function StatusLine({
  label,
  tone = 'success'
}: {
  label: string
  tone?: 'success' | 'warning'
}): JSX.Element {
  const Icon = tone === 'success' ? CircleCheck : ShieldAlert
  return (
    <p className="flex items-center gap-1.5 text-xs text-text-muted">
      <Icon
        className={tone === 'success' ? 'h-3.5 w-3.5 text-success' : 'h-3.5 w-3.5 text-warning'}
        aria-hidden="true"
      />
      {label}
    </p>
  )
}
