import assert from 'node:assert/strict'
import { createInstance } from 'i18next'
import source from '../src/renderer/src/locales/default.json'
import spanish from '../src/renderer/src/locales/es.json'
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
    resources: { en: { translation: source }, es: { translation: spanish } }
  })
  const pages = SETTINGS_GROUPS.flatMap((group) =>
    group.items.map((item) => ({
      section: item.id,
      label: item.label,
      group: group.label
    }))
  ) satisfies SettingsSearchPage[]
  const search = (query: string) => searchSettings(query, i18n.t, pages, i18n.getFixedT('en'))
  assert.equal(search('  ').length, 0)
  assert.equal(search('does-not-exist-4937').length, 0)
  assert.equal(search('BRANCH prefix')[0].entry.title, 'settings.workstreams.prefixTitle')
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
  const pageResults = searchSettings('language', i18n.t, languagePage, i18n.getFixedT('en'))
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
  assert.equal(englishResult.englishMatch, 'Language')
  assert.equal(englishResult.title, i18n.t('settings.language.heading'))
  assert.equal(englishResult.entry.target, 'settings-language-label')
  assert.equal(search('microfono')[0].entry.title, 'voice.microphone')
  assert.equal(search('microphone')[0].entry.title, 'voice.microphone')
  assert.equal(
    new Set(search('idioma').map((result) => result.entry.section + result.title)).size,
    search('idioma').length
  )
  console.log('Settings search: matching, ranking, locales, markup and highlight ranges passed')
}

void main()
