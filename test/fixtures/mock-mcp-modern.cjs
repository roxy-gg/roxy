/**
 * Mock MCP server speaking the MODERN protocol era (revision 2026-07-28).
 *
 * The sibling `mock-mcp.cjs` is a 2025-era server: it answers `initialize` and
 * returns method-not-found for anything it doesn't know. This one is its
 * opposite - it answers `server/discover` and refuses `initialize` - so together
 * they pin BOTH branches of `versionNegotiation: { mode: 'auto' }`:
 *
 *   mock-mcp.cjs        -> probe rejected -> fall back to `initialize` -> legacy
 *   mock-mcp-modern.cjs -> probe answered -> no handshake               -> modern
 *
 * Without this fixture the auto-negotiation path would be half-tested: a suite
 * where every server is legacy passes just as well with negotiation switched off
 * entirely, which is precisely the regression worth catching.
 *
 * Tools mirror the legacy mock (`echo`, `boom`) and add `structured`, which
 * returns ONLY `structuredContent` - the case where a result carries typed data
 * and no text blocks at all.
 *
 * Run as: <node|electron-as-node> mock-mcp-modern.cjs
 */
'use strict'

const PROTOCOL_VERSION = '2026-07-28'

let buf = ''

// Larger than Roxy's normal 200k model-text cap, matching the published map
// app (~343k). If app HTML is treated as prose this is truncated mid-bundle.
const MOCK_APP_HTML =
  '<!doctype html><html><body><h1>hi</h1><script>window.__complete=true</script>' +
  'x'.repeat(342000) +
  '<!--app-complete--></body></html>'
const MOCK_APP_META = {
  ui: {
    csp: {
      connectDomains: ['https://*.openstreetmap.org', 'https://cesium.com', 'https://*.cesium.com'],
      resourceDomains: ['https://*.openstreetmap.org', 'https://cesium.com', 'https://*.cesium.com']
    }
  }
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  for (;;) {
    const nl = buf.indexOf('\n')
    if (nl < 0) break
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    handle(msg)
  }
})

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

/**
 * Reply with a successful result.
 *
 * Every modern-era result MUST carry `resultType`: the 2026-07-28 revision
 * removed the "absent means complete" bridge that earlier revisions allowed, and
 * the SDK rejects a result without it. Funnelling every success through one
 * helper keeps that invariant in a single place.
 */
function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result: { resultType: 'complete', ...result } })
}

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo back the provided message.',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string', description: 'Text to echo' } },
      required: ['message']
    }
  },
  {
    name: 'boom',
    description: 'Always fails (for error-path testing).',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    // Declared app-only: it exists for the VIEW to call, and SEP-1865 says the
    // host MUST NOT offer it to the model.
    name: 'set_cell',
    description: 'Internal operation for the view.',
    inputSchema: { type: 'object', properties: {} },
    _meta: { 'io.modelcontextprotocol/ui': { visibility: ['app'] } }
  },
  {
    // Never answers within the test's patience: used to prove a cancelled call
    // stops waiting rather than hanging for the full request timeout.
    name: 'slow',
    description: 'Never replies.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    // Returns a mixed result: prose, an addressable resource link, a second
    // image, and result-level _meta. The flat projection can represent none of
    // it faithfully, which is the point.
    name: 'rich',
    description: 'Returns mixed content plus result metadata.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    // Declares an outputSchema and returns ONLY structuredContent, so the
    // client's structured-result handling is exercised for real.
    name: 'structured',
    description: 'Returns typed output and no text blocks.',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: {
      type: 'object',
      properties: { total: { type: 'number' }, currency: { type: 'string' } },
      required: ['total', 'currency']
    },
    // Extension metadata must survive discovery intact; MCP Apps keys its UI
    // off exactly this shape.
    // Short key on purpose: this is what @modelcontextprotocol/ext-apps'
    // registerAppTool emits, and what every published example server carries.
    _meta: { ui: { resourceUri: 'ui://mockmodern/app.html' } }
  }
]

function handle(msg) {
  if (msg.id === undefined || msg.id === null) return

  switch (msg.method) {
    // The modern-era advertisement that replaces the `initialize` handshake.
    //
    // Shape matters: the field is `supportedVersions` (NOT `protocolVersions`),
    // and server identity lives in `_meta['io.modelcontextprotocol/serverInfo']`
    // rather than a top-level `serverInfo`. Get either wrong and the client
    // rejects the advertisement and quietly falls back to `initialize` - i.e.
    // the test would still pass while proving the opposite of what it claims.
    case 'server/discover':
      sendResult(msg.id, {
        supportedVersions: [PROTOCOL_VERSION],
        capabilities: { tools: {}, resources: {} },
        _meta: {
          'io.modelcontextprotocol/serverInfo': { name: 'mock-mcp-modern', version: '0.0.1' }
        }
      })
      return
    // Deliberately refused: a modern server does not implement `initialize`.
    // Answering it would make this fixture indistinguishable from the legacy
    // mock and quietly defeat the point of the test.
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: 'initialize is not supported (modern era)' }
      })
      return
    // Modern-era list results carry cache hints (SEP-2549). They are required,
    // not optional: the client validates the wire shape and rejects a list
    // without them. `ttlMs: 0` means "usable, but don't hold it" - the honest
    // answer for a fixture whose tool list is fixed for the life of the process.
    case 'resources/list':
      sendResult(msg.id, {
        resources: [
          {
            uri: 'ui://mockmodern/app.html',
            name: 'app.html',
            mimeType: 'text/html;profile=mcp-app'
          },
          { uri: 'file:///notes.txt', name: 'notes.txt', mimeType: 'text/plain' }
        ],
        ttlMs: 0,
        cacheScope: 'private'
      })
      return
    case 'resources/read': {
      const uri = msg.params && msg.params.uri
      if (uri === 'ui://mockmodern/app.html') {
        // The shape MCP Apps uses: an HTML view delivered as a resource.
        sendResult(msg.id, {
          contents: [
            {
              uri,
              mimeType: 'text/html;profile=mcp-app',
              text: MOCK_APP_HTML,
              // Content-level metadata is where the official map server puts
              // its Cesium/OpenStreetMap CSP.
              _meta: MOCK_APP_META
            }
          ],
          ttlMs: 0,
          cacheScope: 'private'
        })
        return
      }
      if (uri === 'file:///notes.txt') {
        sendResult(msg.id, {
          contents: [{ uri, mimeType: 'text/plain', text: 'note body' }],
          ttlMs: 0,
          cacheScope: 'private'
        })
        return
      }
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32602, message: 'Unknown resource: ' + String(uri) }
      })
      return
    }
    case 'tools/list':
      sendResult(msg.id, { tools: TOOLS, ttlMs: 0, cacheScope: 'private' })
      return
    case 'tools/call': {
      const name = msg.params && msg.params.name
      const args = (msg.params && msg.params.arguments) || {}
      if (name === 'echo') {
        sendResult(msg.id, {
          content: [{ type: 'text', text: 'echo: ' + String(args.message ?? '') }]
        })
        return
      }
      if (name === 'boom') {
        sendResult(msg.id, {
          content: [{ type: 'text', text: 'boom: intentional failure' }],
          isError: true
        })
        return
      }
      if (name === 'set_cell') {
        sendResult(msg.id, { content: [{ type: 'text', text: 'cell set' }] })
        return
      }
      if (name === 'slow') {
        // Deliberately no reply, ever.
        return
      }
      if (name === 'rich') {
        sendResult(msg.id, {
          content: [
            { type: 'text', text: 'here is the report' },
            {
              type: 'resource_link',
              uri: 'file:///repo/report.pdf',
              name: 'report.pdf',
              mimeType: 'application/pdf'
            },
            { type: 'image', data: 'AAA', mimeType: 'image/png' },
            { type: 'image', data: 'BBB', mimeType: 'image/jpeg' }
          ],
          _meta: { 'io.modelcontextprotocol/ui': { resourceUri: 'ui://mockmodern/app.html' } }
        })
        return
      }
      if (name === 'structured') {
        sendResult(msg.id, {
          content: [],
          structuredContent: { total: 61.5, currency: 'EUR' },
          _meta: { viewUUID: 'mock-view-uuid' }
        })
        return
      }
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32602, message: 'Unknown tool: ' + String(name) }
      })
      return
    }
    default:
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } })
  }
}
