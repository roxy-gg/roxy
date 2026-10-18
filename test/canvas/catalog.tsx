import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/geist/index.css'
import '../../src/renderer/src/assets/main.css'
import '../../src/renderer/src/i18n'
import i18n from '../../src/renderer/src/i18n'
import type { CatalogApi, CatalogEntry, CatalogKind } from '../../src/shared/catalog'
import type { McpServerView, SkillView } from '../../src/shared/api'

const pause = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))
const calls: { kind: CatalogKind; query: string; cursor?: string }[] = []
const installs: string[] = []
const state = { calls, installs, failMore: false, actions: [] as string[] }
Object.assign(window, { __catalogTest: state })
const make = (kind: CatalogKind, name: string, extra = ''): CatalogEntry => ({
  id: kind === 'skills' ? `example/skills/${name}` : `io.github.example/${name}`,
  kind,
  name,
  source: kind === 'skills' ? 'example/skills' : 'io.github.example',
  description:
    kind === 'skills'
      ? `Practical ${name} workflows and reference examples.${extra}`
      : `Connect ${name} tools and services.${extra}`,
  url: 'https://example.com',
  iconUrl: null,
  installs: kind === 'skills' ? 24531 : null,
  version: kind === 'mcp' ? '1.2.3' : null
})
const catalog: CatalogApi = {
  async search(kind, query, cursor) {
    calls.push({ kind, query, cursor })
    await pause(query === 'slow' ? 800 : 30)
    if (query === 'error') throw Error('Fixture unavailable')
    if (cursor && state.failMore) throw Error('Fixture pagination failure')
    const names = cursor
      ? ['additional']
      : query
        ? [query]
        : kind === 'skills'
          ? ['react', 'cloudflare', 'design', 'testing']
          : ['filesystem', 'github', 'browser', 'weather']
    return {
      entries: query === 'empty' ? [] : names.map((name) => make(kind, name)),
      nextCursor: !query && !cursor ? 'next' : null,
      stale: query === 'stale',
      updatedAt: new Date().toISOString()
    }
  },
  async skillDetail(id) {
    await pause()
    return {
      reviewId: 'skill-review',
      entry: make('skills', id.split('/').at(-1)!),
      hash: null,
      files: [
        {
          path: 'SKILL.md',
          contents:
            '---\nname: react\ndescription: React workflows\n---\nUse accessible components. <script>alert("never execute")</script>'
        },
        { path: 'references/example.md', contents: 'Companion reference preview.' }
      ]
    }
  },
  async installSkill(id, reviewId) {
    if (reviewId !== 'skill-review') throw Error('Wrong snapshot')
    installs.push(id)
    await pause()
    return [{ name: id.split('/').at(-1)!, source: 'global', location: '/fixture/SKILL.md' }]
  },
  async mcpSetup(id) {
    await pause()
    return {
      reviewId: 'mcp-review',
      entry: make('mcp', id.split('/').at(-1)!),
      options: [
        {
          id: 'remote:0',
          label: 'Remote / Streamable HTTP',
          fields: [{ key: 'token', label: 'API_TOKEN', secret: true, required: true }],
          preview: JSON.stringify(
            {
              type: 'remote',
              url: 'https://example.com/mcp',
              headers: { Authorization: '[REDACTED]' }
            },
            null,
            2
          )
        }
      ]
    }
  },
  async installMcp({ id, reviewId, values }) {
    if (reviewId !== 'mcp-review' || !values.token) throw Error('Missing reviewed token')
    installs.push(id)
    await pause()
    return [
      {
        id,
        config: { type: 'remote', url: 'https://example.com/mcp' },
        enabled: true,
        status: 'connected',
        tools: []
      }
    ]
  }
}
let storedSkills: SkillView[] = [
  {
    name: 'local-workflow',
    source: 'global',
    location: '/fixture/local-workflow/SKILL.md',
    description: 'A manually installed workflow.'
  }
]
let storedServers: McpServerView[] = [
  {
    id: 'local-mcp',
    config: { type: 'remote', url: 'https://example.com/mcp' },
    enabled: true,
    status: 'connected',
    tools: ['search']
  }
]
let markdown = '---\nname: local-workflow\ndescription: Fixture\nlicense: MIT\n---\nInstructions.'
const installedList = () => Promise.resolve([...storedSkills])
window.roxy = {
  catalog,
  system: { openExternal: async () => {} },
  config: { export: async () => ({ ok: false }), import: async () => ({ cancelled: true }) },
  skills: {
    list: installedList,
    refresh: installedList,
    read: async (name: string) => ({
      ...storedSkills.find((s) => s.name === name),
      body: 'Instructions.'
    }),
    readRaw: async () => ({ text: markdown, location: storedSkills[0].location }),
    saveRaw: async (input: { text: string }) => {
      markdown = input.text
      state.actions.push('skill:raw')
      return installedList()
    },
    remove: async (name: string) => {
      state.actions.push('skill:remove')
      storedSkills = storedSkills.filter((s) => s.name !== name)
      return installedList()
    },
    update: async () => {
      state.actions.push('skill:edit')
      return installedList()
    },
    create: async () => installedList()
  },
  mcp: {
    list: async () => [...storedServers],
    setEnabled: async (id: string, enabled: boolean) => {
      state.actions.push('mcp:toggle')
      storedServers = storedServers.map((s) =>
        s.id === id ? { ...s, enabled, status: enabled ? 'connected' : 'disabled' } : s
      )
      return [...storedServers]
    },
    reconnect: async () => {
      state.actions.push('mcp:reconnect')
      return [...storedServers]
    },
    upsert: async (input: McpServerView) => {
      state.actions.push('mcp:raw')
      storedServers = storedServers.map((s) => (s.id === input.id ? { ...s, ...input } : s))
    },
    remove: async (id: string) => {
      state.actions.push('mcp:remove')
      storedServers = storedServers.filter((s) => s.id !== id)
      return [...storedServers]
    }
  }
} as unknown as typeof window.roxy
// The real module captures window.roxy; install the fixture bridge first.
const { CatalogSearch } = await import('../../src/renderer/src/components/CatalogSearch')
const { default: Skills } = await import('../../src/renderer/src/routes/Skills')
const { McpServers } = await import('../../src/renderer/src/components/McpServers')
await i18n.changeLanguage('en')

function Harness() {
  const [active, setActive] = useState(true)
  const [skills, setSkills] = useState<SkillView[]>([])
  const [servers, setServers] = useState<McpServerView[]>([])
  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-9 p-6 font-sans text-text">
      <button id="toggle-active" onClick={() => setActive(!active)}>
        Toggle settings activity
      </button>
      {new URLSearchParams(location.search).has('management') ? (
        <>
          <div id="skills-management">
            <Skills active={active} />
          </div>
          <div id="mcp-management">
            <McpServers active={active} showBackup />
          </div>
        </>
      ) : (
        <>
          <CatalogSearch
            kind="skills"
            active={active}
            installedSkills={skills}
            onSkillsInstalled={setSkills}
          />
          <CatalogSearch
            kind="mcp"
            active={active}
            installedServers={servers}
            onMcpInstalled={setServers}
          />
        </>
      )}
    </main>
  )
}
const root = createRoot(document.getElementById('root')!)
import.meta.hot?.dispose(() => root.unmount())
root.render(
  <StrictMode>
    <Harness />
  </StrictMode>
)
