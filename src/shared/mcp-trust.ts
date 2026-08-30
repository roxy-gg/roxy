/**
 * MCP server trust — deciding when Roxy may start a server, and what to tell the
 * user when it does.
 *
 * Pure logic only (no Node/Electron/SDK imports) so every rule here is unit
 * tested in smoke:shared. Store + prompt plumbing lives in
 * `src/main/services/mcp-trust.ts`.
 *
 * ## The stance
 *
 * Installing an MCP server is like installing an extension: the user picked the
 * source, and picking the source IS the decision. Roxy is not in a position to
 * second-guess it — an approval dialog in front of an action the user just took
 * teaches nothing, and a dialog people always approve is worse than no dialog,
 * because it trains the reflex that later waves through the one that mattered.
 *
 * So the default is YES: servers connect, and the user is TOLD what happened —
 * which tools appeared, and where they came from. Disclosure after the fact,
 * not permission before it.
 *
 * Two things are still gated, because neither is a decision the user made:
 *
 *  - **A definition Roxy has never shown anyone.** Not a veto, a notification:
 *    the servers a project declares are surfaced with their tools, once.
 *  - **A trusted entry whose command changed.** Approving `npx server-github`
 *    is not approving whatever replaced it. This is the one case that gets a
 *    real, blocking prompt, because it is the one case the user did not do.
 *
 * The warning belongs where the trust actually lives: the SOURCE. An MCP server
 * runs with your privileges, so the honest message is "trust the source you got
 * this from", not "are you sure?" — a question the user cannot answer better
 * than they already did when they chose it.
 */

import type { McpServerConfig, McpLocalConfig, McpRemoteConfig } from './mcp'

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * Where a server definition came from. Drives what the user is TOLD, and (for
 * the one blocking case) whether they are asked.
 *
 * - `user`      added in Settings / the MCP page.
 * - `workspace` declared by a project file (`.roxy/mcp.json`).
 * - `agent`     added by the model via the `mcp` tool.
 * - `import`    arrived in a portable config bundle.
 */
export type McpProvenance = 'user' | 'workspace' | 'agent' | 'import'

// ---------------------------------------------------------------------------
// Fingerprinting — the identity a remembered decision is bound to
// ---------------------------------------------------------------------------

/**
 * Canonical string identifying WHAT WILL EXECUTE, so Roxy can tell "the server
 * you already know" from "something else wearing its name".
 *
 * Included, because changing any of them changes what runs:
 *   local  → argv, cwd, and the NAMES of injected env vars
 *   remote → scheme, host, port, path, and the NAMES of injected headers
 *
 * Excluded, deliberately:
 *   - env/header VALUES. They are secrets (`GITHUB_TOKEN`), and rotating a token
 *     is not a new decision. The NAMES are in, because gaining
 *     `AWS_SECRET_ACCESS_KEY` where there was none is.
 *   - `timeout`. A number that cannot change what executes.
 *   - the server id. Renaming an entry is not re-installing it.
 *
 * Not a hash: this string is shown in the UI and diffed in tests, so it is kept
 * legible on purpose. It is an identity key, never a security token.
 */
export function fingerprintConfig(config: McpServerConfig): string {
  if (config.type === 'local') {
    const cfg = config as McpLocalConfig
    const argv = cfg.command.join('\u0000')
    const cwd = cfg.cwd ?? ''
    const envNames = Object.keys(cfg.environment ?? {})
      .sort()
      .join(',')
    return `local\u0001${argv}\u0001${cwd}\u0001${envNames}`
  }
  const cfg = config as McpRemoteConfig
  const headerNames = Object.keys(cfg.headers ?? {})
    .sort()
    .join(',')
  return `remote\u0001${canonicalUrl(cfg.url)}\u0001${headerNames}`
}

/**
 * Normalize a URL for fingerprinting so cosmetic differences (case, a trailing
 * slash, the default port) don't read as a different server.
 *
 * Query and fragment are KEPT: `?tenant=acme` can select an entirely different
 * backend. An unparseable URL falls back to the trimmed raw string — a config
 * that cannot be parsed must never silently collapse onto another's identity.
 */
function canonicalUrl(raw: string): string {
  try {
    const u = new URL(raw.trim())
    const protocol = u.protocol.toLowerCase()
    const host = u.hostname.toLowerCase()
    const port = u.port && !isDefaultPort(protocol, u.port) ? `:${u.port}` : ''
    const path = u.pathname.replace(/\/+$/, '')
    return `${protocol}//${host}${port}${path}${u.search}${u.hash}`
  } catch {
    return raw.trim()
  }
}

function isDefaultPort(protocol: string, port: string): boolean {
  return (protocol === 'http:' && port === '80') || (protocol === 'https:' && port === '443')
}

// ---------------------------------------------------------------------------
// Disclosure — what the user is shown
// ---------------------------------------------------------------------------

/**
 * The facts about a server, derived from its config so the UI cannot drift from
 * what actually runs, and so the copy is testable without rendering React.
 */
export interface McpDisclosure {
  transport: 'local' | 'remote'
  /** The resolved executable — argv[0] for a local server. */
  executable?: string
  /** Arguments after argv[0], verbatim (never re-quoted or shortened). */
  args?: string[]
  /** Working directory as written; `undefined` means the workspace root. */
  cwd?: string
  /** NAMES of injected env vars, sorted. Values are never included. */
  envNames?: string[]
  /** Full URL for a remote server. */
  url?: string
  /** Host of the remote URL — the thing to actually recognise or not. */
  host?: string
  /** NAMES of injected headers, sorted. Values are never included. */
  headerNames?: string[]
  /** Whether any credential-shaped env var / header is being injected. */
  injectsSecrets: boolean
  /**
   * The package or host the server comes FROM (`@modelcontextprotocol/server-github`,
   * `api.acme.com`). This is the thing worth trusting or not, so it is the thing
   * the UI leads with.
   */
  source: string
}

/** Env/header names that look like credentials, for the "shares a secret" note. */
const SECRET_NAME =
  /(?:^|_)(?:token|key|secret|password|passwd|credential|auth|apikey|session)s?(?:_|$)/i

/** Runners that front for a package: the interesting name is their argument. */
const PACKAGE_RUNNERS = /^(?:npx|pnpx|bunx|uvx|pipx|deno|dlx)$/i

/** Flags to skip when hunting for the package name after a runner. */
const RUNNER_FLAGS = /^-/

/**
 * The source a server actually comes from.
 *
 * `npx -y @modelcontextprotocol/server-github` is not meaningfully "npx" — it is
 * the package, and the package is what the user is being asked to trust. Same
 * for a remote server: the host, not the full URL with its path and query.
 */
export function sourceOf(config: McpServerConfig): string {
  if (config.type === 'remote') {
    try {
      return new URL(config.url).host
    } catch {
      return config.url
    }
  }
  const [exe, ...rest] = (config as McpLocalConfig).command
  if (!exe) return ''
  const base = exe.replace(/\\/g, '/').split('/').pop() ?? exe
  if (PACKAGE_RUNNERS.test(base.replace(/\.(?:exe|cmd|bat)$/i, ''))) {
    const pkg = rest.find((a) => !RUNNER_FLAGS.test(a))
    if (pkg) return pkg
  }
  return base
}

/** Build the disclosure shown alongside a server. */
export function describeConfig(config: McpServerConfig): McpDisclosure {
  if (config.type === 'local') {
    const cfg = config as McpLocalConfig
    const [executable, ...args] = cfg.command
    const envNames = Object.keys(cfg.environment ?? {}).sort()
    return {
      transport: 'local',
      executable: executable ?? '',
      args,
      cwd: cfg.cwd,
      envNames,
      injectsSecrets: envNames.some((n) => SECRET_NAME.test(n)),
      source: sourceOf(config)
    }
  }
  const cfg = config as McpRemoteConfig
  const headerNames = Object.keys(cfg.headers ?? {}).sort()
  let host: string | undefined
  try {
    host = new URL(cfg.url).host
  } catch {
    host = undefined
  }
  return {
    transport: 'remote',
    url: cfg.url,
    host,
    headerNames,
    injectsSecrets: headerNames.some((n) => SECRET_NAME.test(n) || /^authorization$/i.test(n)),
    source: sourceOf(config)
  }
}

/**
 * A one-line summary for compact UI (list rows, the agent's tool output).
 * Local servers show the command; remote servers show the host, since the full
 * URL of an API endpoint is noise in a list.
 */
export function summarizeConfig(config: McpServerConfig): string {
  const d = describeConfig(config)
  if (d.transport === 'local') {
    return [d.executable, ...(d.args ?? [])].filter(Boolean).join(' ')
  }
  return d.host || d.url || ''
}

// ---------------------------------------------------------------------------
// Stored decisions
// ---------------------------------------------------------------------------

/** A remembered decision about one server. */
export interface McpTrustEntry {
  /** Server id as it was when decided (display only — identity is the fingerprint). */
  id: string
  /** `fingerprintConfig` of the config this decision covers. */
  fingerprint: string
  /** Where it came from when the decision was made. */
  provenance: McpProvenance
  /**
   * Absolute workspace path this decision is scoped to, or null for "anywhere".
   *
   * Workspace-declared servers are scoped so that one project's `db` server is
   * not confused with a different project's `db` server.
   */
  scope: string | null
  decision: 'allow' | 'deny'
  decidedAt: number
}

/** A whole workspace the user chose to trust, covering its current + future servers. */
export interface McpWorkspaceTrust {
  /** Absolute workspace path. */
  path: string
  trustedAt: number
}

/** The persisted trust state, as handed to the pure resolver. */
export interface McpTrustStore {
  entries: McpTrustEntry[]
  workspaces: McpWorkspaceTrust[]
}

/** User-controlled policy knobs. */
export interface McpTrustPolicy {
  /**
   * Ask before starting any server Roxy hasn't run before, instead of starting
   * it and reporting what it exposed.
   *
   * OFF by default: installing a server is itself the decision, so the useful
   * output is "here is what it gave you", not "are you sure?". People who want
   * the stricter posture (shared machines, untrusted repos) can opt in.
   */
  confirmBeforeRun: boolean
}

export const DEFAULT_TRUST_POLICY: McpTrustPolicy = { confirmBeforeRun: false }

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/** Why a server may start (or must not) — surfaced in logs, tests, and the UI. */
export type McpTrustReason =
  /** The user configured it themselves. */
  | 'self-consented'
  /** The user trusted the whole workspace. */
  | 'workspace-trusted'
  /** A stored allow decision matched this exact fingerprint. */
  | 'remembered-allow'
  /** A stored deny decision matched this exact fingerprint. */
  | 'remembered-deny'
  /** Not seen before; allowed, and disclosed to the user afterwards. */
  | 'first-run'
  /** Not seen before, and the user opted into confirming first. */
  | 'confirm-first-run'
  /** Approved before, but what would execute has changed since. */
  | 'changed'

export interface McpTrustDecision {
  allowed: boolean
  /** True when the user must be asked BEFORE this server may start. */
  needsPrompt: boolean
  /**
   * True when the server may start, but the user should be TOLD - with its tool
   * list and source - once it is up. The disclosure that replaces a prompt.
   */
  needsDisclosure: boolean
  reason: McpTrustReason
  /** For `changed`, the fingerprint that was previously approved. */
  previousFingerprint?: string
}

/**
 * Decide what happens with a server. Pure: same inputs, same answer, no I/O.
 *
 * Order matters:
 *   1. A remembered DENY — the user said no; honour it without re-asking.
 *   2. A remembered ALLOW for this exact fingerprint — silent, the steady state.
 *   3. A fingerprint MISMATCH → `changed`. The one blocking prompt: the user
 *      approved a different command, and swapping it is not their decision.
 *      Checked before workspace trust so a swap resurfaces even in a trusted
 *      project.
 *   4. Self-consent / workspace trust → run silently.
 *   5. Anything else → RUN, and disclose (or prompt, if the user opted in).
 */
export function decideTrust(input: {
  id: string
  config: McpServerConfig
  provenance: McpProvenance
  /** Absolute workspace path, when the server is scoped to one. */
  workspace?: string | null
  store: McpTrustStore
  policy?: McpTrustPolicy
}): McpTrustDecision {
  const { id, config, provenance, store } = input
  const policy = input.policy ?? DEFAULT_TRUST_POLICY
  const workspace = input.workspace ?? null

  const fingerprint = fingerprintConfig(config)
  const relevant = store.entries.filter((e) => e.id === id && inScope(e.scope, workspace))

  const denied = relevant.find((e) => e.decision === 'deny' && e.fingerprint === fingerprint)
  if (denied) {
    return {
      allowed: false,
      needsPrompt: false,
      needsDisclosure: false,
      reason: 'remembered-deny'
    }
  }

  const allowed = relevant.find((e) => e.decision === 'allow' && e.fingerprint === fingerprint)
  if (allowed) {
    return {
      allowed: true,
      needsPrompt: false,
      needsDisclosure: false,
      reason: 'remembered-allow'
    }
  }

  // The one case worth interrupting for: this name was approved running
  // something ELSE. Not a first install - a substitution.
  const prior = relevant.find((e) => e.decision === 'allow')
  if (prior) {
    return {
      allowed: false,
      needsPrompt: true,
      needsDisclosure: false,
      reason: 'changed',
      previousFingerprint: prior.fingerprint
    }
  }

  if (provenance === 'user') {
    return { allowed: true, needsPrompt: false, needsDisclosure: false, reason: 'self-consented' }
  }

  if (workspace && store.workspaces.some((w) => samePath(w.path, workspace))) {
    return {
      allowed: true,
      needsPrompt: false,
      needsDisclosure: false,
      reason: 'workspace-trusted'
    }
  }

  if (policy.confirmBeforeRun) {
    return {
      allowed: false,
      needsPrompt: true,
      needsDisclosure: false,
      reason: 'confirm-first-run'
    }
  }

  // Default: run it, then tell the user what it exposed and where it came from.
  return { allowed: true, needsPrompt: false, needsDisclosure: true, reason: 'first-run' }
}

/**
 * Whether a stored decision applies here. A `null` scope is global (it came from
 * a non-workspace source); a scoped entry only applies in its own workspace, so
 * one repo's decision never leaks into another's.
 */
function inScope(scope: string | null, workspace: string | null): boolean {
  if (scope === null) return true
  if (!workspace) return false
  return samePath(scope, workspace)
}

/**
 * Compare two absolute paths. Case-insensitive (Windows and macOS both have
 * case-insensitive filesystems by default, and treating `C:\Repo` as a
 * different project from `c:\repo` would re-disclose the same folder).
 * Separators are normalized so a path that arrived over IPC still matches.
 */
export function samePath(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b)
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/**
 * "Here's what you just installed" — sent AFTER a server connects, listing the
 * tools it exposes and the source it came from.
 *
 * This is the normal path. It is not a permission request; it is the receipt.
 */
export interface McpInstallNotice {
  id: string
  provenance: McpProvenance
  /** Workspace the server is scoped to, when it came from one. */
  workspace: string | null
  disclosure: McpDisclosure
  /** Unqualified tool names the server exposed, in discovery order. */
  tools: string[]
  /** Set when the server failed to start; the notice doubles as the error report. */
  error?: string
}

/** A blocking question. Only raised for `changed`, or when the user opts in. */
export interface McpConsentRequest {
  /** Correlates the renderer's answer with the awaiting main-process promise. */
  requestId: string
  id: string
  config: McpServerConfig
  provenance: McpProvenance
  workspace: string | null
  disclosure: McpDisclosure
  /** `changed` = a trusted entry was altered; `confirm-first-run` = opted-in check. */
  reason: Extract<McpTrustReason, 'changed' | 'confirm-first-run'>
  /** Human-readable summary of the previously approved config, for `changed`. */
  previousSummary?: string
}

/** The user's answer. `scope` says how widely to remember it. */
export interface McpConsentResponse {
  requestId: string
  decision: 'allow' | 'deny'
  /**
   * - `once`      run now, remember nothing.
   * - `server`    remember this server + fingerprint.
   * - `workspace` trust the workspace: every server it declares, now and later.
   */
  scope: 'once' | 'server' | 'workspace'
}
