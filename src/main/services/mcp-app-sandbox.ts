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
 * its own opaque origin, the same-origin policy does the enforcement for us —
 * the proxy cannot touch Roxy's window, storage, or preload even if it tries.
 *
 * Inside it, the proxy writes the view's HTML into a NESTED iframe with the
 * resource's CSP applied. That is the "double iframe" SEP-1865 requires:
 *
 *   Roxy renderer  →  <iframe src="roxy-mcp-app://…">   (separate origin)
 *                        └─ <iframe srcdoc="…view…">    (CSP-restricted)
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
import { protocol, net } from 'electron'
import { SANDBOX_METHOD_PREFIX } from '../../shared/mcp-apps'

/** Scheme owned by the sandbox. Nothing else in Roxy serves it. */
export const SANDBOX_SCHEME = 'roxy-mcp-app'

/** The single URL the scheme serves. */
export const SANDBOX_URL = `${SANDBOX_SCHEME}://view/index.html`

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

/** Serve the proxy document. Called once, after the app is ready. */
export function serveSandbox(): void {
  protocol.handle(SANDBOX_SCHEME, async (request) => {
    const url = new URL(request.url)
    // One document, one path. Anything else 404s rather than being treated as a
    // path into something real.
    if (url.pathname !== '/index.html') {
      return new Response('Not found', { status: 404 })
    }
    return new Response(PROXY_HTML, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        // The proxy itself is ours and runs one inline script. It never loads
        // anything remote; the VIEW's policy is applied separately, on the inner
        // frame, from the resource's own declaration.
        'content-security-policy':
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src *"
      }
    })
  })
  void net
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
        // The inner frame gets scripts but NOT allow-same-origin: its document
        // is therefore opaque-origin, so it cannot read this proxy's DOM even
        // though the proxy created it. Forms and popups stay off; a view that
        // wants to navigate somewhere must ask via ui/open-link, where the host
        // can vet the URL.
        frame.setAttribute('sandbox', 'allow-scripts')
        if (p.allow) frame.setAttribute('allow', p.allow)
        // The CSP travels INSIDE the document as a meta tag, because srcdoc
        // content inherits no headers of its own.
        var meta = p.csp
          ? '<meta http-equiv="Content-Security-Policy" content="' +
            String(p.csp).replace(/"/g, '&quot;') +
            '">'
          : ''
        frame.srcdoc = meta + String(p.html || '')
        document.body.appendChild(frame)
        view = frame
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
