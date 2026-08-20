/**
 * The shared core of a session turn — extracted from the `llm:start` IPC handler
 * so the local (renderer-driven) path and the remote (phone-driven) path run the
 * *exact same* code with no drift.
 *
 * It resolves the session's workspace, runs one agent turn, prunes the turn's
 * one-shot subagents, and maps errors/aborts to a stable `LlmResult`. Emitting
 * events and persisting messages are the caller's job: the local path streams to
 * the renderer (which persists), while the remote host also fans out to the phone
 * and persists on the desktop's behalf.
 */
import type { LlmEvent, LlmResult, LlmStartInput } from '../../shared/api'
import * as repo from '../db/repo'
import { runAgentTurn } from '../harness'
import { activeBackgroundSubChatIds } from './background-tasks'
import { protectedSubChatIds } from './subagent-stream'
import { setLabel as setBrowserLabel } from './browser'
import { sessionCwd } from './workspace'
import { materializePendingWorktree } from './worktree'
import { markActivation, track, trackFeature, trackToolUse } from './track'
import { beginTurn, finishTurn } from './turn-metrics'
import { modelFamily, reportableAgent } from '../../shared/telemetry'
import path from 'node:path'

/**
 * Resolve a session's working directory, degrading to '' rather than throwing.
 *
 * Same reasoning as the materialize guard above: cwd resolution reads the DB and
 * touches the filesystem, and a turn that can't resolve a worktree should still
 * run — just without one.
 */
function safeSessionCwd(sessionId: string): string {
  try {
    return sessionCwd(sessionId)
  } catch (e) {
    console.warn('[worktree] cwd resolution failed; falling back:', e)
    try {
      return repo.getChatWorkspace(sessionId) ?? ''
    } catch {
      return ''
    }
  }
}

/**
 * Sub sessions that must survive the end-of-turn prune: any with a detached
 * background job still running, any still streaming, and the one on screen.
 */
function keepSubchats(): Set<string> {
  const keep = protectedSubChatIds()
  for (const id of activeBackgroundSubChatIds()) keep.add(id)
  return keep
}

/**
 * Run one agent turn for a session. `emit` receives every streamed `LlmEvent`;
 * `signal` aborts the in-flight turn. Returns `{ ok: true }` on success, or
 * `{ ok: false, error }` on failure (a caller-triggered abort reports "Stopped.").
 */
export async function runSessionTurn(
  input: LlmStartInput,
  emit: (event: LlmEvent) => void,
  signal: AbortSignal
): Promise<LlmResult> {
  // Usage tracking wraps the whole turn HERE, not at either caller: this is the
  // one function both the local (renderer) and remote (phone) paths go through,
  // so counting here is the only way the two can't drift. It records that a turn
  // happened, which backend served it, how hard it worked and how it ended -
  // never what was said or where.
  //
  // The provider rides along so roxy.gg/stats can show which backends people
  // actually point Roxy at - the provider only, never the model id. Passed raw:
  // `track` collapses it to the shipped seed list, which matters here because
  // this fires BEFORE the turn resolves a provider, so an id that isn't even
  // connected still reaches it. The agent mode goes through its own classifier.
  const agent = reportableAgent(input.agentId)
  track('prompt', { provider: input.providerId, agent })
  markActivation('first_prompt')
  // Plan mode is a distinct way of using the product (read-only, no edits), and
  // its share is the difference between "people trust it to write code" and
  // "people use it to read code". Deduped per session by `trackFeature`.
  if (agent === 'plan') trackFeature(input.sessionId, 'plan_mode')

  // Open a collector for this session. The harness accumulates into it as the
  // turn runs (model steps, tool calls, tokens, cost) and `finishTurn` below
  // folds the whole thing into ONE event - so a 200-step overnight run costs
  // the same ingest volume as a one-line question.
  beginTurn(input.sessionId)
  const startedAt = Date.now()
  try {
    const result = await runTurn(input, emit, signal)
    // An abort is a DIFFERENT fact from an error and must not be flattened into
    // one: a user pressing Stop usually means the agent went off the rails (our
    // problem), while an error usually means the provider fell over (theirs).
    // Reported as `ok:false` in both cases for continuity with the historical
    // series, with `outcome` carrying the distinction.
    const outcome = result.ok ? 'ok' : signal.aborted ? 'stopped' : 'error'
    reportTurn(input, outcome, startedAt, result.error)
    if (result.ok) markActivation('first_turn_ok')
    return result
  } catch (e) {
    // runTurn maps its own failures, so reaching here means an unexpected one.
    // Count it as a failed turn and rethrow untouched - tracking never changes
    // behaviour.
    reportTurn(
      input,
      signal.aborted ? 'stopped' : 'error',
      startedAt,
      e instanceof Error ? e.message : String(e)
    )
    throw e
  }
}

/**
 * Emit the `turn_end` summary plus this turn's per-tool events.
 *
 * Wrapped in its own try/catch and never awaited: telemetry sits directly on
 * the turn's return path, and the one thing it must never do is turn a
 * successful answer into a thrown error because a counter misbehaved.
 *
 * The error TEXT is passed only to the classifier, which returns one of a fixed
 * set of kinds - the message itself never reaches the queue. Provider errors
 * routinely embed the request URL, an account id, or a partial key.
 */
function reportTurn(
  input: LlmStartInput,
  outcome: 'ok' | 'stopped' | 'error',
  startedAt: number,
  errorText?: string
): void {
  try {
    const done = finishTurn(input.sessionId, outcome, { text: errorText })
    if (!done) {
      // No collector (the turn never opened one, e.g. a very early failure).
      // Still report the bare fact, so a crash before the harness starts can't
      // silently vanish from the failure rate.
      track('turn_end', {
        ok: outcome === 'ok',
        outcome,
        durationMs: Date.now() - startedAt,
        model: modelFamily(input.model)
      })
      return
    }
    const props = done.errorKind ? { ...done.summary, errorKind: done.errorKind } : done.summary
    // The collector records the family of the model that actually STREAMED. A
    // turn that failed before any model call has none, so fall back to the one
    // the session asked for - otherwise every failed turn reports `other` and
    // the error breakdown can't be split by model at all.
    if (props.model === 'other') props.model = modelFamily(input.model)
    track('turn_end', props)
    trackToolUse(done.toolCounts.map((t) => ({ tool: t.tool, calls: t.calls, errors: t.errors })))
  } catch {
    /* telemetry must never break a turn */
  }
}

async function runTurn(
  input: LlmStartInput,
  emit: (event: LlmEvent) => void,
  signal: AbortSignal
): Promise<LlmResult> {
  // If this session asked for a worktree, build it now — on the first turn,
  // not at create time, so an abandoned composer leaves nothing on disk.
  //
  // Wrapped because this MUST NOT be able to stop a turn. Everything inside is
  // best-effort infrastructure (git, the filesystem, a schema that might be
  // mid-upgrade); if any of it throws, the right outcome is a session that runs
  // in its project folder, not a chat that refuses to answer.
  try {
    const materialized = await materializePendingWorktree(input.sessionId)
    // A session that materialized its own git worktree is running as a
    // workstream - isolated branch, isolated tree. Counted only on success, so
    // the number means "sessions that got one", not "sessions that asked".
    if (materialized.ok) trackFeature(input.sessionId, 'worktree')
    if (materialized.error) emit({ type: 'text', delta: `_${materialized.error}_\n\n` })
  } catch (e) {
    console.warn('[worktree] materialize failed; running in the project folder:', e)
  }
  // Where this session's tools run — its worktree when it has one, else the
  // project folder. The single resolver; never read workspace_path directly.
  const cwd = safeSessionCwd(input.sessionId)
  // Name this session's browser window after its project so concurrent windows
  // are tellable apart (a no-op until/unless the agent opens the browser).
  if (cwd) setBrowserLabel(input.sessionId, path.basename(cwd))
  try {
    await runAgentTurn({
      providerId: input.providerId,
      model: input.model,
      messages: input.messages,
      agentId: input.agentId,
      reasoning: input.reasoning,
      reasoningEffort: input.reasoningEffort,
      contextLimit: input.contextLimit,
      cwd,
      chatId: input.sessionId,
      signal,
      emit
    })
    // The turn's subagents are one-shot — drop any with nothing queued so they
    // don't linger in the sidebar after the work is done. Spared: sub sessions
    // with a still-running background task (Phase 11), one still streaming, and
    // whichever one the user currently has open (pruning a transcript out from
    // under someone reading it is the one thing this sweep must never do).
    repo.pruneSubchats(input.sessionId, keepSubchats())
    return { ok: true }
  } catch (e) {
    if (signal.aborted) return { ok: false, error: 'Stopped.' }
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
