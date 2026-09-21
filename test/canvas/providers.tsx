import './bridge'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import '@fontsource-variable/geist/index.css'
import '@fontsource-variable/geist-mono/index.css'
import '../../src/renderer/src/assets/main.css'
import '../../src/renderer/src/i18n'
import Settings from '../../src/renderer/src/routes/Settings'
import { ModelPicker } from '../../src/renderer/src/components/ModelPicker'
import { useRoxyStore } from '../../src/renderer/src/lib/store'
import type { ConnectedProvider } from '../../src/shared/types'

let providers: ConnectedProvider[] = [1, 2].map((number) => ({
  id: `copilot-${number}`,
  seedId: 'github-copilot',
  accountNumber: number,
  name: `GitHub Copilot ${number}`,
  identity: `${number}:user-${number}`,
  wire: 'openai-chat',
  auth: 'device-flow',
  enabled: true,
  hasCredential: true,
  sortOrder: -number,
  createdAt: number
}))
const settings = {
  onboardingCompleted: true,
  activeProviderId: providers[0].id,
  activeModel: 'test-model',
  language: 'en'
}
Object.assign(window.roxy, {
  providers: {
    listConnected: async () => providers,
    rename: async (id: string, name: string) => {
      providers = providers.map((p) => (p.id === id ? { ...p, name } : p))
      return providers.find((p) => p.id === id)
    },
    disconnect: async (id: string) => {
      providers = providers.filter((p) => p.id !== id)
    },
    reorder: async () => undefined
  },
  settings: { ...window.roxy.settings, get: async () => settings },
  models: {
    list: async () => [{ id: 'test-model', name: 'Test Model', reasoning: false, toolCall: true }],
    hidden: async () => [],
    pinned: async () => [],
    recent: async () => []
  },
  system: {
    getVersions: async () => ({ app: 'test', electron: 'test', chrome: 'test', node: 'test' })
  },
  updates: {
    getState: async () => ({ version: 'test', packaged: false, state: { status: 'idle' } }),
    onStatus: () => () => undefined
  },
  codeHosts: { list: async () => [] },
  mcp: { list: async () => [] },
  cookies: { list: async () => [] },
  browser: { getProxy: async () => ({ enabled: false }), onProxyChanged: () => () => undefined },
  activity: {
    stats: async () => ({
      days: [],
      total: 0,
      max: 0,
      activeDays: 0,
      longestStreak: 0,
      currentStreak: 0
    })
  }
})
useRoxyStore.setState({
  providers,
  settings: settings as never,
  ready: true,
  modelCatalog: Object.fromEntries(
    providers.map((p) => [
      p.id,
      [{ id: 'test-model', name: 'Test Model', reasoning: false, toolCall: true }]
    ])
  ),
  refreshProviders: async () => useRoxyStore.setState({ providers: [...providers] })
})
document.documentElement.dataset.platform = 'win32'
document.documentElement.style.height = '100%'
document.body.style.height = '100%'
document.getElementById('root')!.style.height = '100%'
createRoot(document.getElementById('root')!).render(
  <HashRouter>
    {new URLSearchParams(location.search).has('picker') ? (
      <div className="p-6">
        <ModelPicker />
      </div>
    ) : (
      <Settings />
    )}
  </HashRouter>
)
