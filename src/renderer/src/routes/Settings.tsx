import { EngineeringTools } from '../components/EngineeringTools'
import { CheatTools } from '../components/CheatTools'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useTranslation, Trans } from 'react-i18next'
import {
  ChevronDown,
  Globe,
  MonitorSmartphone,
  Plus,
  Search,
  RotateCcw,
  Trash2,
  X
} from 'lucide-react'
import type { AppVersions } from '@shared/types'
import type { UpdateInfo } from '@shared/api'
import { resolveSeed } from '@shared/providers'
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
import { CookiePanel } from '../components/CookiePanel'
import { ProxyPanel } from '../components/ProxyPanel'
import { ConfigBackup } from '../components/ConfigBackup'
import { ActivitySection } from '../components/ActivitySection'
import { ProviderSetup, AddAccount } from './onboarding/ProviderStep'
import { ProviderAccount } from '../components/ProviderAccount'
import { NotificationSettings } from '../components/NotificationSettings'
import { useRoxyStore } from '../lib/store'
import { MotionSettings } from '../components/MotionSettings'
import { BackgroundSettings } from '../components/BackgroundSettings'
import { VoiceSettings } from '../components/VoiceSettings'
import { RemoteWorkspaceDialog } from '../components/RemoteWorkspaceDialog'
import { SidebarNavItem } from '../components/SidebarFrame'
import { SettingsSearchResults } from '../components/SettingsSearchResults'
import { searchSettings, type SettingsSearchEntry } from '../lib/settings-search'
import { SETTINGS_GROUPS, type SettingsSection } from '../lib/settings-navigation'
import { prefersReducedMotion } from '../lib/motion'
import Themes from './Themes'
import Skills from './Skills'
import Mcp from './Mcp'

/** The section heading repeated down the page. */
const SECTION_HEADING = 'mb-3 text-xs font-semibold uppercase tracking-wide text-text-subtle'

export default function Settings(): JSX.Element {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const { section } = useParams()
  const selected = SETTINGS_GROUPS.flatMap((group) => [...group.items]).find(
    (item) => item.id === section
  )
  const panel: SettingsSection = selected?.id ?? 'activity'
  const [query, setQuery] = useState('')
  const [searchTarget, setSearchTarget] = useState<SettingsSearchEntry | null>(null)
  const [activeResult, setActiveResult] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const panelsRef = useRef<HTMLDivElement>(null)
  const searching = !!query.trim()
  const searchResults = useMemo(
    () =>
      query.trim()
        ? searchSettings(
            query,
            t,
            SETTINGS_GROUPS.flatMap((group) =>
              group.items.map((item) => ({
                section: item.id,
                label: item.label,
                group: group.label
              }))
            ),
            LANGUAGES.map(({ code }) => i18n.getFixedT(code))
          )
        : [],
    [query, t, i18n, i18n.language]
  )
  const active = Math.min(activeResult, Math.max(0, searchResults.length - 1))
  const selectResult = (entry: SettingsSearchEntry): void => {
    setSearchTarget({ ...entry })
    navigate('/settings/' + entry.section)
  }
  const changeSection = (id: string): void => {
    setQuery('')
    setSearchTarget(null)
    navigate('/settings/' + id)
  }

  useEffect(() => {
    if (!searchTarget || panel !== searchTarget.section) return
    const root = panelsRef.current
    if (!root) return
    let target: HTMLElement | null = null
    let previousTabIndex: string | null = null
    let highlightTimer: ReturnType<typeof setTimeout> | undefined
    let observer: MutationObserver | undefined
    const reveal = (): void => {
      if (target) return
      const entry = searchTarget
      const container = root.querySelector<HTMLElement>('#settings-' + entry.section + '-panel')
      const candidate = entry.target
        ? root.querySelector<HTMLElement>('#' + entry.target)
        : (container?.querySelector<HTMLElement>('h2, h3') ?? container)
      if (!candidate || !candidate.getClientRects().length) return
      target = candidate
      observer?.disconnect()
      previousTabIndex = target.getAttribute('tabindex')
      target.setAttribute('tabindex', '-1')
      target.classList.add('settings-search-target')
      target.focus({ preventScroll: true })
      target.scrollIntoView({
        block: 'center',
        behavior: prefersReducedMotion() ? 'instant' : 'smooth'
      })
      highlightTimer = setTimeout(() => target?.classList.remove('settings-search-target'), 3000)
    }
    reveal()
    // Some destinations (e.g. voice controls) arrive after their initial IPC load.
    observer = new MutationObserver(reveal)
    if (!target) observer.observe(root, { childList: true, subtree: true })
    const stopWaiting = setTimeout(() => observer?.disconnect(), 8000)
    return () => {
      observer?.disconnect()
      clearTimeout(highlightTimer)
      clearTimeout(stopWaiting)
      if (!target) return
      target.classList.remove('settings-search-target')
      if (previousTabIndex === null) target.removeAttribute('tabindex')
      else target.setAttribute('tabindex', previousTabIndex)
    }
  }, [searchTarget, panel])
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === 'f' &&
        !event.altKey &&
        !document.querySelector('dialog[open], [role="dialog"], [role="menu"]')
      ) {
        event.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  // Mount on first visit, then retain editors and their unsaved drafts.
  const [visited, setVisited] = useState<Set<SettingsSection>>(() => new Set([panel]))
  useEffect(() => {
    setVisited((previous) => (previous.has(panel) ? previous : new Set([...previous, panel])))
  }, [panel])
  const [remoteOpen, setRemoteOpen] = useState(false)
  const remotePhase = useRoxyStore((s) => s.remote.phase)
  const providers = useRoxyStore((s) => s.providers)
  const settings = useRoxyStore((s) => s.settings)
  const refreshProviders = useRoxyStore((s) => s.refreshProviders)
  const reorderProviders = useRoxyStore((s) => s.reorderProviders)
  const setAutoWorkstream = useRoxyStore((s) => s.setAutoWorkstream)
  const setFreshWorkstream = useRoxyStore((s) => s.setFreshWorkstream)
  const setWorktreeSetupCommand = useRoxyStore((s) => s.setWorktreeSetupCommand)
  const [setupCommand, setSetupCommand] = useState('')
  const telemetryEnabled = useRoxyStore((s) => s.telemetryEnabled)
  const setTelemetryEnabled = useRoxyStore((s) => s.setTelemetryEnabled)
  const setBranchPrefix = useRoxyStore((s) => s.setBranchPrefix)
  const setLanguage = useRoxyStore((s) => s.setLanguage)
  const setMotion = useRoxyStore((s) => s.setMotion)
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
  useEffect(() => {
    setConfirmingReset(false)
  }, [panel])
  const [cookiesOpen, setCookiesOpen] = useState(false)
  const cookiesPanelId = useId()
  const [resetting, setResetting] = useState(false)
  const [dragProviderId, setDragProviderId] = useState<string | null>(null)
  const [dragOverProviderId, setDragOverProviderId] = useState<string | null>(null)
  const [dropAfterProvider, setDropAfterProvider] = useState(false)
  const [setup, setSetup] = useState<{ seedId: string; connectionId?: string } | null>(null)
  const [addingAccount, setAddingAccount] = useState(false)
  const addAccountRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (!addingAccount) addAccountRef.current?.focus()
  }, [addingAccount])

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
    setSetupCommand(settings?.worktreeSetupCommand ?? '')
  }, [settings?.worktreeSetupCommand])

  useEffect(() => {
    refreshProviders()
    api.system.getVersions().then(setVersions)
    api.updates.getState().then(setUpdate)
    const off = api.updates.onStatus((state) =>
      setUpdate((prev) => (prev ? { ...prev, state } : { version: '', packaged: true, state }))
    )
    return off
  }, [refreshProviders])

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
    <PageShell
      title={t('settings.title')}
      contentKey={panel}
      sidebar={
        <>
          <div
            role="search"
            className="sq sq-lg sq-ring sticky top-0 z-10 mb-4 flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-2.5 focus-within:border-accent/70"
          >
            <Search aria-hidden className="h-3.5 w-3.5 shrink-0 text-text-subtle" />
            <input
              ref={searchRef}
              id="settings-search"
              type="search"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={searching}
              aria-controls={searching ? 'settings-search-results' : undefined}
              aria-activedescendant={
                searching && searchResults.length ? 'settings-search-result-' + active : undefined
              }
              aria-describedby={
                searching && searchResults.length ? 'settings-search-help' : undefined
              }
              aria-label={t('settings.search.placeholder')}
              placeholder={t('settings.search.placeholder')}
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setSearchTarget(null)
                setActiveResult(0)
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return
                if (event.key === 'Escape' && query) {
                  event.preventDefault()
                  setQuery('')
                  setSearchTarget(null)
                } else if (searching && searchResults.length) {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    selectResult(searchResults[active].entry)
                  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault()
                    setActiveResult(
                      (active + (event.key === 'ArrowDown' ? 1 : -1) + searchResults.length) %
                        searchResults.length
                    )
                  } else if (event.key === 'Home' || event.key === 'End') {
                    // Preserve normal text-editing keys; Ctrl/Meta+Home/End moves through results.
                    if (event.ctrlKey || event.metaKey) {
                      event.preventDefault()
                      setActiveResult(event.key === 'Home' ? 0 : searchResults.length - 1)
                    }
                  }
                }
              }}
              className="h-9 min-w-0 flex-1 bg-transparent text-xs text-text outline-none placeholder:text-text-subtle [&::-webkit-search-cancel-button]:appearance-none"
            />
            {query && (
              <button
                type="button"
                aria-label={t('settings.search.clear')}
                title={t('settings.search.clear')}
                onClick={() => {
                  setQuery('')
                  setSearchTarget(null)
                  searchRef.current?.focus()
                }}
                className="rounded p-1 text-text-subtle hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
              >
                <X aria-hidden className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          {searching && (
            <SettingsSearchResults
              query={query.trim()}
              results={searchResults}
              active={active}
              onActive={setActiveResult}
              onSelect={selectResult}
            />
          )}
          <div hidden={searching}>
            <label htmlFor="settings-section" className="sr-only">
              {t('settings.navigation.section')}
            </label>
            <select
              id="settings-section"
              value={panel}
              onChange={(event) => changeSection(event.target.value)}
              className="h-10 w-full rounded-lg border border-border bg-surface-2 px-3 text-sm text-text sm:hidden"
            >
              {SETTINGS_GROUPS.map((group) => (
                <optgroup key={group.label} label={t(group.label)}>
                  {group.items.map((item) => (
                    <option key={item.id} value={item.id}>
                      {t(item.label)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <nav aria-label={t('settings.title')} className="hidden flex-col gap-5 sm:flex">
              {SETTINGS_GROUPS.map((group) => (
                <section key={group.label} aria-labelledby={group.label}>
                  <h2
                    id={group.label}
                    className="mb-1.5 px-2 text-[11px] font-semibold uppercase tracking-wide text-text-subtle"
                  >
                    {t(group.label)}
                  </h2>
                  <div className="flex flex-col gap-0.5">
                    {group.items.map(({ id, label, icon: Icon }) => (
                      <SidebarNavItem
                        key={id}
                        id={'settings-' + id}
                        aria-current={!searching && panel === id ? 'page' : undefined}
                        aria-controls={'settings-' + id + '-panel'}
                        onClick={() => changeSection(id)}
                      >
                        <Icon aria-hidden="true" className="h-4 w-4 shrink-0 opacity-80" />
                        <span className="min-w-0 flex-1">{t(label)}</span>
                        {id === 'remote' && remotePhase !== 'idle' && remotePhase !== 'error' && (
                          <span
                            className={cn(
                              'h-1.5 w-1.5 shrink-0 rounded-full',
                              remotePhase === 'live' ? 'bg-success' : 'bg-warning'
                            )}
                            title={t(
                              remotePhase === 'live'
                                ? 'sidebar.sharingLive'
                                : 'sidebar.sharingConnecting'
                            )}
                          />
                        )}
                      </SidebarNavItem>
                    ))}
                  </div>
                </section>
              ))}
            </nav>
          </div>
        </>
      }
      onBack={() => navigate('/')}
      onEscape={() => {
        if (resetting) return true
        if (query) {
          setQuery('')
          setSearchTarget(null)
          searchRef.current?.focus()
          return true
        }
        if (!confirmingReset) return false
        setConfirmingReset(false)
        return true
      }}
    >
      {addingAccount && (
        <AddAccount
          onClose={() => {
            setAddingAccount(false)
          }}
        />
      )}
      {setup && (
        <ProviderSetup
          modal
          seed={resolveSeed(setup.seedId)}
          connectionId={setup.connectionId}
          onClose={() => setSetup(null)}
        />
      )}
      <div ref={panelsRef}>
        <div
          id="settings-background-panel"
          role="region"
          aria-labelledby="settings-background"
          hidden={panel !== 'background'}
        >
          {(visited.has('background') || panel === 'background') && (
            <BackgroundSettings active={panel === 'background'} />
          )}
        </div>
        <div
          id="settings-sidebar-panel"
          role="region"
          aria-labelledby="settings-sidebar"
          hidden={panel !== 'sidebar'}
        >
          {(visited.has('sidebar') || panel === 'sidebar') && (
            <BackgroundSettings section="sidebar" active={panel === 'sidebar'} />
          )}
        </div>
        <div
          id="settings-colors-panel"
          role="region"
          aria-labelledby="settings-colors"
          hidden={panel !== 'colors'}
        >
          {(visited.has('colors') || panel === 'colors') && <Themes />}
        </div>
        <div
          id="settings-skills-panel"
          role="region"
          aria-labelledby="settings-skills"
          hidden={panel !== 'skills'}
        >
          {(visited.has('skills') || panel === 'skills') && <Skills active={panel === 'skills'} />}
        </div>
        <div
          id="settings-mcp-panel"
          role="region"
          aria-labelledby="settings-mcp"
          hidden={panel !== 'mcp'}
        >
          {(visited.has('mcp') || panel === 'mcp') && <Mcp active={panel === 'mcp'} />}
        </div>
        <div
          id="settings-engineering-panel"
          role="region"
          aria-labelledby="settings-engineering"
          hidden={panel !== 'engineering'}
        >
          {(visited.has('engineering') || panel === 'engineering') && (
            <EngineeringTools active={panel === 'engineering'} />
          )}
        </div>
        <div
          id="settings-cheat-panel"
          role="region"
          aria-labelledby="settings-cheat"
          hidden={panel !== 'cheat'}
        >
          {(visited.has('cheat') || panel === 'cheat') && <CheatTools active={panel === 'cheat'} />}
        </div>
        <div
          id="settings-activity-panel"
          role="region"
          aria-labelledby="settings-activity"
          hidden={panel !== 'activity'}
        >
          {(visited.has('activity') || panel === 'activity') && <ActivitySection />}
        </div>
        <div
          id="settings-motion-panel"
          role="region"
          aria-labelledby="settings-motion"
          hidden={panel !== 'motion'}
        >
          {(visited.has('motion') || panel === 'motion') && <MotionSettings onChange={setMotion} />}
        </div>
        <section
          id="settings-remote-panel"
          role="region"
          aria-labelledby="settings-remote"
          hidden={panel !== 'remote'}
        >
          <h2 className={SECTION_HEADING}>{t('remote.title')}</h2>
          <p className="mb-4 text-sm text-text-muted">{t('remote.idleBody')}</p>
          <Button onClick={() => setRemoteOpen(true)}>
            <MonitorSmartphone className="h-4 w-4" />
            {t('settings.navigation.openRemote')}
          </Button>
        </section>
        {remoteOpen && <RemoteWorkspaceDialog onClose={() => setRemoteOpen(false)} />}
        <section
          id="settings-voice-panel"
          role="region"
          aria-labelledby="settings-voice"
          hidden={panel !== 'voice'}
        >
          {(visited.has('voice') || panel === 'voice') && <VoiceSettings />}
        </section>

        <section
          id="settings-accounts-panel"
          role="region"
          aria-labelledby="settings-accounts"
          hidden={panel !== 'accounts'}
          className="mb-8"
        >
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-text-subtle">
              {t('settings.providers.heading')}
            </h2>
            <Button
              size="sm"
              onClick={(e) => {
                addAccountRef.current = e.currentTarget
                setAddingAccount(true)
              }}
            >
              <Plus className="h-3.5 w-3.5" />
              {t('settings.providers.addAccount')}
            </Button>
          </div>
          <p className="mb-4 text-xs text-text-muted">{t('settings.providers.description')}</p>
          <div className="flex flex-col gap-2">
            {providers.map((p, index) => (
              <div
                key={p.id}
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
                <ProviderAccount
                  provider={p}
                  active={settings?.activeProviderId === p.id}
                  onDragStart={(e) => {
                    setDragProviderId(p.id)
                    e.dataTransfer.effectAllowed = 'move'
                    e.dataTransfer.setData('text/plain', p.id)
                  }}
                  onMoveUp={
                    index > 0
                      ? () => {
                          const order = reorderWithinProviders(
                            p.id,
                            providers[index - 1].id,
                            'before'
                          )
                          if (order) void reorderProviders(order)
                        }
                      : undefined
                  }
                  onMoveDown={
                    index < providers.length - 1
                      ? () => {
                          const order = reorderWithinProviders(
                            p.id,
                            providers[index + 1].id,
                            'after'
                          )
                          if (order) void reorderProviders(order)
                        }
                      : undefined
                  }
                  onAddAccount={() => setSetup({ seedId: p.seedId })}
                  onReconnect={() => setSetup({ seedId: p.seedId, connectionId: p.id })}
                />
              </div>
            ))}
            {providers.length === 0 && (
              <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-text-subtle">
                {t('settings.providers.empty')}
              </p>
            )}
          </div>
        </section>

        {/* A native <select> on purpose. The picker is read once and then never
          again, so it earns none of the cost of a custom popover -- and the
          native control already gives us type-ahead, keyboard nav and the OS's
          own font stack, which matters for scripts the app font may not cover. */}
        <section
          id="settings-language-panel"
          role="region"
          aria-labelledby="settings-language"
          hidden={panel !== 'language'}
          className="mb-8"
        >
          <h2 className={SECTION_HEADING}>{t('settings.language.heading')}</h2>
          <div className="flex flex-col gap-3 sq sq-xl sq-ring rounded-xl border border-border bg-surface p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <label
                id="settings-language-label"
                htmlFor="language"
                className="text-sm font-medium text-text"
              >
                {t('settings.language.label')}
              </label>
              <p className="mt-0.5 text-xs text-text-muted">{t('settings.language.description')}</p>
              {language !== SOURCE_LANGUAGE && (
                <p className="mt-2 text-xs text-text-subtle">
                  {t('settings.language.translatedBy')}
                </p>
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

        <section
          id="settings-notifications-panel"
          role="region"
          aria-labelledby="settings-notifications"
          hidden={panel !== 'notifications'}
          className="mb-8"
        >
          <h2 className={SECTION_HEADING}>{t('settings.notifications.heading')}</h2>
          <NotificationSettings />
        </section>

        <section
          id="settings-worktrees-panel"
          role="region"
          aria-labelledby="settings-worktrees"
          hidden={panel !== 'worktrees'}
          className="mb-8"
        >
          <h2 className={SECTION_HEADING}>{t('settings.workstreams.heading')}</h2>
          <div className="flex flex-col gap-3 sq sq-xl sq-ring rounded-xl border border-border bg-surface p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div id="settings-auto-worktree" className="text-sm font-medium text-text">
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

          <div className="mt-3 flex flex-col gap-3 sq sq-xl sq-ring rounded-xl border border-border bg-surface p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div id="settings-fresh-worktree" className="text-sm font-medium text-text">
                {t('settings.workstreams.freshTitle')}
              </div>
              <p className="mt-0.5 text-xs text-text-muted">
                {t('settings.workstreams.freshDescription')}
              </p>
              <p className="mt-2 text-xs text-text-subtle">
                {t('settings.workstreams.freshFootnote')}
              </p>
            </div>
            <Switch
              label={t('settings.workstreams.freshTitle')}
              checked={settings?.freshWorkstream ?? false}
              onChange={(v) => void setFreshWorkstream(v)}
            />
          </div>

          <div className="mt-3 sq sq-xl sq-ring rounded-xl border border-border bg-surface p-4">
            <label
              id="settings-worktree-setup"
              htmlFor="worktree-setup-command"
              className="text-sm font-medium text-text"
            >
              {t('settings.workstreams.setupTitle')}
            </label>
            <p id="worktree-setup-description" className="mt-0.5 text-xs text-text-muted">
              {t('settings.workstreams.setupDescription')}
            </p>
            <div className="mt-3 flex flex-wrap items-start gap-2">
              <textarea
                id="worktree-setup-command"
                value={setupCommand}
                onChange={(e) => setSetupCommand(e.target.value)}
                rows={3}
                spellCheck={false}
                placeholder={t('settings.workstreams.setupPlaceholder')}
                aria-describedby="worktree-setup-description worktree-setup-footnote"
                className="min-w-0 flex-1 basis-full resize-y sq sq-lg sq-ring rounded-lg border border-border bg-surface-2 px-3 py-2 font-mono text-sm text-text outline-none placeholder:text-text-subtle focus:border-border-strong focus:[--sq-ring:var(--color-border-strong)] sm:basis-0"
              />
              <Button
                onClick={() => void setWorktreeSetupCommand(setupCommand)}
                disabled={setupCommand.trim() === (settings?.worktreeSetupCommand ?? '')}
              >
                {t('common.save')}
              </Button>
            </div>
            <p id="worktree-setup-footnote" className="mt-2 text-xs text-text-subtle">
              {t('settings.workstreams.setupFootnote')}
            </p>
          </div>

          <div className="mt-3 sq sq-xl sq-ring rounded-xl border border-border bg-surface p-4">
            <div id="settings-branch-prefix" className="text-sm font-medium text-text">
              {t('settings.workstreams.prefixTitle')}
            </div>
            <p className="mt-0.5 text-xs text-text-muted">
              <Trans i18nKey="settings.workstreams.prefixDescription" />
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
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
                  'w-48 max-w-full sq sq-lg sq-ring rounded-lg border bg-surface-2 px-3 py-1.5 text-sm text-text outline-none placeholder:text-text-subtle',
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
                  normalizeBranchPrefix(prefix) ===
                    (settings?.branchPrefix ?? DEFAULT_BRANCH_PREFIX)
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

        <section
          id="settings-browser-panel"
          role="region"
          aria-labelledby="settings-browser"
          hidden={panel !== 'browser'}
          className="mb-8"
        >
          <h2 className={SECTION_HEADING}>{t('settings.browser.heading')}</h2>
          <div className="flex flex-col gap-3 sq sq-xl sq-ring rounded-xl border border-border bg-surface p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div id="settings-browser-title" className="text-sm font-medium text-text">
                {t('settings.browser.title')}
              </div>
              <p className="mt-0.5 text-xs text-text-muted">{t('settings.browser.description')}</p>
            </div>
            <Button variant="secondary" className="shrink-0" onClick={() => api.browser.open()}>
              <Globe className="h-3.5 w-3.5" /> {t('settings.browser.open')}
            </Button>
          </div>

          <div className="mt-3 overflow-hidden sq sq-xl sq-ring rounded-xl border border-border bg-surface">
            <div
              className={cn(
                'flex items-start justify-between gap-4 p-4',
                cookiesOpen && 'border-b border-border'
              )}
            >
              <div className="min-w-0">
                <div id="settings-cookies-title" className="text-sm font-medium text-text">
                  {t('settings.browser.cookiesTitle')}
                </div>
                <p className="mt-0.5 text-xs text-text-muted">
                  {t('settings.browser.cookiesDescription')}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="w-8 shrink-0 px-0"
                aria-expanded={cookiesOpen}
                aria-controls={cookiesPanelId}
                title={
                  cookiesOpen
                    ? t('settings.browser.cookiesCollapse')
                    : t('settings.browser.cookiesExpand')
                }
                onClick={() => setCookiesOpen((v) => !v)}
              >
                <ChevronDown
                  className={cn('h-4 w-4 transition-transform', cookiesOpen && 'rotate-180')}
                />
              </Button>
            </div>
            <div id={cookiesPanelId} hidden={!cookiesOpen}>
              {cookiesOpen && <CookiePanel className="max-h-[420px]" />}
            </div>
          </div>

          <div className="mt-3 overflow-hidden sq sq-xl sq-ring rounded-xl border border-border bg-surface">
            <ProxyPanel titleId="settings-proxy-title" />
          </div>
        </section>

        {/* Distinct from "Providers" above on purpose: that list is who runs the
          MODEL, this one is where the CODE lives. GitHub appears in both, as
          two unrelated accounts. */}
        <section hidden={panel !== 'accounts'} className="mb-8">
          <h2 id="settings-code-hosts" className={SECTION_HEADING}>
            {t('settings.codeHosts.heading')}
          </h2>
          <CodeHosts />
        </section>

        <section
          id="settings-backup-panel"
          role="region"
          aria-labelledby="settings-backup"
          hidden={panel !== 'backup'}
          className="mb-8"
        >
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

        <section
          id="settings-privacy-panel"
          role="region"
          aria-labelledby="settings-privacy"
          hidden={panel !== 'privacy'}
          className="mb-8"
        >
          <h2 className={SECTION_HEADING}>{t('settings.privacy.heading')}</h2>
          <div className="flex flex-col gap-3 sq sq-xl sq-ring rounded-xl border border-border bg-surface p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div id="settings-telemetry-title" className="text-sm font-medium text-text">
                {t('settings.privacy.title')}
              </div>
              <p className="mt-0.5 text-xs text-text-muted">{t('settings.privacy.description')}</p>
              <p className="mt-2 text-xs text-text-muted">
                <Trans i18nKey="settings.privacy.labels" />
              </p>
            </div>
            <Switch checked={telemetryEnabled} onChange={(v) => void setTelemetryEnabled(v)} />
          </div>
        </section>
        <section
          id="settings-about-panel"
          role="region"
          aria-labelledby="settings-about"
          hidden={panel !== 'about'}
          className="mb-8"
        >
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
                <Button
                  variant="primary"
                  className="shrink-0"
                  onClick={() => api.updates.install()}
                >
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

        <section hidden={panel !== 'about'} className="mb-8">
          <h2 className={SECTION_HEADING}>{t('settings.onboarding.heading')}</h2>
          <div className="flex flex-col gap-3 sq sq-xl sq-ring rounded-xl border border-border bg-surface p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div id="settings-onboarding-title" className="text-sm font-medium text-text">
                {t('settings.onboarding.title')}
              </div>
              <p className="mt-0.5 text-xs text-text-muted">
                {t('settings.onboarding.description')}
              </p>
            </div>
            <Button className="shrink-0" onClick={() => navigate('/onboarding')}>
              <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
              {t('settings.onboarding.replay')}
            </Button>
          </div>
        </section>
        <section hidden={panel !== 'about'} className="mt-8">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-danger">
            {t('settings.danger.heading')}
          </h2>
          <div className="flex flex-col gap-3 sq sq-xl sq-ring sq-ring-danger rounded-xl border border-danger/30 bg-danger/5 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div id="settings-reset-title" className="text-sm font-medium text-text">
                {t('settings.danger.resetTitle')}
              </div>
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
              <Button
                variant="danger"
                className="shrink-0"
                onClick={() => setConfirmingReset(true)}
              >
                <Trash2 className="h-3.5 w-3.5" /> {t('settings.danger.reset')}
              </Button>
            )}
          </div>
        </section>
      </div>
    </PageShell>
  )
}
