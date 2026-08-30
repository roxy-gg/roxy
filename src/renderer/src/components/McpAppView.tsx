import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Globe, Maximize2, Minimize2, ShieldAlert, X } from 'lucide-react'
import type { McpAppLaunch } from '@shared/api'
import { APP_HEIGHT, clampAppHeight, SANDBOX_POST_TARGET } from '@shared/mcp-apps'
import { api } from '../lib/api'
import { cn } from '../lib/cn'

/**
 * Renders one MCP App — a server-supplied UI — inside a tool card.
 *
 * ## What this component is careful about
 *
 * The HTML being mounted is untrusted third-party code. This component never
 * touches it: it hands the markup to a sandbox frame on a DIFFERENT ORIGIN and
 * relays JSON-RPC frames. There is no `dangerouslySetInnerHTML` anywhere, and no
 * path by which the view's script reaches React state, the preload bridge, or
 * another server.
 *
 * The message plumbing is deliberately paranoid in three specific ways:
 *
 *  1. **Source-checked, not origin-checked-only.** Every inbound message is
 *     compared against `frame.contentWindow`. Origin alone is not enough: every
 *     app view shares the one sandbox origin, so two cards in the same
 *     transcript would otherwise be able to answer each other's requests.
 *  2. **Targeted replies.** Responses go to the frame's window with an explicit
 *     origin, never `'*'` — a wildcard reply is readable by whatever happens to
 *     be listening if the frame navigates.
 *  3. **Nothing before `initialized`.** The host sends no notification until the
 *     view says it is ready, per SEP-1865; sending early loses the message and
 *     leaves the view waiting for data it will never get again.
 */
export function McpAppView({
  serverId,
  toolName,
  resourceUri,
  toolInput,
  toolResult
}: {
  serverId: string
  /** Qualified tool name (`mcp__server__tool`) whose call produced this view. */
  toolName: string
  /** The `ui://` resource holding the view. */
  resourceUri: string
  /** Arguments the model passed, forwarded to the view once it initializes. */
  toolInput?: unknown
  /** The tool's own result, forwarded the same way. */
  toolResult?: unknown
}): JSX.Element | null {
  const { t } = useTranslation()
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [launch, setLaunch] = useState<McpAppLaunch | null>(null)
  const [failed, setFailed] = useState(false)
  const [height, setHeight] = useState<number>(APP_HEIGHT.initial)
  const [fullscreen, setFullscreen] = useState(false)

  // Load the view's HTML once per tool call.
  useEffect(() => {
    let alive = true
    void api.mcp.app
      .launch({ serverId, toolName, resourceUri })
      .then((res) => {
        if (!alive) return
        if (res) setLaunch(res)
        else setFailed(true)
      })
      .catch(() => alive && setFailed(true))
    return () => {
      alive = false
    }
  }, [serverId, toolName, resourceUri])

  // Tear the session down when the card unmounts. Without this, scrolling a long
  // transcript would leave a broker session (and its retained result) alive for
  // every app card ever rendered.
  useEffect(() => {
    const id = launch?.sessionId
    if (!id) return
    return () => {
      void api.mcp.app.close(id)
    }
  }, [launch?.sessionId])

  // The bridge. One listener per mounted view, filtered to its own frame.
  useEffect(() => {
    const sessionId = launch?.sessionId
    const frame = frameRef.current
    if (!sessionId || !frame) return

    let proxyReady = false
    let viewReady = false

    const post = (msg: unknown): void => {
      // Explicit target origin, never '*'.
      frame.contentWindow?.postMessage(msg, SANDBOX_POST_TARGET)
    }

    /** Hand the view its tool input + result, once it says it is listening. */
    const sendOpeningData = (): void => {
      if (!viewReady) return
      if (toolInput !== undefined) {
        // The official App SDK validates this envelope. Sending the arguments
        // object directly (the old behavior) makes `ontoolinput` receive no
        // arguments, so the map ignores the requested bounds and stays at its
        // default location.
        post({
          jsonrpc: '2.0',
          method: 'ui/notifications/tool-input',
          params: { arguments: toolInput }
        })
      }
      const result = launch.toolResult ?? toolResult
      if (result !== undefined) {
        // Standard MCP CallToolResult, including result-level `_meta` such as
        // the map server's viewUUID. Never send the card's flattened string
        // when the bounded structured result is available.
        post({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result })
      }
    }

    const onMessage = async (event: MessageEvent): Promise<void> => {
      // Identity check first: this frame, not merely this origin. Every view
      // shares the sandbox origin, so origin alone would let one card's view
      // answer another card's requests.
      if (event.source !== frame.contentWindow) return

      const data = event.data as {
        jsonrpc?: string
        id?: string | number | null
        method?: string
        params?: Record<string, unknown>
      }
      if (!data || data.jsonrpc !== '2.0') return

      // The proxy announcing itself: hand over the HTML + its policy.
      if (data.method === 'ui/notifications/sandbox-proxy-ready') {
        proxyReady = true
        post({
          jsonrpc: '2.0',
          method: 'ui/notifications/sandbox-resource-ready',
          params: { html: launch.html, csp: launch.csp, allow: launch.allow }
        })
        return
      }
      if (!proxyReady) return

      // The view finished its handshake; only now may the host speak to it.
      if (data.method === 'ui/notifications/initialized') {
        viewReady = true
        sendOpeningData()
        return
      }

      // Height reports resize the card. Clamped in shared code so a view cannot
      // claim 900,000px and push the rest of the transcript out of reach.
      if (data.method === 'ui/notifications/size-changed') {
        setHeight(clampAppHeight((data.params as { height?: number })?.height))
        return
      }

      // Everything else goes to the broker in main, which decides whether it is
      // allowed and executes it against this view's own server.
      const reply = await api.mcp.app.request({
        sessionId,
        id: data.id,
        method: data.method,
        params: data.params
      })

      // Notifications carry no id and get no response.
      if (data.id === undefined || data.id === null) return
      post(
        reply.error
          ? { jsonrpc: '2.0', id: data.id, error: reply.error }
          : { jsonrpc: '2.0', id: data.id, result: reply.result ?? {} }
      )
    }

    const listener = (e: MessageEvent): void => void onMessage(e)
    window.addEventListener('message', listener)
    return () => window.removeEventListener('message', listener)
  }, [launch, toolInput, toolResult])

  // Publish the host theme so the view can match it. Read from the live document
  // rather than a constant, so a theme switch is reflected on the next mount.
  useEffect(() => {
    if (!launch) return
    const styles = getComputedStyle(document.documentElement)
    const read = (name: string): string => styles.getPropertyValue(name).trim()
    api.mcp.app.setTheme({
      mode: document.documentElement.classList.contains('light') ? 'light' : 'dark',
      variables: {
        '--mcp-ui-background': read('--color-surface'),
        '--mcp-ui-foreground': read('--color-text'),
        '--mcp-ui-muted': read('--color-text-muted'),
        '--mcp-ui-border': read('--color-border'),
        '--mcp-ui-accent': read('--color-accent'),
        '--mcp-ui-font-family': read('--font-sans') || 'system-ui, sans-serif'
      }
    })
  }, [launch])

  if (failed) return null
  if (!launch) {
    return (
      <div className="border-t border-border bg-surface px-3 py-2 text-xs text-text-subtle">
        {t('mcpApp.loading')}
      </div>
    )
  }

  const canFullscreen = launch.displayModes.includes('fullscreen')

  return (
    <div
      className={cn(
        'flex flex-col border-t border-border bg-surface',
        fullscreen && 'fixed inset-0 z-[70] border-0 bg-black/70 p-6'
      )}
    >
      <div
        className={cn(
          'flex flex-col overflow-hidden',
          fullscreen && 'h-full rounded-2xl border border-border bg-surface'
        )}
      >
        {/* The boundary marker. A sandboxed view can draw anything it likes,
            including a convincing copy of Roxy's own chrome, so the user needs a
            piece of UI outside the frame telling them where the app ends. */}
        <div className="flex items-center gap-2 border-b border-border/60 bg-surface-2 px-2.5 py-1">
          <ShieldAlert className="h-3 w-3 shrink-0 text-text-subtle" />
          <span className="truncate text-[10px] uppercase tracking-wide text-text-subtle">
            {t('mcpApp.boundary', { server: serverId })}
          </span>
          {launch.externalDomains.length > 0 && (
            <span
              className="flex shrink-0 items-center gap-1 text-[10px] text-warning"
              title={launch.externalDomains.join(', ')}
            >
              <Globe className="h-3 w-3" />
              {t('mcpApp.external', { count: launch.externalDomains.length })}
            </span>
          )}
          {canFullscreen && (
            <button
              onClick={() => setFullscreen((f) => !f)}
              aria-label={fullscreen ? t('mcpApp.exitFullscreen') : t('mcpApp.fullscreen')}
              className="press-scale ml-auto rounded p-0.5 text-text-subtle hover:text-text"
            >
              {fullscreen ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
            </button>
          )}
          {fullscreen && (
            <button
              onClick={() => setFullscreen(false)}
              aria-label={t('common.close')}
              className="press-scale rounded p-0.5 text-text-subtle hover:text-text"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        <iframe
          ref={frameRef}
          // Per-app URL: the custom-scheme handler serves the CSP declared by
          // this resource as a response header. A static URL always gets the
          // fallback policy and blocks Cesium's CDN/OSM tiles.
          src={launch.sandboxUrl}
          title={t('mcpApp.frameTitle', { server: serverId })}
          // Matches the official host. `allow-same-origin` means same as the
          // dedicated roxy-mcp-app:// sandbox, never same as Roxy's renderer;
          // popups and top-level navigation remain withheld.
          sandbox="allow-scripts allow-same-origin allow-forms"
          allow={launch.allow || undefined}
          style={{ height: fullscreen ? '100%' : `${height}px` }}
          className="w-full border-0 bg-transparent"
        />
      </div>
    </div>
  )
}
