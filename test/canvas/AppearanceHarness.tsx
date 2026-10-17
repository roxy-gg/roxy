import './BackgroundHarness'
import { aggregateActivityDays } from '../../src/shared/activity'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { Sidebar } from '../../src/renderer/src/components/Sidebar'
import { BackgroundFrame } from '../../src/renderer/src/components/BackgroundFrame'
import Settings from '../../src/renderer/src/routes/Settings'
import { useRoxyStore } from '../../src/renderer/src/lib/store'
import { applyTheme } from '../../src/renderer/src/lib/theme'
import {
  BUILT_IN_THEMES,
  DEFAULT_THEME_ID,
  parseTheme,
  resolveTheme,
  serializeTheme,
  starterTheme,
  toThemeView,
  type ThemeFile
} from '../../src/shared/theme'

Object.assign(window.roxy, {
  system: {
    ...window.roxy.system,
    getVersions: async () => ({ app: 'test', electron: 'test', chrome: 'test', node: 'test' })
  },
  browser: {
    getProxy: async () => ({
      enabled: false,
      scheme: 'http',
      host: '',
      port: 0,
      username: '',
      hasPassword: false
    }),
    onProxyChanged: () => () => {}
  },
  forge: { listHosts: async () => [] },
  activity: {
    stats: async () =>
      aggregateActivityDays(
        new Map([
          ['2026-10-17', 12],
          ['2026-10-16', 8],
          ['2026-10-14', 4]
        ]),
        new Date(2026, 9, 17, 12).getTime(),
        371
      )
  },
  remote: {
    status: async () => ({
      phase: 'live',
      guests: 0,
      rev: 0,
      url: 'https://example.com',
      pin: '123456'
    })
  }
})
useRoxyStore.setState({ providers: [], refreshProviders: async () => {} })

let activeId = DEFAULT_THEME_ID
const custom: ThemeFile[] = []
const list = () => ({
  activeId,
  themes: [
    ...BUILT_IN_THEMES.map((t) => toThemeView(t, 'builtin')),
    ...custom.map((t) => toThemeView(t, 'user'))
  ],
  directory: '/test/themes',
  warnings: []
})
window.roxy.themes = {
  list: async () => list(),
  refresh: async () => list(),
  read: async (id) => serializeTheme(custom.find((t) => t.id === id)!),
  resolve: async (id) =>
    resolveTheme([...BUILT_IN_THEMES, ...custom].find((t) => t.id === (id ?? activeId))!),
  setActive: async (id) => {
    activeId = id
    const theme = await window.roxy.themes.resolve(id)
    applyTheme(theme)
    return theme
  },
  create: async ({ name, from }) => {
    const id = `custom-${custom.length}`
    const base = [...BUILT_IN_THEMES, ...custom].find((t) => t.id === from)
    custom.push(base ? { ...base, id, name } : starterTheme(id, name))
    return { ok: true, id }
  },
  save: async (id, source) => {
    const result = parseTheme(source)
    if (!result.ok) return result
    custom.splice(
      custom.findIndex((t) => t.id === id),
      1,
      result.theme
    )
    return { ok: true, id }
  },
  remove: async (id) => {
    custom.splice(
      custom.findIndex((t) => t.id === id),
      1
    )
    return { ok: true }
  },
  reveal: async () => {},
  onChanged: () => () => {}
}

export function AppearanceHarness(): JSX.Element {
  return (
    <MemoryRouter initialEntries={['/settings']}>
      <AppearancePages />
    </MemoryRouter>
  )
}

function AppearancePages(): JSX.Element {
  const { pathname } = useLocation()
  return (
    <div className="relative h-full w-full overflow-hidden">
      {/* Match App: the real chat sidebar stays mounted under secondary screens. */}
      <div
        id="main-sidebar-harness"
        className={
          pathname === '/' ? 'absolute inset-0' : 'invisible pointer-events-none absolute inset-0'
        }
      >
        <BackgroundFrame>
          <Sidebar />
        </BackgroundFrame>
      </div>
      {pathname !== '/' && (
        <div id="appearance-page" className="absolute inset-0 bg-bg">
          <Routes>
            <Route path="/settings/:section?" element={<Settings />} />
          </Routes>
        </div>
      )}
    </div>
  )
}
