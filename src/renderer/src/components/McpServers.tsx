import { useEffect, useState } from 'react'
import { useTranslation, Trans } from 'react-i18next'
import { Braces, Plug, Plus, RefreshCw, Trash2 } from 'lucide-react'
import type { McpServerView } from '@shared/api'
import {
  parseMcpJson,
  serializeServerConfig,
  type McpServerConfig,
  type ParsedMcpJson
} from '@shared/mcp'
import { api } from '../lib/api'
import { Button, Input, Switch, Badge, Textarea } from './ui'
import { ConfigBackup } from './ConfigBackup'

function configSummary(config: McpServerConfig): string {
  return config.type === 'remote' ? config.url : config.command.join(' ')
}

/* Badge's visible worklet hairline comes from `sq-ring-*`; the matching
   `border-*` is still required as the graceful fallback when Paint Worklet is
   unavailable or has not loaded yet. */
const MCP_STATUS_STYLES: Record<McpServerView['status'], string> = {
  connected: 'border-success/30 sq-ring-success bg-success/15 text-success',
  error: 'border-danger/30 sq-ring-danger bg-danger/15 text-danger',
  disabled: 'text-text-muted'
}

/** Sizes the JSON editor to its content so a long config isn't read through a slot. */
function jsonRows(text: string): number {
  return Math.min(24, Math.max(6, text.split('\n').length + 1))
}

const JSON_PLACEHOLDER = `{
  "type": "local",
  "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/path"],
  "environment": { "API_KEY": "…" }
}`

/** List/add/toggle/reconnect/remove external MCP tool servers. Shared by Settings + the MCP page. */
export function McpServers({ showBackup = false }: { showBackup?: boolean } = {}): JSX.Element {
  const { t } = useTranslation()
  const [servers, setServers] = useState<McpServerView[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'local' | 'remote' | 'json'>('local')
  const [value, setValue] = useState('')
  const [json, setJson] = useState('')
  const [formErr, setFormErr] = useState('')
  /** id of the server whose raw JSON is open in the editor (only one at a time). */
  const [editing, setEditing] = useState<string | null>(null)

  const reload = async (): Promise<void> => {
    setServers(await api.mcp.list())
  }

  useEffect(() => {
    api.mcp.list().then((rows) => {
      setServers(rows)
      setLoading(false)
    })
  }, [])

  const toggle = async (id: string, enabled: boolean): Promise<void> => {
    setBusy(id)
    try {
      setServers(await api.mcp.setEnabled(id, enabled))
    } finally {
      setBusy(null)
    }
  }
  const reconnect = async (id: string): Promise<void> => {
    setBusy(id)
    try {
      setServers(await api.mcp.reconnect(id))
    } finally {
      setBusy(null)
    }
  }
  const remove = async (id: string): Promise<void> => {
    setBusy(id)
    try {
      setServers(await api.mcp.remove(id))
      if (editing === id) setEditing(null)
    } finally {
      setBusy(null)
    }
  }

  /**
   * Persist an edited raw config. A pasted `{ "<name>": … }` map whose name
   * differs from the row's is treated as a rename (write the new entry, drop the
   * old one) rather than silently ignored — but never one that lands on another
   * server, since upsert-then-remove would clobber the one already there.
   *
   * Resolves to a message for the editor to show, or null when the save stuck.
   */
  const saveRaw = async (server: McpServerView, parsed: ParsedMcpJson): Promise<string | null> => {
    const nextId = parsed.id?.trim() || server.id
    const enabled = parsed.enabled ?? server.enabled
    if (nextId !== server.id && servers.some((s) => s.id === nextId)) {
      return t('mcp.errRenameCollision', { name: nextId })
    }
    setBusy(server.id)
    try {
      await api.mcp.upsert({ id: nextId, config: parsed.config, enabled })
      if (nextId !== server.id) await api.mcp.remove(server.id)
      // Reconnect so the edit is validated against the real server right away —
      // debugging a config whose result you can't see is the problem being fixed.
      setServers(enabled ? await api.mcp.reconnect(nextId) : await api.mcp.list())
      setEditing(null)
      return null
    } catch (e) {
      // A rejected upsert (the main process refusing the config) has to surface
      // here rather than vanish; showing failures is this editor's whole job.
      await reload()
      return e instanceof Error ? e.message : t('mcp.errSaveFailed')
    } finally {
      setBusy(null)
    }
  }

  const submit = async (): Promise<void> => {
    let id = name.trim()
    let config: McpServerConfig
    let enabled = true

    if (kind === 'json') {
      const parsed = parseMcpJson(json)
      if (!parsed.ok) {
        setFormErr(parsed.error)
        return
      }
      // A named map carries its own name, so pasting a README snippet needs no typing.
      id = id || (parsed.value.id ?? '')
      config = parsed.value.config
      enabled = parsed.value.enabled ?? true
      if (!id) {
        setFormErr(t('mcp.errNameRequiredJson'))
        return
      }
    } else {
      if (!id) {
        setFormErr(t('mcp.errNameRequired'))
        return
      }
      if (kind === 'remote') {
        const url = value.trim()
        if (!/^https?:\/\//i.test(url)) {
          setFormErr(t('mcp.errInvalidUrl'))
          return
        }
        config = { type: 'remote', url }
      } else {
        const argv = value.trim().split(/\s+/).filter(Boolean)
        if (!argv.length) {
          setFormErr(t('mcp.errCommandRequired'))
          return
        }
        config = { type: 'local', command: argv }
      }
    }

    if (servers.some((s) => s.id === id)) {
      setFormErr(t('mcp.errDuplicateName'))
      return
    }
    setBusy('__add__')
    setFormErr('')
    try {
      await api.mcp.upsert({ id, config, enabled })
      // Connect immediately so the user sees the live status / any error.
      setServers(enabled ? await api.mcp.reconnect(id) : await api.mcp.list())
      setShowAdd(false)
      setName('')
      setValue('')
      setJson('')
      setKind('local')
    } catch (e) {
      setFormErr(e instanceof Error ? e.message : t('mcp.errAddFailed'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {loading ? (
        <p className="text-xs text-text-subtle">{t('common.loading')}</p>
      ) : servers.length === 0 && !showAdd ? (
        <p className="text-xs text-text-muted">
          <Trans i18nKey="mcp.emptyState" />
        </p>
      ) : (
        servers.map((s) => (
          <div
            key={s.id}
            className="flex flex-col sq sq-xl sq-ring rounded-xl border border-border bg-surface p-3.5"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center sq sq-lg sq-ring rounded-lg border border-border bg-surface-2">
                <Plug className="h-4 w-4 text-text-muted" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-text">{s.id}</span>
                  <Badge className={MCP_STATUS_STYLES[s.status]}>
                    {s.status === 'connected'
                      ? t('mcp.toolCount', { count: s.tools.length })
                      : s.status === 'error'
                        ? t('mcp.statusError')
                        : t('mcp.statusDisabled')}
                  </Badge>
                </div>
                <p
                  className="mt-0.5 truncate text-xs text-text-subtle"
                  title={configSummary(s.config)}
                >
                  {configSummary(s.config)}
                </p>
                {s.status === 'error' && s.error && (
                  <p className="mt-0.5 truncate text-xs text-danger" title={s.error}>
                    {s.error}
                  </p>
                )}
              </div>
              <Switch
                checked={s.enabled}
                disabled={busy === s.id}
                onChange={(v) => void toggle(s.id, v)}
              />
              <Button
                size="sm"
                variant="ghost"
                disabled={busy === s.id}
                onClick={() => setEditing((cur) => (cur === s.id ? null : s.id))}
                title={t('mcp.editRawJson')}
                aria-expanded={editing === s.id}
                className={editing === s.id ? 'text-text' : undefined}
              >
                <Braces className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy === s.id || !s.enabled}
                onClick={() => void reconnect(s.id)}
                title={t('mcp.reconnect')}
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy === s.id}
                onClick={() => void remove(s.id)}
                title={t('common.remove')}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
            {editing === s.id && (
              // Keyed by the stored config so an external change (import, the mcp
              // tool) reseeds the draft instead of leaving stale text on screen.
              <RawConfigEditor
                key={configSummary(s.config)}
                server={s}
                busy={busy === s.id}
                onCancel={() => setEditing(null)}
                onSave={(parsed) => saveRaw(s, parsed)}
              />
            )}
          </div>
        ))
      )}

      {showAdd ? (
        <div className="flex flex-col gap-3 sq sq-xl sq-ring rounded-xl border border-border bg-surface p-4">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={
                kind === 'json' ? t('mcp.namePlaceholderJson') : t('mcp.namePlaceholder')
              }
              className="sm:w-48"
              spellCheck={false}
              autoComplete="off"
            />
            <select
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as 'local' | 'remote' | 'json')
                setFormErr('')
              }}
              className="h-9 sq sq-lg sq-ring rounded-lg border border-border bg-surface-2 px-2 text-sm text-text outline-none"
            >
              <option value="local">{t('mcp.kindLocal')}</option>
              <option value="remote">{t('mcp.kindRemote')}</option>
              <option value="json">{t('mcp.kindJson')}</option>
            </select>
          </div>
          {kind === 'json' ? (
            <Textarea
              value={json}
              onChange={(e) => {
                setJson(e.target.value)
                setFormErr('')
              }}
              rows={jsonRows(json || JSON_PLACEHOLDER)}
              placeholder={JSON_PLACEHOLDER}
              className="font-mono text-xs leading-relaxed"
              spellCheck={false}
              autoComplete="off"
            />
          ) : (
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={
                kind === 'remote'
                  ? 'https://example.com/mcp'
                  : 'npx -y @modelcontextprotocol/server-filesystem /path'
              }
              spellCheck={false}
              autoComplete="off"
            />
          )}
          {formErr && <p className="text-xs text-danger">{formErr}</p>}
          <div className="flex items-center gap-2">
            <Button variant="primary" disabled={busy === '__add__'} onClick={() => void submit()}>
              {busy === '__add__' ? t('mcp.connecting') : t('mcp.addAndConnect')}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setShowAdd(false)
                setFormErr('')
              }}
            >
              {t('common.cancel')}
            </Button>
            <span className="ml-auto text-[11px] text-text-subtle">
              {kind === 'json' ? t('mcp.jsonHint') : t('mcp.advancedHint')}
            </span>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowAdd(true)}
          className="press-scale flex items-center justify-center gap-2 sq sq-xl sq-ring sq-dashed rounded-xl border border-dashed border-border bg-surface/40 p-3.5 text-sm text-text-muted hover:border-border-strong hover:[--sq-ring:var(--color-border-strong)] hover:bg-surface hover:text-text"
        >
          <Plus className="h-4 w-4" /> {t('mcp.addServer')}
        </button>
      )}
      {showBackup && (
        <div className="mt-1 border-t border-border pt-3">
          <ConfigBackup onImported={() => void reload()} />
        </div>
      )}
    </div>
  )
}

/**
 * The raw-config escape hatch: one server's stored JSON, editable in place, with
 * its last connection error and live tool list underneath. What it shows is the
 * *normalized* config actually in effect (unknown keys were dropped on the way
 * in) — which is the point: when a server misbehaves you want to see what Roxy
 * is really launching, not what you believe you typed.
 */
function RawConfigEditor({
  server,
  busy,
  onCancel,
  onSave
}: {
  server: McpServerView
  busy: boolean
  onCancel: () => void
  onSave: (parsed: ParsedMcpJson) => Promise<string | null>
}): JSX.Element {
  const { t } = useTranslation()
  const stored = serializeServerConfig(server.config)
  const [text, setText] = useState(stored)
  const [err, setErr] = useState('')

  const dirty = text !== stored
  const parsed = parseMcpJson(text)
  const renameTo =
    parsed.ok && parsed.value.id && parsed.value.id !== server.id ? parsed.value.id : null

  const save = async (): Promise<void> => {
    if (!parsed.ok) {
      setErr(parsed.error)
      return
    }
    setErr(await onSave(parsed.value).then((e) => e ?? ''))
  }

  return (
    <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3">
      <Textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          setErr('')
        }}
        rows={jsonRows(text)}
        className="font-mono text-xs leading-relaxed"
        spellCheck={false}
        autoComplete="off"
        aria-label={t('mcp.rawConfigAriaLabel', { name: server.id })}
        onKeyDown={(e) => {
          // Cmd/Ctrl+Enter saves; a bare Enter has to stay a newline inside JSON.
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            void save()
          }
        }}
      />
      {/* One line, in priority order: a failed save, then a parse problem (only
          once you've typed — the stored config always parses), then a rename. */}
      {err ? (
        <p className="text-xs text-danger">{err}</p>
      ) : !parsed.ok && dirty ? (
        <p className="text-xs text-warning">{parsed.error}</p>
      ) : renameTo ? (
        <p className="text-xs text-text-muted">
          <Trans
            i18nKey="mcp.renameNotice"
            values={{ name: renameTo }}
            components={{ span: <span className="font-mono text-text" /> }}
          />
        </p>
      ) : null}
      {server.status === 'error' && server.error && (
        <p className="text-xs text-danger">
          {t('mcp.lastErrorLabel')} <span className="font-mono">{server.error}</span>
        </p>
      )}
      {server.status === 'connected' && (
        <p className="text-xs text-text-subtle">
          {t('mcp.toolsLabel')}{' '}
          <span className="font-mono text-text-muted">
            {server.tools.length ? server.tools.join(', ') : t('mcp.noToolsExposed')}
          </span>
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button size="sm" variant="primary" disabled={busy || !dirty} onClick={() => void save()}>
          {busy ? t('mcp.saving') : server.enabled ? t('mcp.saveAndReconnect') : t('common.save')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || !dirty}
          onClick={() => {
            setText(stored)
            setErr('')
          }}
        >
          {t('mcp.reset')}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          {t('common.close')}
        </Button>
      </div>
    </div>
  )
}
