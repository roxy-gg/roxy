/**
 * Pure MCP (Model Context Protocol) primitives — no Node/SDK imports, so this is
 * fully testable in smoke:shared. The transport + client lifecycle (built on the
 * official `@modelcontextprotocol/client`) lives in `src/main/services/mcp.ts`.
 *
 * What lives here:
 *  - Server config types + a defensive normalizer (parses untrusted JSON from the
 *    DB or a workspace `.roxy/mcp.json`).
 *  - Tool-name namespacing so every server's tools get a unique, provider-legal
 *    function name (`mcp__<server>__<tool>`), plus an `isMcpToolName` router check.
 *  - MCP tool-def → roxy tool schema conversion (JSON-Schema passthrough).
 *  - MCP tool-result (content blocks) → roxy `ToolResult` rendering.
 *  - The system-prompt blurb describing connected servers + their tools.
 */

import type { ToolResult } from './types'
import { parseCallResult, toToolResult } from './mcp-content'

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

/** A local MCP server spawned as a child process, spoken to over stdio. */
export interface McpLocalConfig {
  type: 'local'
  /** argv, e.g. ["npx","-y","@modelcontextprotocol/server-filesystem","/path"]. */
  command: string[]
  /** Working directory; relative paths resolve from the workspace at connect time. */
  cwd?: string
  /** Extra environment variables for the child process. */
  environment?: Record<string, string>
  /** ms budget for startup + each request (split by the service). */
  timeout?: number
}

/** A remote MCP server reached over HTTP (Streamable HTTP, with SSE fallback). */
export interface McpRemoteConfig {
  type: 'remote'
  url: string
  headers?: Record<string, string>
  timeout?: number
}

export type McpServerConfig = McpLocalConfig | McpRemoteConfig

/**
 * Which protocol era a connection negotiated.
 *
 * `legacy` is the `initialize` handshake (revisions `2024-10-07` through
 * `2025-11-25`); `modern` is `2026-07-28`+, which replaced the handshake with a
 * `server/discover` advertisement and a per-request `_meta` envelope. Mirrors
 * the SDK's own `ProtocolEra`, re-declared here so this isomorphic module stays
 * free of SDK imports.
 */
export type McpProtocolEra = 'legacy' | 'modern'

/**
 * A tool exactly as the server described it.
 *
 * Deliberately loose: Roxy stores the definition verbatim and reads specific
 * keys (`_meta`, `outputSchema`) where it understands them, rather than
 * modelling a spec that is still gaining fields. Narrow at the point of use.
 */
export interface McpToolDefinition {
  name: string
  title?: string
  description?: string
  inputSchema?: unknown
  outputSchema?: unknown
  annotations?: Record<string, unknown>
  icons?: unknown
  /** Extension data - where MCP Apps puts `io.modelcontextprotocol/ui`. */
  _meta?: Record<string, unknown>
}

/** A configured server as persisted (DB row / workspace-file entry). */
export interface McpServerRecord {
  id: string
  config: McpServerConfig
  enabled: boolean
  /**
   * Who put this row in the database.
   *
   * Persisted because it is a SECURITY fact, not UI trivia: a row the user typed
   * in Settings is self-consenting, while one the `mcp` tool added came from the
   * model (which reads web pages, issues and READMEs) and must clear the consent
   * gate before it can run. Without this column an agent-added command would be
   * indistinguishable from a user-added one the moment it was written, laundering
   * itself into "the user configured this".
   *
   * Absent on rows written before this existed, and on workspace-file entries
   * (whose provenance comes from the file they were read out of, not the DB).
   */
  origin?: 'user' | 'agent'
}

// ---------------------------------------------------------------------------
// Config normalization (defensive — inputs come from JSON we didn't write)
// ---------------------------------------------------------------------------

/**
 * Coerce an arbitrary JSON value into a valid `McpServerConfig`, or `null` when it
 * can't be made sense of. Transport is taken from `type` when present, else
 * inferred: a `url` → remote, a `command` → local.
 */
export function normalizeServerConfig(raw: unknown): McpServerConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>

  const type =
    o.type === 'remote' || o.type === 'local'
      ? o.type
      : typeof o.url === 'string'
        ? 'remote'
        : Array.isArray(o.command) || typeof o.command === 'string'
          ? 'local'
          : null

  if (type === 'remote') {
    const url = typeof o.url === 'string' ? o.url.trim() : ''
    if (!url) return null
    const cfg: McpRemoteConfig = { type: 'remote', url }
    const headers = normalizeStringRecord(o.headers)
    if (headers) cfg.headers = headers
    const timeout = normalizeTimeout(o.timeout)
    if (timeout) cfg.timeout = timeout
    return cfg
  }

  if (type === 'local') {
    const command = normalizeCommand(o.command, o.args)
    if (!command.length) return null
    const cfg: McpLocalConfig = { type: 'local', command }
    if (typeof o.cwd === 'string' && o.cwd.trim()) cfg.cwd = o.cwd.trim()
    const environment = normalizeStringRecord(o.environment ?? o.env)
    if (environment) cfg.environment = environment
    const timeout = normalizeTimeout(o.timeout)
    if (timeout) cfg.timeout = timeout
    return cfg
  }

  return null
}

/** Parse a `{ "name": <config> }` map (DB blob or workspace file) into records. */
export function normalizeServerRecords(raw: unknown): McpServerRecord[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  const out: McpServerRecord[] = []
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const name = id.trim()
    if (!name) continue
    const v = (value ?? {}) as Record<string, unknown>
    const config = normalizeServerConfig(v)
    if (!config) continue
    const enabled = v.disabled === true || v.enabled === false ? false : true
    out.push({ id: name, config, enabled })
  }
  return out
}

// ---------------------------------------------------------------------------
// Raw JSON editing (Settings' "edit raw config" escape hatch)
// ---------------------------------------------------------------------------

/** A single server parsed out of hand-written / pasted JSON. */
export interface ParsedMcpJson {
  /** Present when the JSON was a named map (`{ "mcpServers": { "<id>": … } }`). */
  id?: string
  config: McpServerConfig
  /** Present only when the JSON explicitly said `enabled` / `disabled`. */
  enabled?: boolean
}

export type ParseMcpJsonResult = { ok: true; value: ParsedMcpJson } | { ok: false; error: string }

/** The canonical, pretty-printed form of a config — what the raw editor shows. */
export function serializeServerConfig(config: McpServerConfig): string {
  return JSON.stringify(config, null, 2)
}

/**
 * Parse hand-edited/pasted MCP JSON into one server. Deliberately permissive
 * about the wrapper so a snippet copied from any server's README works:
 *
 *   { "type": "local", "command": ["npx", …] }        ← a bare config
 *   { "mcpServers": { "files": { "command": … } } }   ← Claude Desktop style
 *   { "servers": { "files": … } }                     ← VS Code style
 *   { "files": { "command": … } }                     ← a bare one-entry map
 *
 * Returns a *message*, never throws: this is the debug path, so the reason a
 * config was rejected matters more than the rejection.
 */
export function parseMcpJson(text: string): ParseMcpJsonResult {
  const trimmed = text.trim()
  if (!trimmed) return { ok: false, error: 'Enter some JSON.' }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Expected a JSON object describing one MCP server.' }
  }
  const root = parsed as Record<string, unknown>

  // 1. An explicit wrapper always wins — even when empty/broken, so the error
  //    names the real problem instead of "not a valid config".
  for (const key of ['mcpServers', 'servers'] as const) {
    const wrapped = root[key]
    if (wrapped && typeof wrapped === 'object' && !Array.isArray(wrapped)) {
      return fromNamedMap(wrapped as Record<string, unknown>, key)
    }
  }

  // 2. A bare config object.
  const direct = normalizeServerConfig(root)
  if (direct) return { ok: true, value: { config: direct, enabled: readEnabled(root) } }

  // 3. A bare `{ name: config }` map (README snippets often drop the wrapper).
  const keys = Object.keys(root)
  if (keys.length && keys.every((k) => isPlainObject(root[k]))) {
    return fromNamedMap(root, 'object')
  }

  return {
    ok: false,
    error:
      'Not a valid MCP server config — needs a "command" (local, argv array) or a "url" (remote).'
  }
}

/** Pull the single entry out of a `{ name: config }` map. */
function fromNamedMap(map: Record<string, unknown>, label: string): ParseMcpJsonResult {
  const entries = Object.entries(map).filter(([id]) => id.trim())
  if (!entries.length) return { ok: false, error: `"${label}" has no server entries.` }
  if (entries.length > 1) {
    return {
      ok: false,
      error: `Found ${entries.length} servers (${entries.map(([id]) => id).join(', ')}) — paste one at a time.`
    }
  }
  const [id, raw] = entries[0]
  const config = normalizeServerConfig(raw)
  if (!config) {
    return { ok: false, error: `"${id}" is not a valid config — needs a "command" or a "url".` }
  }
  return { ok: true, value: { id: id.trim(), config, enabled: readEnabled(raw) } }
}

/** `enabled` / `disabled` as written, or undefined when the JSON is silent. */
function readEnabled(raw: unknown): boolean | undefined {
  if (!isPlainObject(raw)) return undefined
  const o = raw as Record<string, unknown>
  if (o.disabled === true || o.enabled === false) return false
  if (o.disabled === false || o.enabled === true) return true
  return undefined
}

function isPlainObject(v: unknown): boolean {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function normalizeCommand(command: unknown, args: unknown): string[] {
  if (Array.isArray(command)) {
    return command.filter((x): x is string => typeof x === 'string' && x.length > 0)
  }
  if (typeof command === 'string' && command.trim()) {
    const argv = [command.trim()]
    if (Array.isArray(args)) for (const a of args) if (typeof a === 'string' && a) argv.push(a)
    return argv
  }
  return []
}

function normalizeStringRecord(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val
    else if (typeof val === 'number' || typeof val === 'boolean') out[k] = String(val)
  }
  return Object.keys(out).length ? out : undefined
}

function normalizeTimeout(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined
}

// ---------------------------------------------------------------------------
// Tool-name namespacing
// ---------------------------------------------------------------------------

/** Prefix that marks a tool as coming from an MCP server (used for dispatch routing). */
export const MCP_TOOL_PREFIX = 'mcp'
const SEP = '__'
/** OpenAI/Anthropic/Gemini all cap function names at 64 chars, `[a-zA-Z0-9_-]`. */
export const MAX_TOOL_NAME = 64

/** Replace any char a provider would reject in a function name with `_`. */
export function sanitizeNamePart(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_')
}

/**
 * Build a provider-legal, collision-resistant function name for a server's tool.
 * Overlong names are truncated with a short deterministic hash suffix so distinct
 * long names stay distinct.
 */
export function qualifyToolName(serverId: string, toolName: string): string {
  const base = `${MCP_TOOL_PREFIX}${SEP}${sanitizeNamePart(serverId)}${SEP}${sanitizeNamePart(toolName)}`
  if (base.length <= MAX_TOOL_NAME) return base
  const hash = shortHash(base)
  return `${base.slice(0, MAX_TOOL_NAME - hash.length - 1)}_${hash}`
}

/** Whether a tool name refers to an MCP tool (so `runTool` routes it to the pool). */
export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX + SEP)
}

/** djb2 → base36, ~6 chars. Pure and dependency-free (names only, not security). */
function shortHash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

// ---------------------------------------------------------------------------
// Schema conversion (MCP tool def → roxy function schema)
// ---------------------------------------------------------------------------

export interface RoxyToolSchema {
  type: 'function'
  function: { name: string; description?: string; parameters: Record<string, unknown> }
}

/**
 * Convert an MCP tool definition into the OpenAI-style function schema roxy sends
 * to every provider. `inputSchema` is already JSON Schema; we only guarantee it
 * declares an object so strict providers accept it.
 */
export function mcpToolToSchema(
  qualifiedName: string,
  description: string | undefined,
  inputSchema: unknown
): RoxyToolSchema {
  return {
    type: 'function',
    function: {
      name: qualifiedName,
      description: description?.trim() || `MCP tool "${qualifiedName}".`,
      parameters: sanitizeJsonSchema(inputSchema)
    }
  }
}

/** Ensure a JSON-Schema value is an object schema with a `properties` map. */
function sanitizeJsonSchema(schema: unknown): Record<string, unknown> {
  if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
    const o = { ...(schema as Record<string, unknown>) }
    o.type = 'object'
    if (!o.properties || typeof o.properties !== 'object' || Array.isArray(o.properties)) {
      o.properties = {}
    }
    return o
  }
  return { type: 'object', properties: {} }
}

// ---------------------------------------------------------------------------
// Result rendering (MCP CallTool content blocks → roxy ToolResult)
// ---------------------------------------------------------------------------

/**
 * Flatten an MCP `tools/call` result into a roxy `ToolResult`.
 *
 * A thin projection over the lossless model in `./mcp-content`: parse the raw
 * result into typed blocks (keeping resource URIs, `_meta`, every image, and
 * anything this version doesn't recognise), then lower THAT to a string for the
 * model. The parse is the source of truth; this is one of its consumers.
 *
 * Kept as a function because callers that only want the flat form shouldn't have
 * to know about the two-step. Callers that want the structure - MCP Apps needs
 * `_meta`, resource links need their URI - should call `parseCallResult`
 * directly and read the result, rather than re-deriving anything from this text.
 */
export function renderMcpContent(
  content: unknown,
  isError: boolean | undefined,
  structuredContent?: unknown
): ToolResult {
  return toToolResult(parseCallResult({ content, isError, structuredContent }))
}

// ---------------------------------------------------------------------------
// System-prompt description of connected servers
// ---------------------------------------------------------------------------

export interface McpServerSummary {
  id: string
  status: 'connected' | 'error' | 'disabled'
  /** Unqualified tool display names exposed by the server. */
  tools: string[]
  error?: string
  /**
   * Protocol era this server negotiated, once connected. Undefined for servers
   * that never connected (and, harmlessly, for any that predate the field).
   */
  era?: McpProtocolEra
}

/**
 * A short blurb listing connected MCP servers + their tools, injected into the
 * system prompt so the model knows the tools exist and how they're namespaced.
 * Returns `undefined` when nothing is connected (so no empty section is added).
 */
export function describeMcpForPrompt(servers: McpServerSummary[]): string | undefined {
  const connected = servers.filter((s) => s.status === 'connected')
  if (!connected.length) return undefined
  const lines = [
    'External MCP (Model Context Protocol) servers are connected; their tools are available to you alongside the built-in tools. Each is namespaced as `mcp__<server>__<tool>`:'
  ]
  for (const s of connected) {
    lines.push(`- ${s.id}: ${s.tools.length ? s.tools.join(', ') : '(no tools exposed)'}`)
  }
  return lines.join('\n')
}
