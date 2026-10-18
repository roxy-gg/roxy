/** Pure, deliberately conservative compiler for untrusted MCP Registry manifests.
 * No commands are executed here. The service passes command arrays to the SDK's
 * stdio transport (not a shell); remote configs use HTTP with SSE fallback.
 */
import type { CatalogField, CatalogMcpOption, RegistryMcpServer } from './catalog'
import type { McpServerConfig } from './mcp'

const MAX_ITEMS = 32
const MAX_FIELDS = 64
const MAX_TEXT = 4096
const MAX_TOTAL = 65536
const REDACTED = '[REDACTED]'
type Values = Record<string, string>
type Reader = (values: Values, preview: boolean) => string | undefined
interface InputPlan {
  read: Reader
  optional: boolean
}
interface Plan {
  id: string
  label: string
  fields: CatalogField[]
  build: (values: Values, preview: boolean) => McpServerConfig
}

function fail(message = 'This catalog installation option is not supported.'): never {
  throw new Error(message)
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail()
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) fail()
  return value as Record<string, unknown>
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail()
}
function text(value: unknown, max = MAX_TEXT): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail()
  // Reject lone UTF-16 surrogates before URL encoding (or native argv encoding).
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)) fail()
  return value
}
function literal(value: unknown): string {
  const s = text(value)
  if (/[{}]/.test(s)) fail()
  return s
}
function list(value: unknown): unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_ITEMS) fail()
  return value
}
function own(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

/** Bound the entire manifest, including unused metadata and every alternative.
 * Iterative traversal avoids recursive JSON.stringify on attacker-controlled depth.
 */
function boundedManifest(value: unknown): void {
  const pending = [{ value, depth: 0 }]
  let nodes = 0
  let size = 0
  while (pending.length) {
    const item = pending.pop()!
    if (++nodes > 4096 || item.depth > 8) fail()
    if (typeof item.value === 'string') size += item.value.length
    else if (item.value && typeof item.value === 'object') {
      const entries = Object.entries(item.value)
      if (entries.length > 256) fail()
      for (const [key, child] of entries) {
        size += key.length
        pending.push({ value: child, depth: item.depth + 1 })
      }
    } else if (
      item.value !== undefined &&
      item.value !== null &&
      typeof item.value !== 'number' &&
      typeof item.value !== 'boolean'
    )
      fail()
    if (size > MAX_TOTAL * 4) fail()
  }
}

/** DB ids are strings, not filenames. Preserve the official name, slash included.
 * Tool names are separately sanitized by qualifyToolName in shared/mcp.ts.
 */
export function catalogMcpId(name: string): string {
  if (
    typeof name !== 'string' ||
    name.length > 200 ||
    !/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/.test(name)
  ) {
    fail('This catalog server has an invalid name.')
  }
  return name
}

const INPUT_KEYS = [
  'name',
  'valueHint',
  'type',
  'value',
  'default',
  'description',
  'placeholder',
  'isRequired',
  'isSecret',
  'isRepeated',
  'choices',
  'variables',
  'format'
]

class Inputs {
  fields: CatalogField[] = []
  private count = 0

  compile(
    raw: unknown,
    key: string,
    label: string,
    forceRequired = false,
    inheritedSecret = false,
    nested = false
  ): InputPlan {
    if (++this.count > MAX_FIELDS) fail()
    const input = object(raw)
    keys(input, INPUT_KEYS)
    for (const flag of ['isRequired', 'isSecret', 'isRepeated']) {
      if (input[flag] !== undefined && typeof input[flag] !== 'boolean') fail()
    }
    if (input.isRepeated === true) fail()
    for (const prop of ['name', 'valueHint', 'type', 'description', 'placeholder']) {
      if (input[prop] !== undefined) text(input[prop], 1024)
    }
    if (
      input.format !== undefined &&
      !['string', 'filepath', 'number', 'boolean'].includes(String(input.format))
    )
      fail()
    if (
      nested &&
      ['variables', 'type', 'name', 'valueHint', 'isRepeated'].some((p) => own(input, p))
    )
      fail()
    const required = forceRequired || input.isRequired === true
    const secret = inheritedSecret || input.isSecret === true
    const choices =
      input.choices === undefined ? undefined : list(input.choices).map((v) => literal(v))
    if (choices && (!choices.length || new Set(choices).size !== choices.length)) fail()
    const validate = (v: string): string => {
      literal(v)
      if (choices && !choices.includes(v)) fail(`Choose one of the allowed values for ${label}.`)
      if (input.format === 'boolean' && !['true', 'false'].includes(v))
        fail(`Enter true or false for ${label}.`)
      if (input.format === 'number' && !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(v))
        fail(`Enter a number for ${label}.`)
      return v
    }
    if (input.value !== undefined && input.default !== undefined) fail()
    const fallback = input.default === undefined ? undefined : validate(literal(input.default))
    const fixed = input.value === undefined ? undefined : text(input.value)
    if (fixed !== undefined && !fixed.length) fail() // Empty fixed argv/flags are ambiguous.
    if (fixed === undefined && input.variables !== undefined) fail()

    if (fixed !== undefined && /[{}]/.test(fixed)) {
      if (nested || choices || input.format === 'number' || input.format === 'boolean') fail()
      const variables = object(input.variables)
      const names = Object.keys(variables)
      if (
        !names.length ||
        names.length > MAX_ITEMS ||
        names.some((n) => !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(n))
      )
        fail()
      const refs = [...fixed.matchAll(/\{([A-Za-z_][A-Za-z0-9_-]{0,63})\}/g)].map((m) => m[1])
      if (
        /[{}]/.test(fixed.replace(/\{([A-Za-z_][A-Za-z0-9_-]{0,63})\}/g, '')) ||
        refs.some((n) => !own(variables, n)) ||
        names.some((n) => !refs.includes(n))
      )
        fail()
      const children = names.map((n) => {
        // Variables in a template must all resolve together. Under an optional
        // parent they are conditionally required, not globally required fields.
        const original = object(variables[n])
        if (original.isRequired !== undefined && typeof original.isRequired !== 'boolean') fail()
        const child = { ...original, isRequired: required }
        return [n, this.compile(child, `${key}.${n}`, n, false, secret, true)] as const
      })
      return {
        optional: !required,
        read: (values, preview) => {
          const resolved = new Map(children.map(([n, child]) => [n, child.read(values, preview)]))
          if (!preview && !required && [...resolved.values()].every((v) => v === undefined))
            return undefined
          if ([...resolved.values()].some((v) => v === undefined))
            fail(`Complete all values for ${label}.`)
          if (preview && secret) return REDACTED
          return fixed.replace(
            /\{([A-Za-z_][A-Za-z0-9_-]{0,63})\}/g,
            (_, n: string) => resolved.get(n)!
          )
        }
      }
    }
    if (input.variables !== undefined) fail() // Never silently discard unused variables.
    if (fixed !== undefined) {
      validate(fixed)
      return { optional: false, read: (_, preview) => (preview && secret ? REDACTED : fixed) }
    }
    const field: CatalogField = { key, label, required, secret }
    // A secret default/choice must never cross the bridge into review metadata.
    if (!secret) {
      if (fallback !== undefined) field.default = fallback
      if (choices) field.choices = [...choices]
    }
    if (typeof input.description === 'string') field.description = input.description
    if (typeof input.placeholder === 'string') field.placeholder = input.placeholder
    this.fields.push(field)
    return {
      optional: !required,
      read: (values, preview) => {
        if (preview) return secret ? REDACTED : fallback || `<${label}>`
        const value = own(values, key) ? values[key] : fallback
        if (value === undefined || !value.trim()) {
          if (required) fail(`Enter a value for ${label}.`)
          return undefined
        }
        return validate(value)
      }
    }
  }
}

function recordPlan(raw: unknown, inputs: Inputs, kind: 'header' | 'env'): [string, InputPlan][] {
  const seen = new Set<string>()
  return list(raw).map((item, i) => {
    const input = object(item)
    const name = text(input.name, 128)
    if (input.type !== undefined || input.valueHint !== undefined) fail()
    if (kind === 'header') {
      if (
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
        /^(host|connection|content-length|transfer-encoding|upgrade|proxy-.*|sec-.*)$/i.test(name)
      )
        fail()
    } else {
      if (
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
        /^(PATH|PATHEXT|COMSPEC|SHELL|ENV|BASH_ENV|HOME|USERPROFILE|NODE_.*|NPM_.*|UV_.*|PYTHON.*|LD_.*|DYLD_.*)$/i.test(
          name
        )
      )
        fail()
    }
    const identity = name.toLowerCase()
    if (seen.has(identity)) fail()
    seen.add(identity)
    return [name, inputs.compile(item, `${kind}.${i}`, name)]
  })
}

function resolveRecord(
  entries: [string, InputPlan][],
  values: Values,
  preview: boolean
): Values | undefined {
  const result = Object.fromEntries(
    entries.flatMap(([name, input]) => {
      const value = input.read(values, preview)
      return value === undefined ? [] : [[name, value]]
    })
  )
  return Object.keys(result).length ? result : undefined
}

function validUrl(raw: string): URL {
  text(raw)
  if (!/^https?:\/\//.test(raw) || /[\s\\{}]/.test(raw) || /%(?:00|0a|0d|7b|7d)/i.test(raw)) fail()
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return fail()
  }
  if (!url.hostname || url.username || url.password || url.hash) fail()
  // HTTP is supported only on literal loopback hosts. HTTPS elsewhere.
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    fail()
  return url
}

function remotePlan(raw: unknown, id: string): Plan {
  const remote = object(raw)
  keys(remote, ['type', 'url', 'headers', 'variables'])
  if (remote.type !== 'streamable-http' && remote.type !== 'sse') fail()
  const template = text(remote.url)
  const authority = /^https?:\/\/([^/?#]+)/.exec(template)?.[1]
  // Host/scheme/port templating changes trust boundaries; only path/query
  // components are supported. Also forbid URL credentials, even empty ones.
  if (!authority || /[{}@%\\]/.test(authority)) fail()
  const skeleton = template.replace(/\{[A-Za-z_][A-Za-z0-9_-]{0,63}\}/g, 'catalog-value')
  const origin = validUrl(skeleton).origin
  const inputs = new Inputs()
  const variables = remote.variables === undefined ? {} : object(remote.variables)
  const names = Object.keys(variables)
  const refs = [...template.matchAll(/\{([A-Za-z_][A-Za-z0-9_-]{0,63})\}/g)].map((m) => m[1])
  if (
    names.length > MAX_ITEMS ||
    names.some((n) => !refs.includes(n)) ||
    refs.some((n) => !own(variables, n))
  )
    fail()
  const urlVariables = names.map((name) => {
    // URL components are mandatory even when the manifest forgot isRequired.
    // Optional component removal would require a URL grammar the registry lacks.
    const variable = inputs.compile(variables[name], `url.${name}`, name, true, false, true)
    return [name, variable] as const
  })
  const headers = recordPlan(remote.headers, inputs, 'header')
  return {
    id,
    label: remote.type === 'sse' ? 'Remote / SSE' : 'Remote / Streamable HTTP',
    fields: inputs.fields,
    build: (values, preview) => {
      let url = template
      for (const [name, variable] of urlVariables) {
        const value = variable.read(values, preview)!
        if (value === '.' || value === '..') fail('URL variables cannot be dot path segments.')
        // Callback replacement avoids interpreting user-supplied $&/$` patterns.
        url = url.replaceAll(`{${name}}`, () => encodeURIComponent(value))
      }
      const checked = validUrl(url)
      if (checked.origin !== origin) fail('The server URL must keep its original host.')
      const config: McpServerConfig = { type: 'remote', url }
      const resolved = resolveRecord(headers, values, preview)
      if (resolved) config.headers = resolved
      return config
    }
  }
}

function packagePlan(raw: unknown, id: string): Plan {
  const pkg = object(raw)
  keys(pkg, [
    'registryType',
    'identifier',
    'version',
    'registryBaseUrl',
    'runtimeHint',
    'fileSha256',
    'transport',
    'environmentVariables',
    'runtimeArguments',
    'packageArguments'
  ])
  if (pkg.fileSha256 !== undefined) fail()
  const runtimeArgs = list(pkg.runtimeArguments)
  // Many official npm manifests explicitly repeat npx's noninteractive flag.
  // It is already supplied by our fixed runner; no other runtime flags are safe.
  if (runtimeArgs.length) {
    if (pkg.registryType !== 'npm' || runtimeArgs.length !== 1) fail()
    const arg = object(runtimeArgs[0])
    keys(arg, ['type', 'value'])
    if (arg.type !== 'positional' || !['-y', '--yes'].includes(String(arg.value))) fail()
  }
  const transport = object(pkg.transport)
  keys(transport, ['type'])
  if (transport.type !== 'stdio') fail() // The runner cannot launch a process AND connect by URL.
  const identifier = text(pkg.identifier, 214)
  const version = text(pkg.version, 128) // Never fall back to the *server* version or a moving tag.
  let command: string[]
  if (pkg.registryType === 'npm') {
    if (
      !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(identifier) ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(
        version
      )
    )
      fail()
    if (pkg.runtimeHint !== undefined && pkg.runtimeHint !== 'npx') fail()
    if (
      pkg.registryBaseUrl !== undefined &&
      !['https://registry.npmjs.org', 'https://registry.npmjs.org/'].includes(
        text(pkg.registryBaseUrl)
      )
    )
      fail()
    command = ['npx', '-y', '--registry=https://registry.npmjs.org', `${identifier}@${version}`]
  } else if (pkg.registryType === 'pypi') {
    // Only same-name console scripts: do not guess normalized dots/underscores,
    // accept executable overrides, or reinterpret runtimeHint as an entry point.
    if (
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(identifier) ||
      !/^\d+(?:\.\d+){1,3}(?:(?:a|b|rc)\d+|\.post\d+|\.dev\d+)?$/.test(version)
    )
      fail()
    if (pkg.runtimeHint !== undefined && pkg.runtimeHint !== 'uvx') fail()
    if (
      pkg.registryBaseUrl !== undefined &&
      ![
        'https://pypi.org',
        'https://pypi.org/',
        'https://pypi.org/simple',
        'https://pypi.org/simple/'
      ].includes(text(pkg.registryBaseUrl))
    )
      fail()
    command = [
      'uvx',
      '--index-url',
      'https://pypi.org/simple',
      '--from',
      `${identifier}==${version}`,
      identifier
    ]
  } else return fail()
  const inputs = new Inputs()
  const environment = recordPlan(pkg.environmentVariables, inputs, 'env')
  const args = list(pkg.packageArguments).map((rawArg, i) => {
    const arg = object(rawArg)
    if (arg.type !== 'named' && arg.type !== 'positional') fail()
    let name: string | undefined
    if (arg.type === 'named') {
      name = text(arg.name, 66)
      if (!/^--?[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) fail()
    } else if (arg.name !== undefined) {
      fail() // A positional name is not an executable override.
    }
    const label =
      name ?? (arg.valueHint === undefined ? `Argument ${i + 1}` : text(arg.valueHint, 128))
    return { name, input: inputs.compile(arg, `arg.${i}`, label) }
  })
  // Omitting a positional before another positional changes argument meaning.
  if (
    args.some((arg, i) => !arg.name && arg.input.optional && args.slice(i + 1).some((a) => !a.name))
  )
    fail()
  return {
    id,
    label: `${pkg.registryType === 'npm' ? 'npm / npx' : 'PyPI / uvx (same-name command)'} / ${identifier}@${version}`,
    fields: inputs.fields,
    build: (values, preview) => {
      const argv = [...command]
      for (const arg of args) {
        const value = arg.input.read(values, preview)
        if (value === undefined) continue // Drop the flag AND its missing optional value.
        if (arg.name) argv.push(arg.name)
        argv.push(value) // Exactly one argv item, even with spaces/metacharacters.
      }
      const config: McpServerConfig = { type: 'local', command: argv }
      const resolved = resolveRecord(environment, values, preview)
      if (resolved) config.environment = resolved
      return config
    }
  }
}

function plans(server: RegistryMcpServer): Plan[] {
  try {
    boundedManifest(server)
    const source = object(server)
    catalogMcpId(source.name as string)
    const remotes = list(source.remotes)
    const packages = list(source.packages)
    return [
      ...remotes.map((raw, i) => () => remotePlan(raw, `remote:${i}`)),
      ...packages.map((raw, i) => () => packagePlan(raw, `package:${i}`))
    ].flatMap((compile) => {
      try {
        const plan = compile()
        // Reject malformed fixed/default data before showing an install option.
        if (JSON.stringify(plan.build({}, true)).length > MAX_TOTAL) return []
        return [plan]
      } catch {
        return []
      }
    })
  } catch {
    return []
  }
}

/** Unsupported alternatives are omitted, not partially or unsafely interpreted.
 * IDs are manifest-array coordinates; main must freeze the reviewed manifest.
 */
export function catalogMcpOptions(server: RegistryMcpServer): CatalogMcpOption[] {
  return plans(server).map((plan) => ({
    id: plan.id,
    label: plan.label,
    fields: plan.fields,
    preview: JSON.stringify(plan.build({}, true), null, 2)
  }))
}

/** Reconstruct from the manifest, never from a renderer-supplied preview/config. */
export function resolveCatalogMcpConfig(
  server: RegistryMcpServer,
  optionId: string,
  values: Record<string, string>
): McpServerConfig {
  const plan = plans(server).find((p) => p.id === optionId)
  if (!plan) fail('This installation option is unavailable. Reopen the server setup and try again.')
  let submitted: Record<string, unknown>
  try {
    submitted = object(values)
    if (Object.keys(submitted).length > MAX_FIELDS) fail()
    const allowed = new Set(plan.fields.map((f) => f.key))
    for (const [key, value] of Object.entries(submitted)) {
      if (!allowed.has(key)) fail()
      literal(value)
    }
  } catch {
    return fail('The setup values are invalid. Check the fields and try again.')
  }
  try {
    const config = plan.build(values, false)
    if (JSON.stringify(config).length > MAX_TOTAL) fail()
    return config
  } catch (error) {
    // None of the validation messages includes a submitted/fixed secret value.
    if (
      error instanceof Error &&
      error.message !== 'This catalog installation option is not supported.'
    )
      throw error
    return fail('The setup values are invalid. Check the fields and try again.')
  }
}
