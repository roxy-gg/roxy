/**
 * MCP trust service — decides whether a server starts, and makes sure the user
 * finds out what it exposed.
 *
 * The rules live in `src/shared/mcp-trust.ts` (pure, unit-tested); this file
 * owns the side effects: reading the store, sending the disclosure, asking the
 * rare blocking question, remembering answers.
 *
 * The normal path does NOT prompt. `gateRecords` lets servers through and the
 * caller reports what connected via `discloseConnected`, which is where the tool
 * list comes from — tools are only knowable AFTER the handshake, which is
 * exactly why disclosure-after beats permission-before here: the receipt can
 * name the tools, a pre-flight dialog can only name the command.
 *
 * A prompt is raised in two cases only: a trusted entry whose command changed,
 * and users who opted into confirming first.
 */
import { BrowserWindow, dialog } from 'electron'
import { randomUUID } from 'node:crypto'
import { CHANNELS } from '../../shared/ipc'
import * as repo from '../db/repo'
import {
  decideTrust,
  describeConfig,
  fingerprintConfig,
  summarizeConfig,
  type McpConsentRequest,
  type McpConsentResponse,
  type McpInstallNotice,
  type McpProvenance,
  type McpTrustPolicy
} from '../../shared/mcp-trust'
import type { McpServerRecord } from '../../shared/mcp'

/**
 * How long an unanswered prompt stays open before it is treated as a denial.
 * Only reachable on the two blocking paths, so it can afford to be patient
 * without ever wedging an ordinary turn.
 */
const CONSENT_TIMEOUT_MS = 120_000

/**
 * Escape hatch for automation: `ROXY_MCP_CONFIRM=1` forces the opt-in
 * confirm-first posture. Deliberately an env var and not a config-file key, so
 * a repo you cloned cannot change your posture in either direction.
 */
function envConfirm(): boolean {
  return process.env.ROXY_MCP_CONFIRM === '1'
}

/** A record paired with where it came from, which is what drives disclosure. */
export interface McpCandidate {
  record: McpServerRecord
  provenance: McpProvenance
  /** Workspace the record is scoped to (workspace-file records); null otherwise. */
  workspace: string | null
}

/** Current policy: the persisted toggle, OR-ed with the env override. */
export function trustPolicy(): McpTrustPolicy {
  return { confirmBeforeRun: envConfirm() || repo.getMcpConfirmBeforeRun() }
}

export function setConfirmBeforeRun(enabled: boolean): void {
  repo.setMcpConfirmBeforeRun(enabled)
}

// ---------------------------------------------------------------------------
// Prompting (the exceptional path)
// ---------------------------------------------------------------------------

interface PendingPrompt {
  resolve: (r: McpConsentResponse) => void
  timer: NodeJS.Timeout
}

const pending = new Map<string, PendingPrompt>()
/** Dedupe key → in-flight prompt, so concurrent turns share one dialog. */
const inFlight = new Map<string, Promise<McpConsentResponse>>()

/** Called by the IPC handler when the renderer answers. */
export function resolveConsent(response: McpConsentResponse): void {
  const entry = pending.get(response.requestId)
  if (!entry) return // already timed out, or a stale/duplicate answer
  clearTimeout(entry.timer)
  pending.delete(response.requestId)
  entry.resolve(response)
}

/** Drop every pending prompt (window closing / app quit): unanswered = denied. */
export function cancelAllConsent(): void {
  for (const [requestId, entry] of pending) {
    clearTimeout(entry.timer)
    entry.resolve({ requestId, decision: 'deny', scope: 'once' })
  }
  pending.clear()
}

/** The window that should host UI, or null when running headless. */
function hostWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && !focused.isDestroyed()) return focused
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null
}

/**
 * Native fallback for when there is no renderer to ask. Only reached on the two
 * blocking paths, and both of them mean "something is off", so the fallback
 * denies rather than guessing on the user's behalf.
 */
async function askNatively(request: McpConsentRequest): Promise<McpConsentResponse> {
  const win = hostWindow()
  if (!win) return { requestId: request.requestId, decision: 'deny', scope: 'once' }
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Cancel', 'Run it'],
    defaultId: 0,
    cancelId: 0,
    title: 'MCP server changed',
    message: `"${request.id}" is not what it was.`,
    detail: `Now runs: ${summarizeConfig(request.config)}${
      request.previousSummary ? `\nPreviously: ${request.previousSummary}` : ''
    }\n\nOnly continue if you made this change.`
  })
  return {
    requestId: request.requestId,
    decision: response === 1 ? 'allow' : 'deny',
    scope: response === 1 ? 'server' : 'once'
  }
}

/** Ask the user about one server, deduping concurrent asks for the same thing. */
function prompt(request: McpConsentRequest, key: string): Promise<McpConsentResponse> {
  const existing = inFlight.get(key)
  if (existing) return existing

  const win = hostWindow()
  const p: Promise<McpConsentResponse> = (async () => {
    if (!win) return askNatively(request)
    return new Promise<McpConsentResponse>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(request.requestId)
        // Unanswered is DENIED. This path only triggers when a command changed
        // under a trusted name; letting that expire into a yes would be the
        // wrong way to resolve the one question worth asking.
        resolve({ requestId: request.requestId, decision: 'deny', scope: 'once' })
      }, CONSENT_TIMEOUT_MS)
      pending.set(request.requestId, { resolve, timer })
      win.webContents.send(CHANNELS.mcpConsentRequest, request)
    })
  })()

  inFlight.set(key, p)
  return p.finally(() => inFlight.delete(key))
}

// ---------------------------------------------------------------------------
// Disclosure (the normal path)
// ---------------------------------------------------------------------------

/** Candidates allowed to run, paired with whether the user should be told. */
export interface GateResult {
  records: McpServerRecord[]
  /** Servers to disclose once connected, keyed by id. */
  disclose: Map<string, McpCandidate>
}

/**
 * Tell the user what a server turned out to be, now that it has connected and
 * its tools are known. Also records the allow, so this is a one-time notice
 * rather than a recurring one.
 */
export function discloseConnected(candidate: McpCandidate, tools: string[], error?: string): void {
  const { record, provenance, workspace } = candidate
  try {
    // Remember it even when it failed: a server that is broken today should not
    // re-announce itself on every single turn until it is fixed.
    repo.recordMcpTrust({
      id: record.id,
      fingerprint: fingerprintConfig(record.config),
      provenance,
      scope: workspace,
      decision: 'allow',
      decidedAt: Date.now()
    })
    const win = hostWindow()
    if (!win) return
    const notice: McpInstallNotice = {
      id: record.id,
      provenance,
      workspace,
      disclosure: describeConfig(record.config),
      tools,
      error
    }
    win.webContents.send(CHANNELS.mcpInstallNotice, notice)
  } catch {
    /* disclosure is best-effort; never break a turn over a notification */
  }
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/** Stable dedupe key for one candidate. */
function candidateKey(id: string, fingerprint: string, workspace: string | null): string {
  return `${id}\u0000${fingerprint}\u0000${workspace ?? ''}`
}

/**
 * Decide whether ONE server may start.
 *
 * Returns `disclose: true` when it may run but the user should be told about it
 * afterwards (call `discloseConnected` once the tools are known). Never throws.
 */
export async function ensureTrusted(
  candidate: McpCandidate
): Promise<{ allowed: boolean; disclose: boolean }> {
  const { record, provenance, workspace } = candidate
  try {
    const decision = decideTrust({
      id: record.id,
      config: record.config,
      provenance,
      workspace,
      store: repo.getMcpTrustStore(),
      policy: trustPolicy()
    })
    if (!decision.needsPrompt) {
      return { allowed: decision.allowed, disclose: decision.needsDisclosure }
    }

    const fingerprint = fingerprintConfig(record.config)
    const request: McpConsentRequest = {
      requestId: randomUUID(),
      id: record.id,
      config: record.config,
      provenance,
      workspace,
      disclosure: describeConfig(record.config),
      reason: decision.reason === 'changed' ? 'changed' : 'confirm-first-run',
      previousSummary: decision.previousFingerprint
        ? previousSummaryFor(decision.previousFingerprint)
        : undefined
    }

    const answer = await prompt(request, candidateKey(record.id, fingerprint, workspace))

    if (answer.scope === 'workspace' && answer.decision === 'allow' && workspace) {
      repo.trustMcpWorkspace(workspace)
      return { allowed: true, disclose: false }
    }
    if (answer.scope === 'server' || answer.decision === 'deny') {
      repo.recordMcpTrust({
        id: record.id,
        fingerprint,
        provenance,
        scope: workspace,
        decision: answer.decision,
        decidedAt: Date.now()
      })
    }
    return { allowed: answer.decision === 'allow', disclose: false }
  } catch {
    // A failure in the trust path must not silently swallow a server the user
    // expects to work; the default posture is to run it and disclose.
    return { allowed: true, disclose: true }
  }
}

/**
 * A human-readable rendering of the config previously approved under this id,
 * for the "this changed" prompt.
 *
 * Derived from the fingerprint rather than looked up, because the store keeps
 * IDENTITY and not a copy of the old config. The fingerprint's argv answers the
 * only question being asked: "is this the command you had before?"
 */
function previousSummaryFor(previousFingerprint: string): string {
  const [kind, detail] = previousFingerprint.split('\u0001')
  if (kind === 'local' && detail) return detail.split('\u0000').join(' ')
  if (kind === 'remote' && detail) return detail
  return previousFingerprint
}

/**
 * Filter a turn's records down to the ones allowed to run, and report which of
 * them the user should be told about once they connect.
 *
 * Sequential because the rare prompt path must not stack dialogs; the common
 * path does no I/O beyond a single store read per candidate.
 */
export async function gateRecords(candidates: McpCandidate[]): Promise<GateResult> {
  const records: McpServerRecord[] = []
  const disclose = new Map<string, McpCandidate>()
  for (const candidate of candidates) {
    const { allowed, disclose: tell } = await ensureTrusted(candidate)
    if (!allowed) continue
    records.push(candidate.record)
    if (tell) disclose.set(candidate.record.id, candidate)
  }
  return { records, disclose }
}

// ---------------------------------------------------------------------------
// Test-only helpers
// ---------------------------------------------------------------------------

/** Clear in-memory prompt state between smoke cases (does not touch the DB). */
export function _resetTrustForTests(): void {
  cancelAllConsent()
  inFlight.clear()
}
