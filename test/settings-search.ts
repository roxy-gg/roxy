import assert from 'node:assert/strict'
import { createInstance } from 'i18next'
import { LANGUAGES } from '../src/shared/i18n'
import { resources } from '../src/renderer/src/i18n'
import { SETTINGS_GROUPS } from '../src/renderer/src/lib/settings-navigation'
import {
  SETTINGS_SEARCH,
  searchSettings,
  settingsSearchRanges,
  type SettingsSearchPage
} from '../src/renderer/src/lib/settings-search'

async function main(): Promise<void> {
  const i18n = createInstance()
  await i18n.init({
    lng: 'en',
    fallbackLng: 'en',
    resources
  })
  const pages = SETTINGS_GROUPS.flatMap((group) =>
    group.items.map((item) => ({
      section: item.id,
      label: item.label,
      group: group.label
    }))
  ) satisfies SettingsSearchPage[]
  const languages = LANGUAGES.map(({ code }) => i18n.getFixedT(code))
  const search = (query: string) => searchSettings(query, i18n.t, pages, languages)
  assert.equal(search('  ').length, 0)
  assert.equal(search('does-not-exist-4937').length, 0)
  assert.equal(search('BRANCH prefix')[0].entry.title, 'settings.workstreams.prefixTitle')
  assert.equal(search('auto-reset remote main')[0].entry.target, 'settings-fresh-worktree')
  assert.equal(search('new worktree command')[0].entry.target, 'settings-worktree-setup')
  assert.equal(search('browser password')[0].entry.title, 'proxy.title')
  assert(
    search('notification').some(({ entry }) => entry.title === 'settings.notifications.soundsTitle')
  )
  assert(!search('prefix')[0].description.includes('<code>'))
  assert(search('e').length <= 20)
  assert.equal(search('prefix branch')[0].entry.title, 'settings.workstreams.prefixTitle')
  assert.equal(search('prefix zzz-4937').length, 0)
  const languagePage = [
    {
      section: 'language',
      label: 'settings.language.heading',
      group: 'settings.navigation.general'
    }
  ] as const
  const pageResults = searchSettings('language', i18n.t, languagePage, languages)
  assert.equal(
    pageResults[0].title,
    'Language',
    'exact page labels rank above partial setting labels'
  )
  assert.equal(pageResults[0].entry.target, 'settings-language-label')
  assert.equal(
    searchSettings('prefix', i18n.t, languagePage).length,
    0,
    'unavailable sections are excluded'
  )
  assert.deepEqual(
    [...new Set(SETTINGS_SEARCH.map((entry) => entry.section))].sort(),
    pages.map((page) => page.section).sort(),
    'the search index and actual settings navigation must cover the same sections'
  )
  assert.equal(search('cheat')[0].entry.target, 'settings-cheat-title')
  assert.equal(search('replay onboarding')[0].entry.target, 'settings-onboarding-title')
  for (const entry of SETTINGS_SEARCH) {
    assert(i18n.exists(entry.title), entry.title)
    assert(i18n.exists(entry.description), entry.description)
    if ('terms' in entry) for (const term of entry.terms) assert(i18n.exists(term), term)
  }
  assert.deepEqual(settingsSearchRanges('Notificaci\u00f3n', 'notificacion'), [[0, 12]])
  assert.deepEqual(settingsSearchRanges('caf\u00e9 cafe\u0301', 'CAFE'), [
    [0, 4],
    [5, 10]
  ])
  assert.deepEqual(settingsSearchRanges('banana', 'ana nana'), [[1, 6]])
  assert.deepEqual(settingsSearchRanges('a.b <script>', '.b <script>'), [
    [1, 3],
    [4, 12]
  ])
  assert.deepEqual(settingsSearchRanges('\ud83d\ude80 motion', 'motion'), [[3, 9]])
  assert.deepEqual(settingsSearchRanges('unchanged', ' '), [])
  await i18n.changeLanguage('es')
  assert(search('idioma').some(({ entry }) => entry.section === 'language'))
  const englishResult = search('language')[0]
  assert.equal(englishResult.entry.section, 'language')
  assert.equal(englishResult.matchedTitle, 'Language')
  assert.equal(englishResult.title, i18n.t('settings.language.heading'))
  assert.equal(englishResult.entry.target, 'settings-language-label')
  assert.equal(search('microfono')[0].entry.title, 'voice.microphone')
  assert.equal(search('microphone')[0].entry.title, 'voice.microphone')
  assert.equal(
    new Set(search('idioma').map((result) => result.entry.section + result.title)).size,
    search('idioma').length
  )
  for (const display of LANGUAGES) {
    await i18n.changeLanguage(display.code)
    for (const queryLanguage of LANGUAGES) {
      const translate = i18n.getFixedT(queryLanguage.code)
      const query = translate('voice.microphone')
      const result = search(query)[0]
      const context = `${queryLanguage.code} query in ${display.code} UI`
      assert.equal(result.entry.title, 'voice.microphone', context)
      assert.equal(result.title, i18n.t('voice.microphone'), context)
      assert.equal(result.entry.target, 'settings-voice-microphone', context)
      assert.equal(result.matchedTitle, query === result.title ? undefined : query, context)
      assert.equal(i18n.language, display.code, 'search never changes the UI language')
      for (const key of ['voice.microphoneBody', 'voice.openPrivacy'] as const) {
        assert(
          search(translate(key)).some(({ entry }) => entry.title === 'voice.microphone'),
          `${context}: translated descriptions and extra terms are searchable`
        )
      }
      assert(
        search(translate('settings.navigation.general')).some(
          ({ entry }) => entry.section === 'language'
        ),
        `${context}: translated locations are searchable`
      )
    }
  }
  console.log(
    'Settings search: matching, ranking, all Settings languages, markup and highlight ranges passed'
  )
}

void main()
