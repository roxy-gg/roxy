/**
 * OAuth for remote MCP servers.
 *
 * A remote MCP server is an HTTP API, and the interesting ones are the ones that
 * hold something worth protecting - your issues, your calendar, your database.
 * The spec's answer is OAuth 2.1 with dynamic client registration and PKCE, and
 * the SDK implements the whole dance provided the host supplies two things:
 * somewhere to persist credentials, and a way to put a browser in front of the
 * user for the one interactive step.
 *
 * This module is that host side.
 *
 * ## Why a bespoke store
 *
 * Tokens are persisted through `secure.ts` (OS keychain via Electron
 * `safeStorage`, base64 fallback) rather than dropped in the settings table as
 * plain JSON, for the same reason every other credential in Roxy is: a refresh
 * token is a long-lived bearer credential for a third-party account, and a
 * config file is not a place to keep one.
 *
 * Everything is keyed by SERVER ID rather than by issuer, because that is the
 * identity the rest of the MCP subsystem uses. A server pointed at a new URL is
 * a new authorization anyway - the stored client registration no longer matches
 * the issuer, and the SDK re-registers.
 *
 * ## Why the callback is a loopback server
 *
 * The redirect has to land somewhere. A custom protocol handler (`roxy://`) is
 * the other option, but it needs OS-level registration that only exists in a
 * packaged build - so it would work in production and silently fail in dev,
 * which is the worst possible split for an auth flow. An ephemeral loopback
 * listener works identically everywhere and is what the spec recommends for
 * native apps (RFC 8252).
 */
import { createServer, type Server } from 'node:http'
import { shell } from 'electron'
import type { OAuthClientProvider } from '@modelcontextprotocol/client'
import * as repo from '../db/repo'

/**
 * How long the loopback listener waits for the browser to come back before it
 * gives up and frees the port.
 *
 * Generous: this window covers a human signing in, possibly creating an account
 * and clearing an MFA prompt on a phone. Too short and the flow fails at the
 * exact moment the user finally finished.
 */
const CALLBACK_TIMEOUT = 5 * 60_000

/** Loopback host for the redirect. Literal IP, not `localhost`. */
const CALLBACK_HOST = '127.0.0.1'

/** What the browser tab shows once the redirect has been captured. */
const DONE_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Signed in</title>
<style>body{font:15px system-ui;margin:0;height:100vh;display:grid;place-items:center;background:#18181b;color:#e4e4e7}
div{text-align:center}p{color:#a1a1aa;font-size:13px}</style></head>
<body><div><h2>Signed in</h2><p>You can close this tab and return to Roxy.</p></div></body></html>`

/**
 * One pending authorization: the loopback listener and the promise the connect
 * path is waiting on.
 */
interface PendingAuth {
  server: Server
  redirectUrl: string
  /** Resolves with the full callback query once the browser hits the listener. */
  code: Promise<URLSearchParams>
}

const pending = new Map<string, PendingAuth>()

/**
 * Start (or reuse) a loopback listener for one server's redirect.
 *
 * Port 0 lets the OS pick a free port; the chosen one becomes part of the
 * redirect URI, so nothing is hardcoded and two servers authorizing at once
 * cannot collide.
 */
async function listenForCallback(serverId: string): Promise<PendingAuth> {
  const existing = pending.get(serverId)
  if (existing) return existing

  let resolveCode: (params: URLSearchParams) => void
  let rejectCode: (err: Error) => void
  const code = new Promise<URLSearchParams>((res, rej) => {
    resolveCode = res
    rejectCode = rej
  })

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${CALLBACK_HOST}`)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(DONE_PAGE)
    resolveCode(url.searchParams)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, CALLBACK_HOST, resolve)
  })

  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const entry: PendingAuth = {
    server,
    redirectUrl: `http://${CALLBACK_HOST}:${port}/callback`,
    code
  }
  pending.set(serverId, entry)

  const timer = setTimeout(() => {
    rejectCode(new Error('Timed out waiting for the browser to complete sign-in.'))
    closeCallback(serverId)
  }, CALLBACK_TIMEOUT)
  // Never hold the process open on this listener alone.
  timer.unref?.()
  void code.finally(() => clearTimeout(timer))

  return entry
}

/** Tear down a server's loopback listener, if any. */
export function closeCallback(serverId: string): void {
  const entry = pending.get(serverId)
  if (!entry) return
  pending.delete(serverId)
  try {
    entry.server.close()
  } catch {
    /* already closed */
  }
}

/**
 * The `OAuthClientProvider` the SDK drives.
 *
 * The SDK owns the protocol (discovery, PKCE, registration, refresh); this
 * supplies persistence and the one step a library cannot do for itself - putting
 * the authorization URL in front of a human.
 */
export function mcpAuthProvider(serverId: string, redirectUrl: string): OAuthClientProvider {
  return {
    get redirectUrl() {
      return redirectUrl
    },
    get clientMetadata() {
      return {
        client_name: 'Roxy',
        redirect_uris: [redirectUrl],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none'
      }
    },
    clientInformation() {
      return repo.getMcpOAuthClient(serverId) ?? undefined
    },
    saveClientInformation(info) {
      repo.saveMcpOAuthClient(serverId, info)
    },
    tokens() {
      return repo.getMcpOAuthTokens(serverId) ?? undefined
    },
    saveTokens(tokens) {
      repo.saveMcpOAuthTokens(serverId, tokens)
    },
    redirectToAuthorization(authorizationUrl) {
      // The only genuinely interactive step. Opened in the user's real browser,
      // not an embedded window: they may already have a session there, and an
      // embedded view asking for third-party credentials is a phishing pattern
      // even when it is legitimate.
      void shell.openExternal(authorizationUrl.toString())
    },
    saveCodeVerifier(verifier) {
      repo.saveMcpOAuthVerifier(serverId, verifier)
    },
    codeVerifier() {
      const v = repo.getMcpOAuthVerifier(serverId)
      if (!v) throw new Error('No PKCE code verifier is stored for this server.')
      return v
    }
  }
}

/**
 * Run one interactive authorization for a server.
 *
 * Returns the callback query so the caller can hand it to `finishAuth`, which
 * validates `iss` (RFC 9207) and exchanges the code.
 */
export async function awaitAuthorization(serverId: string): Promise<URLSearchParams> {
  const entry = pending.get(serverId)
  if (!entry) throw new Error('No authorization is in progress for this server.')
  try {
    return await entry.code
  } finally {
    closeCallback(serverId)
  }
}

/** Prepare a listener and return the redirect URI to register with the server. */
export async function prepareAuthorization(serverId: string): Promise<string> {
  const entry = await listenForCallback(serverId)
  return entry.redirectUrl
}

/** Forget every stored credential for a server (used when it is removed). */
export function clearMcpAuth(serverId: string): void {
  closeCallback(serverId)
  repo.clearMcpOAuth(serverId)
}
