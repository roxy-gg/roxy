import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, ExternalLink, Loader2 } from 'lucide-react'
import type { DeviceFlowStart } from '@shared/types'
import { api } from '../lib/api'
import { ProviderLogo } from '../lib/providerLogos'
import { Button } from './ui'

export function CopilotSetup({
  onConnected,
  reconnect = false
}: {
  onConnected: () => void | Promise<void>
  reconnect?: boolean
}): JSX.Element {
  const { t } = useTranslation()
  const [status, setStatus] = useState<'idle' | 'waiting' | 'error'>('idle')
  const [flow, setFlow] = useState<DeviceFlowStart | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const begin = async (): Promise<void> => {
    if (status === 'waiting') return
    setStatus('waiting')
    setError(null)
    setFlow(null)
    setCopied(false)
    try {
      const started = await api.copilot.start()
      setFlow(started)
      await api.system.openExternal(started.verificationUri)
      await api.copilot.poll(started.deviceCode, started.interval)
      await onConnected()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus('error')
    }
  }

  const copyCode = async (): Promise<void> => {
    if (!flow) return
    await navigator.clipboard.writeText(flow.userCode)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  if (status === 'idle') {
    return (
      <div className="flex flex-col gap-4">
        <div>
          {!reconnect && <h2 className="text-lg font-semibold">{t('onboarding.copilotTitle')}</h2>}
          <p role={reconnect ? 'alert' : undefined} className="text-sm text-text-muted">
            {t(reconnect ? 'chat.copilotReconnectBody' : 'onboarding.copilotBody')}
          </p>
        </div>
        <Button variant="primary" onClick={begin}>
          <ProviderLogo id="github-copilot" name="GitHub" size={16} />{' '}
          {t(reconnect ? 'chat.copilotReconnect' : 'onboarding.copilotContinue')}
        </Button>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">{t('onboarding.copilotFailed')}</h2>
        <p role="alert" className="break-words text-sm text-danger">
          {error}
        </p>
        <Button variant="secondary" onClick={begin}>
          {t('onboarding.tryAgain')}
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center gap-5 text-center">
      <div>
        <h2 className="text-lg font-semibold">{t('onboarding.copilotCodeTitle')}</h2>
        <p className="mt-1 text-sm text-text-muted">{t('onboarding.copilotCodeBody')}</p>
      </div>
      <button
        onClick={copyCode}
        disabled={!flow}
        aria-label={t('onboarding.clickToCopy')}
        className="group flex max-w-full items-center gap-3 sq sq-xl sq-ring rounded-xl border border-border bg-surface-2 px-5 py-3 transition-colors hover:border-border-strong focus-visible:outline focus-visible:outline-accent"
      >
        <span className="break-all font-mono text-xl font-semibold tracking-[0.2em] text-text sm:text-2xl">
          {flow?.userCode ?? '••••-••••'}
        </span>
        <Copy className="h-4 w-4 text-text-subtle transition-colors group-hover:text-text" />
      </button>
      <span className="text-xs text-text-subtle">
        {copied ? t('onboarding.copied') : t('onboarding.clickToCopy')}
      </span>
      <Button
        variant="secondary"
        disabled={!flow}
        onClick={() => flow && api.system.openExternal(flow.verificationUri)}
      >
        <ExternalLink className="h-4 w-4" />{' '}
        {t(reconnect ? 'chat.copilotAuthenticate' : 'onboarding.openGitHub')}
      </Button>
      <div role="status" className="mt-1 flex items-center gap-2 text-sm text-text-muted">
        <Loader2 className="h-4 w-4 animate-spin" /> {t('onboarding.waitingForAuth')}
      </div>
    </div>
  )
}
