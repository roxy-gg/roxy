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
import type { ModelCatalogResult } from '../../src/shared/api'

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
const catalogFailure = new URLSearchParams(location.search).has('catalog-failure')
if (catalogFailure) {
  providers = providers.map((p, i) => ({
    ...p,
    id: i === 0 ? 'roxy-account' : 'chatgpt-account',
    seedId: i === 0 ? 'roxy' : 'codex-subscription',
    auth: i === 0 ? 'api-key' : 'subscription',
    name: i === 0 ? 'Roxy.gg Inference 1' : 'ChatGPT 1'
  }))
}
if (new URLSearchParams(location.search).has('many-accounts')) {
  providers = Array.from({ length: 8 }, (_, i) => ({
    ...providers[0],
    id: `account-${i}`,
    name: i === 0 ? 'ChatGPT' : `Very long inference provider account ${i}`
  }))
}
let catalogRecovered = false
let failVisibility = false
let hidden: { providerId: string; model: string }[] = []
const testModels = Array.from({ length: 600 }, (_, i) => ({
  id: i === 0 ? 'test-model' : `model-${i}`,
  name: i === 0 ? 'Test Model' : `Model ${i}`,
  reasoning: false,
  toolCall: true
}))
const settings = {
  onboardingCompleted: true,
  activeProviderId: providers[0].id,
  activeModel: 'test-model',
  language: 'en'
}
Object.assign(window.roxy, {
  copilot: { ...window.roxy.copilot, needsReauthentication: async () => false },
  providers: {
    listConnected: async () => providers,
    connect: async (input: { id: string; apiKey?: string; allowUnverified?: boolean }) => {
      await new Promise((resolve) => setTimeout(resolve, 250))
      if (input.apiKey === 'rejected') return { ok: false, error: 'invalidKey' }
      if (input.apiKey === 'unsupported' && !input.allowUnverified)
        return { ok: false, error: 'unsupported' }
      const provider = {
        ...providers[0],
        id: 'new-key-account',
        seedId: input.id,
        name: 'Roxy.gg Inference 1',
        auth: 'api-key' as const,
        defaultModel: 'test-model'
      }
      providers = [...providers, provider]
      return { ok: true, provider }
    },
    rename: async (id: string, name: string) => {
      providers = providers.map((p) => (p.id === id ? { ...p, name } : p))
      return providers.find((p) => p.id === id)
    },
    disconnect: async (id: string) => {
      providers = providers.filter((p) => p.id !== id)
    },
    reorder: async (ids: string[]) => {
      providers = ids.map((id) => providers.find((p) => p.id === id)!)
    }
  },
  settings: {
    ...window.roxy.settings,
    get: async () => settings,
    getAll: async () => settings,
    setActiveProvider: async () => settings
  },
  models: {
    list: async (id: string): Promise<ModelCatalogResult> => {
      if (catalogFailure && !catalogRecovered) {
        return { models: [], error: id === providers[0].id ? 'authentication' : 'unavailable' }
      }
      if (catalogFailure) await new Promise((resolve) => setTimeout(resolve, 200))
      return {
        models: testModels
      }
    },
    hidden: async () => hidden,
    setHidden: async (providerId: string, model: string, value: boolean) => {
      if (failVisibility) throw new Error('Test visibility failure')
      hidden = hidden.filter((h) => h.providerId !== providerId || h.model !== model)
      if (value) hidden.push({ providerId, model })
    },
    setProviderHidden: async (providerId: string, models: string[]) => {
      if (failVisibility) throw new Error('Test visibility failure')
      hidden = hidden
        .filter((h) => h.providerId !== providerId)
        .concat(models.map((model) => ({ providerId, model })))
    },
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
  modelCatalog: catalogFailure ? {} : Object.fromEntries(providers.map((p) => [p.id, testModels])),
  refreshProviders: async () => useRoxyStore.setState({ providers: [...providers] })
})
Object.assign(window, {
  failVisibility: (fail: boolean) => {
    failVisibility = fail
  },
  accountState: () => ({ providers, hidden: [...useRoxyStore.getState().hiddenModels] }),
  recoverCatalog: () => {
    catalogRecovered = true
  }
})
document.documentElement.dataset.platform = 'win32'
document.documentElement.style.height = '100%'
document.body.style.height = '100%'
document.getElementById('root')!.style.height = '100%'
createRoot(document.getElementById('root')!).render(
  <HashRouter>
    {new URLSearchParams(location.search).has('picker') ? (
      <div className="fixed bottom-0 p-6">
        <ModelPicker />
      </div>
    ) : (
      <Settings />
    )}
  </HashRouter>
)
