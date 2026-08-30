/**
 * MCP Apps — the protocol between a server-supplied UI and Roxy.
 *
 * Pure logic only (no Node/Electron/DOM imports) so every rule here is unit
 * tested in smoke:shared. Implements SEP-1865 (stable, 2026-01-26).
 *
 * ## What an MCP App is
 *
 * A tool can declare a UI in its metadata:
 *
 *   tool._meta['io.modelcontextprotocol/ui'].resourceUri = 'ui://server/app.html'
 *
 * When the model calls that tool, the host reads the `ui://` resource over
 * `resources/read`, gets HTML back, and renders it. The view then talks JSON-RPC
 * back to the host over `postMessage` — it can call the SAME SERVER's tools, ask
 * to open a link, push text into the conversation, or update model context.
 *
 * ## The security posture this file encodes
 *
 * The HTML is written by whoever wrote the MCP server. It is untrusted,
 * arbitrary, executable third-party code. Three rules follow, and every one of
 * them is a function below rather than a comment:
 *
 *  1. **It never runs on Roxy's origin.** A same-origin iframe could reach the
 *     preload bridge, `localStorage`, the session cookie jar — everything. The
 *     spec's answer is a double iframe with a separate-origin sandbox proxy in
 *     between, and that is what `buildCsp` + the proxy page implement.
 *  2. **It only reaches its own server.** A view from server A must not be able
 *     to call server B's tools. Routing is keyed to the app's origin server, not
 *     to whatever the view asks for.
 *  3. **Deny by default.** Unknown methods are rejected, undeclared domains are
 *     blocked, and every capability (camera, links, tool calls) is off until the
 *     resource declares it AND the user allows it.
 */

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** The `_meta` key MCP Apps reserves on tools and resources. */
export const UI_META_KEY = 'io.modelcontextprotocol/ui'

/**
 * The short alias the official SDK actually writes.
 *
 * SEP-1865 reserves the fully-qualified `io.modelcontextprotocol/ui` label, but
 * `registerAppTool` / `registerAppResource` in `@modelcontextprotocol/ext-apps`
 * emit `_meta.ui` - and that is what every published example server carries. A
 * host that reads only the namespaced key renders NOTHING for the entire
 * ecosystem while looking perfectly correct against the prose.
 *
 * Both are accepted, namespaced first: it is the reserved, unambiguous form, and
 * a server that sends both means the qualified one.
 */
export const UI_META_KEY_SHORT = 'ui'

/** The MIME type an MCP App resource must declare. */
export const UI_MIME = 'text/html;profile=mcp-app'

/** URI scheme reserved for MCP App resources. */
export const UI_SCHEME = 'ui://'

/**
 * Origin the sandbox proxy is served from.
 *
 * Shared so the renderer can name an explicit `targetOrigin` on every
 * `postMessage` instead of falling back to `'*'`. A wildcard reply is readable
 * by whatever is listening if the frame navigates, which for a document full of
 * tool results is exactly the leak worth avoiding.
 *
 * Kept in step with `SANDBOX_SCHEME` in main/services/mcp-app-sandbox.ts; a
 * smoke check pins the two together.
 */
export const SANDBOX_ORIGIN_HINT = 'roxy-mcp-app://view'

/**
 * `targetOrigin` for host -> proxy `postMessage`. Necessarily `'*'`.
 *
 * This looks like the sloppy choice and is in fact the only legal one, so the
 * reasoning is written down rather than left to be rediscovered:
 *
 *  1. The proxy frame is `sandbox="allow-scripts"` WITHOUT `allow-same-origin`.
 *     That is deliberate - it is what makes the document opaque, so it cannot
 *     touch Roxy's storage or cookies.
 *  2. An opaque document's origin is not its URL. Posting to
 *     `roxy-mcp-app://view` matches nothing and the browser drops the message
 *     silently: the proxy waits forever for a resource that WAS sent, and the
 *     user sees a blank frame with no error on any channel.
 *  3. The obvious repair - posting to the literal `'null'` - is rejected by the
 *     browser outright: "Invalid target origin 'null' in a call to
 *     'postMessage'". There is no origin string that addresses an opaque frame.
 *
 * So `'*'` is forced. What matters is that it costs nothing here, because the
 * targetOrigin was never the control doing the work:
 *
 *  - Confidentiality is bounded by WHO can receive. The only reader is the frame
 *    we created and hold a handle to; it cannot navigate itself elsewhere
 *    (`allow-top-navigation` is off, and it has no `allow-same-origin` to
 *    re-enter our origin with), so there is no third party for a wildcard to
 *    leak to.
 *  - Authenticity is enforced on the RECEIVING side, which is where it belongs:
 *    the host checks `event.source === frame.contentWindow` (exact window
 *    identity, not a shared origin string), and the proxy pins the host's real
 *    origin from the first inbound message and rejects everything else.
 *
 * A comparable host (`ext-apps`'s own reference proxy) reaches the same
 * conclusion for the same reason.
 */
export const SANDBOX_POST_TARGET = '*'

/** Protocol revision this implementation speaks. */
export const APPS_PROTOCOL_VERSION = '2026-01-26'

// ---------------------------------------------------------------------------
// Declarations read off tool / resource metadata
// ---------------------------------------------------------------------------

/** Domains a resource declares it needs. Anything not listed is blocked. */
export interface McpUiCsp {
  /** Origins allowed for scripts, styles, images, fonts, media. */
  resourceDomains?: string[]
  /** Origins the view may `fetch`/XHR/WebSocket to. */
  connectDomains?: string[]
  /** Origins allowed in nested iframes. Absent means `frame-src 'none'`. */
  frameDomains?: string[]
  /** Origins allowed as `<base href>`. Absent means `base-uri 'self'`. */
  baseUriDomains?: string[]
}

/** Device permissions a resource asks for; each maps to an iframe `allow` token. */
export interface McpUiPermissions {
  camera?: boolean
  microphone?: boolean
  geolocation?: boolean
}

/** The `io.modelcontextprotocol/ui` block on a TOOL. */
export interface McpUiToolMeta {
  /** The `ui://` resource holding this tool's view. */
  resourceUri?: string
  /**
   * Who may see this tool.
   *
   * `['app']` means app-only: the tool exists for the view to call and MUST NOT
   * be offered to the model. Absent means the model sees it as normal.
   */
  visibility?: string[]
  /** Preferred initial size, when the view knows it up front. */
  preferredSize?: { width?: number; height?: number }
}

/** The `io.modelcontextprotocol/ui` block on a RESOURCE. */
export interface McpUiResourceMeta {
  csp?: McpUiCsp
  permissions?: McpUiPermissions
  /** Display modes the view can render in. */
  availableDisplayModes?: McpUiDisplayMode[]
}

export type McpUiDisplayMode = 'inline' | 'fullscreen' | 'pip'

/** Read a tool's UI declaration, if it has one. */
export function uiToolMeta(meta: Record<string, unknown> | undefined): McpUiToolMeta | undefined {
  return readUiBlock(meta) as McpUiToolMeta | undefined
}

/**
 * Read the UI block under either spelling.
 *
 * Shared by the tool and resource readers so the two can never disagree about
 * which key counts - a split there would show up as a tool that declares a view
 * whose resource is then judged not to be one.
 */
function readUiBlock(
  meta: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  for (const key of [UI_META_KEY, UI_META_KEY_SHORT]) {
    const block = meta?.[key]
    if (block && typeof block === 'object' && !Array.isArray(block)) {
      return block as Record<string, unknown>
    }
  }
  return undefined
}

/** Read a resource's UI declaration, if it has one. */
export function uiResourceMeta(
  meta: Record<string, unknown> | undefined
): McpUiResourceMeta | undefined {
  return readUiBlock(meta) as McpUiResourceMeta | undefined
}

/** The `ui://` resource a tool's view lives at, or undefined if it has none. */
export function uiResourceUri(meta: Record<string, unknown> | undefined): string | undefined {
  const uri = uiToolMeta(meta)?.resourceUri
  return typeof uri === 'string' && uri.startsWith(UI_SCHEME) ? uri : undefined
}

/**
 * Whether a tool is app-only and must be hidden from the model.
 *
 * `visibility: ['app']` exists so a server can expose fine-grained operations to
 * its own UI (say, `set_cell`) without polluting the model's tool list with
 * dozens of them. Getting this backwards would hand the model tools the server
 * explicitly said were not for it.
 */
export function isAppOnlyTool(meta: Record<string, unknown> | undefined): boolean {
  const vis = uiToolMeta(meta)?.visibility
  if (!Array.isArray(vis)) return false
  return vis.length > 0 && !vis.includes('model')
}

// ---------------------------------------------------------------------------
// Content Security Policy
// ---------------------------------------------------------------------------

/**
 * A domain entry that is safe to interpolate into a CSP.
 *
 * The declaration comes from the server, i.e. from the same untrusted place as
 * the HTML. A value like `*; script-src *` would otherwise let a resource
 * rewrite the very policy meant to contain it — CSP header injection. Only
 * scheme+host(+port) shapes and a small set of keywords are allowed through;
 * anything containing a separator is dropped.
 */
const SAFE_DOMAIN =
  /^(?:https:\/\/[a-z0-9.*-]+(?::\d+)?|wss:\/\/[a-z0-9.*-]+(?::\d+)?|'self'|'none'|data:)$/i

/** Keep only domain entries that cannot break out of the directive. */
export function sanitizeDomains(list: string[] | undefined): string[] {
  if (!Array.isArray(list)) return []
  return list
    .filter((d) => typeof d === 'string' && SAFE_DOMAIN.test(d.trim()))
    .map((d) => d.trim())
}

/**
 * Build the CSP the sandbox applies to a view.
 *
 * Follows the construction in SEP-1865 §"Content Security Policy Enforcement".
 * `default-src 'none'` is the floor: everything a view can reach has to be named
 * by a directive below it, so a resource that declares nothing gets a document
 * that can run its own inline script and nothing else — no network, no frames,
 * no plugins.
 *
 * `'unsafe-inline'` for script and style is in the spec and unavoidable: these
 * views are single HTML files with inline `<script>`. It is survivable precisely
 * because the origin is disposable and `connect-src` is closed by default — the
 * script can execute, but it cannot phone home.
 */
export function buildCsp(csp: McpUiCsp | undefined): string {
  const resources = sanitizeDomains(csp?.resourceDomains).join(' ')
  const connect = sanitizeDomains(csp?.connectDomains).join(' ')
  const frames = sanitizeDomains(csp?.frameDomains).join(' ')
  const baseUri = sanitizeDomains(csp?.baseUriDomains).join(' ')
  return [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline'${resources ? ' ' + resources : ''}`,
    `style-src 'self' 'unsafe-inline'${resources ? ' ' + resources : ''}`,
    `connect-src 'self'${connect ? ' ' + connect : ''}`,
    `img-src 'self' data:${resources ? ' ' + resources : ''}`,
    `font-src 'self'${resources ? ' ' + resources : ''}`,
    `media-src 'self' data:${resources ? ' ' + resources : ''}`,
    `frame-src ${frames || "'none'"}`,
    "object-src 'none'",
    `base-uri ${baseUri || "'self'"}`
  ].join('; ')
}

/**
 * The iframe `allow` attribute for a view's declared permissions.
 *
 * Empty unless the resource asked. A device permission that nobody requested is
 * a device permission that stays off.
 */
export function buildAllow(permissions: McpUiPermissions | undefined): string {
  const allow: string[] = []
  if (permissions?.camera) allow.push('camera')
  if (permissions?.microphone) allow.push('microphone')
  if (permissions?.geolocation) allow.push('geolocation')
  return allow.join('; ')
}

/**
 * Whether a view wants access to anything outside itself.
 *
 * Drives the disclosure on the tool card: "this UI talks to api.example.com" is
 * the one fact a user cannot discover by looking at the rendered view.
 */
export function externalDomains(meta: McpUiResourceMeta | undefined): string[] {
  const all = [
    ...sanitizeDomains(meta?.csp?.connectDomains),
    ...sanitizeDomains(meta?.csp?.resourceDomains),
    ...sanitizeDomains(meta?.csp?.frameDomains)
  ].filter((d) => d !== "'self'" && d !== "'none'" && d !== 'data:')
  return [...new Set(all)]
}

// ---------------------------------------------------------------------------
// The bridge protocol
// ---------------------------------------------------------------------------

/** Methods a view may send that the host answers itself. */
export const UI_METHODS = [
  'ui/initialize',
  'ui/notifications/initialized',
  'ui/open-link',
  'ui/message',
  'ui/request-display-mode',
  'ui/update-model-context'
] as const

/**
 * Methods a view may send that the host FORWARDS to the MCP server.
 *
 * An explicit allowlist, not a prefix check. The spec permits forwarding
 * anything without a `ui/` prefix, but "everything except a prefix" is a rule
 * that silently grows as the protocol does — a future `roots/list` or
 * `sampling/createMessage` would start flowing to the server the day a server
 * started sending it. Naming the two methods a view legitimately needs keeps the
 * blast radius fixed.
 */
export const FORWARDED_METHODS = ['tools/call', 'resources/read'] as const

/** Reserved sandbox-proxy methods, which must never be forwarded onward. */
export const SANDBOX_METHOD_PREFIX = 'ui/notifications/sandbox-'

export type UiMethod = (typeof UI_METHODS)[number]
export type ForwardedMethod = (typeof FORWARDED_METHODS)[number]

/** What the host should do with an inbound message from a view. */
export type BridgeRoute =
  | { kind: 'host'; method: UiMethod }
  | { kind: 'forward'; method: ForwardedMethod }
  | { kind: 'reject'; reason: string }

/**
 * Classify one inbound method name. The single decision point for "may a view do
 * this?", so the answer is testable without a browser.
 *
 * Deny by default: anything not explicitly listed is rejected, including the
 * reserved sandbox methods (which belong to the proxy and must not reach either
 * the host's handlers or the server).
 */
export function routeBridgeMethod(method: unknown): BridgeRoute {
  if (typeof method !== 'string' || !method) {
    return { kind: 'reject', reason: 'Missing method' }
  }
  if (method.startsWith(SANDBOX_METHOD_PREFIX)) {
    return { kind: 'reject', reason: 'Reserved sandbox method' }
  }
  if ((UI_METHODS as readonly string[]).includes(method)) {
    return { kind: 'host', method: method as UiMethod }
  }
  if ((FORWARDED_METHODS as readonly string[]).includes(method)) {
    return { kind: 'forward', method: method as ForwardedMethod }
  }
  return { kind: 'reject', reason: `Unsupported method: ${method}` }
}

/** JSON-RPC error codes used by the bridge. */
export const BRIDGE_ERROR = {
  /** Implementation-defined; what the spec uses for denied UI requests. */
  denied: -32000,
  methodNotFound: -32601,
  invalidParams: -32602
} as const

/**
 * Whether a URL is safe to hand to the OS browser for `ui/open-link`.
 *
 * http/https only. A view asking to open `file:///`, or a custom scheme
 * registered by some other installed application, is asking the host to do
 * something on its behalf that it could not do itself — the classic sandbox
 * escape by proxy.
 */
export function isOpenableUrl(raw: unknown): boolean {
  if (typeof raw !== 'string') return false
  try {
    const u = new URL(raw)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Host context handed to a view at `ui/initialize`
// ---------------------------------------------------------------------------

/**
 * Theme variables passed to the view so it can match the host.
 *
 * Sent as data rather than injected CSS: the view decides how to use them, and
 * the host never writes into the view's document.
 */
export interface McpUiTheme {
  mode: 'light' | 'dark'
  /** CSS custom properties, e.g. `--mcp-ui-background`. */
  variables: Record<string, string>
}

/** The result of a view's `ui/initialize` request. */
export interface McpUiInitializeResult {
  protocolVersion: string
  hostInfo: { name: string; version: string }
  hostCapabilities: {
    /** The view may call its own server's tools (subject to approval). */
    tools?: Record<string, never>
    /** The view may read its own server's resources. */
    resources?: Record<string, never>
    /** `ui/open-link` is available. */
    openLink?: Record<string, never>
    /** `ui/message` is available. */
    message?: Record<string, never>
    /** `ui/update-model-context` is available. */
    updateModelContext?: Record<string, never>
  }
  /** Display modes this host can actually honour. */
  availableDisplayModes: McpUiDisplayMode[]
  theme: McpUiTheme
}

/**
 * Display modes Roxy supports.
 *
 * `pip` is deliberately absent: advertising a mode the host cannot honour means
 * a view renders itself for a floating window that never appears. Better to say
 * no and have the view fall back than to say yes and be wrong.
 */
export const SUPPORTED_DISPLAY_MODES: McpUiDisplayMode[] = ['inline', 'fullscreen']

/** Clamp a requested display mode to one this host actually implements. */
export function negotiateDisplayMode(requested: unknown): McpUiDisplayMode {
  return (SUPPORTED_DISPLAY_MODES as string[]).includes(requested as string)
    ? (requested as McpUiDisplayMode)
    : 'inline'
}

// ---------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------

/**
 * Bounds on how tall a view may make itself.
 *
 * A view reports its own content height and the host resizes to fit. Unbounded,
 * that is a trivial denial of service on the transcript: one card claiming
 * 900,000px pushes every other message out of reach. The floor exists so a view
 * that reports 0 during layout doesn't collapse to an invisible sliver.
 */
export const APP_HEIGHT = { min: 80, max: 1200, initial: 320 } as const

/** Clamp a self-reported height into something a transcript can hold. */
export function clampAppHeight(height: unknown): number {
  const n = typeof height === 'number' && Number.isFinite(height) ? height : APP_HEIGHT.initial
  return Math.max(APP_HEIGHT.min, Math.min(APP_HEIGHT.max, Math.round(n)))
}
