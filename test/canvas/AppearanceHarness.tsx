import './BackgroundHarness'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { Sidebar } from '../../src/renderer/src/components/Sidebar'
import Themes from '../../src/renderer/src/routes/Themes'
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
    <MemoryRouter initialEntries={['/themes']}>
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
        <Sidebar />
      </div>
      {pathname !== '/' && (
        <div id="appearance-page" className="absolute inset-0 bg-bg">
          <Themes />
        </div>
      )}
    </div>
  )
}
