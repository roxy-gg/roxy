import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation, Trans } from 'react-i18next'
import { GripVertical, Globe, Plus, Trash2 } from 'lucide-react'
import type { AppVersions, ConnectedProvider } from '@shared/types'
import type { UpdateInfo } from '@shared/api'
import { AUTH_LABELS } from '@shared/providers'
import { LANGUAGES, SOURCE_LANGUAGE, normalizeLanguage } from '@shared/i18n'
import { api } from '../lib/api'
import { CodeHosts } from '../components/CodeHosts'
import { Button, Switch } from '../components/ui'
import { cn } from '../lib/cn'
import {
  DEFAULT_BRANCH_PREFIX,
  branchPrefixError,
  normalizeBranchPrefix,
  placeholderBranchName
} from '@shared/branch'
import { randomSlug, slugToBranchSegment } from '@shared/slugs'
import { PageShell } from '../components/PageShell'
import { McpServers } from '../components/McpServers'
import { CookiePanel } from '../components/CookiePanel'
import { ConfigBackup } from '../components/ConfigBackup'
import { ActivitySection } from '../components/ActivitySection'
import { ProviderLogo } from '../lib/providerLogos'
import { SubscriptionAccounts } from '../components/SubscriptionSetup'
import { useRoxyStore } from '../lib/store'

/** The section heading repeated down the page. */
const SECTION_HEADING = 'mb-3 text-xs font-semibold uppercase tracking-wide text-text-subtle'

export default function Settings(): JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const providers = useRoxyStore((s) => s.providers)
  const settings = useRoxyStore((s) => s.settings)
  const refreshProviders = useRoxyStore((s) => s.refreshProviders)
  const reorderProviders = useRoxyStore((s) => s.reorderProviders)
  const setAutoWorkstream = useRoxyStore((s) => s.setAutoWorkstream)
  const telemetryEnabled = useRoxyStore((s) => s.telemetryEnabled)
  const setTelemetryEnabled = useRoxyStore((s) => s.setTelemetryEnabled)
  const setBranchPrefix = useRoxyStore((s) => s.setBranchPrefix)
  const setLanguage = useRoxyStore((s) => s.setLanguage)
  const [prefix, setPrefix] = useState('')
  const prefixError = branchPrefixError(prefix)
  // Pinned once per mount: a preview that reshuffled on every keystroke
  // would read as noise rather than as an example.
  const [example] = useState(() => slugToBranchSegment(randomSlug()))
  const bootstrap = useRoxyStore((s) => s.bootstrap)
  const clearActive = useRoxyStore((s) => s.clearActive)
  const [versions, setVersions] = useState<AppVersions | null>(null)
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  const [confirmingReset, setConfirmingReset] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [dragProviderId, setDragProviderId] = useState<string | null>(null)
  const [dragOverProviderId, setDragOverProviderId] = useState<string | null>(null)
  const [dropAfterProvider, setDropAfterProvider] = useState(false)

  const reorderWithinProviders = (
    sourceId: string,
    targetId: string,
    place: 'before' | 'after'
  ): string[] | null => {
    const ids = providers.map((p) => p.id)
    const from = ids.indexOf(sourceId)
    if (from === -1 || ids.indexOf(targetId) === -1) return null
    ids.splice(from, 1)
    ids.splice(ids.indexOf(targetId) + (place === 'after' ? 1 : 0), 0, sourceId)
    if (ids.every((id, i) => id === providers[i].id)) return null
    return ids
  }

  const onProviderDrop = (targetId: string): void => {
    const source = dragProviderId
    const place = dropAfterProvider ? 'after' : 'before'
    setDragProviderId(null)
    setDragOverProviderId(null)
    setDropAfterProvider(false)
    if (!source || source === targetId) return
    const order = reorderWithinProviders(source, targetId, place)
    if (order) void reorderProviders(order)
  }

  useEffect(() => {
    setPrefix(settings?.branchPrefix ?? DEFAULT_BRANCH_PREFIX)
  }, [settings?.branchPrefix])

  useEffect(() => {
    refreshProviders()
    api.system.getVersions().then(setVersions)
    api.updates.getState().then(setUpdate)
    const off = api.updates.onStatus((state) =>
      setUpdate((prev) => (prev ? { ...prev, state } : { version: '', packaged: true, state }))
    )
    return off
  }, [refreshProviders])

  const disconnect = async (id: string): Promise<void> => {
    await api.providers.disconnect(id)
    await refreshProviders()
  }

  const resetEverything = async (): Promise<void> => {
    setResetting(true)
    await api.settings.reset()
    clearActive()
    await bootstrap()
    navigate('/onboarding')
  }

  const us = update?.state
  const updateBusy =
    us?.status === 'checking' || us?.status === 'downloading' || us?.status === 'available'
  const updateLabel = !update?.packaged
    ? t('settings.about.update.devMode')
    : us?.status === 'checking'
      ? t('settings.about.update.checking')
      : us?.status === 'available'
        ? t('settings.about.update.available', { version: us.version })
        : us?.status === 'downloading'
          ? t('settings.about.update.downloading', { percent: us.percent })
          : us?.status === 'downloaded'
            ? t('settings.about.update.downloaded', { version: us.version })
            : us?.status === 'error'
              ? t('settings.about.update.error', { message: us.message })
              : us?.status === 'not-available'
                ? t('settings.about.update.notAvailable')
                : t('settings.about.update.idle')

  const language = normalizeLanguage(settings?.language)

  return (
    <PageShell title={t('settings.title')} onBack={() => navigate('/')}>
      <ActivitySection />

      <section className="mb-8">
        <h2 className={SECTION_HEADING}>{t('settings.providers.heading')}</h2>
        <div className="flex flex-col gap-2">
          {providers.map((p) => (
            <div
              key={p.id}
              draggable={providers.length > 1}
              onDragStart={(e) => {
                setDragProviderId(p.id)
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', p.id)
              }}
              onDragEnter={() =>
                dragProviderId && dragProviderId !== p.id && setDragOverProviderId(p.id)
              }
              onDragOver={(e) => {
                if (!dragProviderId) return
                e.preventDefault()
                if (dragProviderId === p.id) return
                const rect = e.currentTarget.getBoundingClientRect()
                const after = e.clientY - rect.top > rect.height / 2
                if (dragOverProviderId !== p.id) setDragOverProviderId(p.id)
                if (after !== dropAfterProvider) setDropAfterProvider(after)
              }}
              onDrop={(e) => {
                e.preventDefault()
                onProviderDrop(p.id)
              }}
              onDragEnd={() => {
                setDragProviderId(null)
                setDragOverProviderId(null)
                setDropAfterProvider(false)
              }}
              className={cn(
                'relative',
                dragProviderId === p.id && 'opacity-40',
                dragOverProviderId === p.id &&
                  dragProviderId !== p.id &&
                  (dropAfterProvider
                    ? 'after:absolute after:inset-x-2 after:-bottom-1 after:h-0.5 after:rounded-full after:bg-accent'
                    : 'before:absolute before:inset-x-2 before:-top-1 before:h-0.5 before:rounded-full before:bg-accent')
              )}
            >
              <ProviderRow
                provider={p}
                active={settings?.activeProviderId === p.id}
                draggable={providers.length > 1}
                dragging={dragProviderId === p.id}
                onDisconnect={() => disconnect(p.id)}
              />
            </div>
          ))}
          <button
            type="button"
            onClick={() => navigate('/onboarding')}
            className="press-scale flex items-center justify-center gap-2 sq sq-xl sq-ring sq-dashed rounded-xl border border-dashed border-border bg-surface/40 p-3.5 text-sm text-text-muted hover:border-border-strong hover:[--sq-ring:var(--color-border-strong)] hover:bg-surface hover:text-text"
          >
            <Plus className="h-4 w-4" /> {t('settings.providers.add')}
          </button>
        </div>
      </section>

      {/* A native <select> on purpose. The picker is read once and then never
          again, so it earns none of the cost of a custom popover -- and the
          native control already gives us type-ahead, keyboard nav and the OS's
          own font stack, which matters for scripts the app font may not cover. */}
      <section className="mb-8">
        <h2 className={SECTION_HEADING}>{t('settings.language.heading')}</h2>
        <div className="flex flex-col gap-3 sq sq-xl sq-ring rounded-xl border border-border bg-surface p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <label htmlFor="language" className="text-sm font-medium text-text">
              {t('settings.language.label')}
            </label>
            <p className="mt-0.5 text-xs text-text-muted">{t('settings.language.description')}</p>
            {language !== SOURCE_LANGUAGE && (
              <p className="mt-2 text-xs text-text-subtle">{t('settings.language.translatedBy')}</p>
            )}
          </div>
          <select
            id="language"
            value={language}
            onChange={(e) => void setLanguage(normalizeLanguage(e.target.value))}
            className="h-9 shrink-0 sq sq-lg sq-ring rounded-lg border border-border bg-surface-2 px-3 text-sm text-text outline-none transition-colors focus:border-accent/70"
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.nativeName}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="mb-8">
        <h2 className={SECTION_HEADING}>{t('settings.workstreams.heading')}</h2>
        <div className="flex flex-col gap-3 sq sq-xl sq-ring rounded-xl border border-border bg-surface p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="text-sm font-medium text-text">
              {t('settings.workstreams.autoTitle')}
            </div>
            <p className="mt-0.5 text-xs text-text-muted">
              {t('settings.workstreams.autoDescription')}
            </p>
          </div>
          <Switch
            checked={settings?.autoWorkstream ?? true}
            onChange={(v) => void setAutoWorkstream(v)}
          />
        </div>

        <div className="mt-3 sq sq-xl sq-ring rounded-xl border border-border bg-surface p-4">
          <div className="text-sm font-medium text-text">
            {t('settings.workstreams.prefixTitle')}
          </div>
          <p className="mt-0.5 text-xs text-text-muted">
            <Trans i18nKey="settings.workstreams.prefixDescription" />
          </p>
          <div className="mt-3 flex items-center gap-2">
            <input
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !prefixError) void setBranchPrefix(prefix)
              }}
              spellCheck={false}
              placeholder={t('settings.workstreams.prefixPlaceholder')}
              aria-label={t('settings.workstreams.prefixAriaLabel')}
              className={cn(
                'w-48 sq sq-lg sq-ring rounded-lg border bg-surface-2 px-3 py-1.5 text-sm text-text outline-none placeholder:text-text-subtle',
                prefixError
                  ? 'border-danger [--sq-ring:var(--color-danger)]'
                  : 'border-border focus:border-border-strong focus:[--sq-ring:var(--color-border-strong)]'
              )}
            />
            {/* The example is the point: "roxy" in a box means nothing until
                you see a whole branch name next to it. Uses a real session
                slug, because that is what branches actually look like. */}
            <span className="min-w-0 truncate font-mono text-xs text-text-subtle">
              {placeholderBranchName(prefix, example)}
            </span>
            <Button
              onClick={() => void setBranchPrefix(prefix)}
              disabled={
                !!prefixError ||
                normalizeBranchPrefix(prefix) === (settings?.branchPrefix ?? DEFAULT_BRANCH_PREFIX)
              }
            >
              {t('common.save')}
            </Button>
          </div>
          {prefixError && <p className="mt-2 text-xs text-danger">{prefixError}</p>}
          <p className="mt-2 text-xs text-text-subtle">
            {t('settings.workstreams.prefixFootnote')}
          </p>
        </div>
      </section>

      <section className="mb-8">
        <h2 className={SECTION_HEADING}>{t('settings.browser.heading')}</h2>
        <div className="flex flex-col gap-3 sq sq-xl sq-ring rounded-xl border border-border bg-surface p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="text-sm font-medium text-text">{t('settings.browser.title')}</div>
            <p className="mt-0.5 text-xs text-text-muted">{t('settings.browser.description')}</p>
          </div>
          <Button variant="secondary" className="shrink-0" onClick={() => api.browser.open()}>
            <Globe className="h-3.5 w-3.5" /> {t('settings.browser.open')}
          </Button>
        </div>

        <div className="mt-3 overflow-hidden sq sq-xl sq-ring rounded-xl border border-border bg-surface">
          <div className="border-b border-border p-4">
            <div className="text-sm font-medium text-text">
              {t('settings.browser.cookiesTitle')}
            </div>
            <p className="mt-0.5 text-xs text-text-muted">
              {t('settings.browser.cookiesDescription')}
            </p>
          </div>
          <CookiePanel className="max-h-[420px]" />
        </div>
      </section>

      {/* Distinct from "Providers" above on purpose: that list is who runs the
          MODEL, this one is where the CODE lives. GitHub appears in both, as
          two unrelated accounts. */}
      <section className="mb-8">
        <h2 className={SECTION_HEADING}>{t('settings.codeHosts.heading')}</h2>
        <CodeHosts />
      </section>
      <section className="mb-8">
        <h2 className={SECTION_HEADING}>{t('settings.mcp.heading')}</h2>
        <McpServers />
      </section>

      <section className="mb-8">
        <h2 className={SECTION_HEADING}>{t('settings.backup.heading')}</h2>
        <div className="flex flex-col gap-3 sq sq-xl sq-ring rounded-xl border border-border bg-surface p-4">
          <div className="min-w-0">
            <div className="text-sm font-medium text-text">{t('settings.backup.title')}</div>
            <p className="mt-0.5 text-xs text-text-muted">
              {t('settings.backup.description')}{' '}
              <span className="text-text-subtle">{t('settings.backup.warning')}</span>
            </p>
          </div>
          <ConfigBackup onImported={() => void bootstrap()} />
        </div>
      </section>

      <section className="mb-8">
        <h2 className={SECTION_HEADING}>{t('settings.privacy.heading')}</h2>
        <div className="flex flex-col gap-3 sq sq-xl sq-ring rounded-xl border border-border bg-surface p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="text-sm font-medium text-text">{t('settings.privacy.title')}</div>
            <p className="mt-0.5 text-xs text-text-muted">{t('settings.privacy.description')}</p>
            <p className="mt-2 text-xs text-text-muted">
              <Trans i18nKey="settings.privacy.labels" />
            </p>
          </div>
          <Switch checked={telemetryEnabled} onChange={(v) => void setTelemetryEnabled(v)} />
        </div>
      </section>
      <section>
        <h2 className={SECTION_HEADING}>{t('settings.about.heading')}</h2>
        <div className="flex flex-col gap-3 sq sq-xl sq-ring rounded-xl border border-border bg-surface p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium text-text">
                {t('settings.about.version', { version: versions?.app ?? t('common.dash') })}
              </div>
              <p className="mt-0.5 text-xs text-text-muted">{updateLabel}</p>
            </div>
            {update?.state.status === 'downloaded' ? (
              <Button variant="primary" className="shrink-0" onClick={() => api.updates.install()}>
                {t('settings.about.restartToUpdate')}
              </Button>
            ) : (
              <Button
                variant="secondary"
                className="shrink-0"
                disabled={!update?.packaged || updateBusy}
                onClick={() => void api.updates.check()}
                title={update?.packaged ? undefined : t('settings.about.installedAppOnly')}
              >
                {updateBusy ? t('settings.about.checking') : t('settings.about.checkForUpdates')}
              </Button>
            )}
          </div>
          {versions && (
            <p className="text-[11px] text-text-subtle">
              {t('settings.about.runtime', {
                electron: versions.electron,
                chrome: versions.chrome,
                node: versions.node
              })}
            </p>
          )}
        </div>
      </section>

      <section className="mt-8">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-danger">
          {t('settings.danger.heading')}
        </h2>
        <div className="flex flex-col gap-3 sq sq-xl sq-ring sq-ring-danger rounded-xl border border-danger/30 bg-danger/5 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="text-sm font-medium text-text">{t('settings.danger.resetTitle')}</div>
            <p className="mt-0.5 text-xs text-text-muted">
              {t('settings.danger.resetDescription')}
            </p>
          </div>
          {confirmingReset ? (
            <div className="flex shrink-0 items-center gap-2">
              <Button
                variant="ghost"
                onClick={() => setConfirmingReset(false)}
                disabled={resetting}
              >
                {t('common.cancel')}
              </Button>
              <Button variant="danger" onClick={resetEverything} disabled={resetting}>
                {resetting ? t('settings.danger.wiping') : t('settings.danger.confirm')}
              </Button>
            </div>
          ) : (
            <Button variant="danger" className="shrink-0" onClick={() => setConfirmingReset(true)}>
              <Trash2 className="h-3.5 w-3.5" /> {t('settings.danger.reset')}
            </Button>
          )}
        </div>
      </section>
    </PageShell>
  )
}

function ProviderRow({
  provider,
  active,
  draggable,
  dragging,
  onDisconnect
}: {
  provider: ConnectedProvider
  active: boolean
  draggable: boolean
  dragging: boolean
  onDisconnect: () => void
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <div
      className={cn(
        'flex items-center gap-3 sq sq-xl sq-ring rounded-xl border border-border bg-surface p-3.5 transition',
        dragging && 'cursor-grabbing',
        draggable && !dragging && 'cursor-grab'
      )}
    >
      <GripVertical
        className={cn(
          'h-4 w-4 shrink-0 text-text-subtle transition',
          draggable ? 'opacity-70' : 'opacity-20'
        )}
        aria-hidden="true"
      />
      <div className="flex h-8 w-8 items-center justify-center sq sq-lg sq-ring rounded-lg border border-border bg-surface-2">
        <ProviderLogo id={provider.id} name={provider.name} size={18} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-text">{provider.name}</span>
          {active && (
            <span className="rounded-full bg-success/15 px-2 py-0.5 text-[11px] text-success">
              {t('settings.providers.active')}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-text-subtle">
          {AUTH_LABELS[provider.auth]} ·{' '}
          {provider.auth === 'subscription'
            ? t('settings.providers.signedInLocally')
            : provider.hasCredential
              ? t('settings.providers.keyStored')
              : t('settings.providers.noCredential')}
        </p>
        {/* Subscription providers hold their credential in the sidecar, not in
            Roxy - so the row lists the signed-in accounts instead of a key. The
            id is required: one sidecar holds every subscription's accounts, and
            a row must show only its own. */}
        {provider.auth === 'subscription' && <SubscriptionAccounts providerId={provider.id} />}
      </div>
      <Button size="sm" variant="ghost" onClick={onDisconnect}>
        {t('settings.providers.disconnect')}
      </Button>
    </div>
  )
}
