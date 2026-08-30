import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Boxes,
  CircleAlert,
  FolderGit2,
  Globe,
  KeyRound,
  Package,
  ShieldAlert,
  TerminalSquare,
  Wrench,
  X
} from 'lucide-react'
import type { McpInstallNotice } from '@shared/mcp-trust'
import { api } from '../lib/api'
import { Button } from './ui'

/**
 * "Here's what you just installed" — shown AFTER an MCP server connects, once.
 *
 * This is the disclosure that replaces an approval dialog. Installing a server
 * is the user's decision; asking them to re-confirm it teaches nothing and
 * trains the click-through reflex. What they genuinely can't know in advance is
 * WHAT THE SERVER GAVE THEM — and that only exists after the handshake.
 *
 * So the hierarchy is:
 *   1. The tools it added, by name. The reason you installed it.
 *   2. The source it came from. The thing actually worth trusting.
 *   3. The command/URL, for anyone who wants to check.
 *   4. One honest line: an MCP server runs with your access — trust the source.
 *
 * Dismissable, non-blocking, and never shown twice for the same server.
 */
export function McpInstallSheet(): JSX.Element | null {
  const { t } = useTranslation()
  const [queue, setQueue] = useState<McpInstallNotice[]>([])

  useEffect(() => {
    return api.mcp.trust.onInstall((notice) => {
      setQueue((q) => (q.some((n) => n.id === notice.id) ? q : [...q, notice]))
    })
  }, [])

  const current = queue[0]
  const dismiss = (): void => setQueue((q) => q.slice(1))

  useEffect(() => {
    if (!current) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') dismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [current])

  if (!current) return null

  const { disclosure: d, tools, error } = current
  const isLocal = d.transport === 'local'
  const credentialNames = (isLocal ? d.envNames : d.headerNames) ?? []

  return (
    <div
      className="animate-scrim-in fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6"
      onClick={dismiss}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="mcp-install-title"
        className="animate-modal-in flex max-h-[88vh] w-full max-w-lg flex-col overflow-hidden sq sq-2xl sq-ring rounded-2xl border border-border bg-surface"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b border-border px-5 py-4">
          <div
            className={`flex h-9 w-9 shrink-0 items-center justify-center sq sq-xl rounded-xl ${
              error ? 'bg-danger/15 text-danger' : 'bg-success/15 text-success'
            }`}
          >
            {error ? <CircleAlert className="h-5 w-5" /> : <Boxes className="h-5 w-5" />}
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="mcp-install-title" className="text-base font-semibold">
              {error
                ? t('mcpInstall.failedTitle', { name: current.id })
                : t('mcpInstall.title', { name: current.id })}
            </h2>
            <p className="mt-0.5 truncate text-xs text-text-muted" title={d.source}>
              {t('mcpInstall.from')} <span className="font-mono">{d.source}</span>
            </p>
          </div>
          <button
            onClick={dismiss}
            aria-label={t('common.close')}
            className="press-scale -mr-1 -mt-1 rounded-md p-1 text-text-subtle hover:text-text"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          {error ? (
            <p className="sq sq-lg rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs leading-relaxed text-danger">
              {error}
            </p>
          ) : (
            <>
              {/* The tools ARE the headline: this is what the user gained. */}
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-text-subtle">
                {tools.length
                  ? t('mcpInstall.toolsAdded', { count: tools.length })
                  : t('mcpInstall.noTools')}
              </p>
              {tools.length > 0 && (
                <div className="mb-4 flex flex-wrap gap-1.5">
                  {tools.map((name) => (
                    <span
                      key={name}
                      className="flex items-center gap-1 sq sq-md rounded-md border border-border bg-surface-2 px-2 py-1 font-mono text-[11px] text-text"
                    >
                      <Wrench className="h-3 w-3 text-text-subtle" />
                      {name}
                    </span>
                  ))}
                </div>
              )}
            </>
          )}

          <dl className="flex flex-col gap-2.5">
            <Row
              icon={
                isLocal ? <Package className="h-3.5 w-3.5" /> : <Globe className="h-3.5 w-3.5" />
              }
              label={t('mcpInstall.source')}
            >
              <code className="block break-all font-mono text-xs text-text">{d.source}</code>
            </Row>
            <Row
              icon={<TerminalSquare className="h-3.5 w-3.5" />}
              label={isLocal ? t('mcpInstall.command') : t('mcpInstall.url')}
            >
              <code className="block break-all font-mono text-xs text-text-muted">
                {isLocal ? [d.executable, ...(d.args ?? [])].filter(Boolean).join(' ') : d.url}
              </code>
            </Row>
            {credentialNames.length > 0 && (
              <Row
                icon={<KeyRound className="h-3.5 w-3.5" />}
                label={isLocal ? t('mcpInstall.envVars') : t('mcpInstall.headers')}
              >
                <div className="flex flex-wrap gap-1">
                  {credentialNames.map((name) => (
                    <span
                      key={name}
                      className="sq sq-md rounded-md border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-text-muted"
                    >
                      {name}
                    </span>
                  ))}
                </div>
                {d.injectsSecrets && (
                  <p className="mt-1 text-[11px] text-warning">{t('mcpInstall.secretsNote')}</p>
                )}
              </Row>
            )}
            {current.workspace && (
              <Row icon={<FolderGit2 className="h-3.5 w-3.5" />} label={t('mcpInstall.project')}>
                <code className="block break-all font-mono text-xs text-text-muted">
                  {current.workspace}
                </code>
              </Row>
            )}
          </dl>

          {/* The one honest warning. Not "are you sure?" - the user already
              decided - but the fact that makes the decision theirs to own. */}
          <div className="mt-4 flex items-start gap-2 sq sq-lg rounded-lg border border-warning/30 bg-warning/10 px-3 py-2">
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
            <p className="text-[11px] leading-relaxed text-text">
              <span className="font-medium">{t('mcpInstall.trustSourceTitle')}</span>{' '}
              {isLocal ? t('mcpInstall.trustSourceLocal') : t('mcpInstall.trustSourceRemote')}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 border-t border-border px-5 py-3">
          <Button variant="primary" autoFocus onClick={dismiss}>
            {t('mcpInstall.done')}
          </Button>
          <span className="ml-auto text-[11px] text-text-subtle">{t('mcpInstall.manageNote')}</span>
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
