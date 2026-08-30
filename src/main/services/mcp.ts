/**
 * MCP (Model Context Protocol) client service - connects external tool servers
 * and exposes their tools to the agent loop. Built on the official v2 SDK
 * (`@modelcontextprotocol/client`), which owns the transports and the protocol
 * handshake for us.
 *
 * ## Two protocol eras, one client
 *
 * MCP split into two behavior families. The `legacy` era (`2024-10-07` through
 * `2025-11-25`) opens with an `initialize` handshake; the `modern` era
 * (`2026-07-28`+) has no handshake at all - it advertises via `server/discover`
 * and carries a `_meta` envelope on every request.
 *
 * Roxy connects with `versionNegotiation: { mode: 'auto' }`, so each server is
 * probed once and lands on whichever era it actually speaks. That is what makes
 * this a *client* rather than a client for one vintage of the spec: a 2026
 * server gets the modern wire, and a server pinned to 2025 keeps working
 * untouched. `conn.era` records where each one landed, for the UI and for
 * anything that has to reason about era-specific capabilities later.
 *
 * The probe costs one round trip per connect. Roxy pools connections warmly, so
 * that is once per server per session - not per tool call. On stdio the SDK runs
 * the probe on a disposable sibling process (some servers exit on any
 * pre-`initialize` request), and a silent server is simply read as legacy.
 *
 * ## Design (mirrors the LSP service's warm-pool + graceful-degradation shape)
 *
 *  - A process-wide pool keyed by server id. Connections are lazy (established on
 *    first `ensureMcpConnected`) and warm (reused across turns).
 *  - Nothing here ever throws into the agent loop: a server that fails to spawn,
 *    times out, or returns garbage degrades to "no tools" / an error ToolResult -
 *    it never breaks a turn. A `ROXY_MCP=0` env var disables the whole subsystem.
 *  - The pure protocol-independent logic (naming, schema conversion, result
 *    rendering, prompt blurb) lives in `src/shared/mcp.ts` and is unit-tested in
 *    smoke:shared; this file is exercised end-to-end against a mock server in
 *    smoke:app.
 */
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio'
import {
  Client,
  StreamableHTTPClientTransport,
  SSEClientTransport,
  type Transport
} from '@modelcontextprotocol/client'
import type { OAuthClientProvider } from '@modelcontextprotocol/client'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { ToolResult } from '../../shared/types'
import {
  MAX_TOOL_NAME,
  MCP_TOOL_PREFIX,
  describeMcpForPrompt,
  isMcpToolName,
  mcpToolToSchema,
  normalizeServerRecords,
  qualifyToolName,
  type McpLocalConfig,
  type McpProtocolEra,
  type McpRemoteConfig,
  type McpServerRecord,
  type McpServerSummary,
  type McpToolDefinition,
  type RoxyToolSchema
} from '../../shared/mcp'
import * as repo from '../db/repo'
import { mcpAuthProvider, prepareAuthorization, awaitAuthorization, clearMcpAuth } from './mcp-auth'
import {
  parseCallResult,
  parseResourceContents,
  toToolResult,
  type McpCallResult,
  type McpResourceContents,
  type McpResourceInfo
} from '../../shared/mcp-content'
import { isAppOnlyTool } from '../../shared/mcp-apps'

/**
 * Identity Roxy presents to servers.
 *
 * Read from Electron rather than hardcoded: this used to be a hand-maintained
 * `0.0.13` that had drifted ~80 releases behind the app, which makes any
 * server-side telemetry or version-gating keyed on it actively misleading.
 *
 * Resolved lazily and defensively because this module is also imported by the
 * plain-Node smoke run, where `electron.app` is not available. A version string
 * is not worth an import-time crash.
 */
function clientInfo(): { name: string; version: string } {
  let version = '0.0.0'
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    version = (require('electron') as typeof import('electron')).app.getVersion()
  } catch {
    /* not running under Electron (smoke); the name is what identifies us */
  }
  return { name: 'roxy', version }
}
/** ms to establish + initialize a server before giving up (per-server override wins). */
const DEFAULT_STARTUP_TIMEOUT = 15_000
/** ms budget for a single `tools/call` (tool work can be genuinely slow). */
const DEFAULT_REQUEST_TIMEOUT = 120_000
/**
 * Budget for the `server/discover` probe that decides a connection's era.
 *
 * Deliberately short and separate from the startup timeout. On stdio a silent
 * server IS the legacy answer, so this is the delay every 2025-era server pays
 * before falling back to `initialize` - it must stay small enough that adding
 * era negotiation never feels like a regression on servers that already worked.
 */
const PROBE_TIMEOUT = 3_000

/**
 * Client options shared by every connection.
 *
 * `mode: 'auto'` is the whole point of the v2 migration: probe with
 * `server/discover`, fall back to the 2025 `initialize` handshake when the
 * server doesn't answer it. One client, both eras, no per-server configuration.
 *
 * The SDK's warning about `'auto'` (it can stall a spawn-per-invocation CLI for
 * the probe timeout) does not bite here: Roxy holds a warm pool, so the probe is
 * paid once per server per session, and `PROBE_TIMEOUT` bounds it either way.
 */
function clientOptions(serverId: string): ConstructorParameters<typeof Client>[1] {
  return {
    capabilities: {},
    versionNegotiation: { mode: 'auto', probe: { timeoutMs: PROBE_TIMEOUT } },
    // Cache results from servers that send no freshness hint of their own.
    // Servers that DO send one always win: the SDK honours `ttlMs`/`cacheScope`
    // per result, and this is only the floor for those that say nothing.
    defaultCacheTtlMs: DEFAULT_CACHE_TTL,
    // Let the SDK own the `subscriptions/listen` stream where the server
    // supports it. Hand-rolling this would mean re-implementing the filter
    // negotiation, the era split (2026 `listen` vs 2025 unsolicited
    // notifications), and the close/re-listen policy - all of which the SDK
    // already does, and all of which it also wires to cache eviction.
    //
    // A `list_changed` here means the warm pool is holding a stale tool list, so
    // the refresh has to write back into `toolIndex`, not just log.
    listChanged: {
      tools: {
        onChanged: (error, tools) => {
          if (error || !tools) return
          onToolsChanged(serverId, tools as McpToolDefinition[])
        }
      }
    }
  }
}

/**
 * TTL applied to cacheable results from servers that send no hint of their own.
 *
 * Caching is two halves: a 2026-era server marks a result with `ttlMs` and the
 * SDK's per-client cache honours it. A server that sends nothing gets `ttlMs: 0`
 * and is never cached - which is every 2025-era server, i.e. most of them today.
 *
 * A short opt-in default covers the case this actually matters for: `listTools`
 * is re-read on every turn to rebuild the model's tool list, and re-listing an
 * unchanged server each time is pure latency. Deliberately seconds, not minutes,
 * because a legacy server has no way to tell us it changed - and `listChanged`
 * eviction (below) only exists where the server supports it.
 */
const DEFAULT_CACHE_TTL = 10_000

/** Kill switch: set ROXY_MCP=0 to disable all MCP connections. */
function mcpDisabled(): boolean {
  return process.env.ROXY_MCP === '0'
}

// ---------------------------------------------------------------------------
// Pool state
// ---------------------------------------------------------------------------

interface McpToolInfo {
  /** The provider-legal, namespaced function name (`mcp__server__tool`). */
  qualifiedName: string
  /** The raw tool name the server knows it by. */
  toolName: string
  serverId: string
  schema: RoxyToolSchema
  /**
   * The server's own tool definition, verbatim - including `_meta`,
   * `outputSchema`, `title`, `icons` and annotations.
   *
   * Kept because the model-facing `schema` above is a lossy projection, and
   * everything the modern spec adds lives in the parts it drops. MCP Apps finds
   * its UI resource at `_meta['io.modelcontextprotocol/ui'].resourceUri`, and
   * app-only tools are marked in that same `_meta`. Re-listing a server to
   * recover fields we already received would be the wrong trade.
   */
  definition: McpToolDefinition
}

interface McpConnection {
  id: string
  client: Client | null
  status: 'connected' | 'error'
  error?: string
  tools: McpToolInfo[]
  /**
   * Which protocol era this connection actually landed on: `'modern'` for
   * 2026-07-28+ (negotiated via `server/discover`), `'legacy'` for the 2025
   * `initialize` handshake. Recorded rather than assumed, because era decides
   * which capabilities are even expressible on this connection.
   */
  era?: McpProtocolEra
  /**
   * This server's own request budget, resolved once at connect.
   *
   * Held on the connection because calls arrive by TOOL name, not by record:
   * `callMcpTool` has no config in hand, and without this every call fell back
   * to the global default - so a server configured with `timeout: 5000` still
   * hung a turn for two minutes.
   */
  requestTimeout: number
  /** Whether the server advertised `resources`, so we don't ask servers that can't. */
  hasResources: boolean
}

/** Warm pool: server id → connection (connected or errored/cached). */
/**
 * The full, unflattened result of the most recent call to each MCP tool.
 *
 * Pool state, declared here with the rest of it: `forgetServer` clears entries
 * on disconnect, so the two must stay visibly coupled.
 *
 * Bounded two ways: the parse caps every field (see `MCP_LIMITS`), and only the
 * latest result per tool is held - an agent turn can call one tool hundreds of
 * times, and keeping a history in a warm, long-lived pool would be a slow leak.
 * This is a handoff buffer for the consumer that needs structure right after a
 * call, not a transcript.
 */
const lastResults = new Map<string, McpCallResult>()
const connections = new Map<string, McpConnection>()
/** In-flight connects, so concurrent `ensureMcpConnected` calls don't double-spawn. */
const connecting = new Map<string, Promise<McpConnection>>()
/** qualifiedName → tool info, for O(1) dispatch routing. */
const toolIndex = new Map<string, McpToolInfo>()

// ---------------------------------------------------------------------------
// Transport construction
// ---------------------------------------------------------------------------

function makeStdioTransport(cfg: McpLocalConfig, workspaceCwd: string): Transport {
  const [command, ...args] = cfg.command
  const cwd = cfg.cwd
    ? path.resolve(workspaceCwd || process.cwd(), cfg.cwd)
    : workspaceCwd || undefined
  return new StdioClientTransport({
    command,
    args,
    cwd,
    // Merge the SDK's safe base env (includes PATH so `npx`/`uvx` resolve) with
    // the server's configured vars.
    env: { ...getDefaultEnvironment(), ...(cfg.environment ?? {}) },
    // Don't let a chatty server pollute our stderr; we surface failures via status.
    stderr: 'ignore'
  })
}

/**
 * Ordered transport attempts for a record (remote tries Streamable HTTP, then SSE).
 *
 * Remote transports carry an `authProvider` when the server has stored OAuth
 * credentials, or when the user has explicitly started a sign-in. It is NOT
 * attached unconditionally: passing one makes the SDK treat a 401 as "begin an
 * authorization flow", which would pop a browser window at any server that
 * happens to be down or misconfigured. Auth is something the user opts into.
 */
function transportFactories(
  rec: McpServerRecord,
  workspaceCwd: string,
  auth?: OAuthClientProvider
): Array<() => Transport> {
  if (rec.config.type === 'local') {
    const cfg = rec.config
    return [() => makeStdioTransport(cfg, workspaceCwd)]
  }
  const cfg = rec.config as McpRemoteConfig
  const url = new URL(cfg.url)
  const init = {
    ...(cfg.headers ? { requestInit: { headers: cfg.headers } } : {}),
    ...(auth ? { authProvider: auth } : {})
  }
  return [
    () => new StreamableHTTPClientTransport(url, init),
    () => new SSEClientTransport(url, init)
  ]
}

function startupTimeout(rec: McpServerRecord): number {
  return rec.config.timeout ?? DEFAULT_STARTUP_TIMEOUT
}
function requestTimeout(rec: McpServerRecord): number {
  return rec.config.timeout ?? DEFAULT_REQUEST_TIMEOUT
}

// ---------------------------------------------------------------------------
// Connect + tool discovery
// ---------------------------------------------------------------------------

/** Connect a single server and discover its tools. Never throws → errored connection. */
async function connectOne(
  rec: McpServerRecord,
  workspaceCwd: string,
  auth?: OAuthClientProvider
): Promise<McpConnection> {
  const attempts = transportFactories(rec, workspaceCwd, auth)
  let lastErr: unknown
  for (const make of attempts) {
    const client = new Client(clientInfo(), clientOptions(rec.id))
    try {
      const transport = make()
      await client.connect(transport, { timeout: startupTimeout(rec) })
      const tools = await discoverTools(client, rec)
      // No global side effects here: `getConnection` commits (indexes tools + wires
      // onclose) only if this connection isn't disposed/superseded while in flight,
      // so a mid-connect dispose can't leave orphaned toolIndex entries.
      return {
        id: rec.id,
        client,
        status: 'connected',
        tools,
        era: client.getProtocolEra(),
        requestTimeout: requestTimeout(rec),
        hasResources: !!client.getServerCapabilities()?.resources
      }
    } catch (e) {
      lastErr = e
      try {
        await client.close()
      } catch {
        /* ignore */
      }
    }
  }
  return {
    id: rec.id,
    client: null,
    status: 'error',
    error: errMsg(lastErr),
    tools: [],
    requestTimeout: requestTimeout(rec),
    hasResources: false
  }
}

/**
 * List a server's tools, namespaced + deduped.
 *
 * No manual cursor loop: the v2 SDK walks `nextCursor` itself and returns one
 * aggregated list (bounded by `listMaxPages`, default 64). Passing a cursor is
 * what asks for a single raw page - so the old hand-rolled `do/while` would now
 * fetch page one, then re-request page two *without* aggregation. Deleting it is
 * a behavior fix, not just tidying.
 *
 * The full tool definition is kept on each `McpToolInfo`. Roxy only feeds
 * name/description/inputSchema to the model today, but `_meta`, `outputSchema`,
 * `title`, `icons` and annotations are exactly what the rest of the modern spec
 * is built on - MCP Apps keys its UI resource off `_meta['io.modelcontextprotocol/ui']`,
 * and tool visibility hides app-only tools from the model. Discarding them at
 * discovery, as the v1 code did, is what made those features unimplementable
 * without re-listing every server.
 */
async function discoverTools(client: Client, rec: McpServerRecord): Promise<McpToolInfo[]> {
  const res = await client.listTools(undefined, { timeout: requestTimeout(rec) })
  return buildToolInfos(rec.id, (res.tools ?? []) as McpToolDefinition[])
}

/**
 * A server told us its tool list changed and the SDK re-fetched it.
 *
 * The pool is warm and the model's tool list is rebuilt from `toolIndex` each
 * turn, so a stale entry means the agent is offered a tool the server no longer
 * has - it would fail at call time with a confusing error. Rebuilding here is
 * what makes `listChanged` worth subscribing to at all.
 */
function onToolsChanged(serverId: string, tools: McpToolDefinition[]): void {
  const conn = connections.get(serverId)
  if (!conn || conn.status !== 'connected') return
  conn.tools = buildToolInfos(serverId, tools)
  indexTools(conn)
}

/** Namespace + dedupe a server's raw tool definitions into routable entries. */
function buildToolInfos(serverId: string, tools: McpToolDefinition[]): McpToolInfo[] {
  const infos: McpToolInfo[] = []
  const seen = new Set<string>()
  for (const t of tools) {
    if (!t || typeof t.name !== 'string' || !t.name) continue
    const qualified = uniqueName(qualifyToolName(serverId, t.name), seen)
    seen.add(qualified)
    infos.push({
      qualifiedName: qualified,
      toolName: t.name,
      serverId,
      schema: mcpToolToSchema(qualified, t.description, t.inputSchema),
      definition: t
    })
  }
  return infos
}

/** Ensure a name is unique within a server by appending a counter (staying ≤ limit). */
function uniqueName(name: string, seen: Set<string>): string {
  if (!seen.has(name)) return name
  for (let i = 1; ; i++) {
    const suffix = `_${i}`
    const candidate = name.slice(0, MAX_TOOL_NAME - suffix.length) + suffix
    if (!seen.has(candidate)) return candidate
  }
}

/**
 * Drop everything keyed to one server: its tool index entries and any cached
 * call results.
 *
 * Both must go together. A cached result is keyed by qualified tool name, so
 * leaving one behind after a disconnect would let a later consumer read stale
 * structure for a tool that no longer exists - and, in a warm pool, hold its
 * payload for the rest of the session.
 */
function forgetServer(id: string): void {
  for (const [key, info] of toolIndex) {
    if (info.serverId !== id) continue
    toolIndex.delete(key)
    lastResults.delete(key)
  }
}

function indexTools(conn: McpConnection): void {
  // Drop any stale tools this server previously registered, then re-index.
  forgetServer(conn.id)
  for (const t of conn.tools) toolIndex.set(t.qualifiedName, t)
}

/** A server's transport closed unexpectedly: prune its tools and mark it errored. */
function onTransportClosed(id: string, client: Client): void {
  const conn = connections.get(id)
  if (!conn || conn.client !== client) return // superseded by a newer connection
  forgetServer(id)
  conn.status = 'error'
  conn.error = conn.error ?? 'The MCP server disconnected.'
  conn.client = null
  conn.tools = []
}

/** Get the warm connection for a record, connecting (once) if needed. */
function getConnection(rec: McpServerRecord, workspaceCwd: string): Promise<McpConnection> {
  const cached = connections.get(rec.id)
  if (cached) return Promise.resolve(cached) // connected or cached-errored (no per-turn retry storm)
  const inflight = connecting.get(rec.id)
  if (inflight) return inflight
  // Attach OAuth only when this server already has credentials. Passing an
  // auth provider makes the SDK treat a 401 as "start an authorization flow",
  // which would pop a browser at any server that is merely down. Signing in is
  // something the user does deliberately (`signInMcpServer`).
  const auth =
    rec.config.type === 'remote' && repo.hasMcpOAuth(rec.id)
      ? mcpAuthProvider(rec.id, REDIRECT_PLACEHOLDER)
      : undefined
  const p: Promise<McpConnection> = connectOne(rec, workspaceCwd, auth).then((conn) => {
    // If we were disposed or superseded by a newer connect while this one was in
    // flight, don't resurrect the pool entry — just release this child process.
    // Whoever superseded us already owns `connections`/`toolIndex`; leave them be.
    // (connectOne wrote no global state, so there's nothing else to unwind.)
    if (connecting.get(rec.id) !== p) {
      if (conn.client) void conn.client.close().catch(() => {})
      return conn
    }
    connections.set(rec.id, conn)
    // Commit global routing state only now that we own the pool slot. Wiring onclose
    // here (not in connectOne) means a discarded in-flight connect never touches it.
    if (conn.status === 'connected' && conn.client) {
      indexTools(conn)
      const client = conn.client
      client.onclose = (): void => onTransportClosed(rec.id, client)
    }
    connecting.delete(rec.id)
    return conn
  })
  connecting.set(rec.id, p)
  return p
}

// ---------------------------------------------------------------------------
// Public API (agent loop + IPC)
// ---------------------------------------------------------------------------

/**
 * Connect every enabled record that isn't already in the pool. Idempotent and
 * warm: already-connected servers are reused; already-errored ones are left as-is
 * (call `reconnectMcpServer` to retry a specific one). Never throws.
 */
export async function ensureMcpConnected(
  records: McpServerRecord[],
  workspaceCwd: string
): Promise<void> {
  if (mcpDisabled()) return
  const enabled = records.filter((r) => r.enabled)
  await Promise.all(
    enabled.map((r) =>
      getConnection(r, workspaceCwd).catch(() => {
        /* getConnection already degrades to an errored connection */
      })
    )
  )
}

/**
 * Tool schemas from currently-connected servers, for the agent's tool list.
 * Pass the turn's record ids to scope the result to just this workspace's servers
 * (the pool is process-global, but a workspace's `.roxy/mcp.json` servers must not
 * leak into a different workspace's chat).
 */
export function mcpToolSchemas(ids?: Set<string>): RoxyToolSchema[] {
  const out: RoxyToolSchema[] = []
  for (const conn of connections.values()) {
    if (conn.status !== 'connected') continue
    if (ids && !ids.has(conn.id)) continue
    for (const t of conn.tools) {
      // App-only tools are omitted from the MODEL's list.
      //
      // `visibility: ['app']` is how a server exposes fine-grained operations to
      // its own view (`set_cell`, `select_row`) without filling the model's tool
      // list with dozens of them. SEP-1865 makes this a MUST NOT for hosts, and
      // it is a correctness issue as much as a spec one: offering the model a
      // tool the server said was not for it invites calls the server never
      // meant to serve.
      //
      // They stay in `toolIndex`, so the view can still call them through the
      // broker - hidden from the model is not the same as unavailable.
      if (isAppOnlyTool(t.definition._meta)) continue
      out.push(t.schema)
    }
  }
  return out
}

/**
 * Route + run an MCP tool call, rendering the result. Never throws.
 *
 * `signal` is the turn's abort signal. Passing it through matters because MCP
 * tool calls are the slowest thing an agent does and the most likely to be
 * running when a user hits stop: without it the SDK keeps waiting on the wire,
 * the server keeps working, and the child process stays busy long after the turn
 * that wanted the answer has gone. The SDK also emits `notifications/cancelled`,
 * so a well-behaved server can stop its own work rather than finish into a void.
 */
export async function callMcpTool(
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<ToolResult> {
  const info = toolIndex.get(name)
  if (!info) return { ok: false, output: `Unknown MCP tool: ${name}` }
  const conn = connections.get(info.serverId)
  if (!conn || conn.status !== 'connected' || !conn.client) {
    return { ok: false, output: `MCP server "${info.serverId}" is not connected.` }
  }
  try {
    // v2 dropped the result-schema argument: `callTool(params, options)`.
    const res = await conn.client.callTool(
      { name: info.toolName, arguments: args ?? {} },
      // The server's own budget, not the global default (see `requestTimeout`).
      { timeout: conn.requestTimeout, signal }
    )
    // Parse ONCE into the lossless model, cache it, and hand the caller the flat
    // projection. Everything the flat form cannot express - resource URIs, extra
    // images, result `_meta`, unrecognised block types - stays reachable via
    // `lastMcpCallResult` instead of being destroyed on arrival.
    const parsed = parseCallResult(res)
    lastResults.set(name, parsed)
    return toToolResult(parsed)
  } catch (e) {
    // A cancelled call is not a failure to report to the model as a tool error -
    // the turn it belonged to is already gone. Name it plainly so a retry
    // doesn't read it as "the server is broken".
    if (signal?.aborted) return { ok: false, output: `MCP tool "${name}" was cancelled.` }
    return { ok: false, output: `MCP tool "${name}" failed: ${errMsg(e)}` }
  }
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

/**
 * List a server's resources, or `[]` when it exposes none.
 *
 * Resources are the half of MCP that isn't tools: files, configs, database rows
 * a server is willing to hand over as context. Roxy needs them for MCP Apps in
 * particular, where the UI itself arrives as a `ui://` resource read over this
 * same path.
 *
 * Reads are cached by the SDK per the server's own `ttlMs`, so calling this on a
 * warm connection is cheap.
 */
export async function listMcpResources(serverId: string): Promise<McpResourceInfo[]> {
  const conn = connections.get(serverId)
  if (!conn || conn.status !== 'connected' || !conn.client || !conn.hasResources) return []
  try {
    const res = await conn.client.listResources(undefined, { timeout: conn.requestTimeout })
    return (res.resources ?? []).map((r) => {
      const raw = r as typeof r & { meta?: Record<string, unknown> }
      return {
        uri: r.uri,
        name: r.name,
        title: r.title,
        description: r.description,
        mimeType: r.mimeType,
        // Listing-level metadata is the spec fallback when resources/read omits
        // it. `_meta` is canonical; `meta` is emitted by some Python SDKs and is
        // accepted by the official reference host too.
        _meta: r._meta ?? raw.meta
      }
    })
  } catch {
    return []
  }
}

/**
 * Read one resource by URI. Returns its contents, or an error string.
 *
 * Never throws, mirroring `callMcpTool`: a resource read happens inside an agent
 * turn, and a server that 404s a URI must not take the turn with it.
 */
export async function readMcpResource(
  serverId: string,
  uri: string,
  signal?: AbortSignal
): Promise<McpResourceContents | { error: string }> {
  const conn = connections.get(serverId)
  if (!conn || conn.status !== 'connected' || !conn.client) {
    return { error: `MCP server "${serverId}" is not connected.` }
  }
  try {
    const res = await conn.client.readResource({ uri }, { timeout: conn.requestTimeout, signal })
    return parseResourceContents(uri, res.contents)
  } catch (e) {
    if (signal?.aborted) return { error: `Reading ${uri} was cancelled.` }
    return { error: `Could not read ${uri}: ${errMsg(e)}` }
  }
}

/**
 * The lossless result of the last call to `qualifiedName`, if any.
 *
 * The seam MCP Apps reads: a UI-bearing tool's result carries the data its view
 * renders, and the flat `ToolResult` is a lossy projection of exactly that.
 */
export function lastMcpCallResult(qualifiedName: string): McpCallResult | undefined {
  return lastResults.get(qualifiedName)
}

/**
 * The server's own definition of one namespaced tool, or undefined if unknown.
 *
 * The seam MCP Apps builds on: a UI-bearing tool declares its view at
 * `_meta['io.modelcontextprotocol/ui'].resourceUri`, and app-only tools are
 * flagged in the same `_meta`. Exposed as a lookup rather than folded into
 * `mcpToolSchemas` because the schema list is the MODEL's view, and these fields
 * are deliberately not part of it.
 */
export function mcpToolDefinition(name: string): McpToolDefinition | undefined {
  return toolIndex.get(name)?.definition
}

/** Whether a tool name should be dispatched to the MCP pool (re-exported for tools.ts). */
export const isMcpTool = isMcpToolName

/** A human-friendly `server · tool` label for a namespaced MCP tool name (for UI cards). */
export function mcpToolTitle(name: string): string {
  const info = toolIndex.get(name)
  if (info) return `${info.serverId} · ${info.toolName}`
  return name.startsWith(`${MCP_TOOL_PREFIX}__`)
    ? name.slice(MCP_TOOL_PREFIX.length + 2).replace(/__/g, ' · ')
    : name
}

/** Per-server status snapshot (for the settings UI + prompt blurb). Optionally scoped. */
export function mcpServerSummaries(ids?: Set<string>): McpServerSummary[] {
  const out: McpServerSummary[] = []
  for (const conn of connections.values()) {
    if (ids && !ids.has(conn.id)) continue
    out.push({
      id: conn.id,
      status: conn.status,
      tools: conn.tools.map((t) => t.toolName),
      error: conn.error,
      era: conn.era
    })
  }
  return out
}

/** The system-prompt blurb describing connected servers, or undefined when none. */
export function mcpInstructions(ids?: Set<string>): string | undefined {
  return describeMcpForPrompt(mcpServerSummaries(ids))
}

/** Force a fresh connection attempt for one server (used by the UI's reconnect). */
export async function reconnectMcpServer(
  rec: McpServerRecord,
  workspaceCwd: string
): Promise<McpServerSummary> {
  await disposeConnection(rec.id)
  if (!rec.enabled || mcpDisabled()) {
    return { id: rec.id, status: 'disabled', tools: [] }
  }
  const conn = await getConnection(rec, workspaceCwd)
  return {
    id: conn.id,
    status: conn.status,
    tools: conn.tools.map((t) => t.toolName),
    error: conn.error,
    era: conn.era
  }
}

/**
 * Redirect URI used when refreshing an already-authorized connection.
 *
 * A refresh never redirects anywhere - the SDK exchanges the stored refresh
 * token directly - but `clientMetadata` still has to name the URI the client was
 * registered with, or the authorization server rejects the request. The
 * interactive path (`signInMcpServer`) allocates a real port and overrides this.
 */
const REDIRECT_PLACEHOLDER = 'http://127.0.0.1/callback'

/**
 * Sign in to a remote MCP server, then connect it.
 *
 * The one genuinely interactive MCP flow: allocate a loopback listener, let the
 * SDK send the user to the authorization server, capture the redirect, exchange
 * the code, and reconnect with the tokens in place.
 *
 * Never throws - a failed sign-in reports as an errored summary, exactly like a
 * server that wouldn't start.
 */
export async function signInMcpServer(
  rec: McpServerRecord,
  workspaceCwd: string
): Promise<McpServerSummary> {
  if (rec.config.type !== 'remote') {
    return { id: rec.id, status: 'error', tools: [], error: 'Only remote servers use OAuth.' }
  }
  await disposeConnection(rec.id)
  try {
    const redirectUrl = await prepareAuthorization(rec.id)
    const auth = mcpAuthProvider(rec.id, redirectUrl)
    const client = new Client(clientInfo(), clientOptions(rec.id))
    const [make] = transportFactories(rec, workspaceCwd, auth)
    const transport = make()
    try {
      // Expected to reject with UnauthorizedError after opening the browser:
      // that IS the handshake, not a failure.
      await client.connect(transport, { timeout: startupTimeout(rec) })
    } catch {
      const params = await awaitAuthorization(rec.id)
      // `finishAuth` validates `iss` (RFC 9207) and exchanges the code. The
      // transport is single-use once it has failed, so reconnect on a fresh one:
      // OAuth state lives on the provider, not the transport.
      await (transport as { finishAuth?: (p: URLSearchParams) => Promise<void> }).finishAuth?.(
        params
      )
    }
    await client.close().catch(() => {})
    return await reconnectMcpServer(rec, workspaceCwd)
  } catch (e) {
    return { id: rec.id, status: 'error', tools: [], error: errMsg(e) }
  }
}

/** Forget a remote server's OAuth credentials and drop its connection. */
export async function signOutMcpServer(id: string): Promise<void> {
  clearMcpAuth(id)
  await disposeConnection(id)
}

/** Whether a server has stored OAuth credentials (drives the "signed in" badge). */
export function isMcpSignedIn(id: string): boolean {
  return repo.hasMcpOAuth(id)
}

/** Close + forget one server's connection (e.g. it was deleted or disabled). */
export async function disposeConnection(id: string): Promise<void> {
  connecting.delete(id)
  const conn = connections.get(id)
  connections.delete(id)
  forgetServer(id)
  if (conn?.client) {
    conn.client.onclose = undefined
    try {
      await conn.client.close()
    } catch {
      /* already gone */
    }
  }
}

/** Close every connection (called on app quit). */
export async function shutdownAllMcp(): Promise<void> {
  // Include in-flight connects: disposing clears their `connecting` entry so the
  // pending promise self-tears-down (closes its child) instead of resurrecting.
  const ids = new Set([...connections.keys(), ...connecting.keys()])
  await Promise.all([...ids].map((id) => disposeConnection(id)))
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// ---------------------------------------------------------------------------
// Workspace config source (project-portable, opencode/Claude-Desktop style)
// ---------------------------------------------------------------------------

/**
 * Read project-scoped MCP servers from a workspace config file. Supports the
 * common shapes: `{ "mcpServers": {...} }` (Claude Desktop), `{ "servers": {...} }`,
 * or a bare `{ name: config }` map. Missing/invalid files yield `[]` (never throws).
 */
export function loadWorkspaceMcpServers(cwd: string): McpServerRecord[] {
  if (!cwd) return []
  for (const rel of ['.roxy/mcp.json', '.mcp.json']) {
    const file = path.join(cwd, rel)
    if (!existsSync(file)) continue
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      const servers =
        parsed && typeof parsed === 'object'
          ? (parsed.mcpServers ?? parsed.servers ?? parsed)
          : parsed
      return normalizeServerRecords(servers)
    } catch {
      return []
    }
  }
  return []
}

// ---------------------------------------------------------------------------
// Test-only helpers
// ---------------------------------------------------------------------------

/** Tear down all connections + caches between smoke cases. */
export async function _resetMcpForTests(): Promise<void> {
  await shutdownAllMcp()
  connections.clear()
  connecting.clear()
  toolIndex.clear()
  lastResults.clear()
}
