import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CatalogClient, prepareCatalogSkill } from '../src/main/services/catalog'
import { installCatalogSkillFiles } from '../src/main/services/skills'
import type { CatalogEntry, CatalogSkillDetail, RegistryMcpServer } from '../src/shared/catalog'

const entry: CatalogEntry = {
  id: 'example/skills/catalog-test-skill',
  kind: 'skills',
  name: 'Human Display Name',
  description: '',
  source: 'example/skills',
  url: 'https://skills.sh/example/skills/catalog-test-skill',
  iconUrl: null,
  installs: 42,
  version: null
}
const skill: CatalogSkillDetail = {
  reviewId: '',
  entry,
  hash: null,
  files: [
    {
      path: 'SKILL.md',
      contents: '---\nname: catalog-test-skill\ndescription: Fixture\n---\nUse fixtures.'
    },
    { path: 'references/guide.md', contents: 'Reference bytes' }
  ]
}
const server: RegistryMcpServer = {
  name: 'io.github.example/catalog-test',
  description: 'Fixture',
  version: '1.0.0',
  remotes: [{ type: 'streamable-http', url: 'https://example.com/mcp' }]
}
const mcpEntry: CatalogEntry = {
  ...entry,
  id: server.name,
  kind: 'mcp',
  name: 'Fixture',
  source: 'io.github.example',
  installs: null,
  version: '1.0.0'
}
let count = 0
async function test(name: string, run: () => void | Promise<void>) {
  await run()
  console.log(`ok ${++count} - ${name}`)
}
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })

async function main() {
  await test('snapshot validation uses canonical skill name and preserves companions', () => {
    const bundle = prepareCatalogSkill(skill)
    assert.equal(bundle.name, 'catalog-test-skill')
    assert.deepEqual(bundle.files, skill.files)
    assert.equal(
      prepareCatalogSkill({
        ...skill,
        files: [
          {
            path: 'SKILL.md',
            contents: '---\nname: Next.js Development\n---\nHuman-readable upstream name'
          }
        ]
      }).name,
      'Next.js Development'
    )
    assert.throws(() => prepareCatalogSkill({ ...skill, files: null }))
  })
  await test('unsafe Windows/POSIX paths, case aliases, file-parent conflicts and oversized files fail', () => {
    for (const bad of [
      '../evil',
      '/evil',
      'C:/evil',
      'scripts\\evil',
      'CON',
      'safe/file:stream',
      'safe/end.',
      'safe/end ',
      'safe//file'
    ]) {
      assert.throws(
        () =>
          prepareCatalogSkill({ ...skill, files: [...skill.files!, { path: bad, contents: '' }] }),
        bad
      )
    }
    for (const files of [
      [...skill.files!, { path: 'skill.md', contents: '' }],
      [...skill.files!, { path: 'references', contents: '' }],
      [{ path: 'nested/SKILL.md', contents: skill.files![0].contents }],
      [...skill.files!, { path: 'huge', contents: 'x'.repeat(512 * 1024 + 1) }]
    ])
      assert.throws(() => prepareCatalogSkill({ ...skill, files }))
    assert.throws(() =>
      prepareCatalogSkill({
        ...skill,
        files: [{ path: 'SKILL.md', contents: '---\nname: CON\n---\nx' }]
      })
    )
  })
  await test('search preserves pagination/counts and admits only same-relay icon keys', async () => {
    let request = ''
    const key = 'a'.repeat(64)
    const client = new CatalogClient('https://relay.example', async (input, init) => {
      request = String(input)
      assert.equal(init?.redirect, 'error')
      assert.equal(init?.credentials, 'omit')
      return json({
        entries: [
          { ...entry, iconUrl: `https://relay.example/api/catalog/icons/${key}` },
          {
            ...entry,
            id: 'example/skills/other',
            iconUrl: `https://tracker.example/api/catalog/icons/${key}`
          }
        ],
        nextCursor: 'opaque',
        stale: true,
        updatedAt: new Date(0).toISOString()
      })
    })
    const result = await client.search('skills', 'react', 'cursor')
    assert.match(request, /q=react&cursor=cursor/)
    assert.equal(result.nextCursor, 'opaque')
    assert.equal(result.stale, true)
    assert.equal(result.entries[0].installs, 42)
    assert.equal(result.entries[0].iconUrl, `https://relay.example/api/catalog/icons/${key}`)
    assert.equal(result.entries[1].iconUrl, null)
  })
  await test('MCP counts remain unknown, malformed relay responses and insecure bases fail', async () => {
    const client = new CatalogClient('https://relay.example', async () =>
      json({
        entries: [{ ...mcpEntry, installs: 99 }],
        nextCursor: null,
        stale: false,
        updatedAt: new Date().toISOString()
      })
    )
    assert.equal((await client.search('mcp', '')).entries[0].installs, null)
    await assert.rejects(client.search('mcp', 'a'))
    for (const base of [
      'http://relay.example',
      'https://user:pass@relay.example',
      'https://relay.example/path',
      'https://relay.example?token=x'
    ])
      assert.throws(() => new CatalogClient(base))
    const bad = new CatalogClient(
      'https://relay.example',
      async () => new Response('<html>no</html>')
    )
    await assert.rejects(bad.search('skills', 'react'))
  })
  await test('review handles freeze exact skill bytes, do not share windows and expire', async () => {
    let now = 0
    let body = structuredClone(skill)
    const client = new CatalogClient(
      'https://relay.example',
      async () => json(body),
      () => now
    )
    assert.throws(() => client.skillForInstall(entry.id, 'unreviewed'), /expired/)
    const first = await client.skillDetail(entry.id)
    assert.equal(first.entry.name, 'catalog-test-skill')
    first.files![0].contents = 'renderer tamper'
    body = {
      ...body,
      files: [
        { path: 'SKILL.md', contents: '---\nname: catalog-test-skill\n---\nChanged upstream' }
      ]
    }
    const second = await client.skillDetail(entry.id)
    assert.match(client.skillForInstall(entry.id, first.reviewId).files[0].contents, /Use fixtures/)
    assert.match(
      client.skillForInstall(entry.id, second.reviewId).files[0].contents,
      /Changed upstream/
    )
    assert.throws(
      () => new CatalogClient('https://relay.example').skillForInstall(entry.id, first.reviewId),
      /expired/
    )
    client.forget(first.reviewId)
    assert.throws(() => client.skillForInstall(entry.id, first.reviewId), /expired/)
    now = 10 * 60_000
    assert.throws(() => client.skillForInstall(entry.id, second.reviewId), /expired/)
  })
  await test('MCP review handles freeze endpoints; install never refetches or accepts preview config', async () => {
    let upstream = structuredClone(server)
    const client = new CatalogClient('https://relay.example', async () =>
      json({ entry: mcpEntry, server: upstream })
    )
    const setup = await client.mcpSetup(server.name)
    upstream = {
      ...upstream,
      remotes: [{ type: 'streamable-http', url: 'https://changed.example/mcp' }]
    }
    const next = await client.mcpSetup(server.name)
    assert.deepEqual(client.mcpForInstall(server.name, setup.reviewId, setup.options[0].id, {}), {
      type: 'remote',
      url: 'https://example.com/mcp'
    })
    assert.deepEqual(client.mcpForInstall(server.name, next.reviewId, next.options[0].id, {}), {
      type: 'remote',
      url: 'https://changed.example/mcp'
    })
    assert.throws(() => client.mcpForInstall(server.name, setup.reviewId, 'remote:100', {}))
  })
  await test('catalog disk install writes one bundle only, refuses replacement and cleans failed writes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roxy-catalog-install-'))
    try {
      const bundle = prepareCatalogSkill(skill)
      await installCatalogSkillFiles(bundle.name, bundle.files, root)
      assert.equal(
        await fs.readFile(path.join(root, bundle.name, 'references/guide.md'), 'utf8'),
        'Reference bytes'
      )
      await assert.rejects(
        installCatalogSkillFiles(bundle.name, bundle.files, root),
        /already exists/
      )
      assert.match(
        await fs.readFile(path.join(root, bundle.name, 'SKILL.md'), 'utf8'),
        /Use fixtures/
      )
      await installCatalogSkillFiles(
        'Human Readable Skill',
        [{ path: 'SKILL.md', contents: '---\nname: Human Readable Skill\n---\nOriginal bytes' }],
        root
      )
      assert.match(
        await fs.readFile(path.join(root, 'human-readable-skill/SKILL.md'), 'utf8'),
        /name: Human Readable Skill/
      )
      await assert.rejects(
        installCatalogSkillFiles(
          'catalog-bad-fixture',
          [
            { path: '../evil', contents: 'no' },
            { path: 'SKILL.md', contents: 'x' }
          ],
          root
        ),
        /Unsafe/
      )
      await assert.rejects(fs.stat(path.join(root, 'catalog-bad-fixture')))
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
  console.log(`\n${count} catalog client/install tests passed.`)
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
