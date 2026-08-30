import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderGit2, Plug, ShieldCheck, Trash2 } from 'lucide-react'
import type { McpTrustView } from '@shared/api'
import { api } from '../lib/api'
import { Button, Switch } from './ui'

/**
 * The MCP trust panel — the servers Roxy has run, and the posture it runs them
 * under.
 *
 * Roxy's default is to run a server you installed and then tell you what it
 * exposed, so this list is mostly a RECORD rather than a set of permissions:
 * what has connected, what you blocked, which projects you trusted wholesale.
 * Everything here is revocable, which is what keeps the default honest — a
 * permissive default is only defensible if the consequences stay visible and
 * reversible.
 *
 * The one switch flips the posture to ask-first, for shared machines and repos
 * you don't control.
 */
export function McpTrustPanel(): JSX.Element {
  const { t } = useTranslation()
  const [view, setView] = useState<McpTrustView | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api.mcp.trust.list().then(setView)
  }, [])

  const revoke = async (
    target: { kind: 'server'; id: string } | { kind: 'workspace'; path: string }
  ): Promise<void> => {
    setBusy(true)
    try {
      setView(await api.mcp.trust.revoke(target))
    } finally {
      setBusy(false)
    }
  }

  const setConfirm = async (confirmBeforeRun: boolean): Promise<void> => {
    setBusy(true)
    try {
      const policy = await api.mcp.trust.setPolicy(confirmBeforeRun)
      setView((v) => (v ? { ...v, policy } : v))
    } finally {
      setBusy(false)
    }
  }

  if (!view) return <p className="text-xs text-text-subtle">{t('common.loading')}</p>

  const allowed = view.entries.filter((e) => e.decision === 'allow')
  const denied = view.entries.filter((e) => e.decision === 'deny')

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs leading-relaxed text-text-muted">{t('mcpTrust.panelIntro')}</p>

      {view.workspaces.length > 0 && (
        <Section title={t('mcpTrust.trustedProjects')}>
          {view.workspaces.map((w) => (
            <Row
              key={w.path}
              icon={<FolderGit2 className="h-3.5 w-3.5 text-text-muted" />}
              title={w.path}
              subtitle={t('mcpTrust.trustedProjectSub')}
              busy={busy}
              onRevoke={() => void revoke({ kind: 'workspace', path: w.path })}
            />
          ))}
        </Section>
      )}

      {allowed.length > 0 && (
        <Section title={t('mcpTrust.knownServers')}>
          {allowed.map((e) => (
            <Row
              key={`${e.id}:${e.fingerprint}:${e.scope ?? ''}`}
              icon={<ShieldCheck className="h-3.5 w-3.5 text-success" />}
              title={e.id}
              subtitle={e.scope ?? t('mcpTrust.scopeAnywhere')}
              busy={busy}
              onRevoke={() => void revoke({ kind: 'server', id: e.id })}
            />
          ))}
        </Section>
      )}

      {denied.length > 0 && (
        <Section title={t('mcpTrust.blockedServers')}>
          {denied.map((e) => (
            <Row
              key={`${e.id}:${e.fingerprint}:${e.scope ?? ''}`}
              icon={<Plug className="h-3.5 w-3.5 text-danger" />}
              title={e.id}
              subtitle={e.scope ?? t('mcpTrust.scopeAnywhere')}
              busy={busy}
              onRevoke={() => void revoke({ kind: 'server', id: e.id })}
            />
          ))}
        </Section>
      )}

      {!view.workspaces.length && !view.entries.length && (
        <p className="text-xs text-text-subtle">{t('mcpTrust.noneYet')}</p>
      )}

      {/* The stricter posture, for people who want it. Off by default: choosing
          to install a server is already the decision. */}
      <div className="mt-1 flex items-start gap-3 border-t border-border pt-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-text">{t('mcpTrust.confirmLabel')}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-text-muted">
            {t('mcpTrust.confirmHelp')}
          </p>
        </div>
        <Switch
          checked={view.policy.confirmBeforeRun}
          disabled={busy}
          onChange={(v) => void setConfirm(v)}
        />
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-text-subtle">{title}</p>
      <div className="flex flex-col gap-1.5">{children}</div>
    </div>
  )
}

function Row({
  icon,
  title,
  subtitle,
  busy,
  onRevoke
}: {
  icon: JSX.Element
  title: string
  subtitle: string
  busy: boolean
  onRevoke: () => void
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-2.5 sq sq-lg sq-ring rounded-lg border border-border bg-surface px-3 py-2">
      {icon}
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-text" title={title}>
          {title}
        </p>
        <p className="truncate text-[11px] text-text-subtle" title={subtitle}>
          {subtitle}
        </p>
      </div>
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={onRevoke}
        title={t('mcpTrust.revoke')}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}
