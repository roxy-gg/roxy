import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ShieldAlert, Wrench } from 'lucide-react'
import type { McpAppApprovalRequest } from '@shared/api'
import { api } from '../lib/api'
import { Button } from './ui'

/**
 * Approval for a tool call a VIEW wants to make.
 *
 * The model calling a tool is the agent doing its job. A server-supplied UI
 * calling one is different: it is untrusted third-party code, running because a
 * tool result happened to carry a view, asking to take an action nobody typed.
 * So it asks — once per (view, tool), then remembers for that view's lifetime.
 *
 * The per-view memory matters as much as the prompt: a spreadsheet app that
 * writes a cell on every keystroke would be unusable if it asked each time, and
 * a dialog people dismiss reflexively protects nothing.
 */
export function McpAppApprovalDialog(): JSX.Element | null {
  const { t } = useTranslation()
  const [queue, setQueue] = useState<McpAppApprovalRequest[]>([])

  useEffect(() => {
    return api.mcp.app.onApprovalRequest((req) => {
      setQueue((q) => (q.some((r) => r.requestId === req.requestId) ? q : [...q, req]))
    })
  }, [])

  const current = queue[0]

  const answer = (allowed: boolean): void => {
    if (!current) return
    api.mcp.app.respondApproval({ requestId: current.requestId, allowed })
    setQueue((q) => q.slice(1))
  }

  useEffect(() => {
    if (!current) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') answer(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current])

  if (!current) return null

  const args = JSON.stringify(current.args ?? {}, null, 2)

  return (
    <div
      className="animate-scrim-in fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-6"
      onClick={() => answer(false)}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="animate-modal-in flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden sq sq-2xl sq-ring rounded-2xl border border-border bg-surface"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b border-border px-5 py-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center sq sq-xl rounded-xl bg-warning/15 text-warning">
            <ShieldAlert className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">{t('mcpApp.approveTitle')}</h2>
            <p className="mt-0.5 text-xs text-text-muted">
              {t('mcpApp.approveSubtitle', { server: current.serverId })}
            </p>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          <div className="flex flex-col gap-1 sq sq-lg sq-ring rounded-lg border border-border bg-surface-2 px-3 py-2">
            <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-text-subtle">
              <Wrench className="h-3.5 w-3.5" />
              {t('mcpApp.tool')}
            </div>
            <code className="break-all font-mono text-xs text-text">{current.toolName}</code>
          </div>
          {args !== '{}' && (
            <pre className="mt-2 max-h-48 overflow-auto sq sq-lg rounded-lg border border-border bg-surface-2 px-3 py-2 font-mono text-[11px] leading-relaxed text-text-muted">
              {args}
            </pre>
          )}
          <p className="mt-3 text-[11px] leading-relaxed text-text-muted">
            {t('mcpApp.approveNote')}
          </p>
        </div>

        <div className="flex items-center gap-2 border-t border-border px-5 py-3">
          {/* Deny focused: the safe answer is the one a reflexive Enter lands on. */}
          <Button variant="secondary" autoFocus onClick={() => answer(false)}>
            {t('mcpApp.deny')}
          </Button>
          <Button variant="primary" onClick={() => answer(true)}>
            {t('mcpApp.allow')}
          </Button>
          <span className="ml-auto text-[11px] text-text-subtle">{t('mcpApp.rememberNote')}</span>
        </div>
      </div>
    </div>
  )
}
