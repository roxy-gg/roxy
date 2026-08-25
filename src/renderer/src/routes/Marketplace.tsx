/**
 * The Marketplace — one place to answer "what else can Roxy do?".
 *
 * ## The intuitiveness problem this page is solving
 *
 * Before this page, extending Roxy meant knowing *which mechanism* your wish was
 * implemented by: a Skill, an MCP server, an Integration, or the Remote Workspace
 * dialog. Four pages, four vocabularies, and every one of them named after the
 * plumbing rather than the outcome. That is only navigable if you already built it.
 *
 * Five decisions make this version intuitive, in order of how much they matter:
 *
 * 1. **One noun.** Everything is an *Add-on*. The mechanism survives as a small
 *    badge ("Tool server", "Skill") because it is genuinely useful once you're
 *    curious — but it is never how the list is organized, and never something you
 *    must understand first. You search for "postgres", not for "an MCP server".
 *
 * 2. **Two tabs, not seven.** *Installed* (what I have) and *Discover* (what I
 *    could have) — the split VS Code got right, and the only split that maps onto
 *    a question a user actually has. Labs is a third tab only because it answers a
 *    different question: "where is this going?".
 *
 * 3. **Search is the primary control.** Categories and kinds are secondary chips,
 *    and the search index deliberately includes the jargon we removed from the
 *    surface, so "mcp" and "SKILL.md" still find the right cards.
 *
 * 4. **Permissions on the card, before install.** Every add-on states what it can
 *    do in plain language, and its risk is *derived* from those capabilities
 *    (`addonRisk`) rather than self-reported. This is what lets a page like this
 *    list something as dangerous as SuperUser honestly.
 *
 * 5. **One switch means one thing.** A live toggle for anything real; an explicit
 *    "Preview — not wired up" for shells; a "Watch"-style interest signal for
 *    ideas. A control that looks live but is inert would poison every other
 *    control on the page.
 *
 * ## Wiring
 *
 * No new IPC. Installed rows are read from the existing `skills.list()`,
 * `mcp.list()` and `integrations.list()`; installs go through `mcp.upsert` +
 * `mcp.reconnect` and `skills.install`; flags for previews/labs persist through
 * `integrations.setEnabled` under namespaced ids (`addon:` / `lab:`).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowUpRight,
  ChevronRight,
  Download,
  FlaskConical,
  Loader2,
  Plug,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  Trash2,
  X
} from 'lucide-react'
import type { McpServerView, SkillView } from '@shared/api'
import type { IntegrationConnection } from '@shared/types'
import { INTEGRATIONS } from '@shared/integrations'
import {
  ADDON_CATEGORIES,
  LAB_IDEAS,
  MARKETPLACE_CATALOG,
  SUPERUSER_ADDON,
  addonFlagId,
  addonRisk,
  getAddonKind,
  getCatalogAddon,
  installNeeds,
  labFlagId,
  matchesFilter,
  matchesQuery,
  needsConsent,
  readFlag,
  sortCapabilities,
  type AddonCategory,
  type AddonKind,
  type AddonManifest,
  type AddonState,
  type CapabilityId,
  type LabIdea,
  type RiskLevel
} from '@shared/marketplace'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { CatalogIcon } from '../lib/icons'
import { Badge, Button, Input, Switch } from '../components/ui'
import { PageShell } from '../components/PageShell'
import { McpServers } from '../components/McpServers'

// ---------------------------------------------------------------------------
// The row model — a manifest plus whatever the backends say about it right now
// ---------------------------------------------------------------------------

/**
 * One card's worth of truth. `manifest` is the published description; the rest is
 * live state merged in from the subsystem that actually owns the thing.
 */
interface AddonRow {
  manifest: AddonManifest
  state: AddonState
  /** Where it lives / what it runs — the one grey line under the tagline. */
  detail?: string
  /** Set when `state === 'broken'`. */
  error?: string
  /** Tool count for a connected server. */
  tools?: number
}

type Tab = 'installed' | 'discover' | 'labs'

const RISK_STYLES: Record<RiskLevel, string> = {
  safe: 'border-border text-text-muted',
  moderate: 'border-border text-text-muted',
  elevated: 'border-warning/30 bg-warning/10 text-warning',
  critical: 'border-danger/30 bg-danger/10 text-danger'
}

const STATE_LABEL: Record<AddonState, string> = {
  enabled: 'On',
  disabled: 'Off',
  available: 'Not installed',
  preview: 'Preview',
  planned: 'Idea',
  broken: 'Needs attention'
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Marketplace(): JSX.Element {
  const navigate = useNavigate()
  const [tab, setTab] = useState<Tab>('installed')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<AddonCategory | null>(null)
  const [kind, setKind] = useState<AddonKind | null>(null)
  const [selected, setSelected] = useState<AddonRow | null>(null)
  const [manual, setManual] = useState(false)

  const { rows, flags, loading, reload } = useInstalledAddons()

  // Installing / toggling by add-on id, so only the touched card shows a spinner.
  const [busy, setBusy] = useState<string | null>(null)

  const installed = useMemo(
    () => rows.filter((r) => r.state !== 'available' && r.state !== 'planned'),
    [rows]
  )
  const installedIds = useMemo(() => new Set(installed.map((r) => r.manifest.id)), [installed])

  /** Discover hides what you already have — a catalog full of "Installed" is noise. */
  const discover = useMemo<AddonRow[]>(
    () =>
      MARKETPLACE_CATALOG.filter((m) => !installedIds.has(m.id)).map((manifest) => ({
        manifest,
        state: 'available' as const
      })),
    [installedIds]
  )

  const source = tab === 'installed' ? installed : tab === 'discover' ? discover : []
  const visible = useMemo(
    () => source.filter((r) => matchesFilter(r.manifest, { query, category, kind })),
    [source, query, category, kind]
  )

  const visibleLabs = useMemo(
    () => LAB_IDEAS.filter((idea) => matchesQuery({ ...idea, kind: 'lab' }, query)),
    [query]
  )

  const setFlag = async (flag: string, value: boolean): Promise<void> => {
    setBusy(flag)
    try {
      await api.integrations.setEnabled(flag, value)
      await reload()
    } finally {
      setBusy(null)
    }
  }

  return (
    <PageShell
      title="Marketplace"
      onBack={() => navigate('/')}
      wide
      actions={
        <Button size="sm" variant="ghost" onClick={() => void reload()} className="gap-1.5">
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          Refresh
        </Button>
      }
    >
      <div className="flex flex-col gap-5">
        <Header />

        {/* Search first: the primary control, not a filter tucked in a corner. */}
        <div className="flex flex-col gap-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-subtle" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search add-ons — try “postgres”, “review”, “phone”, or “mcp”"
              className="h-10 pl-9"
              spellCheck={false}
              autoComplete="off"
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                title="Clear"
                className="press-scale absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center sq sq-md rounded-md text-text-subtle hover:bg-white/5 hover:text-text"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <Tabs
            tab={tab}
            counts={{
              installed: installed.length,
              discover: discover.length,
              labs: LAB_IDEAS.length
            }}
            onChange={(t) => {
              setTab(t)
              setCategory(null)
              setKind(null)
            }}
          />

          {tab !== 'labs' && (
            <FilterRow category={category} kind={kind} onCategory={setCategory} onKind={setKind} />
          )}
        </div>

        {tab === 'labs' ? (
          <LabsTab
            ideas={visibleLabs}
            flags={flags}
            busy={busy}
            onToggle={(idea, value) => void setFlag(labFlagId(idea.id), value)}
          />
        ) : loading ? (
          <p className="py-10 text-center text-xs text-text-muted">Reading your add-ons…</p>
        ) : visible.length === 0 ? (
          <EmptyResult
            tab={tab}
            query={query}
            onClear={() => {
              setQuery('')
              setCategory(null)
              setKind(null)
            }}
            onDiscover={() => setTab('discover')}
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {visible.map((row) => (
              <AddonCard
                key={row.manifest.id}
                row={row}
                busy={busy === row.manifest.id}
                onOpen={() => setSelected(row)}
                onInstalled={reload}
                onBusy={setBusy}
                onFlag={setFlag}
              />
            ))}
          </div>
        )}

        {tab !== 'labs' && <ManualSection open={manual} onToggle={() => setManual((v) => !v)} />}
      </div>

      {selected && (
        <DetailPanel row={selected} onClose={() => setSelected(null)} onChanged={reload} />
      )}
    </PageShell>
  )
}

/** The one-paragraph frame: what an add-on is, before any list of them. */
function Header(): JSX.Element {
  return (
    <div>
      <p className="text-sm text-text-muted">
        Add-ons are how Roxy gets new abilities — new tools, reusable playbooks, other places to
        reach it from, other devices to run it on. Every one says up front what it is allowed to do,
        and can be switched off without being removed.
      </p>
    </div>
  )
}

function Tabs({
  tab,
  counts,
  onChange
}: {
  tab: Tab
  counts: Record<Tab, number>
  onChange: (tab: Tab) => void
}): JSX.Element {
  const items: { id: Tab; label: string; hint: string }[] = [
    { id: 'installed', label: 'Installed', hint: 'What Roxy can do right now' },
    { id: 'discover', label: 'Discover', hint: 'One-click add-ons' },
    { id: 'labs', label: 'Labs', hint: 'Ideas being explored' }
  ]
  return (
    <div className="flex items-center gap-1 border-b border-border">
      {items.map((it) => (
        <button
          key={it.id}
          onClick={() => onChange(it.id)}
          title={it.hint}
          className={cn(
            'relative -mb-px flex items-center gap-1.5 px-3 py-2 text-sm transition-colors',
            tab === it.id
              ? 'border-b-2 border-text font-medium text-text'
              : 'border-b-2 border-transparent text-text-muted hover:text-text'
          )}
        >
          {it.id === 'labs' && <FlaskConical className="h-3.5 w-3.5" />}
          {it.label}
          {counts[it.id] > 0 && (
            <span className="text-[11px] tabular-nums text-text-subtle">{counts[it.id]}</span>
          )}
        </button>
      ))}
    </div>
  )
}

/**
 * Secondary filters. Kinds are listed *after* categories and worded as outcomes
 * ("Tool server", not "MCP") — the mechanism is available to filter by, but it is
 * not the first thing asked of you.
 */
function FilterRow({
  category,
  kind,
  onCategory,
  onKind
}: {
  category: AddonCategory | null
  kind: AddonKind | null
  onCategory: (c: AddonCategory | null) => void
  onKind: (k: AddonKind | null) => void
}): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Chip active={!category && !kind} onClick={() => (onCategory(null), onKind(null))}>
        All
      </Chip>
      <span className="mx-0.5 h-4 w-px bg-border" />
      {ADDON_CATEGORIES.map((c) => (
        <Chip key={c} active={category === c} onClick={() => onCategory(category === c ? null : c)}>
          {c}
        </Chip>
      ))}
      <span className="mx-0.5 h-4 w-px bg-border" />
      {(['skill', 'mcp'] as AddonKind[]).map((k) => (
        <Chip key={k} active={kind === k} onClick={() => onKind(kind === k ? null : k)}>
          {getAddonKind(k)?.label}
        </Chip>
      ))}
    </div>
  )
}

function Chip({
  active,
  onClick,
  children
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={cn(
        'press-scale rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
        active
          ? 'border-text/20 bg-white text-black'
          : 'border-border text-text-muted hover:border-border-strong hover:text-text'
      )}
    >
      {children}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

function AddonCard({
  row,
  busy,
  onOpen,
  onInstalled,
  onBusy,
  onFlag
}: {
  row: AddonRow
  busy: boolean
  onOpen: () => void
  onInstalled: () => Promise<void>
  onBusy: (id: string | null) => void
  onFlag: (flag: string, value: boolean) => Promise<void>
}): JSX.Element {
  const { manifest, state } = row
  const risk = addonRisk(manifest.capabilities)
  const kindDef = getAddonKind(manifest.kind)

  return (
    <div
      className={cn(
        'group flex flex-col gap-3 sq sq-xl sq-ring rounded-xl border border-border bg-surface p-4 transition-colors hover:border-border-strong hover:[--sq-ring:var(--color-border-strong)]',
        state === 'broken' &&
          'border-danger/30 [--sq-ring:color-mix(in_srgb,var(--color-danger)_30%,transparent)]'
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center sq sq-lg rounded-lg',
            risk === 'critical' ? 'bg-danger/10 text-danger' : 'bg-white/5 text-text-muted'
          )}
        >
          <CatalogIcon name={manifest.icon} className="h-4 w-4" />
        </span>

        <button onClick={onOpen} className="min-w-0 flex-1 text-left">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-medium text-text">{manifest.name}</span>
            {kindDef && <Badge>{kindDef.label}</Badge>}
            <StateBadge state={state} />
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs text-text-muted">{manifest.tagline}</p>
          {row.detail && (
            <p className="mt-1 truncate text-[11px] text-text-subtle" title={row.detail}>
              {row.detail}
            </p>
          )}
          {row.error && (
            <p className="mt-1 line-clamp-2 text-[11px] text-danger" title={row.error}>
              {row.error}
            </p>
          )}
        </button>

        <div className="flex shrink-0 items-center gap-1.5">
          <CardAction
            row={row}
            busy={busy}
            onOpen={onOpen}
            onInstalled={onInstalled}
            onBusy={onBusy}
            onFlag={onFlag}
          />
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        <CapabilityChips capabilities={manifest.capabilities} max={3} />
        <button
          onClick={onOpen}
          className="ml-auto inline-flex shrink-0 items-center gap-0.5 text-[11px] text-text-subtle opacity-0 transition-opacity hover:text-text group-hover:opacity-100"
        >
          Details <ChevronRight className="h-3 w-3" />
        </button>
      </div>
    </div>
  )
}

/**
 * The single control on a card, chosen by state. The whole point is that its
 * *shape* tells you what will happen: a switch for something live, a button for
 * something to fetch, and flat text for a shell that isn't wired up.
 */
function CardAction({
  row,
  busy,
  onOpen,
  onInstalled,
  onBusy,
  onFlag
}: {
  row: AddonRow
  busy: boolean
  onOpen: () => void
  onInstalled: () => Promise<void>
  onBusy: (id: string | null) => void
  onFlag: (flag: string, value: boolean) => Promise<void>
}): JSX.Element {
  const { manifest, state } = row

  if (busy) return <Loader2 className="h-4 w-4 animate-spin text-text-subtle" />

  // A preview ships as a shell. It must read as "not built yet", never as "off":
  // an inert switch that looks live is the one thing this page cannot do.
  if (state === 'preview') {
    return (
      <button
        onClick={onOpen}
        className="press-scale rounded-full border border-warning/30 bg-warning/10 px-2.5 py-1 text-[11px] font-medium text-warning"
        title="Shipped as a shell — read the details"
      >
        Preview
      </button>
    )
  }

  if (state === 'available') {
    const needs = installNeeds(manifest.install)
    return (
      <Button
        size="sm"
        variant={manifest.install ? 'primary' : 'secondary'}
        onClick={() => {
          // Anything needing a value (a token, a path) or explicit consent goes
          // through the detail panel. Silently installing a broken config would
          // trade one click for a debugging session.
          if (!manifest.install || needs.length || needsConsent(manifest.capabilities)) {
            onOpen()
            return
          }
          void installAddon(manifest, onBusy, onInstalled)
        }}
        className="gap-1.5"
      >
        {needs.length ? (
          <>
            Set up <ChevronRight className="h-3.5 w-3.5" />
          </>
        ) : (
          <>
            <Download className="h-3.5 w-3.5" /> Add
          </>
        )}
      </Button>
    )
  }

  // Installed and real: one switch, and it means exactly what it says.
  const flag = addonFlagId(manifest.id)
  return (
    <Switch
      checked={state === 'enabled' || state === 'broken'}
      onChange={(v) => {
        if (manifest.kind === 'mcp') {
          onBusy(manifest.id)
          void api.mcp
            .setEnabled(manifest.id, v)
            .then(onInstalled)
            .finally(() => onBusy(null))
        } else if (manifest.kind === 'integration') {
          void onFlag(manifest.id, v)
        } else {
          void onFlag(flag, v)
        }
      }}
    />
  )
}

function StateBadge({ state }: { state: AddonState }): JSX.Element | null {
  if (state === 'enabled' || state === 'available') return null
  const styles: Partial<Record<AddonState, string>> = {
    disabled: 'text-text-subtle',
    broken: 'border-danger/30 bg-danger/10 text-danger',
    preview: 'border-warning/30 bg-warning/10 text-warning',
    planned: 'text-text-subtle'
  }
  return <Badge className={styles[state]}>{STATE_LABEL[state]}</Badge>
}

/** Permission chips, worst-first, so nothing alarming hides behind a "+2". */
function CapabilityChips({
  capabilities,
  max
}: {
  capabilities: CapabilityId[]
  max?: number
}): JSX.Element {
  const caps = sortCapabilities(capabilities)
  if (!caps.length) {
    return <span className="text-[11px] text-text-subtle">No extra permissions</span>
  }
  const shown = max ? caps.slice(0, max) : caps
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {shown.map((c) => (
        <span
          key={c.id}
          title={c.detail}
          className={cn(
            'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium',
            RISK_STYLES[c.risk]
          )}
        >
          <CatalogIcon name={c.icon} className="h-2.5 w-2.5" />
          {c.label}
        </span>
      ))}
      {max && caps.length > max && (
        <span className="text-[10px] text-text-subtle">+{caps.length - max}</span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------------

/**
 * The "extension page": prose, the full permission list, and the install/consent
 * control. A modal rather than a route so browsing state (query, tab, scroll)
 * survives — reading about one add-on should not cost you your search.
 */
function DetailPanel({
  row,
  onClose,
  onChanged
}: {
  row: AddonRow
  onClose: () => void
  onChanged: () => Promise<void>
}): JSX.Element {
  const { manifest, state } = row
  const risk = addonRisk(manifest.capabilities)
  const kindDef = getAddonKind(manifest.kind)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [consent, setConsent] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const gated = needsConsent(manifest.capabilities)

  return (
    <div
      className="animate-scrim-in fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onClick={onClose}
    >
      <div
        className="animate-modal-in flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden sq sq-2xl sq-ring rounded-2xl border border-border bg-surface"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b border-border px-5 py-4">
          <span
            className={cn(
              'flex h-10 w-10 shrink-0 items-center justify-center sq sq-xl rounded-xl',
              risk === 'critical' ? 'bg-danger/10 text-danger' : 'bg-white/5 text-text-muted'
            )}
          >
            <CatalogIcon name={manifest.icon} className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <h2 className="text-base font-semibold text-text">{manifest.name}</h2>
              {kindDef && <Badge>{kindDef.label}</Badge>}
              <StateBadge state={state} />
            </div>
            <p className="mt-0.5 text-xs text-text-muted">
              {manifest.author ?? 'Community'} · {manifest.category}
            </p>
          </div>
          <button
            onClick={onClose}
            className="press-scale flex h-7 w-7 shrink-0 items-center justify-center sq sq-lg rounded-lg text-text-muted hover:bg-white/5 hover:text-text"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <p className="text-sm text-text">{manifest.tagline}</p>

          {manifest.about?.map((para, i) => (
            <p key={i} className="mt-3 text-xs leading-relaxed text-text-muted">
              {para}
            </p>
          ))}

          {kindDef && (
            <p className="mt-4 sq sq-lg sq-ring rounded-lg border border-border bg-surface-2 px-3 py-2 text-[11px] text-text-subtle">
              <span className="font-medium text-text-muted">How it works:</span> {kindDef.detail}
            </p>
          )}

          {/* Permissions in full — the reason this page can be trusted. */}
          <div className="mt-5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-text-subtle">
              What it can do
            </h3>
            {manifest.capabilities.length === 0 ? (
              <p className="mt-2 text-xs text-text-muted">
                Nothing beyond what Roxy already does. This add-on only changes how it behaves.
              </p>
            ) : (
              <ul className="mt-2 flex flex-col gap-1.5">
                {sortCapabilities(manifest.capabilities).map((c) => (
                  <li key={c.id} className="flex items-start gap-2">
                    <span
                      className={cn(
                        'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border',
                        RISK_STYLES[c.risk]
                      )}
                    >
                      <CatalogIcon name={c.icon} className="h-2.5 w-2.5" />
                    </span>
                    <span className="min-w-0 text-xs">
                      <span className="font-medium text-text">{c.label}</span>
                      <span className="text-text-muted"> — {c.detail}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {row.detail && (
            <p className="mt-4 break-all font-mono text-[11px] text-text-subtle">{row.detail}</p>
          )}
          {row.error && (
            <p className="mt-2 text-xs text-danger">
              Last error: <span className="font-mono">{row.error}</span>
            </p>
          )}

          {state === 'available' && installNeeds(manifest.install).length > 0 && (
            <div className="mt-4 sq sq-lg sq-ring rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 [--sq-ring:color-mix(in_srgb,var(--color-warning)_30%,transparent)]">
              <p className="text-[11px] text-warning">
                Needs a value before it will run: {installNeeds(manifest.install).join(', ')}. Add
                it, then fill it in with the <span className="font-mono">{'{ }'}</span> editor under
                “Add manually”.
              </p>
            </div>
          )}

          {manifest.homepage && (
            <button
              onClick={() => void api.system.openExternal(manifest.homepage as string)}
              className="mt-4 inline-flex items-center gap-1 text-xs text-text-muted hover:text-text"
            >
              Documentation <ArrowUpRight className="h-3 w-3" />
            </button>
          )}

          {/* Consent gate: for `critical` add-ons a switch is too cheap a gesture. */}
          {gated && state !== 'preview' && (
            <div className="mt-5 sq sq-lg sq-ring rounded-lg border border-danger/30 bg-danger/5 p-3 [--sq-ring:color-mix(in_srgb,var(--color-danger)_30%,transparent)]">
              <p className="flex items-start gap-2 text-xs text-danger">
                <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                This add-on can act outside Roxy, as you. Type{' '}
                <span className="font-mono font-semibold">I understand</span> to enable it.
              </p>
              <Input
                value={consent}
                onChange={(e) => setConsent(e.target.value)}
                placeholder="I understand"
                className="mt-2"
              />
            </div>
          )}

          {error && <p className="mt-3 text-xs text-danger">{error}</p>}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border px-5 py-3">
          <span className="text-[11px] text-text-subtle">
            {state === 'preview'
              ? 'Shipped as a shell — the switch grants nothing yet.'
              : 'Switching an add-on off never deletes it.'}
          </span>
          <div className="flex items-center gap-2">
            {state === 'available' && manifest.install && (
              <Button
                size="sm"
                variant="primary"
                disabled={busy || (gated && consent.trim().toLowerCase() !== 'i understand')}
                onClick={() => {
                  setBusy(true)
                  setError(null)
                  void installAddon(manifest, () => {}, onChanged)
                    .then((e) => {
                      if (e) setError(e)
                      else onClose()
                    })
                    .finally(() => setBusy(false))
                }}
                className="gap-1.5"
              >
                {busy ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Adding…
                  </>
                ) : (
                  <>
                    <Download className="h-3.5 w-3.5" /> Add to Roxy
                  </>
                )}
              </Button>
            )}
            {(state === 'enabled' || state === 'disabled' || state === 'broken') &&
              manifest.kind === 'mcp' && (
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true)
                    void api.mcp
                      .remove(manifest.id)
                      .then(onChanged)
                      .then(onClose)
                      .finally(() => setBusy(false))
                  }}
                  className="gap-1.5"
                >
                  <Trash2 className="h-3.5 w-3.5" /> Remove
                </Button>
              )}
            <Button size="sm" variant="ghost" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Labs
// ---------------------------------------------------------------------------

const EFFORT_LABEL: Record<LabIdea['effort'], string> = {
  small: 'Small',
  medium: 'Medium',
  large: 'Large'
}

/**
 * Labs — the repo's idea list, in the product.
 *
 * Publishing candidate implementations next to shipped ones is the point: an idea
 * with a name, a capability list and a stated tradeoff is something a user can
 * argue with, and a maintainer can be held to. The section is only honest if the
 * controls are: `preview` gets a real flag, `planned` gets an interest signal that
 * is *labelled* as one.
 */
function LabsTab({
  ideas,
  flags,
  busy,
  onToggle
}: {
  ideas: LabIdea[]
  flags: IntegrationConnection[]
  busy: string | null
  onToggle: (idea: LabIdea, value: boolean) => void
}): JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <div className="sq sq-xl sq-ring rounded-xl border border-border bg-surface-2 p-4">
        <h2 className="flex items-center gap-2 text-sm font-medium text-text">
          <FlaskConical className="h-4 w-4 text-accent" />
          Ideas we&apos;re exploring
        </h2>
        <p className="mt-1.5 text-xs leading-relaxed text-text-muted">
          Roxy is an open repo, and this is where its direction is argued in the open rather than in
          a backlog. Each idea lists what it would let Roxy do, what it would build on, and the
          honest objection to it. <span className="text-text">Preview</span> means a shell exists
          behind the switch; <span className="text-text">Idea</span> means nothing is built and the
          switch only records that you want it. Nothing here is a promise.
        </p>
      </div>

      {ideas.length === 0 ? (
        <p className="py-8 text-center text-xs text-text-muted">No ideas match that search.</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {ideas.map((idea) => {
            const flag = labFlagId(idea.id)
            const on = readFlag(flags, flag)
            return (
              <div
                key={idea.id}
                className="flex flex-col gap-3 sq sq-xl sq-ring rounded-xl border border-border bg-surface p-4"
              >
                <div className="flex items-start gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center sq sq-lg rounded-lg bg-white/5 text-text-muted">
                    <CatalogIcon name={idea.icon} className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-medium text-text">{idea.name}</span>
                      <StateBadge state={idea.state} />
                      <Badge>{EFFORT_LABEL[idea.effort]}</Badge>
                    </div>
                    <p className="mt-0.5 text-xs text-text-muted">{idea.tagline}</p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    {busy === flag ? (
                      <Loader2 className="h-4 w-4 animate-spin text-text-subtle" />
                    ) : (
                      <Switch checked={on} onChange={(v) => onToggle(idea, v)} />
                    )}
                    <span className="text-[10px] text-text-subtle">
                      {idea.state === 'preview' ? 'Try it' : 'I want this'}
                    </span>
                  </div>
                </div>

                <p className="text-[11px] leading-relaxed text-text-muted">{idea.rationale}</p>

                {idea.buildsOn && (
                  <p className="text-[11px] text-text-subtle">
                    <span className="font-medium text-text-muted">Builds on:</span> {idea.buildsOn}
                  </p>
                )}
                {idea.tradeoff && (
                  <p className="text-[11px] text-warning/80">
                    <span className="font-medium">Catch:</span> {idea.tradeoff}
                  </p>
                )}

                <CapabilityChips capabilities={idea.capabilities} />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Manual / advanced
// ---------------------------------------------------------------------------

/**
 * The escape hatch, collapsed by default. The catalog is a shortcut, not a
 * boundary: any MCP server and any skill repo still works, and the existing
 * raw-JSON editor is the right tool for that — it just should not be the first
 * thing a newcomer sees.
 */
function ManualSection({ open, onToggle }: { open: boolean; onToggle: () => void }): JSX.Element {
  const navigate = useNavigate()
  return (
    <div className="mt-2 border-t border-border pt-4">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-2 text-xs font-semibold uppercase tracking-wide text-text-subtle hover:text-text"
      >
        <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} />
        Add manually
      </button>
      {open && (
        <div className="mt-3 flex flex-col gap-4">
          <p className="text-xs text-text-muted">
            Anything not in the catalog: paste an MCP server config, or install a skill from a
            GitHub repo. Same result — it shows up under Installed like everything else.
          </p>
          <div>
            <h3 className="mb-2 flex items-center gap-1.5 text-xs font-medium text-text">
              <Plug className="h-3.5 w-3.5" /> Tool servers
            </h3>
            <McpServers />
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => navigate('/skills')}>
              <Plus className="h-3.5 w-3.5" /> Write or install a skill
            </Button>
            <span className="text-[11px] text-text-subtle">
              Opens the skill editor (SKILL.md files under ~/.roxy/skills).
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

function EmptyResult({
  tab,
  query,
  onClear,
  onDiscover
}: {
  tab: Tab
  query: string
  onClear: () => void
  onDiscover: () => void
}): JSX.Element {
  return (
    <div className="flex flex-col items-center gap-3 py-12 text-center">
      <div className="flex h-12 w-12 items-center justify-center sq sq-2xl rounded-2xl bg-white/5 text-text-muted">
        <Sparkles className="h-6 w-6" />
      </div>
      {query ? (
        <>
          <p className="text-sm font-medium text-text">Nothing matches “{query}”</p>
          <p className="max-w-sm text-xs text-text-muted">
            Try a broader word, or add it yourself — any MCP server or skill repo works.
          </p>
          <Button size="sm" variant="secondary" onClick={onClear}>
            Clear filters
          </Button>
        </>
      ) : tab === 'installed' ? (
        <>
          <p className="text-sm font-medium text-text">No add-ons yet</p>
          <p className="max-w-sm text-xs text-text-muted">
            Roxy already reads and writes files, runs commands and browses the web. Add-ons are for
            everything past that — your database, your issue tracker, your own playbooks.
          </p>
          <Button size="sm" variant="primary" onClick={onDiscover} className="gap-1.5">
            <Sparkles className="h-3.5 w-3.5" /> Browse add-ons
          </Button>
        </>
      ) : (
        <>
          <p className="text-sm font-medium text-text">You have everything in the catalog</p>
          <p className="max-w-sm text-xs text-text-muted">
            Use “Add manually” below for anything else.
          </p>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

/**
 * Merge the three existing backends into one list of rows.
 *
 * This is the whole trick of the page: no migration, no new service. An MCP
 * server, a discovered SKILL.md and an integration flag are already
 * enable/disable-able things with a status — they just never shared a shape. Here
 * they get one, and their backend status collapses into the six-value
 * {@link AddonState} the user actually reasons about.
 */
function useInstalledAddons(): {
  rows: AddonRow[]
  flags: IntegrationConnection[]
  loading: boolean
  reload: () => Promise<void>
} {
  const [rows, setRows] = useState<AddonRow[]>([])
  const [flags, setFlags] = useState<IntegrationConnection[]>([])
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async (): Promise<void> => {
    const [skills, servers, integrations] = await Promise.all([
      api.skills.list(),
      api.mcp.list(),
      api.integrations.list()
    ])
    setFlags(integrations)
    setRows([
      ...servers.map(mcpRow),
      ...skills.map(skillRow),
      ...integrationRows(integrations),
      remoteRow(),
      superUserRow()
    ])
    setLoading(false)
  }, [])

  useEffect(() => {
    void reload()
    // The agent can add servers/skills itself mid-session, and the raw editor
    // lives on another surface — so re-read whenever the window comes back.
    const onFocus = (): void => void reload()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [reload])

  return { rows, flags, loading, reload }
}

/** An MCP server → a row. A catalog manifest supplies the prose when we have one. */
function mcpRow(s: McpServerView): AddonRow {
  const known = getCatalogAddon(s.id)
  const manifest: AddonManifest = known ?? {
    id: s.id,
    name: s.id,
    tagline:
      s.status === 'connected'
        ? `Adds ${s.tools.length} tool${s.tools.length === 1 ? '' : 's'} to Roxy.`
        : 'An external tool server.',
    kind: 'mcp',
    category: 'Coding',
    // Unknown servers are described by their transport, which is all we honestly
    // know: a local one runs a process here, a remote one talks to someone else.
    capabilities:
      s.config.type === 'local' ? ['shell', 'files-read', 'network'] : ['network', 'credentials'],
    icon: 'plug',
    keywords: ['mcp', 'tool server']
  }
  return {
    manifest,
    state: !s.enabled ? 'disabled' : s.status === 'error' ? 'broken' : 'enabled',
    detail: s.config.type === 'remote' ? s.config.url : s.config.command.join(' '),
    error: s.error,
    tools: s.tools.length
  }
}

/** A discovered SKILL.md → a row. Skills are files: present means on. */
function skillRow(s: SkillView): AddonRow {
  const known = getCatalogAddon(s.name)
  return {
    manifest: known ?? {
      id: s.name,
      name: s.name,
      tagline: s.description || 'A playbook Roxy loads when a task matches it.',
      kind: 'skill',
      category: 'Workflow',
      capabilities: [],
      icon: 'file-text',
      author: s.source === 'workspace' ? 'This project' : 'You',
      keywords: ['skill', 'skill.md', 'playbook', s.source]
    },
    state: 'enabled',
    detail: s.location
  }
}

/** Messaging channels: catalog defs joined with their persisted flag. */
function integrationRows(rows: IntegrationConnection[]): AddonRow[] {
  return INTEGRATIONS.map((it) => ({
    manifest: {
      id: it.id,
      name: it.name,
      tagline: it.description,
      kind: 'integration' as const,
      category: 'Communication' as const,
      capabilities: ['messaging', 'network', 'credentials'] as CapabilityId[],
      state: it.status === 'coming-soon' ? ('preview' as const) : undefined,
      icon: it.icon,
      author: 'Roxy',
      keywords: ['integration', 'chat', 'channel', 'messenger']
    },
    state: (it.status === 'coming-soon'
      ? 'preview'
      : readFlag(rows, it.id)
        ? 'enabled'
        : 'disabled') as AddonState
  }))
}

/**
 * Remote Workspace was a sidebar dialog, which meant it was only discoverable if
 * you happened to hover the right icon. It is an add-on like any other, so it is
 * listed here too — the card explains it, the dialog still runs it.
 */
function remoteRow(): AddonRow {
  return {
    manifest: {
      id: 'remote-workspace',
      name: 'Remote Workspace',
      tagline: 'Drive this session from your phone, over an encrypted link.',
      kind: 'bridge',
      category: 'Devices',
      capabilities: ['network', 'always-on'],
      icon: 'monitor-smartphone',
      author: 'Roxy',
      keywords: ['remote', 'phone', 'mobile', 'qr', 'share', 'pair'],
      about: [
        'Shares the running session to a phone: scan a QR, enter the PIN, and prompt Roxy from anywhere.',
        'Your code and files never leave this computer — only the chat is relayed. Start it from the Remote Workspace button in the sidebar; stopping it revokes the link and the PIN immediately.'
      ]
    },
    state: 'enabled',
    detail: 'Start it from the sidebar — it shares on demand, not continuously.'
  }
}

/** The SuperUser shell (see `SUPERUSER_ADDON` for why it ships unwired). */
function superUserRow(): AddonRow {
  return { manifest: SUPERUSER_ADDON, state: 'preview' }
}

/**
 * Run an install. Returns an error message, or null on success — installs fail for
 * ordinary reasons (no network, a repo with no SKILL.md) and the reason has to
 * reach the card that asked.
 */
async function installAddon(
  manifest: AddonManifest,
  onBusy: (id: string | null) => void,
  onDone: () => Promise<void>
): Promise<string | null> {
  const install = manifest.install
  if (!install) return 'This add-on has nothing to install.'
  onBusy(manifest.id)
  try {
    if (install.via === 'mcp') {
      await api.mcp.upsert({ id: manifest.id, config: install.config, enabled: true })
      // Connect right away so a bad config surfaces here rather than mid-turn.
      await api.mcp.reconnect(manifest.id)
    } else if (install.via === 'skill') {
      const res = await api.skills.install(install.source)
      if (!res.ok) return res.error ?? 'Nothing was installed.'
    } else {
      await api.integrations.setEnabled(manifest.id, true)
    }
    await onDone()
    return null
  } catch (e) {
    return e instanceof Error ? e.message : 'Install failed.'
  } finally {
    onBusy(null)
  }
}
