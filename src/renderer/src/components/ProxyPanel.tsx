import { useEffect, useState } from 'react'
import { Check, Loader2, ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { BrowserProxyConfig, BrowserProxyScheme } from '@shared/api'
import { api } from '../lib/api'
import { Button, Input, Switch } from './ui'
import { cn } from '../lib/cn'

const EMPTY: BrowserProxyConfig = {
  enabled: false,
  scheme: 'http',
  host: '',
  port: 0,
  username: '',
  hasPassword: false
}

export function ProxyPanel({ compact = false }: { compact?: boolean }): JSX.Element {
  const { t } = useTranslation()
  const [saved, setSaved] = useState(EMPTY)
  const [enabled, setEnabled] = useState(false)
  const [scheme, setScheme] = useState<BrowserProxyScheme>('http')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [clearPassword, setClearPassword] = useState(false)
  const [busy, setBusy] = useState(true)
  const [note, setNote] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  const populate = (config: BrowserProxyConfig): void => {
    setSaved(config)
    setEnabled(config.enabled)
    setScheme(config.scheme)
    setHost(config.host)
    setPort(config.port ? String(config.port) : '')
    setUsername(config.username)
    setPassword('')
    setClearPassword(false)
  }

  useEffect(() => {
    let live = true
    void api.browser
      .getProxy()
      .then((config) => {
        if (live) populate(config)
      })
      .finally(() => live && setBusy(false))
    const off = api.browser.onProxyChanged((config) => {
      if (live) populate(config)
    })
    return () => {
      live = false
      off()
    }
  }, [])

  const save = async (): Promise<void> => {
    setBusy(true)
    setNote(null)
    try {
      const result = await api.browser.setProxy({
        enabled,
        scheme,
        host,
        port: Number(port),
        username,
        ...(password ? { password } : {}),
        clearPassword
      })
      if (!result.ok) {
        setNote({ kind: 'error', text: result.error ?? t('proxy.saveFailed') })
        return
      }
      populate(result.config)
      setNote({
        kind: 'ok',
        text: result.config.enabled ? t('proxy.connected') : t('proxy.disabled')
      })
    } catch (e) {
      setNote({ kind: 'error', text: e instanceof Error ? e.message : t('proxy.saveFailed') })
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (value: boolean): Promise<void> => {
    if (value && (!host.trim() || !port)) {
      setEnabled(true)
      return
    }
    setEnabled(value)
    setBusy(true)
    setNote(null)
    try {
      const result = await api.browser.setProxy({
        enabled: value,
        scheme,
        host,
        port: Number(port),
        username,
        ...(password ? { password } : {}),
        clearPassword
      })
      if (!result.ok) {
        setEnabled(saved.enabled)
        setNote({ kind: 'error', text: result.error ?? t('proxy.saveFailed') })
        return
      }
      populate(result.config)
      setNote({ kind: 'ok', text: value ? t('proxy.connected') : t('proxy.disabled') })
    } catch (e) {
      setEnabled(saved.enabled)
      setNote({ kind: 'error', text: e instanceof Error ? e.message : t('proxy.saveFailed') })
    } finally {
      setBusy(false)
    }
  }

  const passwordPlaceholder = saved.hasPassword && !clearPassword ? t('proxy.passwordSaved') : ''
  const authUnsupported = scheme === 'socks4' || scheme === 'socks5'

  return (
    <div className={cn('bg-surface', compact ? 'flex min-h-0 flex-1 flex-col' : '')}>
      <div className={cn('flex items-start justify-between gap-4', compact ? 'px-4 py-3' : 'p-4')}>
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium text-text">
            <ShieldCheck
              className={cn('h-4 w-4', saved.enabled ? 'text-success' : 'text-text-subtle')}
            />
            {t('proxy.title')}
          </div>
          <p className="mt-1 text-xs text-text-muted">{t('proxy.description')}</p>
        </div>
        <Switch checked={enabled} onChange={(value) => void toggle(value)} disabled={busy} />
      </div>

      <div
        className={cn('grid gap-3 border-t border-border', compact ? 'p-4' : 'p-4 sm:grid-cols-6')}
      >
        <Field label={t('proxy.protocol')} className={compact ? '' : 'sm:col-span-2'}>
          <select
            value={scheme}
            onChange={(e) => setScheme(e.target.value as BrowserProxyScheme)}
            className="h-9 w-full sq sq-lg sq-ring rounded-lg border border-border bg-surface-2 px-3 text-sm uppercase text-text outline-none focus:border-accent/70"
          >
            <option value="http">HTTP</option>
            <option value="https">HTTPS</option>
            <option value="socks4">SOCKS4</option>
            <option value="socks5">SOCKS5</option>
          </select>
        </Field>
        <Field label={t('proxy.host')} className={compact ? '' : 'sm:col-span-3'}>
          <Input
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder={t('proxy.hostPlaceholder')}
            spellCheck={false}
          />
        </Field>
        <Field label={t('proxy.port')} className={compact ? '' : 'sm:col-span-1'}>
          <Input
            value={port}
            onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))}
            placeholder="8080"
            inputMode="numeric"
          />
        </Field>
        <Field label={t('proxy.username')} className={compact ? '' : 'sm:col-span-3'}>
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={t('proxy.optional')}
            disabled={authUnsupported}
            autoComplete="off"
          />
        </Field>
        <Field label={t('proxy.password')} className={compact ? '' : 'sm:col-span-3'}>
          <Input
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value)
              setClearPassword(false)
            }}
            placeholder={passwordPlaceholder || t('proxy.optional')}
            disabled={authUnsupported}
            autoComplete="new-password"
          />
        </Field>

        {authUnsupported && (
          <p className={cn('text-xs text-text-subtle', compact ? '' : 'sm:col-span-6')}>
            {t('proxy.socksAuth')}
          </p>
        )}
        {saved.hasPassword && !authUnsupported && (
          <label
            className={cn(
              'flex items-center gap-2 text-xs text-text-muted',
              compact ? '' : 'sm:col-span-6'
            )}
          >
            <input
              type="checkbox"
              checked={clearPassword}
              onChange={(e) => {
                setClearPassword(e.target.checked)
                if (e.target.checked) setPassword('')
              }}
            />
            {t('proxy.clearPassword')}
          </label>
        )}

        <div
          className={cn('flex items-center justify-between gap-3', compact ? '' : 'sm:col-span-6')}
        >
          <div
            className={cn(
              'min-h-4 text-xs',
              note?.kind === 'error' ? 'text-danger' : note ? 'text-success' : 'text-text-subtle'
            )}
          >
            {note?.kind === 'ok' && <Check className="mr-1 inline h-3.5 w-3.5" />}
            {note?.text ??
              (saved.enabled
                ? t('proxy.activeSummary', {
                    scheme: saved.scheme,
                    host: saved.host,
                    port: saved.port
                  })
                : t('proxy.direct'))}
          </div>
          <Button onClick={() => void save()} disabled={busy} className="shrink-0">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {t('common.save')}
          </Button>
        </div>
      </div>
    </div>
  )
}

function Field({
  label,
  className,
  children
}: {
  label: string
  className?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <label className={className}>
      <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-text-subtle">
        {label}
      </span>
      {children}
    </label>
  )
}
