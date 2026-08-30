/**
 * Electron-runtime smoke test. Boots a headless Electron main process against a
 * throwaway userData/DB and exercises the REAL code paths: SQLite migrations +
 * repo CRUD, harness file/bash tools, loop tools, and the Electron browser tools.
 * Run: npm run smoke:app
 */
import { mkdtempSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow } from 'electron'

import * as repo from '../src/main/db/repo'
import { getActivityStats } from '../src/main/services/activity'
import { localDay } from '../src/shared/cost'
import { closeDb } from '../src/main/db/database'
import {
  runTool,
  killSessionBackground,
  listServices,
  serviceOutput,
  stopService,
  restartService
} from '../src/main/harness'
import { sessionCwd } from '../src/main/services/workspace'
import {
  createTheme,
  deleteTheme,
  listThemes,
  refreshThemes,
  resolveThemeById,
  themeWarnings,
  writeTheme
} from '../src/main/services/themes'
import {
  OVERLAY_HEIGHT,
  applyWindowChrome,
  backgroundColorFor,
  initialOverlay,
  symbolColorFor
} from '../src/main/services/window-chrome'
import Database from 'better-sqlite3'
import { MIGRATIONS, repairSchema } from '../src/main/db/migrations'
import * as git from '../src/main/services/git'
import { branchNameError, isPlaceholderBranch } from '../src/shared/branch'
import {
  materializePendingWorktree,
  pruneWorktrees,
  removeWorktreeForChat,
  renameWorkstreamBranch,
  syncBranchToTitle,
  loadWorktreeConfig
} from '../src/main/services/worktree'
import { allocateDevPort, ensureDevPort } from '../src/main/services/ports'
import { emitSessionsUpdated } from '../src/main/services/session-events'
import { spawn } from 'node:child_process'
import * as browser from '../src/main/services/browser'
import {
  boundToolOutput,
  isManagedToolOutputPath,
  toolOutputRoot,
  cleanupToolOutputs
} from '../src/main/services/tool-output-store'
import {
  registerBackgroundJob,
  finishBackgroundJob,
  listRunningBackgroundJobs,
  activeBackgroundSubChatIds,
  hasActiveBackgroundJobs,
  cancelBackgroundJob,
  cancelSessionBackgroundJobs,
  _resetBackgroundJobs
} from '../src/main/services/background-tasks'
import {
  startToolRun,
  cancelToolCall,
  cancelToolCallsFor,
  wasToolCallCancelled,
  _resetToolRuns
} from '../src/main/services/tool-runs'
import * as lsp from '../src/main/services/lsp'
import {
  ensureMcpConnected,
  mcpToolSchemas,
  mcpToolDefinition,
  lastMcpCallResult,
  listMcpResources,
  readMcpResource,
  callMcpTool,
  isMcpTool,
  mcpToolTitle,
  mcpServerSummaries,
  mcpInstructions,
  reconnectMcpServer,
  disposeConnection,
  shutdownAllMcp,
  loadWorkspaceMcpServers,
  _resetMcpForTests
} from '../src/main/services/mcp'
import {
  launchMcpApp,
  handleMcpAppRequest,
  closeMcpApp,
  setMcpAppApprover,
  _resetMcpAppsForTests
} from '../src/main/services/mcp-apps'
import {
  SANDBOX_SCHEME,
  SANDBOX_URL,
  registerSandboxScheme,
  serveSandbox
} from '../src/main/services/mcp-app-sandbox'
import { SANDBOX_ORIGIN_HINT, uiResourceUri } from '../src/shared/mcp-apps'
import { _resetTrustForTests } from '../src/main/services/mcp-trust'
import type { McpServerRecord } from '../src/shared/mcp'
import {
  listSkills,
  skillInstructions,
  loadSkill,
  refreshSkills,
  installSkillFromSource,
  exportGlobalSkills,
  importGlobalSkills,
  _setInstallFetchForTests,
  _resetSkillsForTests
} from '../src/main/services/skills'
import { buildExport, applyImport } from '../src/main/services/portable'
import { parseBundle } from '../src/shared/portable'
import {
  streamTurn,
  isTransientModelError,
  isNonRetryableModelError,
  nextRetryDelay,
  abortableDelay,
  MODEL_FATAL_ATTEMPTS
} from '../src/main/harness/agent'
import { COPILOT_EDITOR_HEADERS, ModelHttpError } from '../src/main/services/llm'
import { getUsageStats } from '../src/main/services/usage'
import { consumeAiSdkStream } from '../src/main/services/aisdk'
import { APICallError } from 'ai'
import type { MessagePart } from '../src/shared/types'
import {
  initTracking,
  track,
  flush,
  setTrackingEnabled,
  isTrackingEnabled,
  shutdownTracking,
  _resetTracking,
  _queueDepth
} from '../src/main/services/track'
import { markActivation, trackFeature, trackToolUse } from '../src/main/services/track'
import {
  beginTurn,
  finishTurn,
  recordRetry,
  recordStep,
  recordSubagent,
  recordTool,
  recordTrim,
  _liveTurnCount,
  _resetTurnMetrics
} from '../src/main/services/turn-metrics'
import { isSeedProviderId } from '../src/shared/providers'
import { createServer } from 'node:http'

let pass = 0
const fails: string[] = []
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++
    console.log(`  \u2713 ${name}`)
  } else {
    fails.push(name)
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ''}`)
  }
}

/** Reject after `ms` so a stalled browser op fails its check instead of hanging. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout: ${label} (${ms}ms)`)), ms)
    )
  ])
}

// Isolate from the real app: throwaway userData → throwaway roxy.db.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'roxy-smoke-'))
app.setPath('userData', tmp)

// Closing the browser window must NOT auto-quit the app before we report — we
// exit explicitly at the end. (Default Electron behavior quits on Windows.)
app.on('window-all-closed', () => undefined)

async function main(): Promise<void> {
  const ws = path.join(tmp, 'workspace')
  await fs.mkdir(ws, { recursive: true })
  const run = (name: string, input: Record<string, unknown>): ReturnType<typeof runTool> =>
    runTool(name, input, { cwd: ws })

  // ---- migrations + settings ----
  check('settings default (onboarding false)', repo.getSettings().onboardingCompleted === false)
  repo.completeOnboarding()
  check('completeOnboarding persists', repo.getSettings().onboardingCompleted === true)
  repo.setActiveProvider('openai', 'gpt-test')
  check(
    'setActiveProvider persists',
    repo.getSettings().activeProviderId === 'openai' &&
      repo.getSettings().activeModel === 'gpt-test'
  )
  // Auto-workstream defaults ON and is stored only when disabled, so existing
  // installs are opted in without a migration.
  check('auto-workstream defaults on', repo.getSettings().autoWorkstream === true)
  repo.setAutoWorkstream(false)
  check('setAutoWorkstream(false) persists', repo.getSettings().autoWorkstream === false)
  repo.setAutoWorkstream(true)
  check('setAutoWorkstream(true) restores the default', repo.getSettings().autoWorkstream === true)

  check('reasoning effort default high', repo.getSettings().reasoningEffort === 'high')
  repo.setReasoningEffort('low')
  check('setReasoningEffort persists', repo.getSettings().reasoningEffort === 'low')
  repo.setReasoningEffort('max')
  check(
    'setReasoningEffort accepts the xhigh/max ladder',
    repo.getSettings().reasoningEffort === 'max'
  )
  repo.setReasoningEffort('high')
  check('context limit default null', repo.getSettings().contextLimit === null)
  repo.setContextLimit(1_000_000)
  check('setContextLimit persists', repo.getSettings().contextLimit === 1_000_000)
  repo.setContextLimit(null)
  check('setContextLimit clears', repo.getSettings().contextLimit === null)
  check('language defaults to English', repo.getSettings().language === 'en')
  repo.setLanguage('es')
  check('setLanguage persists', repo.getSettings().language === 'es')
  // English is the default and clears its row, so it must still READ as 'en'
  // rather than falling through to whatever was there before.
  repo.setLanguage('en')
  check('setLanguage back to the default persists', repo.getSettings().language === 'en')
  // A row written by a newer build, or a language since removed, must degrade
  // to English instead of leaving the UI rendering raw keys.
  repo.setLanguage('kl' as never)
  check('an unknown language falls back to English', repo.getSettings().language === 'en')
  repo.setLanguage('es-MX' as never)
  check('a regional tag folds to its base language', repo.getSettings().language === 'es')
  repo.setLanguage('en')

  // ---- per-session inference config ----
  //
  // The two behaviours users expect at once: a NEW session starts from what you
  // last picked, and changing one session never touches another. Exercised
  // against the real DB because both halves live in SQL (createChat stamps the
  // seed; setChatConfig writes one row).
  repo.setActiveProvider('anthropic', 'claude-opus-5')
  repo.setActiveAgent('plan')
  repo.setReasoningEffort('max')
  repo.setContextLimit(1_000_000)
  check('setActiveAgent persists', repo.getSettings().activeAgentId === 'plan')

  const cfgA = repo.createChat({ title: 'cfg A', kind: 'main', workspacePath: ws })
  check(
    'a new session inherits the last-used model',
    cfgA.providerId === 'anthropic' && cfgA.model === 'claude-opus-5'
  )
  check(
    'a new session inherits the last-used mode/effort/context',
    cfgA.agentId === 'plan' && cfgA.reasoningEffort === 'max' && cfgA.contextLimit === 1_000_000
  )

  // Change session A. The GLOBAL template is written separately by the store
  // (dual-write), so at this layer only A moves.
  repo.setChatConfig(cfgA.id, { providerId: 'openai', model: 'gpt-5' })
  repo.setChatConfig(cfgA.id, { reasoningEffort: 'low', contextLimit: 64_000 })
  check(
    'setChatConfig pins the session',
    repo.getChat(cfgA.id)?.model === 'gpt-5' &&
      repo.getChat(cfgA.id)?.reasoningEffort === 'low' &&
      repo.getChat(cfgA.id)?.contextLimit === 64_000
  )
  check(
    'setChatConfig does NOT touch the global template',
    repo.getSettings().activeModel === 'claude-opus-5' &&
      repo.getSettings().reasoningEffort === 'max'
  )

  // The isolation guarantee: a second session created from the same template is
  // unaffected by anything session A did to itself.
  const cfgB = repo.createChat({ title: 'cfg B', kind: 'main', workspacePath: ws })
  check(
    "a sibling session is unaffected by another session's model change",
    cfgB.model === 'claude-opus-5' && cfgB.reasoningEffort === 'max'
  )
  repo.setChatConfig(cfgB.id, { agentId: 'build' })
  check(
    "changing one session's mode leaves its sibling alone",
    repo.getChat(cfgB.id)?.agentId === 'build' && repo.getChat(cfgA.id)?.agentId === 'plan'
  )

  // A later template change reaches only sessions created AFTER it: the seed is
  // a snapshot, so tuning a picker never rewrites sessions already in flight.
  repo.setActiveProvider('google', 'gemini-3')
  const cfgC = repo.createChat({ title: 'cfg C', kind: 'main', workspacePath: ws })
  check(
    'the next new session picks up the newest template',
    cfgC.providerId === 'google' && cfgC.model === 'gemini-3'
  )
  check(
    'existing sessions are NOT rewritten by a later template change',
    repo.getChat(cfgA.id)?.model === 'gpt-5' && repo.getChat(cfgB.id)?.model === 'claude-opus-5'
  )

  // Clearing an override returns that field to the global default (null column).
  repo.setChatConfig(cfgA.id, { contextLimit: null })
  check(
    'setChatConfig clears an override back to inherit',
    repo.getChat(cfgA.id)?.contextLimit === null
  )

  // An explicit provider must never be paired with the seeded model id.
  const cfgD = repo.createChat({
    title: 'cfg D',
    kind: 'main',
    workspacePath: ws,
    providerId: 'openai'
  })
  check(
    'an explicitly-provided provider does not inherit the template model',
    cfgD.providerId === 'openai' && cfgD.model === null
  )

  // Restore the template the rest of the suite expects.
  repo.setActiveProvider('openai', 'gpt-test')
  repo.setReasoningEffort('high')
  repo.setContextLimit(null)
  for (const id of [cfgA.id, cfgB.id, cfgC.id, cfgD.id]) repo.removeChat(id)

  // ---- chats / sessions ----
  const chat = repo.createChat({ title: 'smoke', kind: 'main', workspacePath: ws })
  check('createChat (main + workspace)', chat.kind === 'main' && chat.workspacePath === ws)
  check(
    'listChats contains it',
    repo.listChats().some((c) => c.id === chat.id)
  )
  check('getChatWorkspace', repo.getChatWorkspace(chat.id) === ws)
  repo.renameChat(chat.id, 'renamed')
  check('renameChat', repo.listChats().find((c) => c.id === chat.id)?.title === 'renamed')
  // ---- session reorder within a project (v12: sort_order) ----
  const rws = path.join(ws, 'reorder-project')
  const rs1 = repo.createChat({ title: 'r1', kind: 'main', workspacePath: rws })
  const rs2 = repo.createChat({ title: 'r2', kind: 'main', workspacePath: rws })
  const rs3 = repo.createChat({ title: 'r3', kind: 'main', workspacePath: rws })
  const orderOf = (): string =>
    repo
      .listChats()
      .filter((c) => c.workspacePath === rws)
      .map((c) => c.title)
      .join()
  check(
    'all three sessions are grouped under the project',
    orderOf().split(',').sort().join() === 'r1,r2,r3'
  )
  // reorderSessions assigns distinct descending keys, so the order is exact.
  repo.reorderSessions(rws, [rs1.id, rs3.id, rs2.id])
  check('reorderSessions persists a new order', orderOf() === 'r1,r3,r2')
  repo.reorderSessions(rws, [rs2.id, rs1.id, rs3.id])
  check('reorderSessions persists another order', orderOf() === 'r2,r1,r3')
  // A partial/foreign id set is ignored (guards against clobbering).
  repo.reorderSessions(rws, [rs1.id])
  check('reorderSessions ignores an incomplete set', orderOf() === 'r2,r1,r3')

  // ---- project (workspace) order is explicit + independent of sessions (v13) ----
  // New projects register at the BOTTOM of the order, not the top.
  const pA = path.join(ws, 'proj-a')
  const pB = path.join(ws, 'proj-b')
  const pC = path.join(ws, 'proj-c')
  repo.createChat({ title: 'a1', kind: 'main', workspacePath: pA })
  repo.createChat({ title: 'b1', kind: 'main', workspacePath: pB })
  repo.createChat({ title: 'c1', kind: 'main', workspacePath: pC })
  const projOrder = (): string =>
    repo
      .listProjectOrder()
      .filter((p) => p === pA || p === pB || p === pC)
      .map((p) => p.split(/[\\/]/).pop())
      .join()
  check(
    'new projects append at the bottom in creation order',
    projOrder() === 'proj-a,proj-b,proj-c'
  )
  // Creating another session in the FIRST project must not float it to the top.
  repo.createChat({ title: 'a2', kind: 'main', workspacePath: pA })
  check('a new session does not reorder its project', projOrder() === 'proj-a,proj-b,proj-c')
  // Reordering a project session order must not touch the project order either.
  const paIds = repo
    .listChats()
    .filter((c) => c.workspacePath === pA)
    .map((c) => c.id)
  repo.reorderSessions(pA, [paIds[1], paIds[0]])
  check('reordering sessions does not reorder projects', projOrder() === 'proj-a,proj-b,proj-c')
  // Explicit reorder: move C to the front.
  repo.reorderProjects([pC, pA, pB])
  check('reorderProjects persists a new order', projOrder() === 'proj-c,proj-a,proj-b')
  // Deleting a project last session/loop forgets the project (drops its slot).
  repo
    .listChats()
    .filter((c) => c.workspacePath === pB)
    .forEach((c) => repo.removeChat(c.id))
  check('an emptied project is dropped from the order', !repo.listProjectOrder().includes(pB))
  // Re-opening that folder later appends it at the bottom again (fresh slot).
  repo.createChat({ title: 'b2', kind: 'main', workspacePath: pB })
  check('a re-opened project appends at the bottom', projOrder() === 'proj-c,proj-a,proj-b')
  ;[pA, pB, pC].forEach((p) =>
    repo
      .listChats()
      .filter((c) => c.workspacePath === p)
      .forEach((c) => repo.removeChat(c.id))
  )
  check(
    'all test projects cleaned up',
    repo.listProjectOrder().every((p) => p !== pA && p !== pB && p !== pC)
  )

  repo.removeChat(rs1.id)
  repo.removeChat(rs2.id)
  repo.removeChat(rs3.id)

  // ---- subagent sessions link to + cascade-delete with their parent (v9) ----
  const sub = repo.createChat({
    title: 'explore: find x',
    kind: 'sub',
    workspacePath: ws,
    parentId: chat.id
  })
  check('createChat (sub + parentId)', sub.kind === 'sub' && sub.parentId === chat.id)
  check(
    'listSubchats returns the sub',
    repo.listSubchats(chat.id).some((c) => c.id === sub.id)
  )
  const tmpParent = repo.createChat({ title: 'tmp', kind: 'main', workspacePath: ws })
  const tmpSub = repo.createChat({ title: 'sub', kind: 'sub', parentId: tmpParent.id })
  repo.removeChat(tmpParent.id)
  check(
    'removeChat cascades to subagent sessions',
    !repo.listChats().some((c) => c.id === tmpParent.id || c.id === tmpSub.id)
  )
  // prune drops a finished (queue-less) subagent session, but keeps a queued one
  const busySub = repo.createChat({ title: 'busy sub', kind: 'sub', parentId: chat.id })
  repo.enqueue(busySub.id, 'follow-up')
  repo.pruneSubchats(chat.id)
  check(
    'pruneSubchats drops a queue-less sub',
    !repo.listSubchats(chat.id).some((c) => c.id === sub.id)
  )
  check(
    'pruneSubchats keeps a queued sub',
    repo.listSubchats(chat.id).some((c) => c.id === busySub.id)
  )

  // ---- messages + ordered parts round-trip (v6) ----
  repo.addMessage({ chatId: chat.id, role: 'user', content: 'hi' })
  const parts: MessagePart[] = [
    { type: 'reasoning', text: 'thinking' },
    { type: 'tool', tool: 'bash', state: 'done', title: 'ls', output: 'a\nb' },
    { type: 'text', text: 'done' }
  ]
  repo.addMessage({ chatId: chat.id, role: 'assistant', content: 'done', parts })
  const msgs = repo.listMessages(chat.id)
  check('messages persisted in order', msgs.length === 2 && msgs[0].role === 'user')
  check(
    'assistant parts round-trip (reasoning→tool→text)',
    msgs[1].parts.length === 3 &&
      msgs[1].parts[0].type === 'reasoning' &&
      msgs[1].parts[1].type === 'tool' &&
      msgs[1].parts[2].type === 'text'
  )
  const userPart = msgs[0].parts[0]
  check(
    'legacy/no-parts row falls back to single text part',
    msgs[0].parts.length === 1 && userPart.type === 'text' && userPart.text === 'hi'
  )

  // ---- fork: copy a session's context into a new one ----
  //
  // The point of a fork is that the copy can carry on a conversation the source
  // already had, so the transcript has to arrive in the same ORDER with the
  // same timestamps - `context_summary_at` is a watermark into `created_at`, so
  // restamped messages would silently fall out of the fork's context window.
  // Its own source session, not the shared `chat`: a fork test that left a
  // compaction summary behind on the fixture would break assertions further
  // down for reasons no one would look for here.
  const forkSrc = repo.createChat({ title: 'fork source', kind: 'main', workspacePath: ws })
  repo.addMessage({ chatId: forkSrc.id, role: 'user', content: 'hi' })
  repo.addMessage({ chatId: forkSrc.id, role: 'assistant', content: 'done', parts })
  const srcMsgs = repo.listMessages(forkSrc.id)
  repo.setChatSummary(forkSrc.id, 'a summary of earlier turns', srcMsgs[0].createdAt)
  repo.enqueue(forkSrc.id, 'not forked')
  repo.createChat({ title: 'fork src sub', kind: 'sub', parentId: forkSrc.id })
  const forked = repo.forkChat(forkSrc.id, { title: 'forked session' })
  const forkedMsgs = repo.listMessages(forked.id)
  const sourceMsgs = repo.listMessages(forkSrc.id)
  check('forkChat leaves the source transcript intact', sourceMsgs.length === srcMsgs.length)
  check(
    'forkChat copies the whole transcript, in order, at the original times',
    forkedMsgs.length === sourceMsgs.length &&
      forkedMsgs.every(
        (m, i) =>
          m.role === sourceMsgs[i].role &&
          m.content === sourceMsgs[i].content &&
          m.createdAt === sourceMsgs[i].createdAt
      )
  )
  check(
    'forkChat rewrites message ids (rows are never shared)',
    forkedMsgs.every((m) => m.chatId === forked.id) &&
      !forkedMsgs.some((m) => sourceMsgs.some((s) => s.id === m.id))
  )
  check(
    'forkChat carries structured parts across',
    forkedMsgs[1].parts.length === 3 && forkedMsgs[1].parts[1].type === 'tool'
  )
  check(
    'forkChat carries the compaction summary + its watermark',
    forked.contextSummary === 'a summary of earlier turns' &&
      forked.contextSummaryAt === srcMsgs[0].createdAt
  )
  check(
    'forkChat inherits the project + inference config',
    forked.workspacePath === forkSrc.workspacePath && forked.agentId === forkSrc.agentId
  )
  check('forkChat is a main session with no parent', forked.kind === 'main' && !forked.parentId)
  // Resources, as opposed to context, must NOT come along: two sessions sharing
  // one checkout (or one queue) would fight over it.
  check(
    'forkChat takes no worktree, branch, port or queue',
    !forked.worktreePath &&
      !forked.branch &&
      !forked.devPort &&
      repo.listQueue(forked.id).length === 0
  )
  check('forkChat does not copy subagent children', repo.listSubchats(forked.id).length === 0)
  // Deleting a fork must not touch the session it came from - the whole feature
  // is worthless if the copies are entangled.
  repo.removeChat(forked.id)
  check(
    'deleting a fork leaves the source and its messages alone',
    !!repo.getChat(forkSrc.id) && repo.listMessages(forkSrc.id).length === sourceMsgs.length
  )
  repo.removeChat(forkSrc.id)

  // ---- queue (FIFO) ----
  const q1 = repo.enqueue(chat.id, 'q1')
  const q2 = repo.enqueue(chat.id, 'q2')
  check(
    'queue FIFO order',
    repo
      .listQueue(chat.id)
      .map((x) => x.content)
      .join() === 'q1,q2'
  )
  repo.reorderQueue(chat.id, [q2.id, q1.id])
  check(
    'queue reorder',
    repo
      .listQueue(chat.id)
      .map((x) => x.content)
      .join() === 'q2,q1'
  )
  repo.removeQueueItem(q1.id)
  check(
    'queue remove',
    repo
      .listQueue(chat.id)
      .map((x) => x.content)
      .join() === 'q2'
  )
  const qImg = repo.enqueue(chat.id, 'with image', [
    { dataUrl: 'data:image/png;base64,iVBORw0KGgo=', mediaType: 'image/png', name: 'a.png' }
  ])
  check(
    'queue stores images',
    repo.listQueue(chat.id).find((x) => x.id === qImg.id)?.images?.length === 1
  )
  // Editing rewrites text + images in place, keeping the item's FIFO position.
  const qEditPos = repo.listQueue(chat.id).findIndex((x) => x.id === qImg.id)
  const qEdited = repo.updateQueueItem(qImg.id, 'edited text', [
    { dataUrl: 'data:image/png;base64,AAAA', mediaType: 'image/png', name: 'b.png' },
    { dataUrl: 'data:image/png;base64,BBBB', mediaType: 'image/png', name: 'c.png' }
  ])
  check('queue edit returns updated item', qEdited?.content === 'edited text')
  check(
    'queue edit persists text',
    repo.listQueue(chat.id).find((x) => x.id === qImg.id)?.content === 'edited text'
  )
  check(
    'queue edit updates images',
    repo.listQueue(chat.id).find((x) => x.id === qImg.id)?.images?.length === 2
  )
  check(
    'queue edit preserves position',
    repo.listQueue(chat.id).findIndex((x) => x.id === qImg.id) === qEditPos
  )
  // Clearing images on edit drops them entirely (no empty array left behind).
  repo.updateQueueItem(qImg.id, 'text only', [])
  check(
    'queue edit can clear images',
    repo.listQueue(chat.id).find((x) => x.id === qImg.id)?.images === undefined
  )
  check('queue edit unknown id is a no-op', repo.updateQueueItem('missing-id', 'x') === undefined)
  repo.removeQueueItem(qImg.id)

  // ---- usage / cost recording + rollup ----
  check('usage empty before any record', repo.hasAnyUsage() === false)
  const nowU = Date.now()
  const rec1 = repo.recordUsage({
    chatId: chat.id,
    providerId: 'openai',
    model: 'gpt-x',
    usage: {
      input: 1000,
      output: 500,
      cacheRead: 100,
      cacheWrite: 0,
      reasoning: 20,
      estimated: false
    },
    cost: 0.03
  })
  check('usage record returns id + fields', !!rec1.id && rec1.input === 1000 && rec1.cost === 0.03)
  check('usage record persists estimated flag', rec1.estimated === false)
  repo.recordUsage({
    chatId: chat.id,
    providerId: 'anthropic',
    model: 'claude-y',
    usage: {
      input: 3000,
      output: 1500,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      estimated: true
    },
    cost: 0.09
  })
  check('usage hasAnyUsage after record', repo.hasAnyUsage() === true)
  const since = nowU - 60_000
  const listed = repo.listUsageSince(since)
  check('usage listUsageSince returns both rows', listed.length === 2)
  check('usage listUsageSince newest-first', listed[0].createdAt >= listed[1].createdAt)
  check(
    'usage rounds fractional tokens',
    repo.recordUsage({
      chatId: null,
      providerId: 'openai',
      model: 'gpt-x',
      usage: {
        input: 10.7,
        output: 0.2,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        estimated: false
      },
      cost: 0
    }).input === 11
  )
  // Service rollup (prices already baked into rows).
  const uStats = getUsageStats()
  check('usage stats overview has spend', uStats.overview.last30d.cost > 0.11)
  check('usage stats has provider tabs', uStats.providers.length >= 2)
  check('usage stats daily is 30 long', uStats.overview.daily.length === 30)
  // Deleting a chat keeps its usage rows (chat_id SET NULL, not cascade).
  const before = repo.listUsageSince(since).length
  const throwaway = repo.createChat({ title: 'x', kind: 'main' })
  repo.recordUsage({
    chatId: throwaway.id,
    providerId: 'openai',
    model: 'gpt-x',
    usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, estimated: false },
    cost: 0.001
  })
  repo.removeChat(throwaway.id)
  check('usage survives chat deletion', repo.listUsageSince(since).length === before + 1)

  // ---- compaction summary ----
  check('chat summary null by default', repo.getChat(chat.id)?.contextSummary === null)
  const compacted = repo.setChatSummary(chat.id, 'compact summary', 123)
  check(
    'setChatSummary persists',
    compacted.contextSummary === 'compact summary' && compacted.contextSummaryAt === 123
  )
  check('getChat reflects summary', repo.getChat(chat.id)?.contextSummary === 'compact summary')

  // ---- loops ----
  const loop = repo.createLoop({ name: 'PR watcher', prompt: 'check the PR', intervalMinutes: 5 })
  check('createLoop (enabled, owns loop-kind chat)', loop.enabled === true)
  check(
    'loop chat is kind=loop',
    repo.listChats().some((c) => c.id === loop.chatId && c.kind === 'loop')
  )
  check(
    'dueLoops includes enabled loop',
    repo.dueLoops(Date.now() + 1000).some((l) => l.id === loop.id)
  )
  repo.appendLoopRun(loop.id, 'scheduled prompt', 'heartbeat reply')
  check('appendLoopRun posts into loop chat', repo.listMessages(loop.chatId).length === 2)
  const projLoop = repo.createLoop({
    name: 'P',
    prompt: 'go',
    intervalMinutes: 3,
    workspacePath: ws
  })
  check('createLoop scopes to a project workspace', repo.getChatWorkspace(projLoop.chatId) === ws)
  const dueBefore = repo.dueLoops(Date.now() + 1000).some((l) => l.id === projLoop.id)
  repo.markLoopRan(projLoop.id)
  const dueAfter = repo.dueLoops(Date.now() + 1000).some((l) => l.id === projLoop.id)
  check('markLoopRan advances the schedule', dueBefore === true && dueAfter === false)

  // ---- sessions status excludes loop chats ----
  const status = repo.listSessionsStatus()
  check(
    'listSessionsStatus includes the main session',
    status.some((s) => s.id === chat.id)
  )
  check('listSessionsStatus excludes loop chats', !status.some((s) => s.id === loop.chatId))
  check('checkSession reports message count', repo.checkSession(chat.id)?.messageCount === 2)

  // ---- harness file/bash tools (real fs, sandboxed to ws) ----
  const wrote = await run('write', { path: 'hello.txt', content: 'world' })
  check('write tool', wrote.ok)
  check('write tool diff (new file)', wrote.diff?.before === '' && wrote.diff?.after === 'world')
  const read = await run('read', { path: 'hello.txt' })
  check('read tool', read.ok && read.output === 'world', read.output)
  const edited = await run('edit', { path: 'hello.txt', oldString: 'world', newString: 'WORLD' })
  check('edit tool', edited.ok)
  check(
    'edit tool diff (before/after)',
    edited.diff?.before === 'world' && edited.diff?.after === 'WORLD'
  )
  check('edit applied', (await run('read', { path: 'hello.txt' })).output === 'WORLD')
  // Image files render inline (data URL) instead of dumping raw bytes as text.
  const png1x1 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  await fs.writeFile(path.join(ws, 'pixel.png'), Buffer.from(png1x1, 'base64'))
  const img = await run('read', { path: 'pixel.png' })
  check(
    'read image returns inline image',
    img.ok &&
      (img.image ?? '').startsWith('data:image/png;base64,') &&
      img.output.startsWith('Read image'),
    img.output
  )
  const list = await run('list', { path: '.' })
  check('list tool', list.ok && list.output.includes('hello.txt'))
  const globr = await run('glob', { pattern: '*.txt' })
  check('glob tool', globr.ok && globr.output.includes('hello.txt'))
  const grepr = await run('grep', { pattern: 'WORLD', include: '*.txt' })
  check('grep tool', grepr.ok && grepr.output.includes('hello.txt'))

  // ---- webfetch (offline-safe reject paths; no network needed) ----
  const badScheme = await run('webfetch', { url: 'file:///etc/passwd' })
  check(
    'webfetch rejects non-http scheme',
    !badScheme.ok && badScheme.output.includes('scheme'),
    badScheme.output
  )
  const badUrl = await run('webfetch', { url: 'not a url' })
  check(
    'webfetch rejects a malformed url',
    !badUrl.ok && badUrl.output.toLowerCase().includes('valid'),
    badUrl.output
  )

  // ---- disk-backed tool-output store (Phase 9.3) ----
  const smallBound = await boundToolOutput('sess-1', 'call-small', 'a short result')
  check('boundToolOutput passes small output through untouched', smallBound === 'a short result')
  // >2000 lines trips the line bound while staying well under read's 100k char cap.
  const bigText = Array.from({ length: 2500 }, (_, i) => `line ${i}`).join('\n')
  const bigBound = await boundToolOutput('sess-1', 'call-big', bigText)
  check(
    'boundToolOutput previews oversized output',
    bigBound.length < bigText.length && bigBound.includes('truncated')
  )
  const ptrMatch = bigBound.match(/saved to (\S+\.txt)/)
  const ptr = ptrMatch?.[1] ?? ''
  check(
    'boundToolOutput returns a file pointer',
    ptr.length > 0 && isManagedToolOutputPath(ptr),
    ptr
  )
  check('spilled file lives under the managed root', ptr.startsWith(toolOutputRoot()))
  const full = await fs.readFile(ptr, 'utf8')
  check('spilled file holds the full output', full === bigText)
  // The model can read the pointer back via the read tool (managed dir is allowed).
  const readBack = await run('read', { path: ptr })
  check(
    'read tool can reach the spilled pointer',
    readBack.ok && readBack.output.includes('line 2499'),
    readBack.output
  )
  // A path outside both the workspace and the managed dir is still rejected.
  const escaped = await run('read', { path: path.join(tmp, 'outside.txt') })
  check('read still rejects non-managed absolute paths', !escaped.ok, escaped.output)
  await cleanupToolOutputs()
  check(
    'cleanupToolOutputs keeps fresh spills',
    await fs
      .readFile(ptr, 'utf8')
      .then(() => true)
      .catch(() => false)
  )

  const bashCmd = process.platform === 'win32' ? 'Write-Output roxy-bash-ok' : 'echo roxy-bash-ok'
  const bashr = await run('bash', { command: bashCmd })
  check(
    'bash tool runs in workspace',
    bashr.ok && bashr.output.includes('roxy-bash-ok'),
    bashr.output
  )

  // ---- background bash (long-running processes: dev servers / watchers) ----
  const bgCmd =
    process.platform === 'win32'
      ? 'Write-Output roxy-bg-ok; Start-Sleep -Seconds 5'
      : 'echo roxy-bg-ok; sleep 5'
  const started = await run('bash', { command: bgCmd, background: true })
  const bgId = started.output.match(/bg_\d+/)?.[0] ?? ''
  check('bash background starts and returns an id', started.ok && bgId !== '', started.output)
  await new Promise((r) => setTimeout(r, 1500))
  const bgList = await run('bash_list', {})
  check(
    'bash_list shows the running process',
    bgList.ok && bgList.output.includes(bgId) && bgList.output.includes('running'),
    bgList.output
  )
  const bgOut = await run('bash_output', { id: bgId })
  check(
    'bash_output reads new output',
    bgOut.ok && bgOut.output.includes('roxy-bg-ok'),
    bgOut.output
  )
  const bgKill = await run('bash_kill', { id: bgId })
  check('bash_kill stops the process', bgKill.ok, bgKill.output)
  check('bash_output rejects an unknown id', !(await run('bash_output', { id: 'bg_nope' })).ok)

  // ---- Stop actually interrupts a running tool ----
  // The turn signal now reaches INSIDE runTool. Before this, the harness could
  // only check `aborted` BETWEEN tool calls, so pressing Stop during a long
  // bash did nothing until that command finished on its own (up to 10 minutes)
  // — the "cancel button gets stuck" bug.
  {
    const sleepCmd = process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30'

    // Aborting mid-flight kills the child and returns promptly.
    const controller = new AbortController()
    const startedAt = Date.now()
    const pending = runTool(
      'bash',
      { command: sleepCmd, timeout: 30 },
      { cwd: ws, signal: controller.signal }
    )
    setTimeout(() => controller.abort(), 300)
    const stoppedRes = await pending
    const elapsed = Date.now() - startedAt
    check('bash: an aborted command returns promptly', elapsed < 10_000, `${elapsed}ms`)
    check('bash: an aborted command is not ok', !stoppedRes.ok, stoppedRes.output)
    check(
      'bash: an aborted command reads as stopped, not as a timeout',
      /stopped/i.test(stoppedRes.output) && !/timed out/i.test(stoppedRes.output),
      stoppedRes.output
    )

    // An already-aborted signal must not spawn anything at all.
    const dead = new AbortController()
    dead.abort()
    const skipped = await runTool('bash', { command: bashCmd }, { cwd: ws, signal: dead.signal })
    check(
      'bash: an already-stopped turn never spawns the command',
      !skipped.ok && !skipped.output.includes('roxy-bash-ok'),
      skipped.output
    )

    // A signal that never aborts must not change ordinary behaviour.
    const live = new AbortController()
    const normal = await runTool('bash', { command: bashCmd }, { cwd: ws, signal: live.signal })
    check(
      'bash: a live signal leaves a normal command untouched',
      normal.ok && normal.output.includes('roxy-bash-ok'),
      normal.output
    )

    // Every tool call attaches an abort listener to the SAME turn signal, so a
    // long turn would leak one per call if they were never removed.
    const shared = new AbortController()
    for (let i = 0; i < 12; i++) {
      await runTool('bash', { command: bashCmd }, { cwd: ws, signal: shared.signal })
    }
    const listeners = (
      shared.signal as AbortSignal & { listenerCount?: (t: string) => number }
    ).listenerCount?.('abort')
    check(
      'bash: abort listeners are cleaned up between calls',
      listeners === undefined || listeners <= 1,
      String(listeners)
    )

    // A cancelled fetch reports as stopped rather than as a network failure.
    const fetchCtl = new AbortController()
    fetchCtl.abort()
    const fetchRes = await runTool(
      'webfetch',
      { url: 'https://example.com' },
      { cwd: ws, signal: fetchCtl.signal }
    )
    check(
      'webfetch: an already-stopped turn reports as stopped',
      !fetchRes.ok && /stopped/i.test(fetchRes.output),
      fetchRes.output
    )
  }

  // ---- background procs are owned per SESSION, not per cwd ----
  // Two sessions open on the SAME folder must not see or kill each other's dev
  // servers, and a subagent's processes must be owned by its parent session.
  {
    const sessA = repo.createChat({ title: 'bg A', kind: 'main', workspacePath: ws })
    const sessB = repo.createChat({ title: 'bg B', kind: 'main', workspacePath: ws })
    const subOfA = repo.createChat({ title: 'sub of A', kind: 'sub', parentId: sessA.id })
    check(
      'rootSessionId: a main session is its own root',
      repo.rootSessionId(sessA.id) === sessA.id
    )
    check('rootSessionId: a sub resolves to its parent', repo.rootSessionId(subOfA.id) === sessA.id)
    check('rootSessionId: an unknown id is returned as-is', repo.rootSessionId('nope') === 'nope')

    const inSession = (
      sessionId: string,
      name: string,
      input: Record<string, unknown>
    ): ReturnType<typeof runTool> => runTool(name, input, { cwd: ws, sessionId })

    const aStart = await inSession(sessA.id, 'bash', { command: bgCmd, background: true })
    const aId = aStart.output.match(/bg_\d+/)?.[0] ?? ''
    check('session A starts a background process', aStart.ok && aId !== '', aStart.output)

    // Same cwd, different session — the old cwd-keyed code leaked here.
    const bList = await inSession(sessB.id, 'bash_list', {})
    check(
      "session B cannot SEE session A's process (same folder)",
      bList.ok && !bList.output.includes(aId),
      bList.output
    )
    const bKill = await inSession(sessB.id, 'bash_kill', { id: aId })
    check("session B cannot KILL session A's process", !bKill.ok, bKill.output)
    const bOut = await inSession(sessB.id, 'bash_output', { id: aId })
    check("session B cannot READ session A's process output", !bOut.ok, bOut.output)

    const aList = await inSession(sessA.id, 'bash_list', {})
    check(
      'session A still sees its own process',
      aList.ok && aList.output.includes(aId),
      aList.output
    )

    // A subagent's process is registered under the PARENT, so the parent's
    // bash_list sees it (and deleting the parent will stop it).
    const subStart = await inSession(subOfA.id, 'bash', { command: bgCmd, background: true })
    const subId = subStart.output.match(/bg_\d+/)?.[0] ?? ''
    check('a subagent can start a background process', subStart.ok && subId !== '', subStart.output)
    const aList2 = await inSession(sessA.id, 'bash_list', {})
    check(
      "a subagent's process shows up in its PARENT's bash_list",
      aList2.ok && aList2.output.includes(subId),
      aList2.output
    )
    const bList2 = await inSession(sessB.id, 'bash_list', {})
    check(
      "an unrelated session still can't see the subagent's process",
      bList2.ok && !bList2.output.includes(subId),
      bList2.output
    )

    // Deleting a session stops its processes (previously they lived until quit).
    const killedCount = killSessionBackground(sessA.id)
    check('killSessionBackground kills the session + subagent processes', killedCount === 2)
    const aList3 = await inSession(sessA.id, 'bash_list', {})
    check(
      'the registry is emptied for that session after the kill',
      aList3.ok && !aList3.output.includes(aId) && !aList3.output.includes(subId),
      aList3.output
    )
    check(
      'killSessionBackground on an unknown session is a no-op',
      killSessionBackground('nope') === 0
    )
    check('killSessionBackground ignores an empty id', killSessionBackground('') === 0)

    repo.removeChat(sessA.id)
    repo.removeChat(sessB.id)
  }

  // ---- activity survives deletion (the whole point of the ledger) ----
  // The contribution graph used to COUNT assistant messages, which cascade away
  // with their chat - so deleting a session, or removing a project folder (which
  // deletes every session under it), silently erased months of history. These
  // pin the property that broke: the record of having worked outlives the
  // transcript it came from.
  {
    const before = getActivityStats().total
    const today = localDay(Date.now())

    const keep = repo.createChat({ title: 'activity keep', kind: 'main', workspacePath: ws })
    const doomed = repo.createChat({ title: 'activity doomed', kind: 'main', workspacePath: ws })
    const sub = repo.createChat({
      title: 'activity sub',
      kind: 'sub',
      workspacePath: ws,
      parentId: doomed.id
    })

    repo.addMessage({ chatId: keep.id, role: 'user', content: 'hi' })
    repo.addMessage({ chatId: keep.id, role: 'assistant', content: 'one' })
    repo.addMessage({ chatId: doomed.id, role: 'assistant', content: 'two' })
    repo.addMessage({ chatId: sub.id, role: 'assistant', content: 'three' })

    // 4 messages went in, 3 of them assistant: user prompts are not turns.
    const after = getActivityStats()
    check('activity: assistant messages are recorded as turns', after.total === before + 3)
    const todayCell = after.days[after.days.length - 1]
    check(
      'activity: turns land on today, in local time',
      todayCell.date === today && todayCell.count >= 3
    )

    // Deleting the session cascades its messages AND its subagent's - the graph
    // must not move.
    repo.removeChat(doomed.id)
    check(
      "activity: deleting a session doesn't erase its history",
      getActivityStats().total === before + 3
    )
    check(
      'activity: the messages really were deleted',
      repo.listMessages(doomed.id).length === 0 && repo.listMessages(sub.id).length === 0
    )

    // ...and removing the last session in a folder (what "remove folder" does)
    // must not either.
    repo.removeChat(keep.id)
    const end = getActivityStats()
    check('activity: emptying a project folder keeps the graph', end.total === before + 3)
    check('activity: today is still an active day', end.currentStreak >= 1)
  }

  // ---- migration repair (two branches, two different "v14"s) ----
  // The schema version is an ARRAY POSITION, so when the usage-dashboard branch
  // and the worktree branch each shipped a migration numbered v14, a database
  // that applied one advanced past the other and would never run it. Both
  // directions leave a DB that looks fully migrated with a schema object missing.
  // The reconcile step must repair either, be idempotent, and lose no data.
  {
    /** Open a database the way database.ts does: migrate, then repair. */
    const runLadder = (db: InstanceType<typeof Database>): void => {
      for (
        let v = db.pragma('user_version', { simple: true }) as number;
        v < MIGRATIONS.length;
        v++
      ) {
        const step = MIGRATIONS[v]
        if (typeof step === 'string') db.exec(step)
        else step(db)
        db.pragma(`user_version = ${v + 1}`)
      }
      // Unconditional: the version counter alone can't tell us the schema is
      // actually complete.
      repairSchema(db)
    }
    const colsOf = (db: InstanceType<typeof Database>): string[] =>
      (db.prepare('PRAGMA table_info(chats)').all() as { name: string }[]).map((c) => c.name)
    const tablesOf = (db: InstanceType<typeof Database>): string[] =>
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
      ).map((t) => t.name)
    /** Apply the first `upTo` migrations, then seed a session. */
    const seeded = async (name: string, upTo: number): Promise<InstanceType<typeof Database>> => {
      const dir = path.join(tmp, name)
      await fs.mkdir(dir, { recursive: true })
      const db = new Database(path.join(dir, 'roxy.db'))
      for (let i = 0; i < upTo; i++) {
        const step = MIGRATIONS[i]
        if (typeof step === 'string') db.exec(step)
        else step(db)
      }
      db.pragma(`user_version = ${upTo}`)
      db.prepare(
        `INSERT INTO chats(id, title, kind, workspace_path, created_at, updated_at, sort_order)
         VALUES('mig1','pre-existing','main','/proj',1,1,1)`
      ).run()
      return db
    }

    // v18's backfill: an existing install upgrading must not start from a blank
    // graph. The ledger is seeded from the assistant messages still on disk,
    // bucketed by LOCAL day so it agrees with what the renderer draws.
    {
      const db = await seeded('mig-activity', 17)
      const mk = (id: string, at: number, role: string): void => {
        db.prepare(
          `INSERT INTO messages(id, chat_id, role, content, created_at)
           VALUES(?, 'mig1', ?, 'x', ?)`
        ).run(id, role, at)
      }
      const noon = new Date(2026, 0, 15, 12, 0, 0).getTime()
      mk('m1', noon, 'assistant')
      mk('m2', noon + 60_000, 'assistant')
      mk('m3', noon - 24 * 60 * 60 * 1000, 'assistant')
      mk('m4', noon, 'user') // not a turn
      check('migration v18: ledger absent before the upgrade', !tablesOf(db).includes('activity'))

      runLadder(db)
      const led = db.prepare('SELECT day, turns FROM activity ORDER BY day').all() as {
        day: string
        turns: number
      }[]
      check(
        'migration v18: backfills one row per active day',
        led.length === 2,
        JSON.stringify(led)
      )
      check(
        'migration v18: backfills local-day counts, assistant only',
        led[0].day === localDay(noon - 24 * 60 * 60 * 1000) &&
          led[0].turns === 1 &&
          led[1].day === localDay(noon) &&
          led[1].turns === 2,
        JSON.stringify(led)
      )

      // The ledger is the record of record: re-running must never re-seed on top
      // of it, or every restart would double a day that still has its messages.
      repairSchema(db)
      repairSchema(db)
      check(
        'migration v18: repeated opens never double-count',
        (
          db.prepare('SELECT turns AS t FROM activity WHERE day = ?').get(localDay(noon)) as {
            t: number
          }
        ).t === 2
      )
      db.close()
    }

    // Direction 1: took the usage v14, so the worktree columns were skipped.
    // This is the state from the bug report ("no such column: worktree_path").
    {
      const db = await seeded('mig-usage-first', 14)
      db.exec('ALTER TABLE chats ADD COLUMN worktree_pending TEXT')
      db.pragma('user_version = 15')
      check('migration repro: worktree columns are missing', !colsOf(db).includes('worktree_path'))
      let reported = ''
      try {
        db.prepare('UPDATE chats SET worktree_path = ? WHERE id = ?').run('/wt', 'mig1')
      } catch (e) {
        reported = e instanceof Error ? e.message : String(e)
      }
      check(
        'migration repro: reproduces the reported error',
        /no such column: worktree_path/.test(reported),
        reported
      )

      runLadder(db)
      for (const col of ['worktree_path', 'branch', 'dev_port', 'worktree_pending']) {
        check(`migration repair (usage-first): adds ${col}`, colsOf(db).includes(col))
      }
      db.prepare('UPDATE chats SET worktree_path = ? WHERE id = ?').run('/wt', 'mig1')
      const row = db.prepare('SELECT * FROM chats WHERE id = ?').get('mig1') as {
        title: string
        worktree_path: string | null
      }
      check(
        'migration repair (usage-first): the failing write now succeeds',
        row.worktree_path === '/wt'
      )
      check('migration repair (usage-first): existing rows survive', row.title === 'pre-existing')
      check('migration repair (usage-first): usage table intact', tablesOf(db).includes('usage'))

      // Idempotent — it runs on every open, including healthy databases.
      repairSchema(db)
      repairSchema(db)
      check(
        'migration repair: re-running changes nothing',
        (
          db.prepare('SELECT worktree_path AS w FROM chats WHERE id = ?').get('mig1') as {
            w: string
          }
        ).w === '/wt'
      )
      check(
        'migration repair: no duplicate columns',
        colsOf(db).filter((c) => c === 'worktree_path').length === 1
      )
      db.close()
    }

    // Direction 2: took the WORKTREE v14 (the pre-merge build), so the usage
    // table was skipped — the cost dashboard would crash instead.
    {
      const db = await seeded('mig-worktree-first', 13)
      db.exec(`ALTER TABLE chats ADD COLUMN worktree_path TEXT;
               ALTER TABLE chats ADD COLUMN branch TEXT;
               ALTER TABLE chats ADD COLUMN dev_port INTEGER;`)
      db.pragma('user_version = 14')
      db.exec('ALTER TABLE chats ADD COLUMN worktree_pending TEXT')
      db.pragma('user_version = 15')
      check('migration repro: the usage table is missing', !tablesOf(db).includes('usage'))

      runLadder(db)
      check(
        'migration repair (worktree-first): creates the usage table',
        tablesOf(db).includes('usage')
      )
      check(
        'migration repair (worktree-first): keeps the worktree columns',
        colsOf(db).includes('worktree_path')
      )
      check(
        'migration repair (worktree-first): existing rows survive',
        (db.prepare('SELECT title FROM chats WHERE id = ?').get('mig1') as { title: string })
          .title === 'pre-existing'
      )
      // The usage table must be the REAL one, not a stub.
      const usageCols = (db.prepare('PRAGMA table_info(usage)').all() as { name: string }[]).map(
        (c) => c.name
      )
      for (const col of ['provider_id', 'model', 'cost', 'estimated']) {
        check(`migration repair (worktree-first): usage.${col} exists`, usageCols.includes(col))
      }
      db.close()
    }
  }

  // ---- schema self-heal ----
  // `user_version` counts the steps that RAN, not what the database contains.
  // When the counter runs ahead of reality — two branches numbering a migration
  // the same, a partial upgrade, a restored backup — the ladder has "nothing to
  // do" while a table or column is missing, and it only surfaces much later as a
  // runtime crash ("no such table: projects"). repairSchema runs unconditionally
  // on every open to close that hole.
  {
    const healDir = path.join(tmp, 'heal')
    await fs.mkdir(healDir, { recursive: true })
    let n = 0
    /** A fully migrated DB with one session, as a healthy install would look. */
    const healthy = (): InstanceType<typeof Database> => {
      const db = new Database(path.join(healDir, `h${++n}.db`))
      for (const step of MIGRATIONS) {
        if (typeof step === 'string') db.exec(step)
        else step(db)
      }
      db.pragma(`user_version = ${MIGRATIONS.length}`)
      repairSchema(db)
      db.prepare(
        `INSERT INTO chats(id, title, kind, workspace_path, created_at, updated_at, sort_order)
         VALUES('h1','seeded','main','/proj',1,1,1)`
      ).run()
      return db
    }
    const tablesOf = (db: InstanceType<typeof Database>): string[] =>
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
          .all() as { name: string }[]
      ).map((t) => t.name)

    // Every table the app depends on must come back, not just the ones a
    // previously-reported bug happened to name.
    for (const table of ['projects', 'usage', 'queue', 'mcp_servers', 'settings', 'activity']) {
      const db = healthy()
      db.exec(`DROP TABLE ${table}`)
      check(`self-heal: ${table} is missing before repair`, !tablesOf(db).includes(table))
      repairSchema(db)
      check(`self-heal: ${table} is restored`, tablesOf(db).includes(table))
      check(
        `self-heal: data survives the ${table} repair`,
        (db.prepare('SELECT title AS t FROM chats WHERE id = ?').get('h1') as { t: string }).t ===
          'seeded'
      )
      db.close()
    }

    // The reported crash, end to end.
    {
      const db = healthy()
      db.exec('DROP TABLE projects')
      let before = ''
      try {
        db.prepare('SELECT path FROM projects ORDER BY sort_order ASC').all()
      } catch (e) {
        before = e instanceof Error ? e.message : String(e)
      }
      check(
        'self-heal: reproduces "no such table: projects"',
        /no such table: projects/.test(before),
        before
      )
      repairSchema(db)
      let after = ''
      try {
        db.prepare('SELECT path FROM projects ORDER BY sort_order ASC').all()
      } catch (e) {
        after = e instanceof Error ? e.message : String(e)
      }
      check('self-heal: projects:listOrder works again', after === '', after)
      // projects is derived state, so it can be rebuilt from the sessions.
      check(
        'self-heal: projects is re-seeded from existing sessions',
        (db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n === 1
      )
      db.close()
    }

    // A hand-ordered project list must never be clobbered by that re-seed.
    {
      const db = healthy()
      db.prepare('INSERT INTO projects(path, sort_order, created_at) VALUES(?,?,?)').run(
        '/proj',
        7,
        1
      )
      repairSchema(db)
      check(
        'self-heal: an existing project order is preserved',
        (
          db.prepare('SELECT sort_order AS s FROM projects WHERE path = ?').get('/proj') as {
            s: number
          }
        ).s === 7
      )
      db.close()
    }

    // Idempotent: it runs on every open, so it must cost nothing when healthy.
    {
      const db = healthy()
      const before = tablesOf(db).length
      repairSchema(db)
      repairSchema(db)
      check('self-heal: repeating it on a healthy DB is a no-op', tablesOf(db).length === before)
      check(
        'self-heal: no duplicate columns after repeats',
        (db.prepare('PRAGMA table_info(chats)').all() as { name: string }[]).filter(
          (c) => c.name === 'worktree_path'
        ).length === 1
      )
      db.close()
    }

    // ---- v22: the dead Exa key is deleted on upgrade ----
    // The real scenario, not a synthetic one: someone who actually typed a key
    // into the old "Web search" settings box, then upgrades. The credential is
    // for a feature that no longer exists and that they can no longer see, so
    // leaving it in the settings table (and in every backup of it) is not
    // acceptable. Drive the ladder exactly as database.ts does.
    {
      const db = new Database(path.join(healDir, 'v22.db'))
      // Stop one rung short, at v21 — the last release that still had the box.
      // Indexed from the START of the ladder, not the end: it is append-only, so
      // "the last migration" stops being v22 the moment anything lands after it,
      // and this test would silently start asserting about an unrelated future
      // step. v22 is the 22nd rung, and always will be.
      const V22 = 22
      const priorSteps = MIGRATIONS.slice(0, V22 - 1)
      for (const step of priorSteps) {
        if (typeof step === 'string') db.exec(step)
        else step(db)
      }
      db.pragma(`user_version = ${priorSteps.length}`)
      db.prepare('INSERT INTO settings(key, value) VALUES(?, ?)').run(
        'web_search_api_key',
        'exa_live_secret'
      )
      // A neighbouring row proves the DELETE is aimed, not a blanket wipe.
      db.prepare('INSERT INTO settings(key, value) VALUES(?, ?)').run('active_model', 'gpt-5')
      const keyOf = (k: string): string | undefined =>
        (db.prepare('SELECT value AS v FROM settings WHERE key = ?').get(k) as { v: string })?.v
      check(
        'migration v22: the old key is present before upgrading',
        keyOf('web_search_api_key') === 'exa_live_secret'
      )

      // The remaining rungs, applied the way database.ts applies them.
      for (let v = priorSteps.length; v < MIGRATIONS.length; v++) {
        const step = MIGRATIONS[v]
        if (typeof step === 'string') db.exec(step)
        else step(db)
        db.pragma(`user_version = ${v + 1}`)
      }

      check(
        'migration v22: upgrading deletes the stored Exa key',
        keyOf('web_search_api_key') === undefined
      )
      check('migration v22: other settings are untouched', keyOf('active_model') === 'gpt-5')
      // repairSchema runs on every open and must never resurrect it.
      repairSchema(db)
      check(
        'migration v22: the repair step does not bring it back',
        keyOf('web_search_api_key') === undefined
      )
      db.close()
    }
  }

  // ---- sessionCwd (the one working-directory resolver) ----
  {
    check('sessionCwd: an unknown chat resolves to empty', sessionCwd('nope') === '')
    check('sessionCwd: an empty id resolves to empty', sessionCwd('') === '')

    const plain = repo.createChat({ title: 'cwd plain', kind: 'main', workspacePath: ws })
    check('sessionCwd: no worktree -> the project folder', sessionCwd(plain.id) === ws)

    const noWs = repo.createChat({ title: 'cwd no workspace', kind: 'main' })
    check('sessionCwd: no workspace -> empty', sessionCwd(noWs.id) === '')

    // New columns default to NULL, so nothing changes for existing sessions.
    const fresh = repo.getChat(plain.id)
    check(
      'migration v14: worktree columns default to null',
      fresh?.worktreePath === null && fresh?.branch === null && fresh?.devPort === null
    )

    // A worktree redirects the session; the project IS the repo root here, so
    // the cwd is the worktree itself.
    const wtDir = path.join(tmp, 'wt-fix-auth')
    await fs.mkdir(wtDir, { recursive: true })
    repo.setChatWorktree(plain.id, {
      worktreePath: wtDir,
      branch: 'roxy/a1b2c3d4',
      devPort: 3101
    })
    const wired = repo.getChat(plain.id)
    check(
      'setChatWorktree persists path/branch/port',
      wired?.worktreePath === wtDir && wired?.branch === 'roxy/a1b2c3d4' && wired?.devPort === 3101
    )
    // `ws` has no .git, so findGitRoot finds nothing and we stay put — this is
    // the deliberate "can't trust the mapping" fallback.
    check(
      'sessionCwd: a worktree without a repo root falls back to the project folder',
      sessionCwd(plain.id) === ws
    )

    // With a real repo root, the sub-path is preserved.
    const repoRoot = path.join(tmp, 'repo-with-git')
    const pkgDir = path.join(repoRoot, 'apps', 'web')
    await fs.mkdir(pkgDir, { recursive: true })
    await fs.mkdir(path.join(repoRoot, '.git'), { recursive: true })
    const subFolder = repo.createChat({
      title: 'cwd subfolder',
      kind: 'main',
      workspacePath: pkgDir
    })
    repo.setChatWorktree(subFolder.id, { worktreePath: wtDir, branch: 'roxy/deadbeef' })
    check(
      'sessionCwd: a project inside a repo keeps its subpath in the worktree',
      sessionCwd(subFolder.id) === path.join(wtDir, 'apps', 'web')
    )

    // Subagents always run in their parent's tree, never their own.
    const kid = repo.createChat({ title: 'cwd sub', kind: 'sub', parentId: subFolder.id })
    check(
      'sessionCwd: a sub-session resolves through its parent',
      sessionCwd(kid.id) === path.join(wtDir, 'apps', 'web')
    )
    const grandkid = repo.createChat({ title: 'cwd sub2', kind: 'sub', parentId: kid.id })
    check(
      'sessionCwd: a nested sub-session still resolves to the root worktree',
      sessionCwd(grandkid.id) === path.join(wtDir, 'apps', 'web')
    )

    // Clearing the worktree returns the session to the project folder.
    repo.setChatWorktree(subFolder.id, { worktreePath: null })
    check(
      'sessionCwd: clearing the worktree restores the project folder',
      sessionCwd(subFolder.id) === pkgDir
    )

    repo.removeChat(plain.id)
    repo.removeChat(noWs.id)
    repo.removeChat(subFolder.id)
  }

  // ---- git service + real worktrees ----
  // Builds an actual repo on disk and drives the real `git` binary. Skipped
  // wholesale when git isn't installed, so the suite still runs on a bare box.
  {
    const gitOk = await git.isGitAvailable()
    if (!gitOk) {
      console.log('  (skipping git/worktree checks — no git binary)')
    } else {
      const gitRepo = path.join(tmp, 'gitrepo')
      await fs.mkdir(gitRepo, { recursive: true })
      const runGit = (args: string[], cwd = gitRepo): Promise<number> =>
        new Promise((resolve) => {
          const c = spawn('git', args, { cwd, shell: false, windowsHide: true })
          c.on('close', (code) => resolve(code ?? 1))
          c.on('error', () => resolve(1))
        })
      await runGit(['init', '--initial-branch=main'])
      await runGit(['config', 'user.email', 'smoke@roxy.test'])
      await runGit(['config', 'user.name', 'Roxy Smoke'])
      await runGit(['config', 'commit.gpgsign', 'false'])
      await fs.writeFile(path.join(gitRepo, 'README.md'), '# smoke\n')
      await runGit(['add', '.'])
      await runGit(['commit', '-m', 'initial'])

      // ---- queries ----
      const root = await git.repoRoot(gitRepo)
      check('git.repoRoot finds the repo', !!root, String(root))
      check('git.repoRoot is null outside a repo', (await git.repoRoot(tmp)) === null)
      check('git.currentBranch reads the branch', (await git.currentBranch(gitRepo)) === 'main')
      check(
        'git.defaultBranch falls back to local main',
        (await git.defaultBranch(gitRepo)) === 'main'
      )
      const branches = await git.listBranches(gitRepo)
      check('git.listBranches includes main', branches.includes('main'), branches.join(','))

      const st = await git.status(gitRepo)
      check('git.status: a fresh checkout is clean', st?.dirty === false, JSON.stringify(st))
      await fs.writeFile(path.join(gitRepo, 'dirty.txt'), 'x')
      const st2 = await git.status(gitRepo)
      check('git.status: an untracked file is dirty', st2?.dirty === true && st2.changed === 1)
      await fs.rm(path.join(gitRepo, 'dirty.txt'))

      // The main working tree is always listed, and flagged as main.
      const wt0 = await git.listWorktrees(root!)
      check('git.listWorktrees lists the main tree', wt0.length === 1 && wt0[0].isMain === true)

      // ---- branch naming ----
      const tmpBranch = git.temporaryBranchName()
      check(
        'temporaryBranchName looks like roxy/<8 hex>',
        /^roxy\/[0-9a-f]{8}$/.test(tmpBranch),
        tmpBranch
      )
      check('isTemporaryBranch accepts a generated name', git.isTemporaryBranch(tmpBranch))
      check('isTemporaryBranch rejects a user branch', !git.isTemporaryBranch('fix-auth'))
      check(
        'isTemporaryBranch rejects a roxy-prefixed real name',
        !git.isTemporaryBranch('roxy/fix-auth')
      )
      check('isTemporaryBranch rejects null', !git.isTemporaryBranch(null))

      // ---- create ----
      const created = await git.createWorktree({ repoRoot: root!, branch: tmpBranch })
      check('createWorktree succeeds', created.ok && !!created.worktree, created.error ?? '')
      const wtPath = created.worktree!.path
      check('the worktree directory exists', existsSync(wtPath))
      check(
        'the worktree lives OUTSIDE the repo',
        !path.normalize(wtPath).startsWith(path.normalize(gitRepo)),
        wtPath
      )
      check('the worktree has the repo content', existsSync(path.join(wtPath, 'README.md')))
      check(
        'createWorktree records the PR base in git config',
        (await git.baseBranchFor(gitRepo, tmpBranch)) === 'main'
      )
      const wt1 = await git.listWorktrees(root!)
      check('listWorktrees now sees two trees', wt1.length === 2, String(wt1.length))
      check(
        'the new worktree is not flagged main',
        wt1.some((w) => w.path === wtPath && !w.isMain)
      )

      // Asking for the same branch again ATTACHES rather than failing — git
      // refuses to check one branch out twice.
      const again = await git.createWorktree({ repoRoot: root!, branch: tmpBranch })
      check(
        'createWorktree on a checked-out branch attaches instead of failing',
        again.ok && again.attached === true && again.worktree?.path === wtPath,
        again.error ?? ''
      )

      // ---- sessionCwd resolves into the worktree ----
      const wtChat = repo.createChat({
        title: 'worktree session',
        kind: 'main',
        workspacePath: gitRepo
      })
      repo.setChatWorktree(wtChat.id, { worktreePath: wtPath, branch: tmpBranch })
      check(
        'sessionCwd resolves into the worktree',
        sessionCwd(wtChat.id) === wtPath,
        sessionCwd(wtChat.id)
      )

      // A tool run in that session must actually land in the worktree.
      const wrote = await runTool(
        'write',
        { path: 'from-agent.txt', content: 'hi' },
        {
          cwd: sessionCwd(wtChat.id),
          sessionId: wtChat.id
        }
      )
      check(
        'a tool writes inside the worktree',
        wrote.ok && existsSync(path.join(wtPath, 'from-agent.txt'))
      )
      check('...and NOT in the main checkout', !existsSync(path.join(gitRepo, 'from-agent.txt')))

      // ---- renaming a workstream's branch ----
      // The generated name (roxy/6fdc60b8) says nothing about the work and is
      // what lands on the PR, so renaming has to work from the UI -- WHILE the
      // branch is checked out in a live worktree, without disturbing it.
      {
        const before = repo.getChat(wtChat.id)?.branch
        check('the session starts on its generated branch', before === tmpBranch, before ?? '')

        // Uncommitted work must survive: this is the whole risk of the feature.
        await fs.writeFile(path.join(wtPath, 'in-progress.txt'), 'do not lose me\n')

        const renamed = await renameWorkstreamBranch(wtChat.id, 'feat/nice-name')
        check('renameWorkstreamBranch succeeds on a live worktree', renamed.ok, renamed.error ?? '')
        check('...and reports the new name', renamed.branch === 'feat/nice-name')
        check(
          '...git agrees the worktree is on it',
          (await git.currentBranch(wtPath)) === 'feat/nice-name'
        )
        check('...the DB pointer follows', repo.getChat(wtChat.id)?.branch === 'feat/nice-name')
        check('...the worktree directory is untouched', existsSync(wtPath))
        check('...and uncommitted work survives', existsSync(path.join(wtPath, 'in-progress.txt')))
        // The PR base is stored under the branch's config section, which git
        // moves with the rename -- losing it would break `gh pr create --base`.
        check(
          '...the recorded PR base moves with the branch',
          (await git.baseBranchFor(gitRepo, 'feat/nice-name')) === 'main'
        )

        check(
          'renaming to the SAME name is a no-op, not an error',
          (await renameWorkstreamBranch(wtChat.id, 'feat/nice-name')).ok
        )
        const clash = await renameWorkstreamBranch(wtChat.id, 'main')
        check('renaming onto an existing branch is refused', !clash.ok)
        check(
          '...with a readable reason',
          /already exists/i.test(clash.error ?? ''),
          clash.error ?? ''
        )
        check(
          '...and the branch is unchanged',
          (await git.currentBranch(wtPath)) === 'feat/nice-name'
        )

        const bad = await renameWorkstreamBranch(wtChat.id, 'not a valid name')
        check('an invalid branch name is refused before git runs', !bad.ok)
        check(
          '...without touching the branch',
          (await git.currentBranch(wtPath)) === 'feat/nice-name'
        )
        check('an empty rename is refused', !(await renameWorkstreamBranch(wtChat.id, '   ')).ok)

        // A session with no workstream has no branch to rename.
        const plainChat = repo.createChat({ title: 'no wt', kind: 'main', workspacePath: gitRepo })
        check(
          'a session without a workstream cannot rename',
          !(await renameWorkstreamBranch(plainChat.id, 'x')).ok
        )
        repo.removeChat(plainChat.id)
        check('an unknown session is refused', !(await renameWorkstreamBranch('nope', 'x')).ok)

        // Put it back so the removal checks below still line up.
        await fs.rm(path.join(wtPath, 'in-progress.txt'))
        const back = await renameWorkstreamBranch(wtChat.id, tmpBranch)
        check('renamed back for the remaining checks', back.ok, back.error ?? '')
      }

      // ---- branch names come from the session title ----
      // A session called "Legacy Ogre Apprentice" should land on
      // roxy/legacy-ogre-apprentice, not roxy/6fdc60b8.
      {
        const named = await git.branchNameForTitle(root!, 'Legacy Ogre Apprentice')
        check(
          'branchNameForTitle uses the session title',
          named === 'roxy/legacy-ogre-apprentice',
          named
        )

        // A branch OUTLIVES its worktree, so a repeat title is a real
        // collision -- and `worktree add -b` on an existing branch is fatal.
        await runGit(['branch', 'roxy/legacy-ogre-apprentice'])
        const second = await git.branchNameForTitle(root!, 'Legacy Ogre Apprentice')
        check(
          '...and steps aside when the branch already exists',
          second === 'roxy/legacy-ogre-apprentice-2',
          second
        )
        await runGit(['branch', 'roxy/legacy-ogre-apprentice-2'])
        const third = await git.branchNameForTitle(root!, 'Legacy Ogre Apprentice')
        check('...counting up as needed', third === 'roxy/legacy-ogre-apprentice-3', third)
        await runGit(['branch', '-D', 'roxy/legacy-ogre-apprentice'])
        await runGit(['branch', '-D', 'roxy/legacy-ogre-apprentice-2'])

        // An unusable title falls back to hex rather than inventing a name.
        const emoji = await git.branchNameForTitle(root!, '🎉🎉🎉')
        check(
          'an unusable title falls back to a hex name',
          /^roxy\/[0-9a-f]{8}$/.test(emoji),
          emoji
        )

        // Whatever it produces must be a legal branch AND recognized as ours,
        // or the rename guard would refuse to touch it later.
        check('a generated name is a valid branch', branchNameError(named) === null)
        check('...and is recognized as generated', isPlaceholderBranch(named, 'roxy'))

        // End to end: a real session materializes onto a named branch.
        const titled = repo.createChat({
          title: 'Crimson Goblin Slayer',
          kind: 'main',
          workspacePath: gitRepo,
          worktree: { mode: 'new' }
        })
        const tm = await materializePendingWorktree(titled.id)
        check(
          'a new workstream lands on a title-shaped branch',
          tm.ok && tm.branch === 'roxy/crimson-goblin-slayer',
          tm.branch ?? tm.error ?? ''
        )
        check(
          '...and git agrees',
          (await git.currentBranch(tm.worktreePath!)) === 'roxy/crimson-goblin-slayer'
        )
        await removeWorktreeForChat(titled.id, { force: true })
        repo.removeChat(titled.id)
      }

      // ---- the agent renames the branch when it retitles the session ----
      // A session starts on a random slug and is retitled once the agent knows
      // what the work is; the branch should follow, since that name is what
      // lands on the PR.
      {
        const auto = repo.createChat({
          title: 'Azure Orsted Mage',
          kind: 'main',
          workspacePath: gitRepo,
          worktree: { mode: 'new' }
        })
        const m = await materializePendingWorktree(auto.id)
        check(
          'auto-rename: starts on a slug branch',
          m.branch === 'roxy/azure-orsted-mage',
          m.branch ?? m.error ?? ''
        )

        const synced = await syncBranchToTitle(auto.id, 'Fix auth token refresh')
        check(
          'auto-rename: follows the new title',
          synced.renamed && synced.branch === 'roxy/fix-auth-token-refresh',
          synced.branch ?? ''
        )
        check(
          '...and git agrees',
          (await git.currentBranch(m.worktreePath!)) === 'roxy/fix-auth-token-refresh'
        )
        check(
          '...and the DB pointer follows',
          repo.getChat(auto.id)?.branch === 'roxy/fix-auth-token-refresh'
        )

        // Now the branch is a name that came from a real title -- but it is
        // still OUR shape, so a later retitle may still move it.
        const again = await syncBranchToTitle(auto.id, 'Rework the auth flow')
        check(
          'auto-rename: a generated name can still be re-derived',
          again.renamed === false || again.branch === 'roxy/rework-the-auth-flow',
          String(again.branch)
        )

        // A branch the USER named is off limits, whatever the title becomes.
        const manual = await renameWorkstreamBranch(auto.id, 'my/own-name')
        check('auto-rename: a manual rename works', manual.ok, manual.error ?? '')
        const skipped = await syncBranchToTitle(auto.id, 'Something Else Entirely')
        check('auto-rename: NEVER touches a human-named branch', skipped.renamed === false)
        check(
          '...leaving it exactly as the user set it',
          repo.getChat(auto.id)?.branch === 'my/own-name'
        )

        // An unusable title must not swap a good name for a hex fallback.
        await renameWorkstreamBranch(auto.id, 'roxy/still-generated-name')
        const emoji = await syncBranchToTitle(auto.id, '🎉🎉🎉')
        check('auto-rename: an unusable title changes nothing', emoji.renamed === false)
        check(
          '...keeping the previous branch',
          repo.getChat(auto.id)?.branch === 'roxy/still-generated-name'
        )

        // Renaming to a name that already exists must fail rather than clobber.
        await runGit(['branch', 'roxy/taken-name-here'])
        const clash = await renameWorkstreamBranch(auto.id, 'roxy/taken-name-here')
        check('auto-rename: refuses to clobber an existing branch', !clash.ok)

        // A session with no workstream is simply skipped, not an error.
        const bare = repo.createChat({ title: 'no wt', kind: 'main', workspacePath: gitRepo })
        check(
          'auto-rename: a session without a workstream is skipped',
          (await syncBranchToTitle(bare.id, 'Whatever')).renamed === false
        )
        repo.removeChat(bare.id)
        check(
          'auto-rename: an unknown session is skipped',
          (await syncBranchToTitle('nope', 'Whatever')).renamed === false
        )

        // A PUSHED branch must never be renamed. git moves only the LOCAL ref,
        // so the remote keeps the old name and any open PR points at a branch
        // that no longer exists here. This is the one rule where getting it
        // wrong is externally visible, so it is tested against a real remote.
        {
          const bare = path.join(tmp, 'origin.git')
          await runGit(['init', '--bare', '-q', bare], tmp)
          const pushed = repo.createChat({
            title: 'Pushed Goblin Slayer',
            kind: 'main',
            workspacePath: gitRepo,
            worktree: { mode: 'new' }
          })
          const pm = await materializePendingWorktree(pushed.id)
          const wt = pm.worktreePath!
          await runGit(['remote', 'add', 'origin', bare], wt)
          await runGit(['push', '-q', '-u', 'origin', pm.branch!], wt)

          check('a pushed branch reports an upstream', await git.hasUpstreamBranch(wt, pm.branch!))

          const blocked = await renameWorkstreamBranch(pushed.id, 'roxy/renamed-after-push')
          check('renaming a PUSHED branch is refused', !blocked.ok)
          check(
            '...with a reason naming the push',
            /pushed/i.test(blocked.error ?? ''),
            blocked.error ?? ''
          )
          check(
            '...and the branch is untouched',
            (await git.currentBranch(wt)) === pm.branch,
            pm.branch ?? ''
          )

          const autoSkip = await syncBranchToTitle(pushed.id, 'A Completely New Title')
          check('auto-rename also skips a pushed branch', autoSkip.renamed === false)
          check(
            '...leaving the pushed name in place',
            repo.getChat(pushed.id)?.branch === pm.branch
          )

          await removeWorktreeForChat(pushed.id, { force: true })
          repo.removeChat(pushed.id)
        }

        await removeWorktreeForChat(auto.id, { force: true })
        repo.removeChat(auto.id)
      }

      // ---- lazy materialization ----
      const lazy = repo.createChat({
        title: 'lazy worktree',
        kind: 'main',
        workspacePath: gitRepo,
        worktree: { mode: 'new' }
      })
      check(
        'a pending worktree intent is persisted',
        repo.getChat(lazy.id)?.worktreePending?.mode === 'new'
      )
      check('...and no worktree exists yet', repo.getChat(lazy.id)?.worktreePath === null)
      const mat = await materializePendingWorktree(lazy.id)
      check(
        'materialize creates the worktree on first turn',
        mat.ok && !!mat.worktreePath,
        mat.error ?? ''
      )
      check('the intent is cleared afterwards', repo.getChat(lazy.id)?.worktreePending === null)
      check(
        'the session now points at its worktree',
        repo.getChat(lazy.id)?.worktreePath === mat.worktreePath
      )
      // Second call: the intent is gone, so it reports "nothing to do" and must
      // leave the existing worktree alone rather than making another.
      const wtCountBefore = (await git.listWorktrees(root!)).length
      const redo = await materializePendingWorktree(lazy.id)
      check('materialize does nothing on a second call', redo.ok === false)
      check(
        '...and the session keeps its worktree',
        repo.getChat(lazy.id)?.worktreePath === mat.worktreePath
      )
      check(
        '...and no extra worktree was created',
        (await git.listWorktrees(root!)).length === wtCountBefore
      )

      // Materializing a worktree also reserves a dev port for the session.
      check(
        'a materialized worktree gets a dev port',
        typeof repo.getChat(lazy.id)?.devPort === 'number',
        String(repo.getChat(lazy.id)?.devPort)
      )

      // Materialization announces itself to the renderer (chats:updated) so the
      // workstream strip stops claiming "(pending) / branch pending" mid-turn.
      // This smoke run has NO BrowserWindow at all, which is exactly the case
      // the broadcast has to survive silently: it rides on the turn path, and
      // throwing here would take the turn down with it. That the emit is wired
      // to materialization at all is asserted statically in smoke:shared.
      check(
        'emitSessionsUpdated is safe with no windows open',
        (() => {
          try {
            emitSessionsUpdated({
              reason: 'worktree',
              sessionIds: [lazy.id],
              statusKey: mat.worktreePath
            })
            return true
          } catch {
            return false
          }
        })()
      )

      // The setup script runs in the NEW worktree, through the background path,
      // so it is owned by the session and visible in bash_list.
      {
        await fs.mkdir(path.join(gitRepo, '.roxy'), { recursive: true })
        const marker = 'roxy-setup-ran.txt'
        const setupCmd =
          process.platform === 'win32'
            ? `Set-Content -Path ${marker} -Value "$env:ROXY_PROJECT_ROOT|$env:ROXY_WORKTREE_PATH|$env:ROXY_PORT"`
            : `printf '%s' "$ROXY_PROJECT_ROOT|$ROXY_WORKTREE_PATH|$ROXY_PORT" > ${marker}`
        await fs.writeFile(
          path.join(gitRepo, '.roxy', 'worktree.json'),
          JSON.stringify({ setup: setupCmd })
        )
        const withSetup = repo.createChat({
          title: 'setup script',
          kind: 'main',
          workspacePath: gitRepo,
          worktree: { mode: 'new' }
        })
        const sm = await materializePendingWorktree(withSetup.id)
        check('worktree with a setup script materializes', sm.ok, sm.error ?? '')
        // Fire-and-forget by design (installs take minutes) — poll for the marker.
        let setupOut = ''
        for (let i = 0; i < 60 && !setupOut; i++) {
          await new Promise((r) => setTimeout(r, 100))
          try {
            setupOut = await fs.readFile(path.join(sm.worktreePath!, marker), 'utf8')
          } catch {
            /* not yet */
          }
        }
        check('the setup script ran INSIDE the new worktree', setupOut !== '', setupOut)
        const [gotRoot, gotWt, gotPort] = setupOut.trim().split('|')
        check('ROXY_PROJECT_ROOT points at the project', gotRoot === gitRepo, gotRoot)
        check('ROXY_WORKTREE_PATH points at the worktree', gotWt === sm.worktreePath, gotWt)
        check(
          'ROXY_PORT is the session port',
          gotPort === String(repo.getChat(withSetup.id)?.devPort),
          gotPort
        )
        check(
          'the setup script did NOT run in the main checkout',
          !existsSync(path.join(gitRepo, marker))
        )
        await fs.rm(path.join(gitRepo, '.roxy'), { recursive: true, force: true })
        await removeWorktreeForChat(withSetup.id, { force: true })
        repo.removeChat(withSetup.id)
      }

      // ---- a fork continues from ITS SOURCE's commit, not from main ----
      //
      // This is the part of forking that is easy to get silently wrong: the copy
      // inherits a transcript about work that exists only on the source's
      // branch, so branching it off origin/<default> - what a plain `mode:'new'`
      // does - would hand it a history describing files it cannot see.
      {
        const srcPath = repo.getChat(lazy.id)!.worktreePath!
        await fs.writeFile(path.join(srcPath, 'only-on-this-branch.txt'), 'fork me')
        await runGit(['add', '.'], srcPath)
        await runGit(['commit', '-m', 'work that exists only on the source branch'], srcPath)
        const sourceHead = await git.resolveCommit(srcPath)
        check('the source branch has a commit of its own', !!sourceHead)

        const fork = repo.forkChat(lazy.id, { title: 'forked workstream' })
        repo.setChatWorktreePending(fork.id, { mode: 'new', baseRef: sourceHead! })
        // The intent has to survive the DB round trip WITH its baseRef: the
        // parser rebuilds the object field by field, so one it forgets to list
        // is dropped silently and the fork quietly starts from main instead.
        check(
          'a fork parks its baseRef alongside the worktree intent',
          repo.getChat(fork.id)?.worktreePending?.baseRef === sourceHead,
          String(repo.getChat(fork.id)?.worktreePending?.baseRef)
        )

        const forkMat = await materializePendingWorktree(fork.id)
        check('the fork materializes a worktree of its own', forkMat.ok, forkMat.error ?? '')
        check(
          "...on its own branch, not the source's",
          !!forkMat.branch && forkMat.branch !== repo.getChat(lazy.id)?.branch,
          `${forkMat.branch} vs ${repo.getChat(lazy.id)?.branch}`
        )
        check(
          '...starting from the commit the source was sitting on',
          (await git.resolveCommit(forkMat.worktreePath!)) === sourceHead
        )
        check(
          '...so work that never reached main is present in the fork',
          existsSync(path.join(forkMat.worktreePath!, 'only-on-this-branch.txt'))
        )

        // A stale baseRef (the source branch was deleted in between) must
        // degrade to the normal base, not fail the fork's first turn.
        const stale = repo.createChat({
          title: 'stale base',
          kind: 'main',
          workspacePath: gitRepo,
          worktree: { mode: 'new', baseRef: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }
        })
        const staleMat = await materializePendingWorktree(stale.id)
        check(
          'an unresolvable baseRef falls back instead of failing',
          staleMat.ok && !!staleMat.worktreePath,
          staleMat.error ?? ''
        )
        await removeWorktreeForChat(stale.id, { force: true })
        repo.removeChat(stale.id)
        await removeWorktreeForChat(fork.id, { force: true })
        repo.removeChat(fork.id)
      }

      // A sub-session must never take a worktree of its own.
      const subWt = repo.createChat({
        title: 'sub w/ intent',
        kind: 'sub',
        parentId: lazy.id,
        workspacePath: gitRepo,
        worktree: { mode: 'new' }
      })
      const subMat = await materializePendingWorktree(subWt.id)
      check('a sub-session never materializes its own worktree', subMat.ok === false)
      check('...and its intent is dropped', repo.getChat(subWt.id)?.worktreePending === null)

      // ---- prune ----
      const orphan = await git.createWorktree({ repoRoot: root!, branch: 'roxy/aaaaaaaa' })
      check('created an orphan worktree for prune', orphan.ok, orphan.error ?? '')
      const dry = await pruneWorktrees(gitRepo, { dryRun: true })
      check(
        'prune (dry run) finds the orphan',
        dry.ok && dry.candidates.some((c) => c.path === orphan.worktree!.path),
        JSON.stringify(dry.candidates)
      )
      check(
        'prune (dry run) does NOT list a session-owned worktree',
        !dry.candidates.some((c) => c.path === wtPath)
      )
      check(
        'prune (dry run) removes nothing',
        dry.removed.length === 0 && existsSync(orphan.worktree!.path)
      )
      const wet = await pruneWorktrees(gitRepo, { dryRun: false, force: true })
      check(
        'prune removes the orphan',
        wet.removed.includes(orphan.worktree!.path),
        JSON.stringify(wet.failed)
      )
      check('...and the directory is gone', !existsSync(orphan.worktree!.path))
      check(
        'prune never touches the main working tree',
        existsSync(path.join(gitRepo, 'README.md'))
      )

      // ---- remove ----
      const shared = repo.createChat({
        title: 'shares the worktree',
        kind: 'main',
        workspacePath: gitRepo
      })
      repo.setChatWorktree(shared.id, { worktreePath: wtPath, branch: tmpBranch })
      const blocked = await removeWorktreeForChat(wtChat.id)
      check(
        'a worktree shared with another session is NOT removed',
        blocked.ok && blocked.removed === false
      )
      check('...and it still exists', existsSync(wtPath))
      repo.removeChat(shared.id)

      // Deleting a session must NEVER discard uncommitted code. This used to
      // pass force:true, which mattered little when worktrees were opt-in and
      // rare -- now that every session gets one by default, a stray click on
      // the trash icon would silently `rm -rf` unpushed work with no
      // confirmation and nothing in the reflog to recover from.
      await fs.writeFile(path.join(wtPath, 'uncommitted.txt'), 'precious\n')
      const dirtyRemove = await removeWorktreeForChat(wtChat.id)
      check('a DIRTY worktree is not deleted on session delete', dirtyRemove.removed === false)
      check('...and it says why', !!dirtyRemove.error, dirtyRemove.error ?? '')
      check(
        '...and the uncommitted file survives',
        existsSync(path.join(wtPath, 'uncommitted.txt'))
      )
      await fs.rm(path.join(wtPath, 'uncommitted.txt'))

      // Clean it properly -> the default (non-forced) path removes it happily,
      // so the protection above is about dirt, not a blanket refusal. The
      // sandbox check earlier in this block left `from-agent.txt` behind, which
      // is exactly the kind of untracked file git refuses to discard.
      await fs.rm(path.join(wtPath, 'from-agent.txt'))
      const cleanRemove = await removeWorktreeForChat(wtChat.id)
      check(
        'a CLEAN worktree is removed without force',
        cleanRemove.ok && cleanRemove.removed,
        cleanRemove.error ?? ''
      )
      check('...and its directory is gone', !existsSync(wtPath))

      // Re-attach it so the shared/force-removal checks below still have a
      // worktree to act on. The BRANCH outlives `git worktree remove`, so this
      // is an attach, not a create (`-b` would fail on an existing branch).
      const recreated = await git.attachWorktree({
        repoRoot: root!,
        branch: tmpBranch,
        path: wtPath
      })
      check(
        're-attached the worktree for the remaining checks',
        recreated.ok,
        recreated.error ?? ''
      )
      check('...at the same path', recreated.worktree?.path === wtPath, recreated.worktree?.path)
      repo.setChatWorktree(wtChat.id, { worktreePath: wtPath, branch: tmpBranch })

      const removed = await removeWorktreeForChat(wtChat.id, { force: true })
      check(
        'removeWorktreeForChat removes an unshared worktree',
        removed.ok && removed.removed,
        removed.error ?? ''
      )
      check('the worktree directory is gone', !existsSync(wtPath))
      const wt2 = await git.listWorktrees(root!)
      check('git no longer lists the removed worktree', !wt2.some((w) => w.path === wtPath))
      check(
        'removeWorktreeForChat is a no-op without a worktree',
        (await removeWorktreeForChat(shared.id)).removed === false
      )

      repo.removeChat(wtChat.id)
      repo.removeChat(lazy.id)

      // ---- getting back in sync with a real remote ----
      // A bare repo plus two clones is the only honest way to test this: the
      // whole feature is about what happens when someone ELSE pushed, and
      // faking that with local refs would test our mock, not git.
      {
        const bare = path.join(tmp, 'sync-origin.git')
        const mine = path.join(tmp, 'sync-mine')
        const theirs = path.join(tmp, 'sync-theirs')
        await runGit(['init', '--bare', '-q', '--initial-branch=main', bare], tmp)

        const setup = async (dir: string): Promise<void> => {
          await runGit(['clone', '-q', bare, dir], tmp)
          await runGit(['config', 'user.email', 'smoke@roxy.test'], dir)
          await runGit(['config', 'user.name', 'Roxy Smoke'], dir)
          await runGit(['config', 'commit.gpgsign', 'false'], dir)
        }
        await setup(mine)
        await fs.writeFile(path.join(mine, 'base.txt'), 'base\n')
        await runGit(['add', '.'], mine)
        await runGit(['commit', '-q', '-m', 'base'], mine)
        await runGit(['push', '-q', '-u', 'origin', 'main'], mine)
        await setup(theirs)

        check(
          'status reports the upstream ref by name',
          (await git.status(mine))?.upstream === 'origin/main',
          String((await git.status(mine))?.upstream)
        )

        // Nothing to do is a SUCCESS that reports `updated: false`, not an
        // error - the button must not cry wolf when the user is already current.
        const noop = await git.pullFastForward(mine)
        check('pull: already up to date succeeds', noop.ok, noop.error ?? '')
        check('pull: ...and reports nothing moved', noop.updated === false)

        // Someone else pushes.
        await fs.writeFile(path.join(theirs, 'theirs.txt'), 'theirs\n')
        await runGit(['add', '.'], theirs)
        await runGit(['commit', '-q', '-m', 'their work'], theirs)
        await runGit(['push', '-q', 'origin', 'main'], theirs)

        const ff = await git.pullFastForward(mine)
        check('pull: fast-forwards onto the upstream', ff.ok, ff.error ?? '')
        check('pull: ...and says it moved', ff.updated === true)
        check('pull: ...bringing the new file with it', existsSync(path.join(mine, 'theirs.txt')))
        check('pull: ...leaving nothing behind', (await git.status(mine))?.behind === 0)

        // A fast-forward must survive an untracked file that has nothing to do
        // with the incoming commit - an agent mid-task always has some.
        await fs.writeFile(path.join(theirs, 'more.txt'), 'more\n')
        await runGit(['add', '.'], theirs)
        await runGit(['commit', '-q', '-m', 'more work'], theirs)
        await runGit(['push', '-q', 'origin', 'main'], theirs)
        await fs.writeFile(path.join(mine, 'scratch.txt'), 'agent scratch\n')
        const ffDirty = await git.pullFastForward(mine)
        check('pull: an unrelated dirty file does not block it', ffDirty.ok, ffDirty.error ?? '')
        check(
          'pull: ...and the local file is untouched',
          (await fs.readFile(path.join(mine, 'scratch.txt'), 'utf8')) === 'agent scratch\n'
        )

        // DIVERGED: a local commit plus a remote one. This is the case where a
        // naive `git pull` would merge (or rebase, or open an editor) depending
        // on config - we refuse instead, and must leave the tree exactly as it
        // was so the user still has both sides.
        await runGit(['add', '.'], mine)
        await runGit(['commit', '-q', '-m', 'my local work'], mine)
        await fs.writeFile(path.join(theirs, 'conflict-free.txt'), 'x\n')
        await runGit(['add', '.'], theirs)
        await runGit(['commit', '-q', '-m', 'their later work'], theirs)
        await runGit(['push', '-q', 'origin', 'main'], theirs)

        const localHead = await git.currentBranch(mine)
        const diverged = await git.pullFastForward(mine)
        check('pull: refuses to merge a diverged branch', !diverged.ok)
        check(
          'pull: ...and never leaves a merge behind',
          (await git.status(mine))?.ahead === 1,
          JSON.stringify(await git.status(mine))
        )
        check('pull: ...still on the same branch', (await git.currentBranch(mine)) === localHead)

        // RESET: the escape hatch. Both the local commit and the uncommitted
        // work must end up recoverable, not merely gone.
        await fs.writeFile(path.join(mine, 'uncommitted.txt'), 'in progress\n')
        const before = await git.status(mine)
        check('reset: the tree is dirty going in', before?.dirty === true)

        const reset = await git.resetToUpstream(mine)
        check('reset: succeeds', reset.ok, reset.error ?? '')
        check('reset: reports the ref it synced to', reset.upstream === 'origin/main')
        check('reset: says it stashed the dirty work', reset.stashed === true)

        const after = await git.status(mine)
        check('reset: the branch is level with origin', after?.ahead === 0 && after?.behind === 0)
        check('reset: the tree is clean', after?.dirty === false)
        check(
          'reset: the incoming file is present',
          existsSync(path.join(mine, 'conflict-free.txt'))
        )

        // The promise the confirm step makes: the work is in the stash, and one
        // `git stash pop` brings it back. If this ever breaks, the button is
        // lying to the user about a destructive action.
        const stashList = await new Promise<string>((resolve) => {
          const c = spawn('git', ['stash', 'list'], { cwd: mine, shell: false, windowsHide: true })
          let out = ''
          c.stdout?.on('data', (d: Buffer) => (out += d.toString()))
          c.on('close', () => resolve(out))
          c.on('error', () => resolve(''))
        })
        check('reset: the stash entry names roxy', /roxy: before reset/.test(stashList), stashList)
        await runGit(['stash', 'pop'], mine)
        check(
          'reset: the stashed work comes back with `git stash pop`',
          existsSync(path.join(mine, 'uncommitted.txt'))
        )

        // A clean tree must NOT claim a stash exists - that would send the user
        // to `git stash pop` for an entry that isn't there.
        await runGit(['checkout', '-q', '--', '.'], mine)
        await fs.rm(path.join(mine, 'uncommitted.txt'), { force: true })
        const cleanReset = await git.resetToUpstream(mine)
        check('reset: a clean tree resets fine', cleanReset.ok, cleanReset.error ?? '')
        check('reset: ...and reports no stash', cleanReset.stashed !== true)

        // The "check for updates" path: clicking Update with nothing known to
        // be waiting must still fetch and then answer honestly, because the
        // behind count on screen is only as fresh as the last fetch. This is
        // why `canFastForward` keys off `ahead === 0` rather than `behind > 0`.
        {
          await runGit(['checkout', '-q', 'main'], mine)
          const before = await git.status(mine)
          check('check: nothing is known to be waiting', before?.behind === 0)
          await fs.writeFile(path.join(theirs, 'surprise.txt'), 'surprise\n')
          await runGit(['add', '.'], theirs)
          await runGit(['commit', '-q', '-m', 'pushed behind our back'], theirs)
          await runGit(['push', '-q', 'origin', 'main'], theirs)
          // Still 0 locally - we have not fetched, which is exactly the state a
          // greyed-out button would strand the user in.
          check(
            'check: ...and the stale count still says 0',
            (await git.status(mine))?.behind === 0
          )

          const found = await git.pullFastForward(mine)
          check('check: clicking anyway fetches and updates', found.ok, found.error ?? '')
          check('check: ...and picks up the surprise commit', found.updated === true)
          check('check: ...bringing its file along', existsSync(path.join(mine, 'surprise.txt')))
        }

        // No upstream, but the repo HAS an origin: both actions fall back to
        // `origin/<base>`. This used to decline, on the grounds that guessing a
        // ref was worse than doing nothing. It is the opposite: a workstream
        // branch has no upstream until its first push, so declining took both
        // buttons away for the whole period when "my branch is stale, give me
        // main" is most likely to be true, leaving only "Push to origin".
        await runGit(['checkout', '-q', '-b', 'orphan-branch'], mine)
        const noUp = await git.pullFastForward(mine)
        check('pull: an unpushed branch falls back to origin/<base>', noUp.ok, noUp.error ?? '')
        check('pull: ...naming the ref it actually used', noUp.upstream === 'origin/main')
        // Already identical to main, so honestly nothing moved.
        check('pull: ...and reports no-op rather than a fake update', noUp.updated === false)

        const noUpReset = await git.resetToUpstream(mine)
        check(
          'reset: an unpushed branch resets to origin/<base>',
          noUpReset.ok,
          noUpReset.error ?? ''
        )
        check('reset: ...to that same ref', noUpReset.upstream === 'origin/main')

        // A repo with NO REMOTE AT ALL still has a local base to fall back to,
        // and it is not a stale mirror of anything - it is the only truth there
        // is. Refusing would strand every local-only repo with no way to main.
        {
          const solo = path.join(tmp, 'sync-solo')
          await runGit(['init', '-q', '--initial-branch=main', solo], tmp)
          await runGit(['config', 'user.email', 'ci@roxy.gg'], solo)
          await runGit(['config', 'user.name', 'Roxy CI'], solo)
          await fs.writeFile(path.join(solo, 'a.txt'), 'one\n')
          await runGit(['add', '-A'], solo)
          await runGit(['commit', '-qm', 'first'], solo)
          await runGit(['checkout', '-q', '-b', 'roxy/solo'], solo)
          await runGit(['checkout', '-q', 'main'], solo)
          await fs.writeFile(path.join(solo, 'b.txt'), 'two\n')
          await runGit(['add', '-A'], solo)
          await runGit(['commit', '-qm', 'main moved on'], solo)
          await runGit(['checkout', '-q', 'roxy/solo'], solo)

          const soloPull = await git.pullFastForward(solo)
          check(
            'pull: a remoteless repo updates from LOCAL main',
            soloPull.ok,
            soloPull.error ?? ''
          )
          check('pull: ...naming the bare branch, not origin/main', soloPull.upstream === 'main')
          check('pull: ...and really moved', soloPull.updated === true)
          check('pull: ...bringing the file', existsSync(path.join(solo, 'b.txt')))

          // On the base branch itself there is nothing to sync to: syncing a
          // branch to itself can only ever report "already up to date".
          await runGit(['checkout', '-q', 'main'], solo)
          const onBase = await git.pullFastForward(solo)
          check('pull: declines while ON the base branch', !onBase.ok)
        }
      }
    }
  }

  // ---- services (the panel's view of a session's background processes) ----
  {
    const svcA = repo.createChat({ title: 'svc A', kind: 'main', workspacePath: ws })
    const svcB = repo.createChat({ title: 'svc B', kind: 'main', workspacePath: ws })
    const svcSub = repo.createChat({ title: 'svc sub', kind: 'sub', parentId: svcA.id })

    check('listServices is empty for a fresh session', listServices(svcA.id).length === 0)

    const started = await runTool(
      'bash',
      { command: bgCmd, background: true },
      {
        cwd: ws,
        sessionId: svcA.id
      }
    )
    const svcId = started.output.match(/bg_\d+/)?.[0] ?? ''
    check('a background process appears in listServices', listServices(svcA.id).length === 1)

    const [svc] = listServices(svcA.id)
    check('service carries its command', svc.command === bgCmd)
    check('service carries its cwd', svc.cwd === ws)
    check('service is running', svc.status === 'running')
    // bgState is reused rather than reimplemented in the UI.
    check('service state is the bash_list label', /^running \d+s$/.test(svc.state), svc.state)

    // Isolation: the panel is per session, exactly like bash_list.
    check("session B does not see session A's service", listServices(svcB.id).length === 0)
    check('an empty session id lists nothing', listServices('').length === 0)

    // A subagent's process is owned by the ROOT session, so it shows up in the
    // parent's panel — the parent is who can stop it.
    await runTool('bash', { command: bgCmd, background: true }, { cwd: ws, sessionId: svcSub.id })
    check("a subagent's service appears in the PARENT's panel", listServices(svcA.id).length === 2)
    check('...and not under the sub itself', listServices(svcSub.id).length === 0)

    // Log view reads the whole buffer WITHOUT moving the agent's read cursor.
    const logs = serviceOutput(svcId, svcA.id)
    check('serviceOutput returns the buffered output', logs.includes(bgCmd), logs.slice(0, 80))
    check('serviceOutput is stable when read twice', serviceOutput(svcId, svcA.id) === logs)
    const agentRead = await runTool('bash_output', { id: svcId }, { cwd: ws, sessionId: svcA.id })
    check(
      "the UI's read did not consume the agent's new output",
      agentRead.ok && agentRead.output.includes('roxy-bg-ok'),
      agentRead.output
    )
    check('serviceOutput refuses another session', serviceOutput(svcId, svcB.id) === '')

    // Restart replaces the row rather than accumulating a dead one per restart.
    const restarted = await restartService(svcId, svcA.id)
    check('restartService succeeds', restarted.ok && !!restarted.id, restarted.error ?? '')
    check('...with a NEW process id', restarted.id !== svcId)
    check('...and does not leave the old row behind', listServices(svcA.id).length === 2)
    check(
      'the restarted service runs the same command',
      listServices(svcA.id).some((s) => s.id === restarted.id && s.command === bgCmd)
    )
    check(
      'restartService refuses another session',
      (await restartService(restarted.id!, svcB.id)).ok === false
    )

    // Stop is idempotent.
    const stopped = stopService(restarted.id!, svcA.id)
    check('stopService succeeds', stopped.ok)
    check(
      '...and the service is no longer running',
      listServices(svcA.id).find((s) => s.id === restarted.id)?.status !== 'running'
    )
    check('stopService twice is fine', stopService(restarted.id!, svcA.id).ok)
    check('stopService refuses an unknown id', stopService('bg_nope', svcA.id).ok === false)

    killSessionBackground(svcA.id)
    repo.removeChat(svcA.id)
    repo.removeChat(svcB.id)
  }

  // ---- dev ports (parallel sessions must not fight over :3000) ----
  {
    const pA = repo.createChat({ title: 'port A', kind: 'main', workspacePath: ws })
    const pB = repo.createChat({ title: 'port B', kind: 'main', workspacePath: ws })

    check('a new session starts with no port', repo.getChat(pA.id)?.devPort === null)
    const portA = await ensureDevPort(pA.id)
    check(
      'ensureDevPort allocates a port',
      typeof portA === 'number' && portA! >= 3100,
      String(portA)
    )
    check('...and persists it', repo.getChat(pA.id)?.devPort === portA)

    // Stability is the whole point: a bookmarked localhost:<port>, an open tab
    // and a running server all assume it never moves.
    check('ensureDevPort is idempotent', (await ensureDevPort(pA.id)) === portA)
    check('...even called repeatedly', (await ensureDevPort(pA.id)) === portA)

    const portB = await ensureDevPort(pB.id)
    check('a second session gets a DIFFERENT port', portB !== portA, `${portA} vs ${portB}`)
    check(
      'listDevPorts reports both',
      repo.listDevPorts().includes(portA!) && repo.listDevPorts().includes(portB!)
    )

    // An already-claimed port is skipped even when nothing is listening on it.
    const fresh = await allocateDevPort()
    check(
      'allocateDevPort skips ports claimed by other sessions',
      fresh !== portA && fresh !== portB,
      String(fresh)
    )

    // The port reaches spawned commands as PORT + ROXY_PORT.
    const echoCmd =
      process.platform === 'win32'
        ? 'Write-Output "P=$env:PORT R=$env:ROXY_PORT"'
        : 'echo "P=$PORT R=$ROXY_PORT"'
    const envRes = await runTool('bash', { command: echoCmd }, { cwd: ws, sessionId: pA.id })
    check(
      'PORT is exported to spawned commands',
      envRes.ok && envRes.output.includes(`P=${portA}`),
      envRes.output
    )
    check(
      'ROXY_PORT is exported too',
      envRes.ok && envRes.output.includes(`R=${portA}`),
      envRes.output
    )

    // A session with no port must NOT get a blank PORT clobbering an inherited one.
    const noPort = repo.createChat({ title: 'no port', kind: 'main', workspacePath: ws })
    const noPortRes = await runTool('bash', { command: echoCmd }, { cwd: ws, sessionId: noPort.id })
    check(
      'a session without a port does not set PORT',
      noPortRes.ok && !/P=\d/.test(noPortRes.output),
      noPortRes.output
    )

    // Subagents share the parent's port (they share its tree and its servers).
    const subPort = repo.createChat({ title: 'sub port', kind: 'sub', parentId: pA.id })
    check('a sub-session has no port of its own', repo.getChat(subPort.id)?.devPort === null)

    repo.removeChat(pA.id)
    repo.removeChat(pB.id)
    repo.removeChat(noPort.id)
  }

  // ---- worktree setup config ----
  {
    check('no .roxy/worktree.json -> empty config', loadWorktreeConfig(ws).setup === undefined)

    const cfgDir = path.join(tmp, 'cfgproj')
    await fs.mkdir(path.join(cfgDir, '.roxy'), { recursive: true })
    await fs.writeFile(
      path.join(cfgDir, '.roxy', 'worktree.json'),
      JSON.stringify({ setup: 'echo hello' })
    )
    check('reads the setup command', loadWorktreeConfig(cfgDir).setup === 'echo hello')

    await fs.writeFile(path.join(cfgDir, '.roxy', 'worktree.json'), '{ not json')
    check('malformed config degrades to empty', loadWorktreeConfig(cfgDir).setup === undefined)

    await fs.writeFile(path.join(cfgDir, '.roxy', 'worktree.json'), JSON.stringify({ setup: 42 }))
    check('a non-string setup is ignored', loadWorktreeConfig(cfgDir).setup === undefined)
    check('an empty project root is safe', loadWorktreeConfig('').setup === undefined)
  }

  // ---- change_session_metadata (the agent organizing its own session) ----
  const metaChat = repo.createChat({ title: 'Session 1', workspacePath: ws, kind: 'main' })
  const metaRes = await runTool(
    'change_session_metadata',
    {
      title: 'Auth refactor',
      description: 'Refactoring the login flow',
      tasks: [
        { title: 'read auth code', status: 'completed' },
        { title: 'write tests', status: 'in_progress' }
      ]
    },
    { cwd: ws, sessionId: metaChat.id }
  )
  const metaAfter = repo.getChat(metaChat.id)
  check(
    'change_session_metadata sets name/description/tasks',
    metaRes.ok &&
      metaAfter?.title === 'Auth refactor' &&
      metaAfter?.description === 'Refactoring the login flow' &&
      metaAfter?.tasks.length === 2 &&
      metaAfter?.tasks[0].status === 'completed',
    metaRes.output
  )
  check(
    'change_session_metadata refuses without a session',
    !(await runTool('change_session_metadata', { title: 'x' }, { cwd: ws })).ok
  )
  const escape = await run('read', { path: '../../../etc/hosts' })
  check('path-escape is rejected (sandbox)', !escape.ok)

  // ---- loop tools via runTool ----
  const ll = await run('loop_list', {})
  check('loop_list tool', ll.ok && ll.output.includes('PR watcher'))
  const le = await run('loop_enable', { loop: 'PR watcher' })
  check(
    'loop_enable by name',
    le.ok && repo.listLoops().find((l) => l.id === loop.id)?.enabled === true
  )
  const ld = await run('loop_disable', { loop: loop.id })
  check(
    'loop_disable by id',
    ld.ok && repo.listLoops().find((l) => l.id === loop.id)?.enabled === false
  )
  check('loop tool rejects unknown loop', !(await run('loop_disable', { loop: 'nope' })).ok)

  // ---- background-task registry (Phase 11: parallel + background subagents) ----
  {
    _resetBackgroundJobs()
    const s1 = 'sess_bg_1'
    const s2 = 'sess_bg_2'
    const j1 = registerBackgroundJob({
      sessionId: s1,
      subChatId: 'sub_1',
      description: 'crunch',
      subagentType: 'general'
    })
    check(
      'registerBackgroundJob returns a job id',
      typeof j1.jobId === 'string' && j1.jobId.length > 0
    )
    check('a fresh background job signal is not aborted', j1.signal.aborted === false)
    check(
      'listRunningBackgroundJobs shows the running job',
      listRunningBackgroundJobs(s1).length === 1
    )
    check('hasActiveBackgroundJobs true while running', hasActiveBackgroundJobs(s1) === true)
    check(
      'activeBackgroundSubChatIds tracks the sub session',
      activeBackgroundSubChatIds().has('sub_1')
    )

    // A second session's job is isolated; a null subChatId is never tracked for pruning.
    const j2 = registerBackgroundJob({
      sessionId: s2,
      subChatId: null,
      description: 'watch',
      subagentType: 'explore'
    })
    check(
      'background jobs are isolated per session',
      listRunningBackgroundJobs(s1).length === 1 && listRunningBackgroundJobs(s2).length === 1
    )
    check(
      'null subChatId is not tracked for pruning',
      activeBackgroundSubChatIds().size === 1 && activeBackgroundSubChatIds().has('sub_1')
    )

    // Cancel aborts the signal, but the job stays listed until its run settles + finishes.
    cancelBackgroundJob(j1.jobId)
    check('cancelBackgroundJob aborts the job signal', j1.signal.aborted === true)
    check(
      'a cancelled job is still listed until it finishes',
      listRunningBackgroundJobs(s1).length === 1
    )

    // Finishing removes it from the registry, freeing its sub session to be pruned.
    finishBackgroundJob(j1.jobId, 'error')
    check('finishBackgroundJob removes the job', listRunningBackgroundJobs(s1).length === 0)
    check('a finished job frees its sub session', !activeBackgroundSubChatIds().has('sub_1'))
    check(
      'hasActiveBackgroundJobs false after the last job finishes',
      hasActiveBackgroundJobs(s1) === false
    )
    check(
      'finishing an unknown job id is a no-op',
      (finishBackgroundJob('nope', 'completed'), true)
    )

    // cancelSessionBackgroundJobs aborts every job belonging to a session.
    finishBackgroundJob(j2.jobId, 'completed')
    const a = registerBackgroundJob({
      sessionId: s1,
      subChatId: 'sub_a',
      description: 'a',
      subagentType: 'general'
    })
    const b = registerBackgroundJob({
      sessionId: s1,
      subChatId: 'sub_b',
      description: 'b',
      subagentType: 'general'
    })
    cancelSessionBackgroundJobs(s1)
    check(
      'cancelSessionBackgroundJobs aborts every session signal',
      a.signal.aborted && b.signal.aborted
    )

    // _resetBackgroundJobs clears everything (test isolation).
    _resetBackgroundJobs()
    check(
      '_resetBackgroundJobs clears the registry',
      listRunningBackgroundJobs(s1).length === 0 && !hasActiveBackgroundJobs(s1)
    )
  }

  // ---- per-call tool cancellation: the registry that makes Stop granular ----
  // Stop used to be all-or-nothing: a wedged `bash` could only be escaped by
  // killing the whole turn, losing its reasoning and every other tool result.
  {
    _resetToolRuns()
    let aborted = false
    const run = startToolRun({
      callId: 'call_1',
      tool: 'bash',
      sessionId: 'sess_1',
      cancel: () => {
        aborted = true
      }
    })
    check('a fresh tool run is not cancelled', run.wasCancelled() === false)
    check('cancelToolCall finds a running call', cancelToolCall('call_1') === true)
    check('cancelToolCall aborts the call', aborted === true)
    // The flag is how the harness tells "the user did this" from "the tool
    // failed" — both abort the same signal, so only the registry knows which.
    check(
      'a cancelled call is marked as such',
      run.wasCancelled() && wasToolCallCancelled('call_1')
    )

    // Cancelling something that already finished must report false, so the UI
    // never pretends it did something.
    run.end()
    check('a finished call is gone from the registry', cancelToolCall('call_1') === false)
    check('an unknown call id cancels nothing', cancelToolCall('nope') === false)

    // `end` is idempotent, and a duplicate call id (providers do reuse them
    // across steps) must leave the NEWER call cancellable rather than have the
    // older one's teardown deregister it.
    _resetToolRuns()
    let secondAborted = false
    const first = startToolRun({ callId: 'dup', tool: 'bash', sessionId: 's', cancel: () => {} })
    const second = startToolRun({
      callId: 'dup',
      tool: 'bash',
      sessionId: 's',
      cancel: () => {
        secondAborted = true
      }
    })
    first.end()
    check('a replaced call id stays cancellable', cancelToolCall('dup') === true && secondAborted)
    second.end()

    // A session-wide sweep hits only that session's calls.
    _resetToolRuns()
    let mine = false
    let theirs = false
    const a2 = startToolRun({
      callId: 'c_a',
      tool: 'bash',
      sessionId: 'sess_a',
      cancel: () => {
        mine = true
      }
    })
    const b2 = startToolRun({
      callId: 'c_b',
      tool: 'bash',
      sessionId: 'sess_b',
      cancel: () => {
        theirs = true
      }
    })
    cancelToolCallsFor('sess_a')
    check('cancelToolCallsFor is scoped to one session', mine === true && theirs === false)
    // A session-wide Stop aborts the same signal but must NOT mark the call as
    // individually cancelled: that flag makes the harness tell the model "you
    // cancelled this, carry on with the rest of your work" — a lie in a
    // transcript whose entire turn just stopped.
    check(
      'a session-wide stop is not recorded as a per-call cancel',
      a2.wasCancelled() === false && wasToolCallCancelled('c_a') === false
    )
    // A throwing cancel must not break the sweep for the calls after it.
    const boom = startToolRun({
      callId: 'c_boom',
      tool: 'bash',
      sessionId: 'sess_b',
      cancel: () => {
        throw new Error('nope')
      }
    })
    cancelToolCallsFor('sess_b')
    check('a throwing cancel does not break the sweep', theirs === true)
    a2.end()
    b2.end()
    boom.end()
    _resetToolRuns()
  }

  // ---- end to end: cancelling one call kills the real process ----
  // The registry above is bookkeeping; this proves the signal reaches the work.
  // A 30s sleep would hold the turn open for its full duration — the exact case
  // the feature exists for — so this must return in well under that.
  {
    _resetToolRuns()
    const controller = new AbortController()
    const started = Date.now()
    const run = startToolRun({
      callId: 'sleepy',
      tool: 'bash',
      sessionId: ws,
      cancel: () => controller.abort()
    })
    const sleeping = runTool(
      'bash',
      { command: process.platform === 'win32' ? 'timeout /t 30 /nobreak' : 'sleep 30' },
      { cwd: ws, signal: controller.signal }
    )
    // Give the shell a moment to actually spawn before pulling the rug.
    await new Promise((r) => setTimeout(r, 400))
    check('the sleeping call is cancellable', cancelToolCall('sleepy') === true)
    const result = await sleeping
    const elapsed = Date.now() - started
    run.end()
    check(
      'cancelling one call returns long before its command would end',
      elapsed < 10_000,
      `${elapsed}ms`
    )
    check('a cancelled bash is not reported as ok', result.ok === false)
    _resetToolRuns()
  }

  // ---- LSP diagnostics after edit (Phase 12) via a real mock language server ----
  // Exercises the actual LspClient machinery (spawn → initialize handshake →
  // didOpen/didChange → publishDiagnostics → debounce) against a mock server that
  // flags any document containing "BROKEN". No real language server required.
  {
    const mockPath = path.join(process.cwd(), 'test', 'fixtures', 'mock-lsp.cjs')
    if (!existsSync(mockPath)) {
      check('mock-lsp fixture is present', false, mockPath)
    } else {
      const registerMock = (): void =>
        lsp._registerServerForTests({
          id: 'mocklsp',
          extensions: ['.mocklsp'],
          command: process.execPath, // electron binary, run as node via env below
          args: [mockPath],
          rootMarkers: ['.git'],
          env: { ELECTRON_RUN_AS_NODE: '1' }
        })

      lsp._resetLspForTests()
      registerMock()
      const f = path.join(ws, 'sample.mocklsp')

      check(
        'lsp: configuredServerId matches the registered server',
        lsp.configuredServerId(f) === 'mocklsp'
      )

      // A clean document produces no diagnostics (didOpen → empty push).
      await fs.writeFile(f, 'all good here', 'utf8')
      const clean = await withTimeout(lsp.diagnostics(f), 15_000, 'lsp clean')
      check('lsp: clean file has no diagnostics', clean.length === 0)

      // Editing in a fault surfaces an error (warm client → didChange → error push).
      await fs.writeFile(f, 'this line is BROKEN now', 'utf8')
      const dirty = await withTimeout(lsp.diagnostics(f), 15_000, 'lsp dirty')
      check(
        'lsp: error surfaced after edit',
        dirty.length === 1 && dirty[0].severity === 1,
        JSON.stringify(dirty)
      )
      check('lsp: diagnostic carries the message', (dirty[0]?.message ?? '').includes('BROKEN'))

      const block = await withTimeout(lsp.diagnosticsBlock(f, ws), 15_000, 'lsp block')
      check(
        'lsp: diagnosticsBlock renders an errors block',
        block.includes('<diagnostics') && block.includes('ERROR')
      )
      check('lsp: diagnosticsBlock path is workspace-relative', block.includes('sample.mocklsp'))

      // Fixing the fault clears diagnostics on the next edit (warm didChange).
      await fs.writeFile(f, 'clean again', 'utf8')
      const cleared = await withTimeout(lsp.diagnostics(f), 15_000, 'lsp cleared')
      check('lsp: re-edit clears diagnostics', cleared.length === 0)

      // Graceful degradation: an unsupported file type yields nothing, never throws.
      const none = await lsp.diagnosticsBlock(path.join(ws, 'notes.unknownext'), ws)
      check('lsp: unsupported file → empty block', none === '')

      // Reset disposes the client; a fresh call re-spawns and still works.
      lsp._resetLspForTests()
      registerMock()
      await fs.writeFile(f, 'BROKEN once more', 'utf8')
      const respawned = await withTimeout(lsp.diagnostics(f), 15_000, 'lsp respawn')
      check('lsp: re-spawns a server after reset', respawned.length === 1)
      lsp._resetLspForTests()
    }
  }

  // ---- MCP client (Phase 13) via a real mock MCP server over the official SDK ----
  // Exercises the ACTUAL @modelcontextprotocol/client: stdio spawn → initialize
  // handshake → capability negotiation → tools/list → tools/call, plus roxy's pool,
  // schema conversion, namespaced dispatch (through runTool), and lifecycle.
  {
    const mockPath = path.join(process.cwd(), 'test', 'fixtures', 'mock-mcp.cjs')
    if (!existsSync(mockPath)) {
      check('mock-mcp fixture is present', false, mockPath)
    } else {
      const rec: McpServerRecord = {
        id: 'mockmcp',
        enabled: true,
        config: {
          type: 'local',
          command: [process.execPath, mockPath], // electron binary, run as node via env
          environment: { ELECTRON_RUN_AS_NODE: '1' }
        }
      }

      await _resetMcpForTests()
      await withTimeout(ensureMcpConnected([rec], ws), 20_000, 'mcp connect')

      const schemas = mcpToolSchemas()
      const names = schemas.map((s) => (s.function as { name: string }).name)
      const echoName = names.find((n) => n.endsWith('__echo')) ?? ''
      const boomName = names.find((n) => n.endsWith('__boom')) ?? ''
      check('mcp: discovered both tools', schemas.length === 2, names.join(','))
      check(
        'mcp: tool names are mcp-namespaced',
        echoName.startsWith('mcp__mockmcp__') && boomName.startsWith('mcp__mockmcp__')
      )
      check('mcp: isMcpTool routes namespaced names', isMcpTool(echoName) && !isMcpTool('read'))
      check('mcp: mcpToolTitle renders server · tool', mcpToolTitle(echoName) === 'mockmcp · echo')

      const echoSchema = schemas.find((s) => (s.function as { name: string }).name === echoName)
      check(
        'mcp: tool schema is a function schema with parameters',
        !!echoSchema && echoSchema.type === 'function' && typeof echoSchema.function === 'object'
      )

      const summaries = mcpServerSummaries()
      check(
        'mcp: server summary reports connected + tools',
        summaries.length === 1 &&
          summaries[0].status === 'connected' &&
          summaries[0].tools.includes('echo')
      )
      const instr = mcpInstructions()
      check('mcp: instructions blurb mentions the server', !!instr && instr.includes('mockmcp'))

      const echoRes = await withTimeout(
        callMcpTool(echoName, { message: 'hi' }),
        15_000,
        'mcp echo'
      )
      check(
        'mcp: callMcpTool(echo) returns text',
        echoRes.ok && echoRes.output.includes('echo: hi'),
        echoRes.output
      )
      const boomRes = await withTimeout(callMcpTool(boomName, {}), 15_000, 'mcp boom')
      check(
        'mcp: callMcpTool(boom) surfaces isError → ok:false',
        !boomRes.ok && boomRes.output.includes('boom'),
        boomRes.output
      )
      const missRes = await callMcpTool('mcp__mockmcp__nope', {})
      check('mcp: unknown MCP tool → ok:false (never throws)', !missRes.ok)

      // The real dispatch seam: runTool's default case routes namespaced names.
      const viaRunTool = await withTimeout(run(echoName, { message: 'hey' }), 15_000, 'mcp runTool')
      check(
        'mcp: runTool dispatches MCP tools',
        viaRunTool.ok && viaRunTool.output.includes('echo: hey'),
        viaRunTool.output
      )

      // Dispose drops the tools + closes the child; a stale call degrades cleanly.
      await disposeConnection('mockmcp')
      check('mcp: dispose removes tool schemas', mcpToolSchemas().length === 0)
      const afterDispose = await callMcpTool(echoName, { message: 'x' })
      check('mcp: call after dispose → ok:false', !afterDispose.ok)

      // Reconnect brings the pool back.
      await withTimeout(reconnectMcpServer(rec, ws), 20_000, 'mcp reconnect')
      check('mcp: reconnect restores tools', mcpToolSchemas().length === 2)

      // Workspace scoping: the pool is process-global, but a turn only sees the
      // servers in ITS record set (so workspace A's `.roxy/mcp.json` server can't
      // leak into workspace B's chat).
      check(
        'mcp: schemas scoped to own ids include the server',
        mcpToolSchemas(new Set(['mockmcp'])).length === 2
      )
      check(
        'mcp: schemas scoped to other ids exclude the server',
        mcpToolSchemas(new Set(['other'])).length === 0
      )
      check(
        'mcp: instructions scoped to other ids are empty',
        mcpInstructions(new Set(['other'])) === undefined
      )
      check(
        'mcp: summaries scoped to other ids are empty',
        mcpServerSummaries(new Set(['other'])).length === 0
      )

      // Race guard: disposing DURING the connect window must not resurrect a zombie
      // pool entry (the in-flight connect self-tears-down instead of committing).
      await _resetMcpForTests()
      const inflight = ensureMcpConnected([rec], ws) // do NOT await — connect is mid-flight
      await disposeConnection('mockmcp') // tear down before connectOne resolves
      await withTimeout(inflight, 20_000, 'mcp inflight')
      check(
        'mcp: dispose during connect leaves no resurrected connection',
        mcpToolSchemas().length === 0
      )
      await withTimeout(ensureMcpConnected([rec], ws), 20_000, 'mcp reconnect after race')
      check('mcp: pool still healthy after a mid-connect dispose', mcpToolSchemas().length === 2)

      // A disabled record contributes nothing (never spawns).
      await _resetMcpForTests()
      await ensureMcpConnected([{ ...rec, enabled: false }], ws)
      check('mcp: disabled record spawns nothing', mcpToolSchemas().length === 0)

      // Workspace `.roxy/mcp.json` loader (project-portable config source).
      await fs.mkdir(path.join(ws, '.roxy'), { recursive: true })
      await fs.writeFile(
        path.join(ws, '.roxy', 'mcp.json'),
        JSON.stringify({ mcpServers: { wsserver: { command: ['node', 'x.js'], disabled: true } } }),
        'utf8'
      )
      const wsRecords = loadWorkspaceMcpServers(ws)
      check(
        'mcp: loadWorkspaceMcpServers parses .roxy/mcp.json',
        wsRecords.length === 1 && wsRecords[0].id === 'wsserver'
      )
      check('mcp: workspace `disabled:true` → enabled:false', wsRecords[0].enabled === false)
      check(
        'mcp: loader never throws on a missing file',
        loadWorkspaceMcpServers(path.join(ws, 'nope')).length === 0
      )

      await shutdownAllMcp()
      check('mcp: shutdownAllMcp clears the pool', mcpToolSchemas().length === 0)
      await _resetMcpForTests()

      // ---- protocol era negotiation (the v2 `mode: 'auto'` payoff) ----------
      // The legacy mock above rejects `server/discover`, so every check so far
      // exercised the FALLBACK branch. This block pins the other one against a
      // server that answers the probe and has no `initialize` at all - a server
      // the v1 client could not have talked to.
      const modernPath = path.join(process.cwd(), 'test', 'fixtures', 'mock-mcp-modern.cjs')
      if (!existsSync(modernPath)) {
        check('mock-mcp-modern fixture is present', false, modernPath)
      } else {
        const modernRec: McpServerRecord = {
          id: 'modernmcp',
          enabled: true,
          config: {
            type: 'local',
            command: [process.execPath, modernPath],
            environment: { ELECTRON_RUN_AS_NODE: '1' }
          }
        }
        await ensureMcpConnected([modernRec], process.cwd())
        const modernSummary = mcpServerSummaries(new Set(['modernmcp']))[0]
        check(
          'mcp era: a 2026-era server connects without `initialize`',
          modernSummary?.status === 'connected',
          modernSummary?.error
        )
        check('mcp era: ...and reports the modern era', modernSummary?.era === 'modern')
        check(
          'mcp era: its tools are discovered',
          !!modernSummary && modernSummary.tools.includes('structured')
        )

        // A modern result may carry ONLY structuredContent. The v1 path rendered
        // that as "(no output)" - a successful call reported as empty.
        const structured = await withTimeout(
          callMcpTool('mcp__modernmcp__structured', {}),
          15_000,
          'mcp structured'
        )
        check(
          'mcp era: a structured-only result is not reported as empty',
          structured.ok && structured.output.includes('61.5') && structured.output.includes('EUR'),
          structured.output
        )

        // Ordinary calls behave identically across eras - that is the point of
        // negotiating rather than branching at every call site.
        const modernEcho = await withTimeout(
          callMcpTool('mcp__modernmcp__echo', { message: 'hi' }),
          15_000,
          'mcp modern echo'
        )
        check(
          'mcp era: tool calls work the same on the modern wire',
          modernEcho.ok && modernEcho.output.includes('echo: hi'),
          modernEcho.output
        )

        // Groundwork for MCP Apps: the extension metadata a server attaches to a
        // tool must survive discovery. The v1 code kept only name/description/
        // inputSchema, so a UI-bearing tool arrived indistinguishable from a
        // plain one and Apps could not be built on top without re-listing.
        const def = mcpToolDefinition('mcp__modernmcp__structured')
        // Read through `uiResourceUri` rather than indexing one literal key: the
        // official SDK emits the short `_meta.ui`, the spec reserves the
        // qualified label, and a host has to accept both. Asserting the raw key
        // here would pass only against whichever spelling the fixture happened
        // to use - which is exactly how the interop gap went unnoticed.
        check(
          "mcp apps: a tool's `_meta` survives discovery",
          uiResourceUri(def?._meta) === 'ui://mockmodern/app.html',
          JSON.stringify(def?._meta)
        )
        check('mcp apps: its outputSchema is kept too', !!def?.outputSchema)

        // App-only tools: reachable by the view, invisible to the model. A host
        // that leaks them offers the model operations the server explicitly
        // said were not for it.
        const modelNames = mcpToolSchemas(new Set(['modernmcp'])).map((sc) => sc.function.name)
        check(
          'mcp apps: an app-only tool is hidden from the model',
          !modelNames.includes('mcp__modernmcp__set_cell'),
          modelNames.join(',')
        )
        check(
          'mcp apps: ...but is still routable for its view',
          !!mcpToolDefinition('mcp__modernmcp__set_cell')
        )
        check(
          'mcp apps: ordinary tools are unaffected',
          modelNames.includes('mcp__modernmcp__echo')
        )

        // ---- results stay lossless end-to-end -----------------------------
        // Same property as the shared unit tests, but over a REAL wire: what a
        // server actually sent must still be there after the client, the
        // service, and the pool have handled it.
        const rich = await withTimeout(callMcpTool('mcp__modernmcp__rich', {}), 15_000, 'mcp rich')
        check('mcp lossless: the flat result still reads naturally', rich.ok, rich.output)
        check(
          'mcp lossless: the flat form previews the first image',
          rich.image === 'data:image/png;base64,AAA'
        )
        const full = lastMcpCallResult('mcp__modernmcp__rich')
        check(
          'mcp lossless: every block survives the round trip',
          full?.content.length === 4,
          String(full?.content.length)
        )
        const linkBlock = full?.content.find((b) => b.kind === 'resource_link')
        check(
          'mcp lossless: a resource link is still addressable',
          linkBlock?.kind === 'resource_link' && linkBlock.uri === 'file:///repo/report.pdf'
        )
        check(
          'mcp lossless: the second image is not discarded',
          full?.content.filter((b) => b.kind === 'image').length === 2
        )
        const resultUi = full?._meta?.['io.modelcontextprotocol/ui'] as
          | { resourceUri?: string }
          | undefined
        check(
          'mcp lossless: result _meta reaches the consumer',
          resultUi?.resourceUri === 'ui://mockmodern/app.html'
        )
        // Retaining structure is only defensible if it is also released. The
        // pool is warm and long-lived, so a cached payload that outlived its
        // connection would be a per-session leak.
        await disposeConnection('modernmcp')
        check(
          'mcp lossless: cached results are released with the connection',
          lastMcpCallResult('mcp__modernmcp__rich') === undefined
        )
        await ensureMcpConnected([modernRec], process.cwd())

        // ---- resources -----------------------------------------------------
        // The half of MCP that isn't tools, and the delivery mechanism for MCP
        // Apps: a UI arrives as a `ui://` resource read over this same path.
        const resources = await withTimeout(
          listMcpResources('modernmcp'),
          15_000,
          'mcp resources/list'
        )
        check(
          'mcp resources: a server\u2019s resources are listed',
          resources.length === 2 && resources.some((r) => r.uri === 'ui://mockmodern/app.html'),
          JSON.stringify(resources.map((r) => r.uri))
        )
        const uiRes = await withTimeout(
          readMcpResource('modernmcp', 'ui://mockmodern/app.html'),
          15_000,
          'mcp resources/read'
        )
        check(
          'mcp resources: a ui:// resource reads back as text',
          'text' in uiRes && !!uiRes.text && uiRes.text.includes('<h1>hi</h1>'),
          JSON.stringify(uiRes)
        )
        check(
          'mcp resources: ...carrying the MCP Apps mime profile',
          'mimeType' in uiRes && uiRes.mimeType === 'text/html;profile=mcp-app'
        )
        // A missing URI is an error VALUE, not a thrown exception: a resource
        // read happens inside a turn and must not take the turn with it.
        const missing = await withTimeout(
          readMcpResource('modernmcp', 'file:///nope'),
          15_000,
          'mcp resources/read missing'
        )
        check('mcp resources: an unknown URI degrades to an error value', 'error' in missing)
        check(
          'mcp resources: listing a server without the capability is empty, not an error',
          (await listMcpResources('mockmcp')).length === 0
        )

        // ---- MCP Apps: the broker end to end -------------------------------
        // Loads a real `ui://` resource over the real client, then exercises the
        // boundary the whole feature rests on.
        const launched = await withTimeout(
          launchMcpApp('modernmcp', 'mcp__modernmcp__structured', 'ui://mockmodern/app.html'),
          15_000,
          'mcp app launch'
        )
        check(
          'mcp app: a ui:// view loads',
          !!launched && launched.html.includes('<h1>hi</h1>'),
          JSON.stringify(launched)?.slice(0, 120)
        )
        check(
          'mcp app: it arrives with a restrictive CSP',
          !!launched?.csp.includes("default-src 'none'")
        )

        if (launched) {
          // A view names an UNQUALIFIED tool; the broker qualifies it against the
          // session's own server. There is no code path that reads a server id
          // from the view, which is what makes cross-server calls impossible
          // rather than merely discouraged.
          setMcpAppApprover(async () => true)
          const ok = await withTimeout(
            handleMcpAppRequest({
              sessionId: launched.sessionId,
              id: 1,
              method: 'tools/call',
              params: { name: 'echo', arguments: { message: 'from-view' } }
            }),
            15_000,
            'mcp app tools/call'
          )
          check(
            'mcp app: an approved tool call reaches its own server',
            JSON.stringify(ok.result ?? '').includes('from-view'),
            JSON.stringify(ok)
          )

          // The same call, denied.
          setMcpAppApprover(async () => false)
          const denied = await withTimeout(
            handleMcpAppRequest({
              sessionId: launched.sessionId,
              id: 2,
              method: 'tools/call',
              params: { name: 'boom', arguments: {} }
            }),
            15_000,
            'mcp app denied call'
          )
          check('mcp app: an unapproved tool call is refused', !!denied.error)

          // The legacy mock's `echo` exists, but not on THIS view's server.
          setMcpAppApprover(async () => true)
          const cross = await withTimeout(
            handleMcpAppRequest({
              sessionId: launched.sessionId,
              id: 3,
              method: 'tools/call',
              params: { name: 'mcp__mockmcp__echo', arguments: {} }
            }),
            15_000,
            'mcp app cross-server'
          )
          check('mcp app: a view cannot reach another server', !!cross.error, JSON.stringify(cross))

          // Methods outside the allowlist never reach a server.
          const bad = await withTimeout(
            handleMcpAppRequest({
              sessionId: launched.sessionId,
              id: 4,
              method: 'sampling/createMessage',
              params: {}
            }),
            15_000,
            'mcp app bad method'
          )
          check('mcp app: an unsupported method is rejected', !!bad.error)

          // Teardown must actually invalidate the session, or a stale frame
          // could keep calling tools after its card is gone.
          closeMcpApp(launched.sessionId)
          const afterClose = await withTimeout(
            handleMcpAppRequest({
              sessionId: launched.sessionId,
              id: 5,
              method: 'tools/call',
              params: { name: 'echo', arguments: {} }
            }),
            15_000,
            'mcp app after close'
          )
          check('mcp app: a closed session serves nothing', !!afterClose.error)
        }
        // The renderer names an explicit targetOrigin on every postMessage, so
        // the constant it uses MUST match the scheme main actually serves. If
        // these drift, every reply is silently dropped by the browser and the
        // bridge dies with no error anywhere.
        check(
          'mcp app: the sandbox origin matches the served scheme',
          SANDBOX_ORIGIN_HINT.startsWith(SANDBOX_SCHEME + '://') &&
            SANDBOX_URL.startsWith(SANDBOX_ORIGIN_HINT)
        )
        // ---- the sandbox origin, for real ----------------------------------
        // Everything above tests the BROKER. None of it proves the custom
        // scheme actually serves, and that is the one layer whose failure mode
        // is invisible: `registerSchemesAsPrivileged` has to run before
        // app-ready, and if it didn't, every app view silently renders a blank
        // frame with no error on any channel. Load it in a real window.
        {
          const win = new BrowserWindow({ show: false })
          try {
            await win.loadURL(SANDBOX_URL)
            const probe = (await win.webContents.executeJavaScript(
              `(() => ({
                 origin: String(window.origin),
                 secure: Boolean(window.isSecureContext),
                 hasProxy: typeof window.__roxyProxyReady !== 'undefined' || !!document.querySelector('script'),
                 title: document.title
               }))()`
            )) as { origin: string; secure: boolean; hasProxy: boolean; title: string }
            check(
              'mcp app: the sandbox origin actually loads',
              probe.origin.startsWith(SANDBOX_SCHEME + '://'),
              probe.origin
            )
            // Privileged registration is what grants a secure context. Without
            // it the proxy still "loads" but modern APIs quietly degrade.
            check('mcp app: ...as a secure context', probe.secure === true)
            check('mcp app: ...serving the proxy document', probe.hasProxy === true)
          } catch (e) {
            check('mcp app: the sandbox origin actually loads', false, String(e))
          } finally {
            win.destroy()
          }
        }

        _resetMcpAppsForTests()

        // ---- cancellation --------------------------------------------------
        // The `slow` tool never replies. Without a signal this would block for
        // the full request timeout; with one it returns as soon as we abort.
        const ac = new AbortController()
        const startedAt = Date.now()
        setTimeout(() => ac.abort(), 250)
        const cancelled = await withTimeout(
          callMcpTool('mcp__modernmcp__slow', {}, ac.signal),
          15_000,
          'mcp cancel'
        )
        check(
          'mcp cancel: an aborted call returns promptly',
          Date.now() - startedAt < 5_000,
          `${Date.now() - startedAt}ms`
        )
        check(
          'mcp cancel: ...and reports cancellation, not a server failure',
          !cancelled.ok && /cancelled/i.test(cancelled.output),
          cancelled.output
        )

        // ---- per-server request timeouts -----------------------------------
        // Calls arrive by TOOL name, so `callMcpTool` has no config in hand and
        // used to fall back to the global 120s default - a server configured
        // with `timeout: 800` still hung a turn for two minutes. The budget is
        // resolved at connect and carried on the connection.
        const impatientRec: McpServerRecord = {
          id: 'impatient',
          enabled: true,
          config: {
            type: 'local',
            command: [process.execPath, modernPath],
            environment: { ELECTRON_RUN_AS_NODE: '1' },
            timeout: 800
          }
        }
        await ensureMcpConnected([impatientRec], process.cwd())
        const slowStart = Date.now()
        const timedOut = await withTimeout(
          callMcpTool('mcp__impatient__slow', {}),
          20_000,
          'mcp per-server timeout'
        )
        const elapsed = Date.now() - slowStart
        check(
          'mcp timeout: a server\u2019s own budget is honoured, not the global default',
          !timedOut.ok && elapsed < 10_000,
          `${elapsed}ms`
        )
        await disposeConnection('impatient')

        // ...and none of it leaks into what the model sees.
        const modelSchema = mcpToolSchemas(new Set(['modernmcp'])).find(
          (s) => s.function.name === 'mcp__modernmcp__structured'
        )
        check(
          "mcp apps: extension metadata stays out of the model's tool list",
          !!modelSchema && !JSON.stringify(modelSchema).includes('io.modelcontextprotocol/ui')
        )

        // Both eras coexist in one warm pool, each on its own negotiated wire.
        await ensureMcpConnected([rec], process.cwd())
        const legacySummary = mcpServerSummaries(new Set(['mockmcp']))[0]
        check(
          'mcp era: a 2025-era server still negotiates legacy alongside it',
          legacySummary?.status === 'connected' && legacySummary?.era === 'legacy',
          `${legacySummary?.era} / ${legacySummary?.error}`
        )

        await _resetMcpForTests()
      }

      // ---- the `mcp` MANAGEMENT tool (add/list/enable/disable/reconnect/remove) ----
      // Drives the agent-facing tool through runTool end-to-end against the real DB
      // + the mock server: add → connect → use in the same flow → toggle → remove.
      const mcpCmd = {
        action: 'add',
        id: 'toolmcp',
        command: [process.execPath, mockPath],
        env: { ELECTRON_RUN_AS_NODE: '1' }
      }
      // ---- the default: an agent-added server just runs ----------------------
      // Installing a server is the user's decision, so the `mcp` tool connects
      // it and Roxy discloses what it exposed afterwards. No prompt, no window
      // needed - which is why this works in a headless run.
      _resetTrustForTests()
      repo.revokeMcpTrust('toolmcp')
      const added = await withTimeout(run('mcp', mcpCmd), 20_000, 'mcp tool add')
      check(
        'mcp tool: add connects the server and names its tools',
        added.ok && added.output.includes('mcp__toolmcp__echo'),
        added.output
      )
      check(
        'mcp tool: add persists the server to the DB',
        repo.listMcpServers().some((r) => r.id === 'toolmcp')
      )
      // Provenance still survives the write. It no longer gates anything by
      // default, but it is what the disclosure says ("added by the agent") and
      // what the opt-in confirm posture keys off.
      check(
        'mcp trust: an agent-added row stays marked agent-added',
        repo.listMcpServers().find((r) => r.id === 'toolmcp')?.origin === 'agent'
      )
      // Connecting records the server, so the notice is a one-off rather than a
      // banner on every turn.
      check(
        'mcp trust: connecting remembers the server',
        repo.getMcpTrustStore().entries.some((e) => e.id === 'toolmcp' && e.decision === 'allow')
      )

      // ---- the exception: a KNOWN name now running something else ------------
      // This is the one case that interrupts. With no window to ask, it must
      // resolve to "not connected" rather than silently running the substitute.
      const swapped = await withTimeout(
        run('mcp', {
          action: 'add',
          id: 'toolmcp',
          command: [process.execPath, mockPath, '--different'],
          env: { ELECTRON_RUN_AS_NODE: '1' }
        }),
        20_000,
        'mcp tool add (swapped)'
      )
      check(
        'mcp trust: swapping a known server does not silently run it',
        !swapped.ok && /declined/i.test(swapped.output),
        swapped.output
      )
      // A refused swap must leave NO trace: the rejected command must not be
      // sitting in the DB waiting to be picked up by the next enable/reconnect.
      check(
        'mcp trust: a declined swap does not overwrite the stored config',
        repo.listMcpServers().find((r) => r.id === 'toolmcp')?.config.type === 'local' &&
          !JSON.stringify(repo.listMcpServers().find((r) => r.id === 'toolmcp')?.config).includes(
            '--different'
          )
      )
      // This is what runLoop calls to rebuild the live tool list mid-turn:
      check(
        'mcp tool: added server is immediately in the scoped schemas (usable same turn)',
        mcpToolSchemas(new Set(['toolmcp'])).length === 2
      )

      const listedRes = await run('mcp', { action: 'list' })
      check(
        'mcp tool: list shows the server as connected',
        listedRes.ok &&
          listedRes.output.includes('toolmcp') &&
          listedRes.output.includes('connected'),
        listedRes.output
      )

      // The payoff: a tool the agent just added is callable through the same runTool.
      const usedAdded = await withTimeout(
        run('mcp__toolmcp__echo', { message: 'viatool' }),
        15_000,
        'mcp added echo'
      )
      check(
        "mcp tool: a just-added server's tool is callable",
        usedAdded.ok && usedAdded.output.includes('echo: viatool'),
        usedAdded.output
      )

      const disabled = await withTimeout(
        run('mcp', { action: 'disable', id: 'toolmcp' }),
        15_000,
        'mcp tool disable'
      )
      check(
        'mcp tool: disable disconnects + drops its schemas',
        disabled.ok && mcpToolSchemas().length === 0
      )
      check(
        'mcp tool: disable persists enabled=false',
        repo.listMcpServers().find((r) => r.id === 'toolmcp')?.enabled === false
      )

      const enabled = await withTimeout(
        run('mcp', { action: 'enable', id: 'toolmcp' }),
        20_000,
        'mcp tool enable'
      )
      check(
        'mcp tool: enable reconnects the server',
        enabled.ok && mcpToolSchemas(new Set(['toolmcp'])).length === 2,
        enabled.output
      )

      const reconnected = await withTimeout(
        run('mcp', { action: 'reconnect', id: 'toolmcp' }),
        20_000,
        'mcp tool reconnect'
      )
      check(
        'mcp tool: reconnect refreshes the connection',
        reconnected.ok && mcpToolSchemas(new Set(['toolmcp'])).length === 2,
        reconnected.output
      )

      const removed = await withTimeout(
        run('mcp', { action: 'remove', id: 'toolmcp' }),
        15_000,
        'mcp tool remove'
      )
      check(
        'mcp tool: remove deletes from DB + drops schemas',
        removed.ok &&
          !repo.listMcpServers().some((r) => r.id === 'toolmcp') &&
          mcpToolSchemas().length === 0
      )

      // Input validation — every bad call degrades to ok:false, never throws.
      const noAction = await run('mcp', {})
      check('mcp tool: missing action → ok:false', !noAction.ok)
      const noConfig = await run('mcp', { action: 'add', id: 'incomplete' })
      check('mcp tool: add without command/url → ok:false', !noConfig.ok)
      check(
        'mcp tool: a failed add did not persist a broken server',
        !repo.listMcpServers().some((r) => r.id === 'incomplete')
      )
      const ghost = await run('mcp', { action: 'reconnect', id: 'ghost' })
      check('mcp tool: reconnect an unknown server → ok:false', !ghost.ok)
      const bogus = await run('mcp', { action: 'frobnicate', id: 'toolmcp' })
      check('mcp tool: unknown action → ok:false', !bogus.ok)
      const rmGhost = await run('mcp', { action: 'remove', id: 'never-existed' })
      check('mcp tool: removing a non-existent server is a friendly no-op (ok:true)', rmGhost.ok)

      await _resetMcpForTests()
    }
  }

  // ---- Skills runtime (Phase 14): discover SKILL.md on disk + the `skill` tool ----
  // Builds a real fixture skills tree (workspace + an isolated global home) and
  // exercises the ACTUAL discovery/dedup/cache + the `skill` tool through runTool.
  {
    const prevHome = process.env.HOME
    const prevProfile = process.env.USERPROFILE
    const prevDisabled = process.env.ROXY_SKILLS
    const skHome = path.join(tmp, 'skhome')
    const w = (p: string): string => path.join(ws, p)
    try {
      // Isolate the global skill roots to a throwaway home so discovery is deterministic.
      process.env.HOME = skHome
      process.env.USERPROFILE = skHome
      const globalActive = os.homedir() === skHome

      // Workspace fixture: frontmatter-named + folder-named + bare-file skills, a
      // companion file, and a name clash across .roxy/.claude roots.
      await fs.mkdir(w('.roxy/skills/demo/scripts'), { recursive: true })
      await fs.writeFile(
        w('.roxy/skills/demo/SKILL.md'),
        '---\nname: demokit\ndescription: Workspace demo skill\n---\n# Demo\nUse scripts/run.sh.\n',
        'utf8'
      )
      await fs.writeFile(w('.roxy/skills/demo/scripts/run.sh'), 'echo hi\n', 'utf8')
      await fs.writeFile(
        w('.roxy/skills/notes.md'),
        '---\ndescription: Bare single-file skill\n---\nNotes body.\n',
        'utf8'
      )
      await fs.mkdir(w('.claude/skills/greet'), { recursive: true })
      await fs.writeFile(
        w('.claude/skills/greet/SKILL.md'),
        '---\ndescription: Says hello\n---\nHello!\n',
        'utf8'
      )
      await fs.mkdir(w('.roxy/skills/dup'), { recursive: true })
      await fs.writeFile(
        w('.roxy/skills/dup/SKILL.md'),
        '---\ndescription: roxy wins\n---\nR\n',
        'utf8'
      )
      await fs.mkdir(w('.claude/skills/dup'), { recursive: true })
      await fs.writeFile(
        w('.claude/skills/dup/SKILL.md'),
        '---\ndescription: claude loses\n---\nC\n',
        'utf8'
      )

      // Global fixture (under the isolated home): one that clashes with the workspace
      // (must lose) and one global-only (must be discovered).
      if (globalActive) {
        await fs.mkdir(path.join(skHome, '.roxy/skills/demokit'), { recursive: true })
        await fs.writeFile(
          path.join(skHome, '.roxy/skills/demokit/SKILL.md'),
          '---\ndescription: global demokit (should lose)\n---\nG\n',
          'utf8'
        )
        await fs.mkdir(path.join(skHome, '.roxy/skills/awscli'), { recursive: true })
        await fs.writeFile(
          path.join(skHome, '.roxy/skills/awscli/SKILL.md'),
          '---\ndescription: Global AWS skill\n---\nAWS\n',
          'utf8'
        )
      }

      _resetSkillsForTests()
      const found = await listSkills(ws)
      const by = new Map(found.map((s) => [s.name, s]))
      check('skills: frontmatter name wins over folder name', by.has('demokit') && !by.has('demo'))
      check('skills: discovers a folder-named SKILL.md', by.get('greet')?.source === 'workspace')
      check('skills: discovers a bare <name>.md', by.has('notes'))
      check(
        'skills: results sorted by name',
        found.map((s) => s.name).join() === [...found.map((s) => s.name)].sort().join()
      )
      check(
        'skills: .roxy beats .claude on a name clash',
        by.get('dup')?.description === 'roxy wins'
      )
      if (globalActive) {
        check('skills: discovers global skills', by.get('awscli')?.source === 'global')
        check(
          'skills: workspace overrides a same-named global',
          by.get('demokit')?.source === 'workspace' &&
            by.get('demokit')?.description === 'Workspace demo skill'
        )
      }

      const instr = await skillInstructions(ws)
      check(
        'skills: instructions block lists discovered skills',
        !!instr &&
          instr.includes('<available_skills>') &&
          instr.includes('demokit') &&
          instr.includes('greet')
      )

      const loaded = await loadSkill('demokit', ws)
      check(
        'skills: loadSkill returns body + base dir',
        loaded.ok &&
          loaded.output.includes('Use scripts/run.sh') &&
          loaded.output.includes('Base directory')
      )
      check(
        'skills: loadSkill samples companion files (relative)',
        loaded.output.includes('<skill_files>') &&
          loaded.output.includes('<file>scripts/run.sh</file>')
      )

      // Symlink hardening: a symlinked file whose real path escapes the skill dir
      // must NOT be listed (no out-of-dir path leaked into the model context).
      try {
        const outside = path.join(tmp, 'outside-secret.txt')
        await fs.writeFile(outside, 'TOPSECRET', 'utf8')
        await fs.symlink(outside, w('.roxy/skills/demo/secret.txt'))
        const linked = await loadSkill('demokit', ws)
        check(
          'skills: symlinked file escaping the skill dir is not listed',
          linked.ok && !linked.output.includes('secret.txt') && !linked.output.includes('TOPSECRET')
        )
      } catch {
        check('skills: symlink hardening (skipped — symlinks unsupported here)', true)
      }
      const loadedBare = await loadSkill('notes', ws)
      check(
        'skills: a bare-file skill has no <skill_files>',
        loadedBare.ok && !loadedBare.output.includes('<skill_files>')
      )
      const loadedCI = await loadSkill('DEMOKIT', ws)
      check('skills: loadSkill is case-insensitive', loadedCI.ok)
      const loadedMiss = await loadSkill('nope', ws)
      check(
        'skills: unknown skill → ok:false with a list',
        !loadedMiss.ok && loadedMiss.output.includes('Available skills')
      )

      const viaRun = await run('skill', { name: 'demokit' })
      check(
        'skills: runTool dispatches the skill tool',
        viaRun.ok && viaRun.output.includes('<skill_content')
      )

      // Cache invalidation: a newly-added skill is only seen after a refresh.
      await fs.writeFile(
        w('.roxy/skills/fresh.md'),
        '---\ndescription: Added later\n---\nX\n',
        'utf8'
      )
      check(
        'skills: discovery is cached (new file not seen yet)',
        !(await listSkills(ws)).some((s) => s.name === 'fresh')
      )
      refreshSkills(ws)
      check(
        'skills: refreshSkills re-scans',
        (await listSkills(ws)).some((s) => s.name === 'fresh')
      )

      // Kill switch.
      process.env.ROXY_SKILLS = '0'
      _resetSkillsForTests()
      check('skills: ROXY_SKILLS=0 disables discovery', (await listSkills(ws)).length === 0)
      const disabledLoad = await loadSkill('demokit', ws)
      check(
        'skills: ROXY_SKILLS=0 disables the tool',
        !disabledLoad.ok && disabledLoad.output.toLowerCase().includes('disabled')
      )
    } finally {
      if (prevHome === undefined) delete process.env.HOME
      else process.env.HOME = prevHome
      if (prevProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = prevProfile
      if (prevDisabled === undefined) delete process.env.ROXY_SKILLS
      else process.env.ROXY_SKILLS = prevDisabled
      _resetSkillsForTests()
    }
  }

  // ---- Portable config export/import (backup skills + MCP to another machine) ----
  // Drives the REAL buildExport/applyImport against an isolated global home + the
  // live DB: seed global skills (folder + companion, and a bare .md) and MCP rows,
  // export to a bundle, wipe everything, then import and verify a faithful restore.
  {
    const prevHome = process.env.HOME
    const prevProfile = process.env.USERPROFILE
    const prevDisabled = process.env.ROXY_SKILLS
    delete process.env.ROXY_SKILLS
    const pHome = path.join(tmp, 'porthome')
    try {
      process.env.HOME = pHome
      process.env.USERPROFILE = pHome
      const homeOk = os.homedir() === pHome

      if (homeOk) {
        // Seed two global skills: a folder skill with a companion, and a bare .md.
        await fs.mkdir(path.join(pHome, '.roxy/skills/backupme/scripts'), { recursive: true })
        await fs.writeFile(
          path.join(pHome, '.roxy/skills/backupme/SKILL.md'),
          '---\nname: backupme\ndescription: Backup me\n---\nBody here. Use scripts/go.sh.\n',
          'utf8'
        )
        await fs.writeFile(
          path.join(pHome, '.roxy/skills/backupme/scripts/go.sh'),
          'echo go\n',
          'utf8'
        )
        await fs.writeFile(
          path.join(pHome, '.roxy/skills/solo.md'),
          '---\ndescription: Bare solo skill\n---\nSolo body.\n',
          'utf8'
        )
        _resetSkillsForTests()

        const exported = await exportGlobalSkills()
        const byName = new Map(exported.map((s) => [s.name, s]))
        check(
          'portable(app): export finds the folder + bare skills',
          byName.has('backupme') && byName.has('solo')
        )
        check(
          'portable(app): folder skill carries its companion file',
          (byName.get('backupme')?.files.length ?? 0) === 2
        )
        check(
          'portable(app): bare skill is normalized to a SKILL.md file',
          byName.get('solo')?.files.some((f) => f.path.toLowerCase() === 'skill.md') === true
        )

        // Seed MCP rows, then build the whole export via the service (skills + DB).
        repo.upsertMcpServer({
          id: 'port-fs',
          config: { type: 'local', command: ['npx', 'srv'] },
          enabled: true
        })
        repo.upsertMcpServer({
          id: 'port-remote',
          config: { type: 'remote', url: 'https://p.example/mcp' },
          enabled: false
        })
        const built = await buildExport()
        check(
          'portable(app): buildExport counts skills + servers',
          built.skills >= 2 && built.mcpServers >= 2
        )
        check(
          'portable(app): buildExport text is a valid bundle',
          parseBundle(built.text).ok === true
        )

        // Wipe both sides, then restore from the exported text.
        await fs.rm(path.join(pHome, '.roxy/skills'), { recursive: true, force: true })
        repo.deleteMcpServer('port-fs')
        repo.deleteMcpServer('port-remote')
        _resetSkillsForTests()
        check('portable(app): skills gone before import', (await exportGlobalSkills()).length === 0)

        const applied = await applyImport(built.text)
        check('portable(app): applyImport reports ok', applied.ok === true)
        check(
          'portable(app): applyImport restored the skills',
          applied.skills.some((s) => s.name === 'backupme')
        )
        check(
          'portable(app): applyImport restored the servers',
          applied.mcpServers.some((s) => s.id === 'port-fs') &&
            applied.mcpServers.some((s) => s.id === 'port-remote')
        )

        // Verify the files + DB rows really came back.
        const restoredSkill = await fs
          .readFile(path.join(pHome, '.roxy/skills/backupme/SKILL.md'), 'utf8')
          .catch(() => '')
        check(
          'portable(app): restored SKILL.md content matches',
          restoredSkill.includes('Body here.')
        )
        const restoredCompanion = await fs
          .readFile(path.join(pHome, '.roxy/skills/backupme/scripts/go.sh'), 'utf8')
          .catch(() => '')
        check(
          'portable(app): restored companion file matches',
          restoredCompanion.includes('echo go')
        )
        const remote = repo.listMcpServers().find((r) => r.id === 'port-remote')
        check(
          'portable(app): restored a disabled remote server',
          remote?.enabled === false && remote?.config.type === 'remote'
        )

        // Re-importing overwrites (replaced=true), never duplicates.
        const again = await applyImport(built.text)
        check(
          'portable(app): re-import marks skills replaced',
          again.skills.find((s) => s.name === 'backupme')?.replaced === true
        )
        check(
          'portable(app): re-import marks servers replaced',
          again.mcpServers.find((s) => s.id === 'port-fs')?.replaced === true
        )

        // A malformed bundle is a graceful, structured failure.
        const bad = await applyImport('{ not a bundle }')
        check(
          'portable(app): applyImport rejects junk without throwing',
          bad.ok === false && !!bad.error
        )

        // importGlobalSkills refuses a path escaping the skill folder.
        const escaped = await importGlobalSkills([
          {
            name: 'evil',
            files: [
              {
                path: 'SKILL.md',
                dataBase64: Buffer.from('---\nname: evil\n---\nx', 'utf8').toString('base64')
              },
              { path: '../pwn.sh', dataBase64: Buffer.from('bad', 'utf8').toString('base64') }
            ]
          }
        ])
        check(
          'portable(app): import writes the skill but drops the escaping path',
          escaped.installed.some((s) => s.name === 'evil')
        )
        check(
          'portable(app): the escaping companion was not written',
          !existsSync(path.join(pHome, '.roxy/skills/pwn.sh')) &&
            !existsSync(path.join(tmp, 'pwn.sh'))
        )

        // Clean up DB rows this block created.
        repo.deleteMcpServer('port-fs')
        repo.deleteMcpServer('port-remote')
      } else {
        check('portable(app): skipped (home override unsupported here)', true)
      }
    } finally {
      if (prevHome === undefined) delete process.env.HOME
      else process.env.HOME = prevHome
      if (prevProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = prevProfile
      if (prevDisabled === undefined) delete process.env.ROXY_SKILLS
      else process.env.ROXY_SKILLS = prevDisabled
      _resetSkillsForTests()
    }
  }
  // ---- skill_manage tool (Phase 14+): the model authoring/managing skills ----
  // Drives the real writeSkill/deleteSkill service through runTool against the
  // smoke workspace `ws` (scope defaults to workspace → writes ws/.roxy/skills),
  // so it never touches the user's real ~/.roxy/skills.
  {
    const prevDisabled = process.env.ROXY_SKILLS
    delete process.env.ROXY_SKILLS
    _resetSkillsForTests()
    try {
      const SN = 'smokemanaged'
      const MARK = 'SMOKE-BODY-MARKER-A'

      // create
      const created = await run('skill_manage', {
        action: 'create',
        name: SN,
        description: 'first desc',
        body: `# ${SN}\n${MARK}\n`
      })
      check('skill_manage: create returns ok', created.ok && created.output.includes(SN))
      check(
        'skill_manage: created skill is discovered',
        (await listSkills(ws)).some((s) => s.name === SN)
      )

      // the `skill` tool can load what we just created
      const loaded = await run('skill', { name: SN })
      check(
        'skill_manage: created skill loads via the skill tool',
        loaded.ok && loaded.output.includes(MARK)
      )

      // duplicate create is refused
      const dup = await run('skill_manage', { action: 'create', name: SN, body: 'x' })
      check('skill_manage: duplicate create → ok:false', !dup.ok)

      // edit description only → body preserved
      const edited = await run('skill_manage', {
        action: 'edit',
        name: SN,
        description: 'second desc'
      })
      check('skill_manage: edit returns ok', edited.ok)
      const afterEdit = (await listSkills(ws)).find((s) => s.name === SN)
      check('skill_manage: edit changed the description', afterEdit?.description === 'second desc')
      const reloaded = await run('skill', { name: SN })
      check(
        'skill_manage: edit preserved the omitted body',
        reloaded.ok && reloaded.output.includes(MARK)
      )

      // list action surfaces it
      const listed = await run('skill_manage', { action: 'list' })
      check('skill_manage: list includes the skill', listed.ok && listed.output.includes(SN))

      // synonyms: op/add + content alias
      const viaSyn = await run('skill_manage', {
        op: 'add',
        name: 'smokesyn',
        content: 'body via content alias'
      })
      check('skill_manage: op/add + content alias works', viaSyn.ok)
      await run('skill_manage', { action: 'remove', name: 'smokesyn' })

      // remove deletes it
      const removed = await run('skill_manage', { action: 'remove', name: SN })
      check(
        'skill_manage: remove returns ok+removed',
        removed.ok && removed.output.includes('Removed')
      )
      check(
        'skill_manage: removed skill is gone',
        !(await listSkills(ws)).some((s) => s.name === SN)
      )

      // validation / never-throws
      const noAction = await run('skill_manage', {})
      check('skill_manage: missing action → ok:false', !noAction.ok)
      const noName = await run('skill_manage', { action: 'edit' })
      check('skill_manage: edit without name → ok:false', !noName.ok)
      const noBody = await run('skill_manage', { action: 'create', name: 'smokenobody' })
      check('skill_manage: create without body → ok:false', !noBody.ok)
      const badName = await run('skill_manage', { action: 'create', name: 'bad name', body: 'x' })
      check('skill_manage: invalid name → ok:false', !badName.ok)
      const unknown = await run('skill_manage', { action: 'frobnicate', name: 'x' })
      check('skill_manage: unknown action → ok:false', !unknown.ok)
      const missRm = await run('skill_manage', { action: 'remove', name: 'does-not-exist-xyz' })
      check(
        'skill_manage: remove nonexistent → friendly ok',
        missRm.ok && /no skill/i.test(missRm.output)
      )
    } finally {
      if (prevDisabled === undefined) delete process.env.ROXY_SKILLS
      else process.env.ROXY_SKILLS = prevDisabled
      _resetSkillsForTests()
    }
  }

  // ---- skill install from a remote source (Roxy's `npx skills add`) ----
  // Drives the REAL installSkillFromSource + runTool('skill_manage' install) with a
  // network-free fake fetch that serves a tiny GitHub repo (contents API + raw files).
  {
    const prevDisabled = process.env.ROXY_SKILLS
    delete process.env.ROXY_SKILLS
    _resetSkillsForTests()

    const SKILL_HELLO = '---\nname: hello\ndescription: Say hi\n---\n# Hello\nRun scripts/run.sh\n'
    const SKILL_SOLO = '---\nname: solo\ndescription: A single-file skill\n---\n# Solo\nJust me.\n'
    const RAWBASE = 'https://raw.githubusercontent.com'
    const ghFile = (repo: string, p: string, size = 60): Record<string, unknown> => ({
      type: 'file',
      name: path.posix.basename(p),
      path: p,
      size,
      download_url: `${RAWBASE}/acme/${repo}/HEAD/${p}`
    })
    const ghDir = (p: string): Record<string, unknown> => ({
      type: 'dir',
      name: path.posix.basename(p),
      path: p
    })
    // Contents API tree, keyed by "owner/repo" then repo-relative dir path.
    const contents: Record<string, Record<string, unknown[]>> = {
      'acme/skills': {
        '': [ghDir('skills'), ghFile('skills', 'README.md', 10)],
        skills: [ghDir('skills/hello')],
        'skills/hello': [ghFile('skills', 'skills/hello/SKILL.md'), ghDir('skills/hello/scripts')],
        'skills/hello/scripts': [ghFile('skills', 'skills/hello/scripts/run.sh', 8)]
      },
      'acme/empty': { '': [ghFile('empty', 'README.md', 10)] }
    }
    const rawBodies: Record<string, string> = {
      [`${RAWBASE}/acme/skills/HEAD/skills/hello/SKILL.md`]: SKILL_HELLO,
      [`${RAWBASE}/acme/skills/HEAD/skills/hello/scripts/run.sh`]: 'echo hi\n',
      [`${RAWBASE}/acme/skills/HEAD/README.md`]: '# readme\n',
      [`${RAWBASE}/acme/empty/HEAD/README.md`]: '# readme\n',
      [`${RAWBASE}/acme/solo/main/solo/SKILL.md`]: SKILL_SOLO
    }
    const mkResp = (body: unknown, bytes: string | null, ok = true, status = 200): Response =>
      ({
        ok,
        status,
        json: async () => body,
        text: async () => bytes ?? '',
        arrayBuffer: async () => new TextEncoder().encode(bytes ?? '').buffer,
        headers: { get: (): string | null => null }
      }) as unknown as Response
    const fakeFetch = (async (input: string | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString()
      const apiMatch = /api\.github\.com\/repos\/([^/]+)\/([^/]+)\/contents\/?([^?]*)/.exec(url)
      if (apiMatch) {
        const key = `${apiMatch[1]}/${apiMatch[2]}`
        const dir = decodeURIComponent(apiMatch[3] || '')
        const tree = contents[key]
        const listing = tree?.[dir]
        if (!listing) return mkResp(null, null, false, 404)
        return mkResp(listing, null)
      }
      if (url in rawBodies) return mkResp(null, rawBodies[url])
      return mkResp(null, null, false, 404)
    }) as unknown as typeof fetch

    try {
      // 1) Repo install (owner/repo shorthand) → finds skills/hello + companion file.
      const res = await installSkillFromSource('acme/skills', {
        cwd: ws,
        scope: 'workspace',
        fetchImpl: fakeFetch
      })
      check(
        'skill install: repo install ok',
        res.ok && res.installed.some((s) => s.name === 'hello')
      )
      const helloMd = path.join(ws, '.roxy/skills/hello/SKILL.md')
      check('skill install: wrote SKILL.md', existsSync(helloMd))
      check(
        'skill install: wrote companion file',
        existsSync(path.join(ws, '.roxy/skills/hello/scripts/run.sh'))
      )
      refreshSkills(ws)
      const found = await listSkills(ws)
      check(
        'skill install: installed skill is discovered',
        found.some((s) => s.name === 'hello')
      )
      const loaded = await loadSkill('hello', ws)
      check(
        'skill install: installed skill loads with companions',
        loaded.ok &&
          loaded.output.includes('Run scripts/run.sh') &&
          loaded.output.includes('run.sh')
      )

      // 2) Direct blob URL to a SKILL.md → installs that one skill (via its folder).
      const blob = await installSkillFromSource(
        'https://github.com/acme/skills/blob/main/skills/hello/SKILL.md',
        { cwd: ws, scope: 'workspace', fetchImpl: fakeFetch }
      )
      check(
        'skill install: blob URL installs the skill',
        blob.ok && blob.installed[0]?.name === 'hello'
      )

      // 3) Direct raw SKILL.md URL → bare install using its frontmatter name.
      const raw = await installSkillFromSource(`${RAWBASE}/acme/solo/main/solo/SKILL.md`, {
        cwd: ws,
        scope: 'workspace',
        fetchImpl: fakeFetch
      })
      check(
        'skill install: raw .md URL installs (frontmatter name)',
        raw.ok && raw.installed[0]?.name === 'solo'
      )
      check(
        'skill install: raw install wrote canonical SKILL.md',
        existsSync(path.join(ws, '.roxy/skills/solo/SKILL.md'))
      )

      // 4) A repo with no SKILL.md → friendly ok:false (never throws).
      const empty = await installSkillFromSource('acme/empty', {
        cwd: ws,
        scope: 'workspace',
        fetchImpl: fakeFetch
      })
      check(
        'skill install: no SKILL.md → ok:false',
        !empty.ok && /no skill\.?md/i.test(empty.error ?? '')
      )

      // 5) Unsupported source (GitLab) → ok:false with a reason, no fetch.
      const gitlab = await installSkillFromSource('https://gitlab.com/o/r', {
        cwd: ws,
        scope: 'workspace',
        fetchImpl: fakeFetch
      })
      check(
        'skill install: unsupported source → ok:false',
        !gitlab.ok && /gitlab/i.test(gitlab.error ?? '')
      )

      // 6) 404 source → friendly message, never throws.
      const missing = await installSkillFromSource('acme/nope', {
        cwd: ws,
        scope: 'workspace',
        fetchImpl: fakeFetch
      })
      check('skill install: 404 source → friendly ok:false', !missing.ok && !!missing.error)

      // 7) Through runTool('skill_manage', install) using the test fetch seam.
      _setInstallFetchForTests(fakeFetch)
      const viaTool = await run('skill_manage', { action: 'install', source: 'acme/skills' })
      check(
        'skill install: skill_manage install dispatches via runTool',
        viaTool.ok && viaTool.output.includes('Installed') && viaTool.output.includes('hello')
      )
      // create-with-source-and-no-body is treated as an install (forgiving routing).
      const viaCreate = await run('skill_manage', {
        action: 'create',
        source: `${RAWBASE}/acme/solo/main/solo/SKILL.md`
      })
      check(
        'skill install: create+source (no body) routes to install',
        viaCreate.ok && viaCreate.output.includes('Installed')
      )
      const noSource = await run('skill_manage', { action: 'install' })
      check('skill install: install without source → ok:false', !noSource.ok)
    } finally {
      _setInstallFetchForTests(undefined)
      if (prevDisabled === undefined) delete process.env.ROXY_SKILLS
      else process.env.ROXY_SKILLS = prevDisabled
      _resetSkillsForTests()
    }
  }

  // ---- browser tools (real Electron window, local file, no network) ----
  try {
    const page =
      '<!doctype html><html><head><title>Smoke</title></head><body><h1 id="h">Hi roxy</h1>' +
      '<script>console.error("boom-smoke-error")</script></body></html>'
    const pagePath = path.join(ws, 'smoke.html')
    await fs.writeFile(pagePath, page, 'utf8')
    const fileUrl = pathToFileURL(pagePath).href

    const opened = await withTimeout(browser.open(fileUrl), 15_000, 'browser_open')
    check('browser_open loads a page', Boolean(opened.url) && !opened.error, opened.error ?? '')
    const html = await withTimeout(browser.getHtml('#h'), 15_000, 'browser_read')
    check('browser_read returns element HTML', html.includes('Hi roxy'), html.slice(0, 80))
    const tabsOut = await withTimeout(run('browser_tabs', {}), 15_000, 'browser_tabs')
    check(
      'browser_tabs lists the active tab',
      tabsOut.ok && tabsOut.output.includes('smoke.html') && tabsOut.output.includes('*'),
      tabsOut.output
    )
    const shot = await withTimeout(run('browser_screenshot', {}), 15_000, 'browser_screenshot')
    // Embedded views can't be captured on a headless display surface; the tool
    // works in the real (windowed) app. Tolerate that specific env limitation.
    const headlessCapture = !shot.ok && /display surface not available/i.test(shot.output)
    check(
      'browser_screenshot returns an inline image + saves a file',
      headlessCapture ||
        (Boolean(shot.image) &&
          shot.image!.startsWith('data:image/') &&
          shot.output.includes('.roxy')),
      headlessCapture ? '(skipped: headless has no capturable surface)' : shot.output
    )
    const con = await withTimeout(run('browser_console', {}), 15_000, 'browser_console')
    check(
      'browser_console captures the page error',
      con.output.toLowerCase().includes('boom-smoke-error'),
      con.output.slice(0, 120)
    )
    // Tab reorder (drag-to-reorganize): move the first tab to the end.
    browser.newTab('about:blank')
    const before = browser.listTabs().map((t) => t.id)
    if (before.length >= 2) {
      browser.moveTab(before[0], before.length - 1)
      const after = browser.listTabs().map((t) => t.id)
      check(
        'browser.moveTab reorders the strip',
        after[after.length - 1] === before[0] && after.length === before.length,
        after.join(',')
      )
    }
    browser.close()
  } catch (e) {
    check('browser tools', false, e instanceof Error ? e.message : String(e))
  }

  // ---- overnight resilience: transient model failures don't kill the run ----
  // There's no cap on tool-call count (the loop runs `for (;;)`); the real
  // overnight risk is a transient provider blip throwing out of the model stream.
  // `streamTurn` rides those out. These checks lock in the classification + the
  // retry policy without touching the network (fake model call, skipped backoff).
  try {
    check(
      'Copilot requests include the editor identity required by token exchange',
      COPILOT_EDITOR_HEADERS['Copilot-Integration-Id'] === 'vscode-chat' &&
        COPILOT_EDITOR_HEADERS['Editor-Version'].startsWith('vscode/') &&
        COPILOT_EDITOR_HEADERS['Editor-Plugin-Version'].startsWith('copilot-chat/') &&
        COPILOT_EDITOR_HEADERS['User-Agent'].startsWith('GitHubCopilotChat/')
    )

    const apiErr = (statusCode: number, responseBody = ''): APICallError =>
      new APICallError({
        message: `api ${statusCode}`,
        url: 'https://example.test',
        requestBodyValues: {},
        statusCode,
        responseHeaders: {},
        responseBody
      })

    check(
      'isTransientModelError: ModelHttpError 429/5xx/408/409 are transient',
      [429, 500, 503, 408, 409].every((s) => isTransientModelError(new ModelHttpError(s, 'x')))
    )
    check(
      'isTransientModelError: ModelHttpError 4xx (400/401/403/404) are fatal',
      [400, 401, 403, 404].every((s) => !isTransientModelError(new ModelHttpError(s, 'x')))
    )
    check(
      'isTransientModelError: AI SDK APICallError follows its own isRetryable',
      isTransientModelError(apiErr(429)) &&
        isTransientModelError(apiErr(503)) &&
        !isTransientModelError(apiErr(400)) &&
        !isTransientModelError(apiErr(404))
    )
    check(
      'isTransientModelError: a status-less NETWORK error is transient',
      isTransientModelError(new Error('ECONNRESET: socket hang up')) &&
        isTransientModelError(new TypeError('fetch failed')) &&
        isTransientModelError(Object.assign(new Error('boom'), { code: 'ETIMEDOUT' })) &&
        isTransientModelError(
          Object.assign(new TypeError('fetch failed'), {
            cause: Object.assign(new Error('read'), { code: 'ECONNRESET' })
          })
        )
    )
    check(
      'isTransientModelError: a status-less SETUP error (revoked token / not connected) is fatal',
      !isTransientModelError(new Error('Provider "openai" is not connected.')) &&
        !isTransientModelError(new Error('GitHub Copilot is not linked.')) &&
        !isTransientModelError(new TypeError("Cannot read properties of undefined (reading 'x')"))
    )
    check(
      'isNonRetryableModelError: 402 Payment Required is terminal (both transports)',
      isNonRetryableModelError(new ModelHttpError(402, 'Model request failed (402).')) &&
        isNonRetryableModelError(apiErr(402))
    )
    check(
      'isNonRetryableModelError: out-of-credits / quota text is terminal whatever the status',
      isNonRetryableModelError(
        new ModelHttpError(
          429,
          'Model request failed (429). {"error":{"code":"insufficient_quota","message":"You exceeded your current quota, please check your plan and billing details."}}'
        )
      ) &&
        isNonRetryableModelError(
          new ModelHttpError(400, 'Your credit balance is too low to access the Anthropic API.')
        ) &&
        isNonRetryableModelError(
          apiErr(429, '{"type":"error","error":{"code":"insufficient_quota"}}')
        )
    )
    check(
      'isNonRetryableModelError: a plain rate-limit / 5xx / network blip is NOT billing',
      !isNonRetryableModelError(
        new ModelHttpError(429, 'Rate limit reached, please try again in 2s')
      ) &&
        !isNonRetryableModelError(new ModelHttpError(503, 'upstream temporarily unavailable')) &&
        !isNonRetryableModelError(new Error('ECONNRESET: socket hang up'))
    )
    check(
      'isTransientModelError: an out-of-quota 429 is NOT a retry-forever rate-limit',
      !isTransientModelError(
        new ModelHttpError(429, 'insufficient_quota: You exceeded your current quota')
      ) &&
        // …but a genuine rate-limit 429 still rides out during a long run.
        isTransientModelError(new ModelHttpError(429, 'Rate limit reached, try again shortly'))
    )
    check(
      'nextRetryDelay ramps 1s→16s then caps at 30s (never negative)',
      nextRetryDelay(0) === 1000 &&
        nextRetryDelay(1) === 2000 &&
        nextRetryDelay(2) === 4000 &&
        nextRetryDelay(3) === 8000 &&
        nextRetryDelay(4) === 16000 &&
        nextRetryDelay(5) === 30000 &&
        nextRetryDelay(9) === 30000 &&
        nextRetryDelay(-3) === 1000
    )

    {
      const ac = new AbortController()
      ac.abort()
      const t0 = Date.now()
      await abortableDelay(10_000, ac.signal)
      check('abortableDelay returns at once when already aborted', Date.now() - t0 < 500)
    }
    {
      const ac = new AbortController()
      const t0 = Date.now()
      const p = abortableDelay(10_000, ac.signal)
      setTimeout(() => ac.abort(), 10)
      await p
      check('abortableDelay wakes the moment the signal aborts mid-wait', Date.now() - t0 < 500)
    }

    // streamTurn orchestration — fake the model call + skip the real backoff.
    const noDelay = async (): Promise<void> => {}
    const ok = { text: 'done', toolCalls: [] as never[], usage: null }
    const call = (
      signal: AbortSignal,
      deps: {
        runOnce?: (...a: unknown[]) => Promise<{ text: string; toolCalls: never[] }>
        delay?: (ms: number, signal: AbortSignal) => Promise<void>
      }
    ): ReturnType<typeof streamTurn> =>
      streamTurn(
        'openai',
        false,
        'm',
        [],
        signal,
        undefined,
        undefined,
        [],
        () => {},
        () => {},
        deps as never
      )

    {
      const ac = new AbortController()
      let calls = 0
      const runOnce = async (): Promise<{ text: string; toolCalls: never[] }> => {
        calls++
        if (calls < 3) throw new ModelHttpError(503, 'boom')
        return ok
      }
      const r = await call(ac.signal, { runOnce, delay: noDelay })
      check('streamTurn retries transient failures then succeeds', r.text === 'done' && calls === 3)
    }
    {
      // A 429 window longer than MODEL_FATAL_ATTEMPTS still recovers — the core
      // overnight guarantee: transient errors are never given up on.
      const ac = new AbortController()
      let calls = 0
      const runOnce = async (): Promise<{ text: string; toolCalls: never[] }> => {
        calls++
        if (calls <= MODEL_FATAL_ATTEMPTS + 3) throw new ModelHttpError(429, 'rate limited')
        return ok
      }
      const r = await call(ac.signal, { runOnce, delay: noDelay })
      check(
        'streamTurn never gives up on 429 (survives a long rate-limit)',
        r.text === 'done' && calls === MODEL_FATAL_ATTEMPTS + 4
      )
    }
    {
      const ac = new AbortController()
      let calls = 0
      const runOnce = async (): Promise<{ text: string; toolCalls: never[] }> => {
        calls++
        throw new ModelHttpError(400, 'bad request')
      }
      let threw = false
      try {
        await call(ac.signal, { runOnce, delay: noDelay })
      } catch {
        threw = true
      }
      check(
        'streamTurn gives up on a fatal 400 after MODEL_FATAL_ATTEMPTS',
        threw && calls === MODEL_FATAL_ATTEMPTS
      )
    }
    {
      // A hard billing / out-of-credits wall surfaces IMMEDIATELY — no retries,
      // no backoff — so an out-of-credits run fails fast with a clear message
      // instead of hammering the endpoint every 30s for hours.
      const ac = new AbortController()
      let calls = 0
      const runOnce = async (): Promise<{ text: string; toolCalls: never[] }> => {
        calls++
        throw new ModelHttpError(
          429,
          'insufficient_quota: You exceeded your current quota, check your plan and billing'
        )
      }
      let threw = false
      try {
        await call(ac.signal, { runOnce, delay: noDelay })
      } catch {
        threw = true
      }
      check('streamTurn surfaces a billing/quota wall at once (no retry)', threw && calls === 1)
    }
    {
      // A permanent status-less setup error (revoked token, not connected) must
      // ALSO surface after the bounded attempts — not loop forever overnight.
      const ac = new AbortController()
      let calls = 0
      const runOnce = async (): Promise<{ text: string; toolCalls: never[] }> => {
        calls++
        throw new Error('Provider "openai" is not connected.')
      }
      let threw = false
      try {
        await call(ac.signal, { runOnce, delay: noDelay })
      } catch {
        threw = true
      }
      check(
        'streamTurn gives up on a permanent status-less error (does not loop forever)',
        threw && calls === MODEL_FATAL_ATTEMPTS
      )
    }
    {
      // Once bytes have streamed this attempt, a failure is NOT retried — re-running
      // would duplicate the partial output the user already saw.
      const ac = new AbortController()
      let calls = 0
      const runOnce = async (...a: unknown[]): Promise<{ text: string; toolCalls: never[] }> => {
        calls++
        ;(a[8] as (d: string) => void)('partial ')
        throw new ModelHttpError(503, 'mid-stream drop')
      }
      let threw = false
      try {
        await call(ac.signal, { runOnce, delay: noDelay })
      } catch {
        threw = true
      }
      check('streamTurn does not retry after output already streamed', threw && calls === 1)
    }
    {
      // Stop pressed during a backoff wait ends the turn cleanly.
      const ac = new AbortController()
      let calls = 0
      const runOnce = async (): Promise<{ text: string; toolCalls: never[] }> => {
        calls++
        throw new ModelHttpError(503, 'boom')
      }
      const delay = async (): Promise<void> => {
        ac.abort()
      }
      const r = await call(ac.signal, { runOnce, delay })
      check('streamTurn stops when aborted during backoff', r.text === '' && calls === 1)
    }
    {
      const ac = new AbortController()
      ac.abort()
      let calls = 0
      const runOnce = async (): Promise<{ text: string; toolCalls: never[] }> => {
        calls++
        return ok
      }
      const r = await call(ac.signal, { runOnce, delay: noDelay })
      check('streamTurn is a no-op when already aborted', r.text === '' && calls === 0)
    }

    // ---- AI SDK usage capture (Claude/Gemini report tokens in `finish`) ----
    {
      async function* parts(): AsyncGenerator<{
        type: string
        text?: string
        totalUsage?: Record<string, number>
      }> {
        yield { type: 'text-delta', text: 'hi' }
        yield {
          type: 'finish',
          // AI SDK's inputTokens INCLUDES cached; consume splits them out.
          totalUsage: {
            inputTokens: 1000,
            outputTokens: 200,
            cachedInputTokens: 300,
            reasoningTokens: 50
          }
        }
      }
      const ac = new AbortController()
      const out = await consumeAiSdkStream(
        parts(),
        ac.signal,
        () => {},
        () => {}
      )
      check(
        'aisdk: captures real usage from finish',
        out.usage !== null && out.usage.estimated === false
      )
      check(
        'aisdk: splits cached out of input',
        out.usage?.input === 700 && out.usage?.cacheRead === 300
      )
      check(
        'aisdk: maps output + reasoning',
        out.usage?.output === 200 && out.usage?.reasoning === 50
      )
    }
    {
      // No finish/usage frame → consume returns null (streamViaAiSdk estimates upstream).
      async function* parts(): AsyncGenerator<{ type: string; text?: string }> {
        yield { type: 'text-delta', text: 'hello world' }
      }
      const ac = new AbortController()
      const out = await consumeAiSdkStream(
        parts(),
        ac.signal,
        () => {},
        () => {}
      )
      check(
        'aisdk: usage null when provider omits finish',
        out.usage === null && out.text === 'hello world'
      )
    }
  } catch (e) {
    check('overnight resilience (streamTurn)', false, e instanceof Error ? e.message : String(e))
  }

  // ---- usage tracking (real HTTP against a local stub) ----
  // Worth booting a server for: the whole point of this module is what lands on
  // the wire, and every failure inside it is swallowed by design. A unit test
  // that only asserts on queue depth would pass even if the payload were empty.
  try {
    interface Batch {
      deviceId?: string
      platform?: string
      appVersion?: string
      channel?: string
      events?: { name: string; clientId: string; ts: number; props?: Record<string, unknown> }[]
    }
    let batches: Batch[] = []
    let status = 200
    let hits = 0

    const server = createServer((req, res) => {
      hits++
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        try {
          batches.push(JSON.parse(body) as Batch)
        } catch {
          batches.push({})
        }
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end('{}')
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    process.env.ROXY_TRACK_ENDPOINT = `http://127.0.0.1:${port}/track`
    const idFile = path.join(tmp, 'install-id.json')
    // initTracking() fires its own flush without awaiting it (deliberately - it
    // must never delay startup), so tests have to wait for the request to land
    // rather than assume flush() covered it.
    const settled = async (n: number): Promise<void> => {
      for (let i = 0; i < 100 && hits < n; i++) await new Promise((r) => setTimeout(r, 10))
    }
    const reset = async (): Promise<void> => {
      _resetTracking()
      batches = []
      hits = 0
      status = 200
      await fs.rm(idFile, { force: true }).catch(() => undefined)
    }

    // 1. A cold start reports app_open and nothing else.
    await reset()
    initTracking()
    await settled(1)
    check('track: first launch posts one batch', batches.length === 1, `got ${batches.length}`)
    const first = batches[0]
    check('track: app_open is sent on launch', first?.events?.[0]?.name === 'app_open')
    check(
      'track: batch carries build facts, not user data',
      first?.platform === process.platform &&
        first?.appVersion === app.getVersion() &&
        first?.channel === 'dev'
    )
    check(
      'track: a fresh install does not report an update',
      !first?.events?.some((e) => e.name === 'update')
    )
    const idA = first?.deviceId
    check('track: deviceId is a uuid', typeof idA === 'string' && /^[0-9a-f-]{36}$/.test(idA))

    // 2. The payload contains ONLY the fields we promised. This is the check
    //    that would catch someone helpfully adding `cwd` or `model` later.
    check(
      'track: batch has no fields beyond the documented set',
      Object.keys(first ?? {})
        .sort()
        .join(',') === 'appVersion,arch,channel,deviceId,events,platform',
      Object.keys(first ?? {}).join(',')
    )
    check(
      'track: an event has no fields beyond name/clientId/ts/props',
      Object.keys(first?.events?.[0] ?? {})
        .sort()
        .join(',') === 'clientId,name,ts',
      Object.keys(first?.events?.[0] ?? {}).join(',')
    )

    // 3. The id survives a restart — that is what makes retention measurable.
    _resetTracking()
    batches = []
    hits = 0
    initTracking()
    await settled(1)
    check('track: deviceId persists across a restart', batches[0]?.deviceId === idA)

    // 4. turn_end props survive the round trip with real values.
    batches = []
    hits = 0
    track('turn_end', { ok: true, durationMs: 1234 })
    await flush()
    await settled(1)
    const props = batches[0]?.events?.[0]?.props
    check('track: props round-trip', props?.ok === true && props?.durationMs === 1234)

    // 4b. A prompt reports its provider, and NOTHING else. The exact key set is
    //     the assertion on purpose: this is the guard that fails when someone
    //     helpfully adds `model` (or `cwd`) alongside the provider.
    batches = []
    hits = 0
    track('prompt', { provider: 'openai' })
    await flush()
    await settled(1)
    const promptProps = batches[0]?.events?.[0]?.props
    check(
      'track: a prompt carries props with only a provider key',
      Object.keys(promptProps ?? {})
        .sort()
        .join(',') === 'provider',
      Object.keys(promptProps ?? {}).join(',')
    )
    check('track: the provider round-trips', promptProps?.provider === 'openai')

    // 4c. The allow-list is what stops a private endpoint from becoming a
    //     near-unique fingerprint. Drive it through track() with a raw id rather
    //     than pre-mapping it in the test: that is the difference between
    //     asserting the sanitizer exists and asserting it is actually wired in.
    check('track: a shipped provider id is allow-listed', isSeedProviderId('github-copilot'))
    check(
      'track: an unknown provider id is not allow-listed',
      !isSeedProviderId('acme-internal-gateway')
    )
    batches = []
    hits = 0
    track('prompt', { provider: 'acme-internal-gateway' })
    await flush()
    await settled(1)
    check(
      'track: an unrecognized provider is replaced with "other"',
      batches[0]?.events?.[0]?.props?.provider === 'other',
      String(batches[0]?.events?.[0]?.props?.provider)
    )
    check(
      'track: a custom provider id appears nowhere on the wire',
      !JSON.stringify(batches).includes('acme-internal-gateway')
    )

    // 4d. A private endpoint is configured against the shipped
    //     `openai-compatible` id (the URL lives in a separate column and is
    //     never passed here), so that install reports as `openai-compatible` -
    //     indistinguishable from every other one. That is the intended outcome,
    //     not an accident, so pin it.
    batches = []
    hits = 0
    track('prompt', { provider: 'openai-compatible' })
    await flush()
    await settled(1)
    check(
      'track: a custom-endpoint install reports only its seed id',
      batches[0]?.events?.[0]?.props?.provider === 'openai-compatible'
    )

    // 5. Opting out is immediate: queued events are dropped and nothing sends.
    batches = []
    hits = 0
    track('prompt')
    check('track: event queued while enabled', _queueDepth() === 1)
    setTrackingEnabled(false)
    check('track: opting out drops the queue', _queueDepth() === 0)
    track('prompt')
    check('track: opting out stops collection', _queueDepth() === 0)
    await flush()
    check('track: opting out stops sending', hits === 0, `${hits} requests`)
    check('track: opt-out is readable', isTrackingEnabled() === false)

    // 6. ...and survives a restart, including a factory reset of the database.
    repo.resetAll()
    _resetTracking()
    initTracking()
    check('track: opt-out survives restart + factory reset', isTrackingEnabled() === false)
    hits = 0
    track('app_open')
    await flush()
    check('track: opted-out restart sends nothing', hits === 0, `${hits} requests`)

    // 7. Opting back in reuses the original id rather than looking like a new
    //    install (which would silently inflate installs on every toggle).
    batches = []
    setTrackingEnabled(true)
    track('prompt')
    await flush()
    check('track: opting back in resumes sending', batches.length === 1)
    check('track: opting back in reuses the original id', batches[0]?.deviceId === idA)

    // 8. A 5xx requeues (idempotent retry), a 4xx drops (retrying can't help).
    await reset()
    initTracking()
    await settled(1)
    batches = []
    hits = 0
    status = 500
    track('prompt')
    await flush()
    check('track: a 5xx requeues the batch', _queueDepth() === 1)
    const retried = batches[0]?.events?.[0]?.clientId
    status = 200
    await flush()
    check(
      'track: the retry reuses clientId so the server can dedupe',
      batches[1]?.events?.[0]?.clientId === retried && typeof retried === 'string'
    )
    check('track: a successful retry clears the queue', _queueDepth() === 0)

    status = 400
    track('prompt')
    await flush()
    check('track: a 4xx drops the batch instead of looping', _queueDepth() === 0)
    status = 200

    // 9. An unreachable server must not throw, and must not grow the queue past
    //    the cap. This is the "user on a plane" case.
    _resetTracking()
    process.env.ROXY_TRACK_ENDPOINT = 'http://127.0.0.1:1/track'
    initTracking()
    for (let i = 0; i < 100; i++) track('prompt')
    await flush()
    check('track: an unreachable endpoint never throws', true)
    check('track: the queue stays bounded offline', _queueDepth() <= 40, String(_queueDepth()))
    process.env.ROXY_TRACK_ENDPOINT = `http://127.0.0.1:${port}/track`

    // 10. A version change reports exactly one update event.
    await reset()
    await fs.writeFile(
      idFile,
      JSON.stringify({ deviceId: idA, enabled: true, appVersion: '0.0.0-old' }),
      'utf8'
    )
    initTracking()
    await settled(1)
    const names = batches[0]?.events?.map((e) => e.name) ?? []
    check(
      'track: a version change reports app_open + update',
      names.join(',') === 'app_open,update',
      names.join(',')
    )
    _resetTracking()
    batches = []
    hits = 0
    initTracking()
    await settled(1)
    check(
      'track: the update is not re-reported on the next launch',
      (batches[0]?.events ?? []).every((e) => e.name !== 'update')
    )

    // 10b. The rich turn summary.
    //
    // This is the event the whole product-metrics layer exists for, so the
    // assertions are about SHAPE and about what must never be in it. Driven
    // through the real collector rather than by hand-building props: that is
    // the difference between testing the wire format and testing the pipeline
    // that fills it.
    await reset()
    initTracking()
    await settled(1)
    _resetTurnMetrics()
    batches = []
    hits = 0

    beginTurn('sess-metrics')
    recordStep(
      'sess-metrics',
      'claude-sonnet-4-5',
      { input: 10_000, output: 500, cacheRead: 8000 },
      0.03
    )
    recordStep(
      'sess-metrics',
      'claude-sonnet-4-5',
      { input: 12_000, output: 300, cacheRead: 0 },
      0.02
    )
    recordTool('sess-metrics', 'bash', true)
    recordTool('sess-metrics', 'bash', false)
    recordTool('sess-metrics', 'mcp__acme_internal_billing__query', true)
    recordSubagent('sess-metrics')
    recordRetry('sess-metrics')
    recordTrim('sess-metrics')
    const done = finishTurn('sess-metrics', 'ok')
    check('metrics: a finished turn produces a summary', !!done)
    check('metrics: model steps are counted', done?.summary.steps === 2)
    check('metrics: tokens sum across steps', done?.summary.inputTokens === 22_000)
    check('metrics: cache reads are tracked separately', done?.summary.cacheReadTokens === 8000)
    check(
      'metrics: cost sums across steps',
      done?.summary.costUsd === 0.05,
      String(done?.summary.costUsd)
    )
    check(
      'metrics: tool calls and failures are counted',
      done?.summary.tools === 3 && done?.summary.toolErrors === 1
    )
    check('metrics: subagents are counted', done?.summary.subagents === 1)
    check('metrics: silent retries are counted', done?.summary.retries === 1)
    check('metrics: a context trim is flagged', done?.summary.trimmed === true)
    check('metrics: the model reports as a FAMILY', done?.summary.model === 'claude-sonnet')
    check('metrics: steps are also bucketed', done?.summary.stepBucket === '2-4')
    // The collector must not leak: a finished turn is removed, so a long-lived
    // process doesn't accumulate one entry per turn forever.
    check('metrics: finishing a turn frees its collector', _liveTurnCount() === 0)
    check(
      'metrics: finishing an unknown turn is null, not a crash',
      finishTurn('nope', 'ok') === null
    )
    // Per-tool counts come back separately, already collapsed.
    const byTool = Object.fromEntries((done?.toolCounts ?? []).map((t) => [t.tool, t]))
    check(
      'metrics: per-tool calls are counted',
      byTool.bash?.calls === 2 && byTool.bash?.errors === 1
    )
    check('metrics: an MCP tool is collapsed to `mcp`', !!byTool.mcp)
    check(
      'metrics: the MCP server name never reaches the summary',
      !JSON.stringify(done).includes('acme_internal_billing')
    )

    // ...and the same summary must survive the wire unchanged.
    track('turn_end', done!.summary)
    trackToolUse(done!.toolCounts)
    await flush()
    await settled(1)
    const sent = batches[0]?.events ?? []
    const turnEnd = sent.find((e) => e.name === 'turn_end')
    check(
      'track: turn_end round-trips its counters',
      turnEnd?.props?.steps === 2 && turnEnd?.props?.inputTokens === 22_000
    )
    check('track: turn_end carries the model family', turnEnd?.props?.model === 'claude-sonnet')
    const toolEvents = sent.filter((e) => e.name === 'tool_use')
    check(
      'track: one tool_use event per distinct tool',
      toolEvents.length === 2,
      String(toolEvents.length)
    )
    check(
      'track: no MCP server name is publishable',
      !JSON.stringify(batches).includes('acme_internal_billing')
    )
    // Busiest-first ordering matters: if a turn ever exceeds the per-turn cap,
    // the tools that survive must be the ones that actually ran.
    check('track: tool_use is ordered busiest-first', toolEvents[0]?.props?.tool === 'bash')

    // A failed turn carries a KIND, never the provider's message - which
    // routinely embeds a private URL or a partial key.
    batches = []
    hits = 0
    beginTurn('sess-fail')
    const failed = finishTurn('sess-fail', 'error', {
      status: 429,
      text: 'You exceeded your current quota at https://acme.internal/v1 (key sk-abc123)'
    })
    check('metrics: an out-of-quota 429 classifies as billing', failed?.errorKind === 'billing')
    track('turn_end', { ...failed!.summary, errorKind: failed!.errorKind! })
    await flush()
    await settled(1)
    const failEvent = batches[0]?.events?.[0]
    check('track: a failed turn reports its error KIND', failEvent?.props?.errorKind === 'billing')
    check(
      'track: the error message never reaches the wire',
      !JSON.stringify(batches).includes('acme.internal')
    )
    check(
      'track: an api key in an error never reaches the wire',
      !JSON.stringify(batches).includes('sk-abc123')
    )

    // Stop is a DIFFERENT fact from an error: one is usually the agent going
    // wrong (our problem), the other the provider (theirs). Flattening them
    // into `ok: false` is exactly what this split exists to prevent.
    beginTurn('sess-stop')
    const stopped = finishTurn('sess-stop', 'stopped')
    check('metrics: a stopped turn is not an error', stopped?.summary.outcome === 'stopped')
    check('metrics: ...but is still not ok', stopped?.summary.ok === false)
    check('metrics: a stopped turn has no errorKind', stopped?.errorKind === undefined)

    // 10c. Activation is once per install, EVER - it spans launches by
    //      definition, so an in-memory guard would re-report on every restart
    //      and turn a funnel into a launch counter.
    await reset()
    initTracking()
    await settled(1)
    batches = []
    hits = 0
    check('activation: the first report goes through', markActivation('first_prompt') === true)
    check('activation: a second report is suppressed', markActivation('first_prompt') === false)
    await flush()
    await settled(1)
    const activations = batches
      .flatMap((b) => b.events ?? [])
      .filter((e) => e.name === 'activation')
    check('activation: exactly one event was sent', activations.length === 1)
    check('activation: it names the milestone', activations[0]?.props?.milestone === 'first_prompt')
    // The part that matters: it must survive a restart.
    _resetTracking()
    initTracking()
    await settled(1)
    check('activation: a restart does not re-report it', markActivation('first_prompt') === false)
    check(
      'activation: a DIFFERENT milestone still reports',
      markActivation('first_turn_ok') === true
    )

    // 10d. Features are deduped per SESSION, not per install: "how many
    //      sessions use subagents" is the question, so re-reporting across
    //      sessions is correct and re-reporting within one is not.
    batches = []
    hits = 0
    trackFeature('sess-a', 'subagent')
    trackFeature('sess-a', 'subagent')
    trackFeature('sess-a', 'subagent')
    trackFeature('sess-b', 'subagent')
    trackFeature('sess-a', 'mcp_server')
    await flush()
    await settled(1)
    const features = batches.flatMap((b) => b.events ?? []).filter((e) => e.name === 'feature')
    check(
      'feature: one session reports a feature once',
      features.length === 3,
      String(features.length)
    )
    check(
      'feature: a second session reports it again',
      features.filter((e) => e.props?.feature === 'subagent').length === 2
    )

    // 11. The kill switch beats everything, including the stored preference.
    _resetTracking()
    process.env.ROXY_TRACK_DISABLE = '1'
    initTracking()
    hits = 0
    track('app_open')
    setTrackingEnabled(true)
    track('prompt')
    await flush()
    check('track: ROXY_TRACK_DISABLE cannot be re-enabled', isTrackingEnabled() === false)
    check('track: ROXY_TRACK_DISABLE sends nothing', hits === 0, `${hits} requests`)
    delete process.env.ROXY_TRACK_DISABLE

    // 12. Shutdown drains rather than dropping.
    await reset()
    initTracking()
    await settled(1)
    batches = []
    hits = 0
    shutdownTracking()
    await settled(1)
    check(
      'track: shutdown flushes app_close',
      batches.some((b) => b.events?.some((e) => e.name === 'app_close'))
    )

    // 13. A read-only profile degrades instead of crashing.
    _resetTracking()
    await fs.writeFile(idFile, 'not json at all{{{', 'utf8')
    initTracking()
    check('track: a corrupt id file does not crash the launch', isTrackingEnabled() === true)
    batches = []
    hits = 0
    await settled(1)
    check('track: a corrupt id file still reports', batches.length === 1)

    _resetTracking()
    await new Promise<void>((r) => server.close(() => r()))
    delete process.env.ROXY_TRACK_ENDPOINT
  } catch (e) {
    check('usage tracking', false, e instanceof Error ? e.message : String(e))
  }

  // ---- themes on disk (config-driven theming) ----
  //
  // shared.ts covers the pure logic (parsing, validation, resolution). What can
  // only be verified against a real filesystem is the part that decides whether
  // a hand-authored file actually reaches the UI: discovery, precedence between
  // roots, and the write/delete paths.
  try {
    const themesRoot = path.join(tmp, 'themes')

    // A theme authored by hand, in the folder layout the docs describe.
    await fs.mkdir(path.join(themesRoot, 'ocean'), { recursive: true })
    await fs.writeFile(
      path.join(themesRoot, 'ocean', 'theme.json'),
      JSON.stringify({
        id: 'ocean',
        name: 'Ocean',
        appearance: 'dark',
        colors: { bg: '#001018', accent: '#22d3ee' },
        fonts: { mono: 'Fira Code' }
      }),
      'utf8'
    )
    // The other accepted shape: a bare <id>.json dropped straight into a root.
    await fs.writeFile(
      path.join(themesRoot, 'plain.json'),
      JSON.stringify({ id: 'plain', name: 'Plain', colors: { bg: '#111' } }),
      'utf8'
    )
    // Junk must not take the scan down with it.
    await fs.writeFile(path.join(themesRoot, 'broken.json'), '{not json', 'utf8')

    refreshThemes()
    const listed = await listThemes()
    check(
      'themes: a hand-authored theme.json is discovered',
      listed.some((t) => t.id === 'ocean' && t.source === 'user'),
      listed.map((t) => t.id).join(',')
    )
    check(
      'themes: a bare <id>.json is discovered too',
      listed.some((t) => t.id === 'plain')
    )
    check(
      'themes: built-ins are always present and marked as such',
      listed.some((t) => t.id === 'roxy-dark' && t.source === 'builtin') &&
        listed.some((t) => t.id === 'roxy-light')
    )
    check(
      'themes: a malformed file is reported, not fatal',
      themeWarnings().some((w) => w.file.includes('broken.json')),
      JSON.stringify(themeWarnings())
    )
    check(
      'themes: the picker gets swatches to render',
      (listed.find((t) => t.id === 'ocean')?.swatches.bg ?? '') === '#001018'
    )

    // Resolution is what the renderer actually applies.
    const resolved = await resolveThemeById('ocean', 'win32')
    check(
      'themes: a user theme resolves to CSS custom properties',
      resolved.vars['--color-bg'] === '#001018' && resolved.vars['--color-accent'] === '#22d3ee',
      JSON.stringify(resolved.vars['--color-bg'])
    )
    check(
      'themes: tokens it never mentioned still come from the default',
      resolved.vars['--color-text'] === '#ededed'
    )
    check(
      'themes: a code font survives the round trip to disk',
      resolved.vars['--font-mono']?.includes('Fira Code') === true,
      String(resolved.vars['--font-mono'])
    )
    check(
      'themes: an unknown id falls back to the default rather than failing',
      (await resolveThemeById('does-not-exist', 'win32')).vars['--color-bg'] === '#0a0a0a'
    )

    // Writes.
    const created = await createTheme({ name: 'My Theme' })
    check('themes: create writes a new theme', created.ok && created.id === 'my-theme')
    check(
      'themes: the created file is on disk where the UI says it is',
      existsSync(path.join(themesRoot, 'my-theme', 'theme.json'))
    )
    const dup = await createTheme({ name: 'My Theme' })
    check(
      'themes: creating the same name twice does not overwrite the first',
      dup.ok && dup.id === 'my-theme-2',
      JSON.stringify(dup)
    )
    const fromBuiltin = await createTheme({ name: 'Light Copy', from: 'roxy-light' })
    const copied = fromBuiltin.ok ? await resolveThemeById(fromBuiltin.id, 'win32') : null
    check(
      'themes: duplicating a built-in copies its palette',
      copied?.vars['--color-bg'] === '#ffffff',
      JSON.stringify(copied?.vars['--color-bg'])
    )
    check(
      'themes: a duplicate keeps the polarity of what it copied',
      copied?.vars['--color-white'] === '#18181b',
      JSON.stringify(copied?.vars['--color-white'])
    )

    // A theme found OUTSIDE the app's own folder must be rewritten in place,
    // not forked into userData where the copy would shadow the original.
    const savedPlain = await writeTheme(
      JSON.stringify({ id: 'plain', name: 'Plain', colors: { bg: '#222' } }),
      { id: 'plain' }
    )
    check('themes: saving an existing theme succeeds', savedPlain.ok)
    check(
      'themes: a theme is rewritten where it was found, not duplicated',
      !existsSync(path.join(themesRoot, 'plain', 'theme.json')) &&
        JSON.parse(await fs.readFile(path.join(themesRoot, 'plain.json'), 'utf8')).colors.bg ===
          '#222'
    )

    check(
      'themes: a built-in id cannot be overwritten',
      !(await writeTheme(JSON.stringify({ id: 'roxy-dark', name: 'Hijack' }), { id: 'roxy-dark' }))
        .ok
    )
    check('themes: a built-in cannot be deleted', !(await deleteTheme('roxy-dark')).ok)

    const removed = await deleteTheme('my-theme')
    check('themes: delete removes a user theme', removed.ok)
    check('themes: its folder is gone from disk', !existsSync(path.join(themesRoot, 'my-theme')))
    refreshThemes()
    check(
      'themes: a deleted theme leaves the list',
      !(await listThemes()).some((t) => t.id === 'my-theme')
    )

    // A user file claiming a built-in id would make the default unreachable
    // from the picker, so it is refused at discovery.
    await fs.mkdir(path.join(themesRoot, 'roxy-dark'), { recursive: true })
    await fs.writeFile(
      path.join(themesRoot, 'roxy-dark', 'theme.json'),
      JSON.stringify({ id: 'roxy-dark', name: 'Impostor', colors: { bg: '#f00' } }),
      'utf8'
    )
    refreshThemes()
    const shadowed = await listThemes()
    check(
      'themes: a user theme cannot shadow a built-in id',
      shadowed.filter((t) => t.id === 'roxy-dark').length === 1 &&
        shadowed.find((t) => t.id === 'roxy-dark')?.source === 'builtin',
      JSON.stringify(shadowed.filter((t) => t.id === 'roxy-dark'))
    )
    check(
      'themes: the default still resolves to its real palette',
      (await resolveThemeById('roxy-dark', 'win32')).vars['--color-bg'] === '#0a0a0a'
    )

    // The active theme is persisted as an id only.
    repo.setActiveThemeId('ocean')
    check(
      'themes: the active id persists in settings',
      repo.getSettings().activeThemeId === 'ocean'
    )
    repo.setActiveThemeId(null)
    check('themes: clearing it returns to the default', repo.getSettings().activeThemeId === null)
  } catch (e) {
    check('themes', false, e instanceof Error ? e.message : String(e))
  }

  // ---- native window chrome (the OS-drawn window controls) ----
  //
  // The minimise / maximise / close buttons are painted by the OS ABOVE the
  // page, so no stylesheet reaches them. Getting this wrong is very visible --
  // a dark block in the corner of a light theme -- and it cannot be caught by
  // the CSS-level tests, so the colour derivation is pinned here.
  try {
    const dark = await resolveThemeById('roxy-dark', 'win32')
    const light = await resolveThemeById('roxy-light', 'win32')

    check(
      'chrome: the overlay is transparent, never a flat colour',
      initialOverlay(48).color === 'rgba(1, 0, 0, 0)',
      String(initialOverlay(48).color)
    )
    // electron#51014: a FULLY transparent black silently falls back to the
    // default opaque frame colour, which is the exact bug being fixed.
    check(
      'chrome: the overlay avoids the rgba(0,0,0,0) fallback bug',
      initialOverlay(48).color !== 'rgba(0, 0, 0, 0)'
    )
    check(
      'chrome: the overlay height matches the app header',
      initialOverlay(OVERLAY_HEIGHT.main).height === 48 &&
        initialOverlay(OVERLAY_HEIGHT.browser).height === 40
    )
    // The glyphs are the one part still painted by the OS, so they must track
    // the theme or they go invisible on one polarity.
    check(
      'chrome: control glyphs follow the theme text colour',
      symbolColorFor(dark) === '#9a9aa3' && symbolColorFor(light) === '#5c5c66',
      symbolColorFor(dark) + ' / ' + symbolColorFor(light)
    )
    check(
      'chrome: the pre-paint background follows the theme',
      backgroundColorFor(dark) === '#0a0a0a' && backgroundColorFor(light) === '#ffffff',
      backgroundColorFor(dark) + ' / ' + backgroundColorFor(light)
    )
    // The OS parses these itself and understands only literal colours.
    check(
      'chrome: never hands the OS a var() or color-mix() it cannot parse',
      [symbolColorFor(dark), symbolColorFor(light), backgroundColorFor(dark)].every(
        (c) => !c.includes('var(') && !c.includes('color-mix')
      )
    )
    check(
      'chrome: applying to a destroyed window is a no-op, not a crash',
      (() => {
        const w = new BrowserWindow({ show: false })
        w.destroy()
        applyWindowChrome(w, dark)
        return true
      })()
    )
    check(
      'chrome: a window with no overlay is tolerated',
      (() => {
        // Constructed WITHOUT titleBarOverlay: setTitleBarOverlay throws here,
        // and that must not take a theme change down with it.
        const w = new BrowserWindow({ show: false })
        applyWindowChrome(w, light)
        w.destroy()
        return true
      })()
    )
  } catch (e) {
    check('chrome', false, e instanceof Error ? e.message : String(e))
  }

  closeDb()
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
}

// Mirror src/main/index.ts: the MCP App sandbox scheme's privileges are locked
// in at app-ready, so registration has to happen before it. Without this the
// smoke process cannot load the sandbox origin at all - which is a property of
// THIS harness, not of the product.
registerSandboxScheme()

app.whenReady().then(async () => {
  serveSandbox()
  console.log('roxy runtime smoke test\n')
  // Watchdog so an overnight run can never hang.
  //
  // Overridable because 60s is a budget for the WHOLE suite, not any one check,
  // and it is spent mostly on spawning `git`. On a slow or loaded machine the
  // run gets guillotined mid-suite, which reads as a failing test but is really
  // just a clock - so the number has to be raisable without editing this file.
  const budgetMs = Number(process.env.SMOKE_TIMEOUT_MS) || 60_000
  const watchdog = setTimeout(() => {
    console.error(`\nSMOKE TIMEOUT (${Math.round(budgetMs / 1000)}s)`)
    app.exit(2)
  }, budgetMs)
  watchdog.unref?.()

  try {
    await main()
  } catch (e) {
    fails.push('fatal: ' + (e instanceof Error ? e.message : String(e)))
    console.error('\nFATAL', e)
  } finally {
    clearTimeout(watchdog)
    const ok = fails.length === 0
    console.log(
      ok
        ? `\nSMOKE OK \u2014 ${pass} checks passed`
        : `\nSMOKE FAILED \u2014 ${fails.length} failing: ${fails.join(', ')}`
    )
    // Short drain delay so the summary flushes before app.exit tears down.
    setTimeout(() => app.exit(ok ? 0 : 1), 150)
  }
})
