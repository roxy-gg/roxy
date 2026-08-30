/**
 * The MCP Apps sandbox origin — where untrusted, server-supplied HTML runs.
 *
 * ## The problem
 *
 * An MCP App is arbitrary HTML+JS written by whoever wrote the MCP server. It
 * has to execute for the feature to exist at all. The entire job of this module
 * is making sure that when it executes, it is somewhere that can hurt nothing.
 *
 * Roxy's renderer runs with `contextIsolation: true` but `sandbox: false` and a
 * preload that exposes `window.roxy` — the full IPC surface. An iframe on the
 * app's own origin could reach that, plus `localStorage`, IndexedDB, and the
 * session's cookie jar. So the view must not share Roxy's origin, and "must not"
 * has to be enforced by the browser, not by our own care.
 *
 * ## The design
 *
 * A custom `roxy-mcp-app://` protocol, registered as a standard scheme, serves
 * exactly one document: the sandbox proxy. Because it is a distinct scheme with
 * its own dedicated origin, the same-origin policy does the enforcement for us —
 * the proxy cannot touch Roxy's window, storage, or preload even if it tries.
 *
 * Inside it, the proxy writes the view's HTML into a NESTED iframe with the
 * resource's CSP applied. That is the "double iframe" SEP-1865 requires:
 *
 *   Roxy renderer  -> <iframe src="roxy-mcp-app://..."> (separate origin)
 *                         -> <iframe> + document.write    (CSP-restricted)
 *
 * The outer frame exists purely to be a different origin and to relay
 * `postMessage`. The inner frame holds the untrusted document. Neither can see
 * Roxy.
 *
 * The proxy source is inlined as a string rather than shipped as a file because
 * it must be served by the protocol handler from memory: there is no directory
 * this origin maps to, and pointing it at one would give the view a filesystem
 * root to probe.
 */
import { app, protocol, session } from 'electron'
import { SANDBOX_METHOD_PREFIX } from '../../shared/mcp-apps'

/** Scheme owned by the sandbox. Nothing else in Roxy serves it. */
export const SANDBOX_SCHEME = 'roxy-mcp-app'

/** The single URL the scheme serves. */
export const SANDBOX_URL = `${SANDBOX_SCHEME}://view/index.html`

/**
 * Build a sandbox URL carrying the app policy for the protocol handler.
 *
 * The official host serves one CSP header per app frame. A meta policy inside
 * the nested document is not equivalent: it can only make the proxy's header
 * stricter, never loosen `default-src 'none'` to permit declared Cesium/OSM
 * domains. The query is internal to this custom scheme and never reaches a
 * network server.
 */
export function sandboxUrlForCsp(csp: string): string {
  const url = new URL(SANDBOX_URL)
  url.searchParams.set('csp', csp)
  return url.toString()
}

/**
 * Register the scheme's privileges.
 *
 * MUST be called before `app.whenReady()`. `standard: true` gives it a real
 * origin (so same-origin checks apply and `postMessage` has a meaningful
 * `event.origin`); `secure: true` stops Chromium treating it as insecure
 * content. Deliberately NOT `allowServiceWorkers` or `supportFetchAPI`: a view
 * has no business persisting a worker or fetching from this origin, and the
 * network it may reach is governed by CSP instead.
 */
export function registerSandboxScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SANDBOX_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: false }
    }
  ])
}

/** The tile host used by the official map MCP App. */
export const OPENSTREETMAP_TILE_PATTERN = 'https://tile.openstreetmap.org/*'

/**
 * Identify Roxy to OSM when a native MCP App requests its standard tiles.
 *
 * A custom-scheme frame cannot send the HTTPS page referrer OSM expects from a
 * web host. Chromium instead sends a generic Electron user agent and no
 * referrer, which OSM answers with an "Access blocked" PNG (still status 200).
 * Their native-client policy accepts a stable, contactable application user
 * agent. This changes only the exact official tile host; every other app request
 * remains untouched and still has to pass its resource-declared CSP.
 */
export function identifyOpenStreetMapRequest(
  requestHeaders: Record<string, string>,
  version: string
): Record<string, string> {
  const headers = { ...requestHeaders }
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'user-agent') delete headers[key]
  }
  const safeVersion = /^[a-z0-9.+_-]+$/i.test(version) ? version : 'unknown'
  headers['User-Agent'] = `Roxy/${safeVersion} (+https://roxy.gg)`
  return headers
}

/** Serve the proxy document. Called once, after the app is ready. */
export function serveSandbox(): void {
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: [OPENSTREETMAP_TILE_PATTERN] },
    (details, callback) => {
      callback({
        requestHeaders: identifyOpenStreetMapRequest(details.requestHeaders, app.getVersion())
      })
    }
  )

  protocol.handle(SANDBOX_SCHEME, async (request) => {
    const url = new URL(request.url)
    // One document, one path. Anything else 404s rather than being treated as a
    // path into something real.
    if (url.pathname !== '/index.html') {
      return new Response('Not found', { status: 404 })
    }
    const viewCsp = url.searchParams.get('csp')
    return new Response(PROXY_HTML, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache, no-store, must-revalidate',
        // One tamper-proof policy per app frame, matching the official host.
        // The proxy script itself is inline, so script-src must retain
        // unsafe-inline even if a malformed internal URL arrives.
        'content-security-policy':
          viewCsp ||
          "default-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-src 'self'"
      }
    })
  })
}

/**
 * The sandbox proxy document.
 *
 * Responsibilities, and nothing else:
 *  1. Announce readiness to the host.
 *  2. Receive the view's HTML + CSP, write it into a nested iframe.
 *  3. Relay messages both ways, verbatim.
 *
 * It never synthesizes requests of its own (SEP-1865 §Sandbox proxy rule 7),
 * because inventing request ids would break the id-correlation both sides rely
 * on. It is a wire, not a participant.
 */
const PROXY_HTML = /* html */ `<!doctype html>
<html>
<head><meta charset="utf-8" />
<style>
  html,body{margin:0;padding:0;height:100%;background:transparent;color-scheme:inherit}
  iframe{display:block;width:100%;height:100%;border:0;background:transparent}
</style>
</head>
<body>
<script>
(function () {
  'use strict'

  // The proxy is only ever meaningful inside a frame. Loading it directly (a
  // user pasting the URL) should do nothing at all.
  if (window.self === window.top) return

  var host = window.parent
  var hostOrigin = null
  var view = null
  var SANDBOX_PREFIX = ${JSON.stringify(SANDBOX_METHOD_PREFIX)}

  function toHost(msg) {
    if (hostOrigin) host.postMessage(msg, hostOrigin)
  }

  window.addEventListener('message', function (event) {
    var data = event.data

    // ---- from the HOST ----------------------------------------------------
    // The first message pins the host's origin; everything after must match it,
    // so a nested frame cannot impersonate the host by posting upward.
    if (event.source === host) {
      if (hostOrigin === null) hostOrigin = event.origin
      if (event.origin !== hostOrigin) return

      if (data && data.method === SANDBOX_PREFIX + 'resource-ready') {
        var p = data.params || {}
        var frame = document.createElement('iframe')
        // 'allow-same-origin' is present deliberately, and it is NOT a hole:
        // the inner frame's origin is this PROXY's origin, which is already a
        // throwaway custom scheme with no storage, no cookies and no access to
        // Roxy's renderer. Same-origin here means "same as the sandbox", not
        // "same as the app".
        //
        // Without it, real views simply do not run. An opaque document cannot
        // use 'localStorage', 'indexedDB', 'SharedWorker', WebGL context
        // creation in some engines, or 'document.cookie' - and libraries like
        // CesiumJS touch several of those during startup, fail, and render a
        // white box. That is the blank map.
        //
        // 'allow-forms' matches the reference host so ordinary form controls
        // behave. Navigation is still withheld: no 'allow-top-navigation', no
        // 'allow-popups', so a view that wants to go somewhere must ask via
        // 'ui/open-link' where the host can vet the URL.
        frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms')
        if (p.allow) frame.setAttribute('allow', p.allow)
        // Assign before document.write: inline app scripts can call app.connect()
        // synchronously while write() is still running. If 'view' is null then,
        // the proxy drops ui/initialize and the app waits forever.
        view = frame
        document.body.appendChild(frame)
        // 'document.write', not 'srcdoc'. srcdoc documents are treated as
        // opaque/inherited-origin in ways that break scripts which resolve URLs
        // against 'document.baseURI' or construct workers - CesiumJS being the
        // canonical example, which is why the reference host does the same.
        // The frame must be in the DOM first for 'contentDocument' to exist.
        var doc = frame.contentDocument || (frame.contentWindow && frame.contentWindow.document)
        if (doc) {
          doc.open()
          // CSP is already a tamper-proof response header on this proxy and is
          // inherited by the about:blank child. Adding a meta policy here would
          // intersect with it and can only make the app stricter.
          doc.write(String(p.html || ''))
          doc.close()
        } else {
          // Only reachable if the frame was blocked from initialising at all.
          frame.srcdoc = String(p.html || '')
        }
        return
      }

      // Anything else from the host is for the view. Never forward the reserved
      // sandbox namespace onward.
      if (data && typeof data.method === 'string' && data.method.indexOf(SANDBOX_PREFIX) === 0) {
        return
      }
      if (view && view.contentWindow) view.contentWindow.postMessage(data, '*')
      return
    }

    // ---- from the VIEW ----------------------------------------------------
    // Only the frame we created may speak. Anything else posting into this
    // window is not part of the conversation.
    if (view && event.source === view.contentWindow) {
      // Window identity survives a self-navigation. Check origin too, otherwise
      // a view that navigated itself to an external page would keep the same
      // contentWindow handle and that page could speak through this broker.
      if (event.origin !== window.location.origin) return
      if (data && typeof data.method === 'string' && data.method.indexOf(SANDBOX_PREFIX) === 0) {
        return
      }
      toHost(data)
    }
  })

  // Tell the host we can accept a resource. Sent with '*' because the host's
  // origin is not yet known - this notification carries no data, and the host
  // verifies the source frame on its side.
  host.postMessage({ jsonrpc: '2.0', method: SANDBOX_PREFIX + 'proxy-ready', params: {} }, '*')
})()
</script>
</body>
</html>`
