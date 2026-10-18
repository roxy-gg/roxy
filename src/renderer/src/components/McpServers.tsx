import { useEffect, useState } from 'react'
import { useTranslation, Trans } from 'react-i18next'
import { Braces, Plus, RefreshCw, Trash2 } from 'lucide-react'
import type { McpServerView } from '@shared/api'
import {
  parseMcpJson,
  serializeServerConfig,
  type McpServerConfig,
  type ParsedMcpJson
} from '@shared/mcp'
import { api } from '../lib/api'
import { Button, Input, Textarea } from './ui'
import { ConfigBackup } from './ConfigBackup'
import { CatalogSearch } from './CatalogSearch'

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
export function McpServers({
  showBackup = false,
  active = true
}: { showBackup?: boolean; active?: boolean } = {}): JSX.Element {
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
  const [listErr, setListErr] = useState('')
  /** id of the server whose raw JSON is open in the editor (only one at a time). */
  const [editing, setEditing] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)

  const reload = async (): Promise<void> => {
    setListErr('')
    try {
      setServers(await api.mcp.list())
    } catch {
      setListErr(t('catalog.listFailed'))
    }
  }

  useEffect(() => {
    if (!active) return
    let alive = true
    setListErr('')
    api.mcp
      .list()
      .then((rows) => {
        if (alive) setServers(rows)
      })
      .catch(() => {
        if (alive) setListErr(t('catalog.listFailed'))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [active, t])

  const toggle = async (id: string, enabled: boolean): Promise<void> => {
    setBusy(id)
    setListErr('')
    try {
      setServers(await api.mcp.setEnabled(id, enabled))
    } catch {
      setListErr(t('catalog.actionFailed'))
    } finally {
      setBusy(null)
    }
  }
  const reconnect = async (id: string): Promise<void> => {
    setBusy(id)
    setListErr('')
    try {
      setServers(await api.mcp.reconnect(id))
    } catch {
      setListErr(t('catalog.actionFailed'))
    } finally {
      setBusy(null)
    }
  }
  const remove = async (id: string): Promise<void> => {
    setBusy(id)
    setListErr('')
    try {
      setServers(await api.mcp.remove(id))
      setRemoving(null)
      if (editing === id) setEditing(null)
    } catch {
      setListErr(t('catalog.actionFailed'))
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
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          onClick={() => {
            setShowAdd((value) => !value)
            setEditing(null)
          }}
          disabled={busy !== null}
        >
          <Plus className="h-3.5 w-3.5" />
          {t('mcp.addServer')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void reload()} disabled={busy !== null}>
          <RefreshCw className="h-3.5 w-3.5" />
          {t('catalog.refresh')}
        </Button>
        {showBackup && <ConfigBackup onImported={() => void reload()} />}
      </div>
      {listErr && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-danger">
          <p>{listErr}</p>
          <Button
            size="sm"
            onClick={() => void reload()}
            disabled={!active}
            className="focus-visible:inset-ring-2 focus-visible:inset-ring-accent/70"
          >
            {t('catalog.retry')}
          </Button>
        </div>
      )}
      {loading && <p className="text-xs text-text-subtle">{t('common.loading')}</p>}
      {editing &&
        servers.find((s) => s.id === editing) &&
        (() => {
          const server = servers.find((s) => s.id === editing)!
          return (
            <div className="rounded-lg border border-border bg-surface p-4">
              <h3 className="text-sm font-medium text-text">
                {t('mcp.rawConfigAriaLabel', { name: server.id })}
              </h3>
              <RawConfigEditor
                key={server.id + JSON.stringify(server.config)}
                server={server}
                busy={busy === server.id}
                onCancel={() => setEditing(null)}
                onSave={(parsed) => saveRaw(server, parsed)}
              />
            </div>
          )
        })()}
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
      ) : null}
      {removing && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface p-3 text-xs text-text"
        >
          <span>{t('catalog.confirmRemove', { name: removing })}</span>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={() => setRemoving(null)}
          >
            {t('common.cancel')}
          </Button>
          <Button
            size="sm"
            variant="danger"
            disabled={busy !== null}
            onClick={() => void remove(removing)}
          >
            {t('common.remove')}
          </Button>
        </div>
      )}
      <div className="mt-3">
        <CatalogSearch
          kind="mcp"
          active={active}
          installedServers={servers}
          onMcpInstalled={setServers}
          renderMcpActions={(server) => (
            <>
              <button
                type="button"
                role="switch"
                aria-checked={server.enabled}
                aria-label={t('catalog.enableNamed', { name: server.id })}
                disabled={busy !== null}
                onClick={() => void toggle(server.id, !server.enabled)}
                className={`relative mr-1 inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40 ${server.enabled ? 'bg-accent' : 'bg-surface-2 inset-ring-1 inset-ring-border'}`}
              >
                <span
                  className={`h-4 w-4 rounded-full bg-white ${server.enabled ? 'translate-x-4' : 'translate-x-0'}`}
                />
              </button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy !== null}
                onClick={() => {
                  setEditing(server.id)
                  setShowAdd(false)
                }}
                title={t('mcp.editRawJson')}
                aria-label={t('catalog.editRawNamed', { name: server.id })}
              >
                <Braces className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy !== null || !server.enabled}
                onClick={() => void reconnect(server.id)}
                title={t('mcp.reconnect')}
                aria-label={t('catalog.reconnectNamed', { name: server.id })}
              >
                <RefreshCw className={`h-3.5 w-3.5 ${busy === server.id ? 'animate-spin' : ''}`} />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy !== null}
                onClick={() => setRemoving(server.id)}
                title={t('common.remove')}
                aria-label={t('catalog.removeNamed', { name: server.id })}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
        />
      </div>
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
