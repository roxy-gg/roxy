/**
 * The MCP Apps broker — the security boundary between a view and Roxy.
 *
 * The renderer never holds an MCP client. A view's request arrives over IPC as
 * data, is validated here, and is executed against the ONE server that view
 * belongs to. That indirection is the whole point: the authenticated connection,
 * the OAuth tokens, and the ability to spawn processes all stay in main, and the
 * renderer is reduced to a courier for JSON-RPC frames it cannot act on itself.
 *
 * ## What this file refuses
 *
 *  - **Cross-server calls.** A session is bound to its origin server at
 *    creation. A view asking for `mcp__other__tool` gets an error, not a call.
 *  - **Unapproved tool calls.** A view is untrusted code; it does not get to
 *    invoke tools silently just because the model invoked one. Approval is
 *    per (app, tool) and remembered for the session.
 *  - **Unknown sessions.** Every request carries a session id minted here. A
 *    renderer that guesses one gets nothing.
 */
import { randomUUID } from 'node:crypto'
import { shell } from 'electron'
import {
  BRIDGE_ERROR,
  isOpenableUrl,
  routeBridgeMethod,
  uiResourceMeta,
  buildCsp,
  buildAllow,
  externalDomains,
  negotiateDisplayMode,
  APPS_PROTOCOL_VERSION,
  SUPPORTED_DISPLAY_MODES,
  UI_MIME,
  type McpUiInitializeResult,
  type McpUiTheme
} from '../../shared/mcp-apps'
import { callMcpTool, readMcpResource, mcpToolDefinition } from './mcp'
import { qualifyToolName } from '../../shared/mcp'

/** One live app view. Created when a UI-bearing tool call renders. */
interface AppSession {
  id: string
  /** The server this view came from. Every request is pinned to it. */
  serverId: string
  /** The tool call that produced this view. */
  toolName: string
  /** `ui://` resource the view was loaded from. */
  resourceUri: string
  /** Tools the user has allowed this view to call, unqualified. */
  approved: Set<string>
  /** Model context the view has pushed, if any (last write wins, per spec). */
  modelContext?: { content?: unknown; structuredContent?: unknown }
  createdAt: number
}

const sessions = new Map<string, AppSession>()

/**
 * Cap on concurrent live views.
 *
 * Each holds a frame and its retained result. A long transcript can accumulate
 * dozens of app cards, and every one of them is a running document; without a
 * ceiling, scrolling back through a session with many UI tools would keep them
 * all alive. Oldest is evicted first.
 */
const MAX_SESSIONS = 12

/** What the renderer needs to mount a view. */
export interface McpAppLaunch {
  sessionId: string
  /** The view's HTML, read from its `ui://` resource. */
  html: string
  /** CSP to apply to the inner frame. */
  csp: string
  /** `allow` attribute for declared device permissions. */
  allow: string
  /** External origins this view declared, for disclosure. */
  externalDomains: string[]
  /** Display modes both the view and this host support. */
  displayModes: string[]
}

/**
 * Prepare a view for a completed tool call.
 *
 * Returns `null` when the tool has no UI, when the resource is missing, or when
 * it isn't actually an MCP App — every one of which is a normal outcome that
 * should leave the tool card rendering its text result as usual.
 */
export async function launchMcpApp(
  serverId: string,
  qualifiedToolName: string,
  resourceUri: string
): Promise<McpAppLaunch | null> {
  const contents = await readMcpResource(serverId, resourceUri)
  if ('error' in contents) return null
  // Must be HTML declaring the MCP Apps profile. A server pointing `ui://` at a
  // PNG or a JSON blob is not offering a view, and rendering whatever came back
  // as a document would be exactly the confusion this check exists to stop.
  if (!contents.mimeType?.startsWith('text/html')) return null
  if (!contents.text) return null

  const meta = uiResourceMeta((contents as { _meta?: Record<string, unknown> })._meta ?? undefined)

  evictOldest()
  const session: AppSession = {
    id: randomUUID(),
    serverId,
    toolName: qualifiedToolName,
    resourceUri,
    approved: new Set(),
    createdAt: Date.now()
  }
  sessions.set(session.id, session)

  return {
    sessionId: session.id,
    html: contents.text,
    csp: buildCsp(meta?.csp),
    allow: buildAllow(meta?.permissions),
    externalDomains: externalDomains(meta),
    displayModes: (meta?.availableDisplayModes ?? SUPPORTED_DISPLAY_MODES).filter((m) =>
      (SUPPORTED_DISPLAY_MODES as string[]).includes(m)
    )
  }
}

/** Drop the oldest session once the ceiling is reached. */
function evictOldest(): void {
  if (sessions.size < MAX_SESSIONS) return
  let oldest: AppSession | undefined
  for (const s of sessions.values()) {
    if (!oldest || s.createdAt < oldest.createdAt) oldest = s
  }
  if (oldest) sessions.delete(oldest.id)
}

/** Tear down one view (its card unmounted, or the transcript moved on). */
export function closeMcpApp(sessionId: string): void {
  sessions.delete(sessionId)
}

/** Drop every view (window closing, workspace switch, tests). */
export function closeAllMcpApps(): void {
  sessions.clear()
}

/**
 * The model context a view has pushed, for injection into the next turn.
 *
 * Per spec each update overwrites the previous one, and the host sends only the
 * latest before the next user message.
 */
export function mcpAppModelContext(): { toolName: string; context: unknown }[] {
  const out: { toolName: string; context: unknown }[] = []
  for (const s of sessions.values()) {
    if (s.modelContext) out.push({ toolName: s.toolName, context: s.modelContext })
  }
  return out
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

/** A JSON-RPC frame from a view, as relayed by the renderer. */
export interface BridgeRequest {
  sessionId: string
  id?: string | number | null
  method?: unknown
  params?: Record<string, unknown>
}

export interface BridgeReply {
  result?: unknown
  error?: { code: number; message: string }
}

/** Ask the user to approve a tool call, via the renderer. Injected to avoid a cycle. */
type ApprovalFn = (req: {
  sessionId: string
  serverId: string
  toolName: string
  args: unknown
}) => Promise<boolean>

let askApproval: ApprovalFn = async () => false

export function setMcpAppApprover(fn: ApprovalFn): void {
  askApproval = fn
}

/** Host theme, supplied by the renderer at launch so the view can match it. */
let currentTheme: McpUiTheme = { mode: 'dark', variables: {} }

export function setMcpAppTheme(theme: McpUiTheme): void {
  currentTheme = theme
}

/**
 * Handle one request from a view.
 *
 * Never throws: a malformed or hostile frame becomes a JSON-RPC error, because
 * the alternative is an unhandled rejection in the IPC layer taking down
 * something a view should not be able to reach.
 */
export async function handleMcpAppRequest(req: BridgeRequest): Promise<BridgeReply> {
  const session = sessions.get(req.sessionId)
  // An unknown session is either a stale frame after teardown or a renderer
  // guessing ids. Neither gets served.
  if (!session) {
    return { error: { code: BRIDGE_ERROR.denied, message: 'No such app session.' } }
  }

  const route = routeBridgeMethod(req.method)
  if (route.kind === 'reject') {
    return { error: { code: BRIDGE_ERROR.methodNotFound, message: route.reason } }
  }

  try {
    if (route.kind === 'host') return await handleHostMethod(session, route.method, req.params)
    return await handleForwarded(session, route.method, req.params)
  } catch (e) {
    return {
      error: { code: BRIDGE_ERROR.denied, message: (e as Error)?.message ?? 'Request failed' }
    }
  }
}

async function handleHostMethod(
  session: AppSession,
  method: string,
  params: Record<string, unknown> | undefined
): Promise<BridgeReply> {
  switch (method) {
    case 'ui/initialize': {
      const result: McpUiInitializeResult = {
        protocolVersion: APPS_PROTOCOL_VERSION,
        hostInfo: { name: 'Roxy', version: process.env.npm_package_version ?? '0.0.0' },
        hostCapabilities: {
          tools: {},
          resources: {},
          openLink: {},
          message: {},
          updateModelContext: {}
        },
        availableDisplayModes: SUPPORTED_DISPLAY_MODES,
        theme: currentTheme
      }
      return { result }
    }

    case 'ui/notifications/initialized':
      return { result: {} }

    case 'ui/open-link': {
      const url = params?.url
      if (!isOpenableUrl(url)) {
        // Rejecting non-http(s) is the point: a view must not be able to make
        // the host launch `file://` or some other app's registered scheme.
        return { error: { code: BRIDGE_ERROR.invalidParams, message: 'Invalid URL' } }
      }
      await shell.openExternal(url as string)
      return { result: {} }
    }

    case 'ui/request-display-mode':
      return { result: { mode: negotiateDisplayMode(params?.mode) } }

    case 'ui/update-model-context':
      // Last write wins, per spec. Stored, not injected: it reaches the model
      // with the next user message.
      session.modelContext = {
        content: params?.content,
        structuredContent: params?.structuredContent
      }
      return { result: {} }

    case 'ui/message':
      // Handled in the renderer (it owns the composer); reaching here means the
      // renderer relayed it without intercepting.
      return { result: {} }

    default:
      return { error: { code: BRIDGE_ERROR.methodNotFound, message: method } }
  }
}

async function handleForwarded(
  session: AppSession,
  method: string,
  params: Record<string, unknown> | undefined
): Promise<BridgeReply> {
  if (method === 'resources/read') {
    const uri = params?.uri
    if (typeof uri !== 'string') {
      return { error: { code: BRIDGE_ERROR.invalidParams, message: 'Missing uri' } }
    }
    // Pinned to the view's own server: a view cannot read another server's
    // resources by naming them.
    const contents = await readMcpResource(session.serverId, uri)
    if ('error' in contents) {
      return { error: { code: BRIDGE_ERROR.denied, message: contents.error } }
    }
    return { result: { contents: [contents] } }
  }

  // tools/call
  const name = params?.name
  const args = (params?.arguments ?? {}) as Record<string, unknown>
  if (typeof name !== 'string' || !name) {
    return { error: { code: BRIDGE_ERROR.invalidParams, message: 'Missing tool name' } }
  }

  // The view names an UNQUALIFIED tool; we qualify it against the session's own
  // server. This is what makes cross-server calls impossible rather than merely
  // discouraged - there is no code path that reads a server id from the view.
  const qualified = qualifyToolName(session.serverId, name)
  if (!mcpToolDefinition(qualified)) {
    return { error: { code: BRIDGE_ERROR.invalidParams, message: `Unknown tool: ${name}` } }
  }

  if (!session.approved.has(name)) {
    const ok = await askApproval({
      sessionId: session.id,
      serverId: session.serverId,
      toolName: name,
      args
    })
    if (!ok) {
      return { error: { code: BRIDGE_ERROR.denied, message: 'Tool call denied by user.' } }
    }
    // Remembered per session, not per call: a spreadsheet view that writes a
    // cell on every keystroke would otherwise be unusable, and the user already
    // answered the question "may this view call this tool".
    session.approved.add(name)
  }

  const result = await callMcpTool(qualified, args)
  return {
    result: {
      content: [{ type: 'text', text: result.output }],
      ...(result.ok ? {} : { isError: true })
    }
  }
}

/** Test seam: the MIME an App resource must declare. */
export const APP_MIME = UI_MIME

/** Test-only: reset broker state between smoke cases. */
export function _resetMcpAppsForTests(): void {
  sessions.clear()
  askApproval = async () => false
}
