/** Standalone pure-Node smoke test; bundle exactly like test/shared.ts. */
import assert from 'node:assert/strict'
import { catalogMcpId, catalogMcpOptions, resolveCatalogMcpConfig } from '../src/shared/catalog-mcp'
import type { RegistryInput, RegistryMcpServer } from '../src/shared/catalog'

type Package = NonNullable<RegistryMcpServer['packages']>[number]
type Remote = NonNullable<RegistryMcpServer['remotes']>[number]
const base: RegistryMcpServer = {
  name: 'io.github.example/weather',
  description: 'Weather',
  version: '99.0.0'
}
const npm: Package = {
  registryType: 'npm',
  identifier: '@example/weather',
  version: '1.2.3',
  transport: { type: 'stdio' }
}
const remote: Remote = { type: 'streamable-http', url: 'https://api.example.test/mcp' }
function local(overrides: Partial<Package> = {}): RegistryMcpServer {
  return { ...base, packages: [{ ...npm, ...overrides }] }
}
function hosted(overrides: Partial<Remote> = {}): RegistryMcpServer {
  return { ...base, remotes: [{ ...remote, ...overrides }] }
}
function resolve(server: RegistryMcpServer, values: Record<string, string> = {}) {
  const [option] = catalogMcpOptions(server)
  assert.ok(option, 'Fixture should expose one installation option')
  return resolveCatalogMcpConfig(server, option.id, values)
}
let passed = 0
function test(title: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`ok ${passed} - ${title}`)
  } catch (error) {
    console.error(`FAIL - ${title}`)
    throw error
  }
}

test('official DB ids preserve namespace/slash without lossy collisions', () => {
  assert.equal(catalogMcpId(base.name), base.name)
  assert.notEqual(catalogMcpId('com.example/a-b'), catalogMcpId('com.example/a_b'))
  for (const name of ['', 'a', 'com.example/a/b', 'com.example/a\n', 'a/'.repeat(201)]) {
    assert.throws(() => catalogMcpId(name), /invalid name/)
  }
})

test('remote Streamable HTTP and SSE preserve URLs and headers', () => {
  for (const type of ['streamable-http', 'sse']) {
    const server = hosted({ type, headers: [{ name: 'X-Region', value: 'west' }] })
    assert.match(catalogMcpOptions(server)[0].label, type === 'sse' ? /SSE/ : /Streamable HTTP/)
    assert.deepEqual(resolve(server), {
      type: 'remote',
      url: remote.url,
      headers: { 'X-Region': 'west' }
    })
  }
})

test('URL variables are component encoded and cannot alter the authority', () => {
  const server = hosted({
    url: 'https://api.example.test/{tenant}/mcp?region={region}',
    variables: { tenant: { isRequired: true }, region: { default: 'us west' } }
  })
  const value = 'a/b?x=1&next=https://evil.test@$&'
  assert.deepEqual(resolve(server, { 'url.tenant': value }), {
    type: 'remote',
    url: `https://api.example.test/${encodeURIComponent(value)}/mcp?region=us%20west`
  })
  assert.throws(() => resolve(server), /tenant/)
  assert.throws(() => resolve(server, { 'url.tenant': '..' }), /dot path/)
  assert.throws(() => resolve(server, { 'url.tenant': '{other}' }), /invalid/)
})

test('fixed URL variables, defaults, repeated references and secrets', () => {
  const server = hosted({
    url: 'https://api.example.test/{tenant}/{tenant}?key={key}',
    variables: {
      tenant: { value: 'fixed/a' },
      key: { default: 'secret-123', isSecret: true }
    }
  })
  assert.equal(catalogMcpOptions(server)[0].fields.length, 1)
  assert.ok(!JSON.stringify(catalogMcpOptions(server)).includes('secret-123'))
  assert.deepEqual(resolve(server), {
    type: 'remote',
    url: 'https://api.example.test/fixed%2Fa/fixed%2Fa?key=secret-123'
  })
})

test('untrusted hosts, URL credentials and unsupported transport data are omitted', () => {
  for (const url of [
    'https://user:password@api.example.test/mcp',
    'https://@api.example.test',
    'https://{host}/mcp',
    '{scheme}://example.test',
    'https://api.example.test:{port}/mcp',
    'javascript:alert(1)',
    'file:///tmp/mcp',
    'http://example.test/mcp',
    'https://api.example.test/#fragment',
    'https://api.example.test/\\evil',
    'https://api.example.test/{missing}',
    'https://api.example.test/%7Bmissing%7D'
  ]) {
    assert.equal(catalogMcpOptions(hosted({ url })).length, 0, url)
  }
  assert.deepEqual(resolve(hosted({ url: 'http://127.0.0.1:8080/mcp' })), {
    type: 'remote',
    url: 'http://127.0.0.1:8080/mcp'
  })
  assert.equal(catalogMcpOptions(hosted({ type: 'websocket' })).length, 0)
  assert.equal(catalogMcpOptions(hosted({ variables: { unused: {} } })).length, 0)
  assert.equal(
    catalogMcpOptions(hosted({ ...({ authentication: { type: 'oauth' } } as object) })).length,
    0
  )
})

test('fixed and default secrets never appear anywhere in setup previews/fields', () => {
  const secrets = [
    'fixed-secret-123',
    'hidden-default-456',
    'child-secret-789',
    'secret-choice-xyz'
  ]
  const server = hosted({
    headers: [
      { name: 'X-Fixed', value: secrets[0], isSecret: true },
      { name: 'X-Default', default: secrets[1], isSecret: true },
      {
        name: 'Authorization',
        value: 'Bearer {token}',
        isRequired: true,
        variables: { token: { value: secrets[2], isSecret: true } }
      },
      { name: 'X-Choice', default: secrets[3], choices: [secrets[3]], isSecret: true }
    ]
  })
  const serialized = JSON.stringify(catalogMcpOptions(server))
  for (const secret of secrets) assert.ok(!serialized.includes(secret), secret)
  assert.match(serialized, /REDACTED/)
  const config = resolve(server)
  assert.equal(config.type, 'remote')
  if (config.type === 'remote')
    assert.deepEqual(config.headers, {
      'X-Fixed': secrets[0],
      'X-Default': secrets[1],
      Authorization: `Bearer ${secrets[2]}`,
      'X-Choice': secrets[3]
    })
})

test('required secret fields validate, fixed fields are not editable, errors do not echo values', () => {
  const server = hosted({ headers: [{ name: 'Authorization', isRequired: true, isSecret: true }] })
  const field = catalogMcpOptions(server)[0].fields[0]
  assert.equal(field.required, true)
  assert.equal(field.secret, true)
  assert.throws(() => resolve(server), /Authorization/)
  assert.throws(() => resolve(server, { [field.key]: '  ' }), /Authorization/)
  assert.deepEqual(resolve(server, { [field.key]: 'Bearer token' }), {
    type: 'remote',
    url: remote.url,
    headers: { Authorization: 'Bearer token' }
  })
  assert.throws(
    () => resolve(server, { [field.key]: 'secret\r\nInjected: yes' }),
    (error: Error) => {
      assert.ok(!error.message.includes('secret'))
      return true
    }
  )
  assert.throws(
    () =>
      resolve(hosted({ headers: [{ name: 'X-Fixed', value: 'fixed' }] }), {
        'header.0': 'override'
      }),
    /invalid/
  )
})

test('header templates and env templates expand once, optional templates omit atomically', () => {
  const server = local({
    environmentVariables: [
      {
        name: 'AUTH',
        value: 'Bearer {token}',
        isRequired: true,
        isSecret: true,
        variables: { token: {} }
      },
      { name: 'PAIR', value: '{a}:{b}', variables: { a: {}, b: {} } }
    ]
  })
  assert.ok(
    catalogMcpOptions(server)[0]
      .fields.filter((f) => f.key.startsWith('env.0'))
      .every((f) => f.secret)
  )
  assert.throws(() => resolve(server), /token/)
  const cfg = resolve(server, { 'env.0.token': '$&; echo hello' })
  assert.equal(cfg.type, 'local')
  if (cfg.type === 'local') assert.deepEqual(cfg.environment, { AUTH: 'Bearer $&; echo hello' })
  assert.throws(() => resolve(server, { 'env.0.token': 't', 'env.1.a': 'one' }), /Complete all/)
})

test('npm is pinned to package version, not server version; npx is fixed', () => {
  assert.deepEqual(
    resolve(local({ runtimeArguments: [{ type: 'positional', value: '-y' }] })),
    resolve(local())
  )
  assert.deepEqual(resolve(local()), {
    type: 'local',
    command: ['npx', '-y', '--registry=https://registry.npmjs.org', '@example/weather@1.2.3']
  })
  assert.equal(catalogMcpOptions(local({ version: undefined })).length, 0)
  assert.equal(catalogMcpOptions(local({ runtimeHint: 'node' })).length, 0)
  assert.equal(catalogMcpOptions(local({ runtimeHint: 'cmd /c evil' })).length, 0)
  assert.equal(catalogMcpOptions(local({ version: '1.2.3-beta.1+build.7' })).length, 1)
})

test('npm identifiers, version selectors and runtime argument injection are rejected', () => {
  for (const identifier of [
    '--help',
    '-p',
    'pkg --yes',
    'pkg;evil',
    'pkg@latest',
    'npm:pkg',
    'file:./evil',
    '../evil',
    'https://evil.test/pkg.tgz',
    'user/repo',
    '@scope/../pkg',
    '@scope/--eval',
    'pkg$(evil)',
    'pkg\n--eval',
    'pkg{var}'
  ]) {
    assert.equal(catalogMcpOptions(local({ identifier })).length, 0, identifier)
  }
  for (const version of [
    'latest',
    'next',
    '*',
    '1',
    '1.2',
    '^1.2.3',
    '~1.2.3',
    '>=1.2.3',
    '1.x',
    '1.2.3 --help',
    'file:x',
    'https://evil.test',
    '1.2.3;evil',
    '01.2.3'
  ]) {
    assert.equal(catalogMcpOptions(local({ version })).length, 0, version)
  }
  assert.equal(
    catalogMcpOptions(
      local({ runtimeArguments: [{ type: 'named', name: '--eval', value: 'evil' }] })
    ).length,
    0
  )
  assert.equal(
    catalogMcpOptions(local({ runtimeArguments: [{ type: 'positional', valueHint: 'option' }] }))
      .length,
    0
  )
})

test('registryBaseUrl is respected only for official registries; custom sources are not silently changed', () => {
  for (const registryBaseUrl of [
    'https://evil.test',
    'http://registry.npmjs.org',
    'https://registry.npmjs.org.evil.test',
    'https://registry.npmjs.org/?evil=1',
    'https://user:pass@registry.npmjs.org',
    'https://registry.npmjs.org/path'
  ]) {
    assert.equal(catalogMcpOptions(local({ registryBaseUrl })).length, 0)
  }
  assert.equal(
    catalogMcpOptions(local({ registryBaseUrl: 'https://registry.npmjs.org/' })).length,
    1
  )
  assert.equal(
    catalogMcpOptions(local({ registryType: 'pypi', registryBaseUrl: 'https://evil.test' })).length,
    0
  )
})

test('PyPI uses a pinned --from distribution AND explicit same-name executable', () => {
  const server = local({
    registryType: 'pypi',
    identifier: 'weather-mcp',
    version: '0.5.0',
    runtimeHint: 'uvx'
  })
  assert.deepEqual(resolve(server), {
    type: 'local',
    command: [
      'uvx',
      '--index-url',
      'https://pypi.org/simple',
      '--from',
      'weather-mcp==0.5.0',
      'weather-mcp'
    ]
  })
  for (const identifier of [
    'Weather_MCP',
    'weather.mcp',
    '--from',
    'weather[extra]',
    'weather==1.0',
    'git+https://evil.test'
  ]) {
    assert.equal(catalogMcpOptions(local({ registryType: 'pypi', identifier })).length, 0)
  }
  for (const version of ['>=1.0', '*', 'latest', '1.0;evil']) {
    assert.equal(
      catalogMcpOptions(local({ registryType: 'pypi', identifier: 'weather-mcp', version })).length,
      0
    )
  }
})

test('all supported fields preserve fixed/default/named/positional argv semantics without a shell', () => {
  const server = local({
    packageArguments: [
      { type: 'positional', value: 'mcp' },
      { type: 'positional', value: 'start' },
      { type: 'named', name: '--mode', default: 'stdio', choices: ['stdio', 'sse'] },
      { type: 'named', name: '--api-key', isRequired: true, isSecret: true },
      { type: 'positional', valueHint: 'path', isRequired: true }
    ],
    environmentVariables: [{ name: 'LOG_LEVEL', default: 'info', choices: ['info', 'debug'] }]
  })
  const config = resolve(server, {
    'arg.3': 'secret with spaces; $(evil)',
    'arg.4': 'C:\\Users\\a b'
  })
  assert.equal(config.type, 'local')
  if (config.type === 'local') {
    assert.deepEqual(config.command.slice(4), [
      'mcp',
      'start',
      '--mode',
      'stdio',
      '--api-key',
      'secret with spaces; $(evil)',
      'C:\\Users\\a b'
    ])
    assert.deepEqual(config.environment, { LOG_LEVEL: 'info' })
  }
  assert.throws(
    () => resolve(server, { 'arg.3': 'secret', 'arg.4': 'path', 'arg.2': 'arbitrary' }),
    /allowed values/
  )
})

test('optional arguments omit flags together and only a trailing positional can be omitted', () => {
  const server = local({
    packageArguments: [
      { type: 'named', name: '--path' },
      { type: 'positional', valueHint: 'file' }
    ]
  })
  const config = resolve(server)
  assert.equal(config.type, 'local')
  if (config.type === 'local') assert.equal(config.command.length, 4)
  const empty = resolve(server, { 'arg.0': '', 'arg.1': '' })
  assert.deepEqual(empty, config)
  assert.equal(
    catalogMcpOptions(
      local({
        packageArguments: [
          { type: 'positional', valueHint: 'optional' },
          { type: 'positional', value: 'next' }
        ]
      })
    ).length,
    0
  )
  const template = local({
    packageArguments: [
      {
        type: 'named',
        name: '--auth',
        value: '{user}:{token}',
        variables: { user: {}, token: { isSecret: true } }
      }
    ]
  })
  assert.deepEqual(resolve(template), resolve(local()))
  assert.throws(() => resolve(template, { 'arg.0.user': 'a' }), /Complete all/)
  assert.equal(
    catalogMcpOptions(
      local({ packageArguments: [{ type: 'named', name: '--eval=bad', value: 'x' }] })
    ).length,
    0
  )
})

test('repeated inputs, fileSha256, unlaunchable transports and unmodeled config omit the whole option', () => {
  for (const property of ['packageArguments', 'environmentVariables'] as const) {
    const input: RegistryInput =
      property === 'packageArguments'
        ? { type: 'positional', value: 'x', isRepeated: true }
        : { name: 'TOKEN', isRequired: true, isRepeated: true }
    assert.equal(catalogMcpOptions(local({ [property]: [input] })).length, 0)
  }
  assert.equal(catalogMcpOptions(local({ fileSha256: 'a'.repeat(64) })).length, 0)
  assert.equal(
    catalogMcpOptions(
      local({ transport: { type: 'streamable-http', url: 'http://localhost:8000/mcp' } })
    ).length,
    0
  )
  assert.equal(
    catalogMcpOptions(local({ transport: { type: 'stdio', url: 'https://unused.test' } })).length,
    0
  )
  assert.equal(catalogMcpOptions(local({ registryType: 'oci' })).length, 0)
  assert.equal(
    catalogMcpOptions(hosted({ headers: [{ name: 'Host', value: 'evil.test' }] })).length,
    0
  )
  assert.equal(
    catalogMcpOptions(
      local({ environmentVariables: [{ name: 'NPM_CONFIG_REGISTRY', value: 'https://evil.test' }] })
    ).length,
    0
  )
  assert.equal(
    catalogMcpOptions(hosted({ headers: [{ name: 'X-Key', value: '{unknown}' }] })).length,
    0
  )
  assert.equal(
    catalogMcpOptions(
      local({
        packageArguments: [
          {
            type: 'named',
            name: '--token',
            value: '{x}',
            variables: { x: { variables: { y: {} } } }
          }
        ]
      })
    ).length,
    0
  )
})

test('unsupported alternatives do not renumber other manifest option IDs', () => {
  const server = { ...base, remotes: [{ ...remote, type: 'websocket' }, remote], packages: [npm] }
  assert.deepEqual(
    catalogMcpOptions(server).map((o) => o.id),
    ['remote:1', 'package:0']
  )
  assert.throws(() => resolveCatalogMcpConfig(server, 'remote:0', {}), /unavailable/)
  assert.throws(() => resolveCatalogMcpConfig(server, 'unknown', {}), /unavailable/)
})

test('strict count/string bounds, duplicate keys and malformed inputs fail closed', () => {
  assert.equal(
    catalogMcpOptions({ ...base, remotes: Array.from({ length: 33 }, () => remote) }).length,
    0
  )
  assert.equal(
    catalogMcpOptions(
      hosted({ headers: Array.from({ length: 33 }, (_, i) => ({ name: `X-${i}` })) })
    ).length,
    0
  )
  assert.equal(
    catalogMcpOptions(hosted({ headers: [{ name: 'X-Key' }, { name: 'x-key' }] })).length,
    0
  )
  assert.equal(
    catalogMcpOptions(local({ environmentVariables: [{ name: 'A', default: 'x'.repeat(4097) }] }))
      .length,
    0
  )
  assert.equal(
    catalogMcpOptions(local({ packageArguments: [{ type: 'named', name: '--mode', choices: [] }] }))
      .length,
    0
  )
  assert.equal(
    catalogMcpOptions({ ...base, description: 'x'.repeat(262145), remotes: [remote] }).length,
    0
  )
  assert.equal(
    catalogMcpOptions(hosted({ headers: [{ name: 'X-Mode', default: 'bad', choices: ['good'] }] }))
      .length,
    0
  )
  for (const raw of [null, [], {}, { ...base, packages: 'bad' }, { ...base, remotes: [null] }]) {
    assert.deepEqual(catalogMcpOptions(raw as RegistryMcpServer), [])
  }
  const server = hosted({ headers: [{ name: 'X-Key' }] })
  for (const values of [
    null,
    [],
    { unknown: 'value' },
    { 'header.0': 1 },
    { 'header.0': 'x'.repeat(4097) },
    { 'header.0': '{unfinished}' },
    { 'header.0': '\uD800' },
    Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`field-${i}`, 'x']))
  ]) {
    assert.throws(
      () => resolveCatalogMcpConfig(server, 'remote:0', values as Record<string, string>),
      /invalid/
    )
  }
})

test('options and resolution are pure and do not mutate a frozen manifest or caller values', () => {
  const server = hosted({ headers: [{ name: 'X-Key', default: 'default' }] })
  Object.freeze(server.remotes![0].headers![0])
  Object.freeze(server.remotes![0].headers)
  Object.freeze(server.remotes![0])
  Object.freeze(server.remotes)
  Object.freeze(server)
  const values = Object.freeze({ 'header.0': 'override' })
  const a = catalogMcpOptions(server)
  assert.deepEqual(a, catalogMcpOptions(server))
  assert.deepEqual(resolve(server, values), resolve(server, values))
  assert.equal(server.remotes![0].headers![0].default, 'default')
})

console.log(`\n${passed} catalog MCP smoke tests passed.`)
