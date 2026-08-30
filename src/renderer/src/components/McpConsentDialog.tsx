import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  FolderGit2,
  Globe,
  KeyRound,
  ShieldAlert,
  TerminalSquare
} from 'lucide-react'
import type { McpConsentRequest, McpConsentResponse } from '@shared/mcp-trust'
import { api } from '../lib/api'
import { Button } from './ui'

/**
 * The MCP consent prompt — the rare blocking question.
 *
 * This is NOT the normal path. Installing an MCP server is the user's own
 * decision, so it runs and reports what it exposed (see McpInstallSheet). This
 * dialog appears in exactly two cases:
 *
 *  - **`changed`** — a server the user already trusted now runs a DIFFERENT
 *    command. Approving `npx server-github` is not approving whatever replaced
 *    it, and this substitution is the one thing the user did not do themselves.
 *  - **`confirm-first-run`** — the user opted into confirming new servers.
 *
 * Keeping the interruption this rare is what makes it mean something: a dialog
 * people see twice a year gets read, a dialog they see daily gets dismissed.
 *
 * Rules: the command is stated verbatim, deny is focused, Escape and the
 * backdrop both deny, and env/header VALUES are never rendered.
 */
export function McpConsentDialog(): JSX.Element | null {
  const { t } = useTranslation()
  const [queue, setQueue] = useState<McpConsentRequest[]>([])

  // Requests are queued, never dropped: two turns can each hit an unapproved
  // server, and silently discarding the second would leave the main process
  // waiting on an answer that can no longer be given (until it times out and
  // denies - correct, but confusing to a user who never saw a prompt).
  useEffect(() => {
    return api.mcp.trust.onRequest((request) => {
      setQueue((q) => (q.some((r) => r.requestId === request.requestId) ? q : [...q, request]))
    })
  }, [])

  const current = queue[0]

  const answer = (decision: 'allow' | 'deny', scope: McpConsentResponse['scope']): void => {
    if (!current) return
    api.mcp.trust.respond({ requestId: current.requestId, decision, scope })
    setQueue((q) => q.slice(1))
  }

  // Escape denies. A dialog you can dismiss into an approval is not a gate.
  useEffect(() => {
    if (!current) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') answer('deny', 'once')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current])

  if (!current) return null

  const { disclosure: d } = current
  const isLocal = d.transport === 'local'
  const changed = current.reason === 'changed'

  return (
    <div
      className="animate-scrim-in fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6"
      onClick={() => answer('deny', 'once')}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="mcp-consent-title"
        className="animate-modal-in flex max-h-[88vh] w-full max-w-lg flex-col overflow-hidden sq sq-2xl sq-ring rounded-2xl border border-border bg-surface"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b border-border px-5 py-4">
          <div
            className={`flex h-9 w-9 shrink-0 items-center justify-center sq sq-xl rounded-xl ${
              changed ? 'bg-danger/15 text-danger' : 'bg-warning/15 text-warning'
            }`}
          >
            {changed ? <AlertTriangle className="h-5 w-5" /> : <ShieldAlert className="h-5 w-5" />}
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="mcp-consent-title" className="text-base font-semibold">
              {changed ? t('mcpTrust.changedTitle') : t('mcpTrust.title')}
            </h2>
            <p className="mt-0.5 text-xs text-text-muted">
              {t(`mcpTrust.origin.${current.provenance}`, {
                name: current.id,
                defaultValue: t('mcpTrust.origin.workspace', { name: current.id })
              })}
            </p>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          {changed && (
            <p className="mb-3 sq sq-lg rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs leading-relaxed text-danger">
              {t('mcpTrust.changedWarning')}
              {current.previousSummary && (
                <span className="mt-1 block font-mono text-[11px] opacity-80">
                  {t('mcpTrust.previously')} {current.previousSummary}
                </span>
              )}
            </p>
          )}

          <p className="mb-3 text-xs leading-relaxed text-text-muted">
            {isLocal ? t('mcpTrust.explainLocal') : t('mcpTrust.explainRemote')}
          </p>

          <dl className="flex flex-col gap-2.5">
            {isLocal ? (
              <>
                <Row
                  icon={<TerminalSquare className="h-3.5 w-3.5" />}
                  label={t('mcpTrust.command')}
                >
                  <code className="block break-all font-mono text-xs text-text">
                    {[d.executable, ...(d.args ?? [])].filter(Boolean).join(' ')}
                  </code>
                </Row>
                <Row icon={<FolderGit2 className="h-3.5 w-3.5" />} label={t('mcpTrust.workingDir')}>
                  <code className="block break-all font-mono text-xs text-text-muted">
                    {d.cwd || current.workspace || t('mcpTrust.workspaceRoot')}
                  </code>
                </Row>
              </>
            ) : (
              <Row icon={<Globe className="h-3.5 w-3.5" />} label={t('mcpTrust.url')}>
                <code className="block break-all font-mono text-xs text-text">{d.url}</code>
              </Row>
            )}

            {/* Names only, never values: a modal is a screenshot waiting to happen. */}
            {!!(isLocal ? d.envNames : d.headerNames)?.length && (
              <Row
                icon={<KeyRound className="h-3.5 w-3.5" />}
                label={isLocal ? t('mcpTrust.envVars') : t('mcpTrust.headers')}
              >
                <div className="flex flex-wrap gap-1">
                  {(isLocal ? d.envNames : d.headerNames)!.map((name) => (
                    <span
                      key={name}
                      className="sq sq-md rounded-md border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-text-muted"
                    >
                      {name}
                    </span>
                  ))}
                </div>
                {d.injectsSecrets && (
                  <p className="mt-1 text-[11px] text-warning">{t('mcpTrust.secretsNote')}</p>
                )}
              </Row>
            )}

            {current.workspace && (
              <Row icon={<FolderGit2 className="h-3.5 w-3.5" />} label={t('mcpTrust.project')}>
                <code className="block break-all font-mono text-xs text-text-muted">
                  {current.workspace}
                </code>
              </Row>
            )}
          </dl>
        </div>

        <div className="flex flex-col gap-2 border-t border-border px-5 py-3">
          <div className="flex items-center gap-2">
            {/* Deny is first and autofocused: the safe answer should be the one
                a reflexive Enter or click lands on. */}
            <Button variant="secondary" autoFocus onClick={() => answer('deny', 'server')}>
              {t('mcpTrust.deny')}
            </Button>
            <Button variant="primary" onClick={() => answer('allow', 'server')}>
              {t('mcpTrust.allow')}
            </Button>
            <span className="ml-auto text-[11px] text-text-subtle">
              {t('mcpTrust.rememberNote')}
            </span>
          </div>
          {/* Trusting the whole project is offered only for workspace-declared
              servers - it is scoped to a folder, so it is meaningless (and
              would be dangerously broad) for anything else. */}
          {current.provenance === 'workspace' && current.workspace && (
            <button
              onClick={() => answer('allow', 'workspace')}
              className="press-scale self-start text-[11px] text-text-muted underline-offset-2 hover:text-text hover:underline"
            >
              {t('mcpTrust.trustWorkspace')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function Row({
  icon,
  label,
  children
}: {
  icon: JSX.Element
  label: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1 sq sq-lg sq-ring rounded-lg border border-border bg-surface-2 px-3 py-2">
      <dt className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-text-subtle">
        {icon}
        {label}
      </dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}
