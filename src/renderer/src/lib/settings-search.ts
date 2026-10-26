import type { ParseKeys, TFunction } from 'i18next'
import type { SettingsSection } from './settings-navigation'

type SearchEntry = {
  section: SettingsSection
  title: ParseKeys
  description: ParseKeys
  target?: string
  terms?: readonly ParseKeys[]
}

// Static UI copy only: never mount panels or inspect saved user data to search.
export const SETTINGS_SEARCH = [
  {
    section: 'background',
    title: 'wallpapers.title',
    description: 'wallpapers.description',
    terms: ['wallpapers.addCustom', 'wallpapers.customHint']
  },
  {
    section: 'sidebar',
    title: 'background.effect',
    description: 'background.sidebarDescription',
    target: 'background-effect-label',
    terms: [
      'background.effects.none',
      'background.effects.dither',
      'background.effects.ascii',
      'background.effects.halftone',
      'background.effects.scanlines',
      'background.effects.haze'
    ]
  },
  {
    section: 'sidebar',
    title: 'background.sidebarStyle',
    description: 'background.sidebarDescription',
    target: 'settings-sidebar-style',
    terms: ['background.sidebarStyles.glass', 'background.sidebarStyles.dimmed']
  },
  {
    section: 'sidebar',
    title: 'background.showOn',
    description: 'background.allSessions',
    target: 'settings-background-scope',
    terms: ['background.emptyOnly']
  },
  {
    section: 'sidebar',
    title: 'background.sidebarOpacity',
    description: 'background.sidebarOpacityHint',
    target: 'settings-sidebarOpacity'
  },
  {
    section: 'sidebar',
    title: 'background.emptyOpacity',
    description: 'background.emptyOpacityHint',
    target: 'settings-emptyOpacity'
  },
  {
    section: 'sidebar',
    title: 'background.sessionOpacity',
    description: 'background.sessionOpacityHint',
    target: 'settings-sessionOpacity'
  },
  {
    section: 'sidebar',
    title: 'background.glass',
    description: 'background.glassHint',
    target: 'settings-background-glass'
  },
  {
    section: 'colors',
    title: 'appearance.themes',
    description: 'appearance.themeDescription',
    terms: [
      'themes.newTheme',
      'themes.openFolder',
      'themes.fonts',
      'themes.fontsBody',
      'themes.colorsBody'
    ]
  },
  {
    section: 'motion',
    title: 'settings.motion.label',
    description: 'settings.motion.description',
    terms: ['settings.motion.reduced', 'settings.motion.system']
  },
  {
    section: 'skills',
    title: 'sidebar.skills',
    description: 'skills.subtitle',
    terms: ['skills.addFromUrl', 'skills.newSkill', 'skills.rescan']
  },
  {
    section: 'mcp',
    title: 'sidebar.mcpServers',
    description: 'mcpPage.subtitle',
    terms: ['mcp.addServer', 'mcp.kindLocal', 'mcp.kindRemote', 'mcp.editRawJson']
  },
  {
    section: 'engineering',
    title: 'engineering.heading',
    description: 'engineering.description',
    terms: ['engineering.toggle', 'engineering.downloadInstall']
  },
  {
    section: 'backup',
    title: 'settings.backup.heading',
    description: 'settings.backup.description',
    terms: ['configBackup.export', 'configBackup.import']
  },
  {
    section: 'cheat',
    title: 'cheat.title',
    description: 'cheat.directOverview',
    target: 'settings-cheat-title',
    terms: ['cheat.enable', 'cheat.toolCatalog', 'cheat.sources', 'cheat.prompt']
  },
  {
    section: 'accounts',
    title: 'settings.providers.heading',
    description: 'settings.providers.description',
    terms: [
      'settings.providers.addAccount',
      'settings.models.visibilityHint',
      'settings.providers.reconnect'
    ]
  },
  {
    section: 'accounts',
    title: 'settings.codeHosts.heading',
    description: 'codeHosts.pullRequestsDescription',
    target: 'settings-code-hosts',
    terms: ['codeHosts.pullRequests']
  },
  {
    section: 'browser',
    title: 'settings.browser.title',
    description: 'settings.browser.description',
    target: 'settings-browser-title'
  },
  {
    section: 'browser',
    title: 'settings.browser.cookiesTitle',
    description: 'settings.browser.cookiesDescription',
    target: 'settings-cookies-title'
  },
  {
    section: 'browser',
    title: 'proxy.title',
    description: 'proxy.description',
    target: 'settings-proxy-title',
    terms: ['proxy.protocol', 'proxy.host', 'proxy.port', 'proxy.username', 'proxy.password']
  },
  {
    section: 'language',
    title: 'settings.language.label',
    description: 'settings.language.description',
    target: 'settings-language-label'
  },
  {
    section: 'voice',
    title: 'voice.models',
    description: 'voice.modelsBody',
    target: 'voice-models-heading',
    terms: ['voice.download', 'voice.useModel']
  },
  {
    section: 'voice',
    title: 'voice.microphone',
    description: 'voice.microphoneBody',
    target: 'settings-voice-microphone',
    terms: ['voice.bluetooth', 'voice.openPrivacy']
  },
  {
    section: 'voice',
    title: 'voice.hotkeys',
    description: 'voice.hotkeysBody',
    target: 'settings-voice-hotkeys',
    terms: ['voice.hotkeyHint']
  },
  {
    section: 'worktrees',
    title: 'settings.workstreams.autoTitle',
    description: 'settings.workstreams.autoDescription',
    target: 'settings-auto-worktree'
  },
  {
    section: 'worktrees',
    title: 'settings.workstreams.freshTitle',
    description: 'settings.workstreams.freshDescription',
    target: 'settings-fresh-worktree',
    terms: ['settings.workstreams.freshFootnote']
  },
  {
    section: 'worktrees',
    title: 'settings.workstreams.setupTitle',
    description: 'settings.workstreams.setupDescription',
    target: 'settings-worktree-setup',
    terms: ['settings.workstreams.setupFootnote']
  },
  {
    section: 'worktrees',
    title: 'settings.workstreams.prefixTitle',
    description: 'settings.workstreams.prefixDescription',
    target: 'settings-branch-prefix'
  },
  {
    section: 'notifications',
    title: 'settings.notifications.completeTitle',
    description: 'settings.notifications.completeHint',
    target: 'settings-notifications-complete'
  },
  {
    section: 'notifications',
    title: 'settings.notifications.soundsTitle',
    description: 'settings.notifications.soundHint',
    target: 'notification-sound-label',
    terms: [
      'settings.notifications.importSound',
      'settings.notifications.soundLimits',
      'settings.notifications.testNotification'
    ]
  },
  {
    section: 'remote',
    title: 'remote.title',
    description: 'remote.idleBody',
    terms: ['settings.navigation.openRemote']
  },
  {
    section: 'activity',
    title: 'settings.navigation.activity',
    description: 'settings.activity.description',
    terms: ['settings.activity.total', 'settings.activity.currentStreak']
  },
  {
    section: 'privacy',
    title: 'settings.privacy.title',
    description: 'settings.privacy.description',
    target: 'settings-telemetry-title',
    terms: ['settings.privacy.labels']
  },
  {
    section: 'about',
    title: 'settings.about.checkForUpdates',
    description: 'settings.about.update.idle'
  },
  {
    section: 'about',
    title: 'settings.danger.resetTitle',
    description: 'settings.danger.resetDescription',
    target: 'settings-reset-title'
  },
  {
    section: 'about',
    title: 'settings.onboarding.title',
    description: 'settings.onboarding.description',
    target: 'settings-onboarding-title',
    terms: ['settings.onboarding.replay', 'settings.onboarding.heading']
  }
] as const satisfies readonly SearchEntry[]

export type SettingsSearchPage = {
  section: SettingsSection
  label: ParseKeys
  group: ParseKeys
}
export type SettingsSearchEntry = {
  section: SettingsSearchPage['section']
  title: ParseKeys
  target?: string
}
export type SettingsSearchResult = {
  entry: SettingsSearchEntry
  title: string
  description: string
  location: string
  matchedTitle?: string
}

export function normalizeSettingsSearch(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

export function settingsSearchRanges(text: string, query: string): [number, number][] {
  const offsets: number[] = []
  let normalized = ''
  let offset = 0
  for (const character of text) {
    const folded = normalizeSettingsSearch(character)
    for (let i = 0; i < folded.length; i++) offsets.push(offset)
    normalized += folded
    offset += character.length
  }
  offsets.push(text.length)
  const ranges: [number, number][] = []
  for (const term of normalizeSettingsSearch(query).split(/\s+/).filter(Boolean)) {
    let start = normalized.indexOf(term)
    while (start !== -1) {
      ranges.push([offsets[start], offsets[start + term.length]])
      start = normalized.indexOf(term, start + term.length)
    }
  }
  ranges.sort((a, b) => a[0] - b[0])
  return ranges.reduce<[number, number][]>((merged, range) => {
    const last = merged[merged.length - 1]
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
    else merged.push([...range])
    return merged
  }, [])
}

export function searchSettings(
  query: string,
  t: TFunction,
  pages: readonly SettingsSearchPage[],
  languages: readonly TFunction[] = []
): SettingsSearchResult[] {
  const terms = normalizeSettingsSearch(query).trim().split(/\s+/).filter(Boolean)
  if (!terms.length) return []
  const wanted = terms.join(' ')
  const plain = (key: ParseKeys, translate = t): string =>
    translate(key).replace(/<\/?\w+[^>]*>/g, '')
  const candidates: SearchEntry[] = [
    ...SETTINGS_SEARCH,
    ...pages.map((page) => {
      const anchor = SETTINGS_SEARCH.find(
        (entry) => entry.section === page.section && 'target' in entry
      )
      return {
        section: page.section,
        title: page.label,
        description: page.group,
        target: anchor && 'target' in anchor ? anchor.target : undefined
      }
    })
  ]
  const seen = new Set<string>()
  return candidates
    .map((entry) => {
      const page = pages.find((page) => page.section === entry.section)
      if (!page) return null
      const title = plain(entry.title)
      const description = plain(entry.description)
      const location = [plain(page.group), plain(page.label)].join(' / ')
      const translatedTitles = [
        title,
        ...languages.map((translate) => plain(entry.title, translate))
      ]
      const titles = translatedTitles.map(normalizeSettingsSearch)
      const fields = [
        ...titles,
        ...[t, ...languages].flatMap((translate) =>
          [entry.description, page.group, page.label, ...(entry.terms ?? [])].map((key) =>
            plain(key, translate)
          )
        )
      ].map(normalizeSettingsSearch)
      if (!terms.every((term) => fields.some((field) => field.includes(term)))) return null
      // Prefer the exact label, then prefixes/word starts, before descriptive matches.
      const score =
        (titles.includes(wanted)
          ? 100
          : titles.some((title) => title.startsWith(wanted))
            ? 60
            : 0) +
        terms.reduce(
          (sum, term) =>
            sum +
            (titles.some((title) => title.split(/\s+/).some((word) => word.startsWith(term)))
              ? 10
              : titles.some((title) => title.includes(term))
                ? 6
                : 1),
          0
        )
      const identity = entry.section + ':' + normalizeSettingsSearch(title)
      if (seen.has(identity)) return null
      seen.add(identity)
      return {
        entry: { section: page.section, title: entry.title, target: entry.target },
        title,
        description,
        location,
        matchedTitle:
          !terms.some((term) => titles[0].includes(term)) &&
          titles.some((title) => terms.some((term) => title.includes(term)))
            ? translatedTitles[
                titles.findIndex((title) => terms.some((term) => title.includes(term)))
              ]
            : undefined,
        score
      }
    })
    .filter((result): result is NonNullable<typeof result> => result !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
}
