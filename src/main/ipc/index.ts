import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { CHANNELS } from '../../shared/ipc'
import type { SessionConfigPatch } from '../../shared/session-config'
import type { ClipboardAction } from '../../shared/context-menu'
import { clipboardHasContent, runClipboardAction } from '../services/context-menu'
import type {
  CookieRow,
  CreateChatInput,
  CreateLoopInput,
  CreateWorktreeInput,
  CreateWorktreeResult,
  ForkChatInput,
  GitStatusView,
  MultiSyncOutcome,
  RepoStatusView,
  RepoSyncResult,
  LlmStartInput,
  McpServerView,
  RemoteStartInput,
  SkillView,
  SkillWriteInput,
  SyncOutcome,
  UpsertMcpServerInput
} from '../../shared/api'
import type {
  AddMessageInput,
  ConnectProviderInput,
  QueueImage,
  ReasoningEffort
} from '../../shared/types'
import * as repo from '../db/repo'
import * as copilot from '../services/copilot'
import * as cliproxy from '../services/cliproxy'
import * as browser from '../services/browser'
import * as cookies from '../services/cookies'
import { listModels } from '../services/models'
import { pickDefaultModel } from '../../shared/models'
import { CLIPROXY_PROVIDER_IDS, accountsFor, isCliProxyProvider } from '../../shared/cliproxy'
import { getUsageStats } from '../services/usage'
import { getActivityStats } from '../services/activity'
import { compactChat } from '../services/compaction'
import {
  runTool,
  projectInstructions,
  killSessionBackground,
  listServices,
  serviceOutput,
  stopService,
  restartService
} from '../harness'
import { sessionCwd, discoverRepos } from '../services/workspace'
import nodePath from 'node:path'
import * as git from '../services/git'
import * as forge from '../services/forge'
import type { ForgeKind } from '../../shared/forge'
import { pruneWorktrees, removeWorktreeForChat, renameWorkstreamBranch } from '../services/worktree'
import { checkForUpdates, quitAndInstall, getUpdateState } from '../services/updater'
import {
  cancelBackgroundJob,
  cancelSessionBackgroundJobs,
  listRunningBackgroundJobs
} from '../services/background-tasks'
import {
  endSubagentRuns,
  listRunningSubagents,
  setViewedSubChat,
  subagentSnapshot,
  cancelSubagentRun,
  cancelSubagentRunsFor
} from '../services/subagent-stream'
import { cancelToolCall, cancelToolCallsFor } from '../services/tool-runs'
import { mcpServerSummaries, reconnectMcpServer, disposeConnection } from '../services/mcp'
import {
  listSkills,
  refreshSkills,
  readSkill,
  writeSkill,
  deleteSkill,
  installSkillFromSource
} from '../services/skills'
import { runSessionTurn } from '../services/session-turn'
import {
  isTrackingEnabled,
  markActivation,
  setTrackingEnabled,
  track,
  trackFeature
} from '../services/track'
import * as remote from '../services/remote'
import { buildExport, applyImport } from '../services/portable'
import { promises as fsp } from 'node:fs'
import { BUNDLE_FILENAME } from '../../shared/portable'

/** In-flight streamed completions, keyed by requestId, so they can be aborted. */
const llmControllers = new Map<string, AbortController>()

/**
 * Every abortable piece of model work a SESSION currently owns.
 *
 * `llmControllers` alone was not enough for Stop to be reliable. The renderer
 * only learns a requestId once the turn is actually starting, and real work
 * happens before that â€” most of all compaction, which is a full model call on a
 * long history and used to run with a hardcoded never-aborted signal. Stop
 * during that window found no requestId and silently did nothing, which is a
 * large part of why the button felt stuck.
 *
 * Keyed by session id (the one handle the UI always has) and holding a SET,
 * because a session can legitimately have more than one thing in flight.
 */
const sessionControllers = new Map<string, Set<AbortController>>()

/** Track a controller against its session; returns the matching untrack. */
function trackSession(sessionId: string | undefined, controller: AbortController): () => void {
  if (!sessionId) return () => {}
  let set = sessionControllers.get(sessionId)
  if (!set) {
    set = new Set()
    sessionControllers.set(sessionId, set)
  }
  set.add(controller)
  return () => {
    const live = sessionControllers.get(sessionId)
    if (!live) return
    live.delete(controller)
    // Drop the empty set rather than leaving it: this map is keyed by session id
    // and would otherwise grow one entry per session for the app's lifetime.
    if (live.size === 0) sessionControllers.delete(sessionId)
  }
}

/** Abort everything in flight for a session (its turn, and any compaction). */
function abortSession(sessionId: string): void {
  for (const controller of sessionControllers.get(sessionId) ?? []) controller.abort()
}

/** Merge persisted MCP server rows with their live connection status for the UI. */
function listMcpServersWithStatus(): McpServerView[] {
  const statusById = new Map(mcpServerSummaries().map((s) => [s.id, s]))
  return repo.listMcpServers().map((rec) => {
    const live = statusById.get(rec.id)
    return {
      id: rec.id,
      config: rec.config,
      enabled: rec.enabled,
      status: live?.status ?? 'disabled',
      tools: live?.tools ?? [],
      error: live?.error
    }
  })
}

/**
 * Discover skills for the Skills page. With no cwd we scan the user's global
 * skill roots (~/.roxy/skills etc.); a workspace path additionally surfaces that
 * project's skills. Returns metadata only (bodies load on demand via the tool).
 */
async function discoverSkillViews(cwd?: string): Promise<SkillView[]> {
  const base = cwd || app.getPath('home')
  const skills = await listSkills(base)
  return skills.map(({ name, description, location, source }) => ({
    name,
    description,
    location,
    source
  }))
}

/**
 * Register every IPC handler. Each maps 1:1 to a method on the `window.roxy`
 * bridge declared in src/preload/index.ts. Add agent capabilities by adding a
 * channel here + a matching bridge method.
 */
export function registerIpc(): void {
  // ---- settings ----
  ipcMain.handle(CHANNELS.settingsGetAll, () => repo.getSettings())
  ipcMain.handle(
    CHANNELS.settingsSetActiveProvider,
    (_e, providerId: string, model: string | null) => repo.setActiveProvider(providerId, model)
  )
  ipcMain.handle(CHANNELS.settingsSetActiveAgent, (_e, agentId: string) =>
    repo.setActiveAgent(agentId)
  )
  ipcMain.handle(CHANNELS.settingsSetReasoningEffort, (_e, level: ReasoningEffort) =>
    repo.setReasoningEffort(level)
  )
  ipcMain.handle(CHANNELS.settingsSetContextLimit, (_e, limit: number | null) =>
    repo.setContextLimit(limit)
  )
  ipcMain.handle(CHANNELS.settingsSetAutoWorkstream, (_e, enabled: boolean) =>
    repo.setAutoWorkstream(enabled)
  )
  ipcMain.handle(CHANNELS.settingsSetBranchPrefix, (_e, prefix: string) =>
    repo.setBranchPrefix(prefix)
  )
  ipcMain.handle(CHANNELS.settingsSetWebSearchApiKey, (_e, key: string | null) =>
    repo.setWebSearchApiKey(key)
  )
  ipcMain.handle(CHANNELS.settingsCompleteOnboarding, () => repo.completeOnboarding())
  ipcMain.handle(CHANNELS.settingsReset, async () => {
    // "Wipes all providers" has to include the subscription tokens held by the
    // sidecar, which resetAll() can't see - they aren't in the database. Every
    // sidecar-backed provider has to be named: disconnecting one now leaves the
    // other's tokens in place (by design), so a single call would quietly spare
    // whichever subscription wasn't mentioned.
    for (const id of CLIPROXY_PROVIDER_IDS) {
      await cliproxy.disconnect(id).catch(() => undefined)
    }
    return repo.resetAll()
  })

  // Telemetry lives outside the settings table (see services/track), so it gets
  // its own handlers instead of riding along on AppSettings.
  ipcMain.handle(CHANNELS.settingsGetTelemetry, () => isTrackingEnabled())
  ipcMain.handle(CHANNELS.settingsSetTelemetry, (_e, enabled: boolean) =>
    setTrackingEnabled(enabled)
  )

  // ---- providers ----
  ipcMain.handle(CHANNELS.providersList, () => repo.listConnectedProviders())
  ipcMain.handle(CHANNELS.providersConnect, (_e, input: ConnectProviderInput) => {
    const connected = repo.connectProvider(input)
    // "What did people set up" is a different question from "what did they end
    // up using", and the gap between the two is where broken onboarding hides -
    // a provider connected far more often than it serves a prompt is one whose
    // auth flow half-works. The id goes through the same seed allow-list as
    // every other provider field.
    track('provider_connect', { provider: input.id })
    markActivation('provider_connected')
    return connected
  })
  ipcMain.handle(CHANNELS.providersDisconnect, async (_e, id: string) => {
    // A subscription provider's credential lives in the sidecar, not in
    // `credentials` - so dropping the row alone would leave the OAuth tokens on
    // disk and the proxy running. Sign out first, then remove the row. The
    // sidecar keeps running if the OTHER subscription is still signed in.
    if (isCliProxyProvider(id)) await cliproxy.disconnect(id)
    return repo.disconnectProvider(id)
  })
  ipcMain.handle(CHANNELS.providersReorder, (_e, ids: string[]) => repo.reorderProviders(ids))

  // ---- chats ----
  ipcMain.handle(CHANNELS.chatsList, () => repo.listChats())
  ipcMain.handle(CHANNELS.chatsCreate, (_e, input?: CreateChatInput) => repo.createChat(input))
  ipcMain.handle(CHANNELS.chatsFork, async (_e, id: string, input?: ForkChatInput) => {
    const source = repo.getChat(id)
    if (!source) throw new Error('Chat not found')

    // The fork's CODE has to match the transcript it inherits. If the source runs
    // in a workstream, the fork gets its own worktree branched off the commit
    // that workstream is sitting on RIGHT NOW - not off origin/main, which would
    // hand the copy a history describing files that aren't in its checkout.
    //
    // Read through the ROOT session: a subagent owns no worktree of its own but
    // works inside its parent's, and forking one is a normal thing to want (it
    // is often where the interesting exploration happened).
    //
    // A source with no worktree at all - auto-workstream off, or a folder that
    // isn't a repo - forks in place and shares the project checkout, exactly as
    // the source does. Inventing an isolated tree for the copy would put it
    // somewhere the user's editor isn't.
    //
    // A source whose workstream is still PENDING (created but never run) counts:
    // it will get a tree on its first turn, and a fork that quietly opted out of
    // one would then be editing the project folder its parent is about to stop
    // using. There is no commit to inherit yet - both will branch off the
    // default - so the baseRef is simply absent, not wrong.
    const root = repo.getChat(repo.rootSessionId(id))
    const wantsWorktree =
      input?.worktree !== false && !!(root?.worktreePath || root?.worktreePending)
    const baseRef = root?.worktreePath
      ? await git.resolveCommit(sessionCwd(id)).catch(() => null)
      : null

    const chat = repo.forkChat(id, { title: input?.title })
    // Forking is a power-user move (branch a conversation at a decision point),
    // so its adoption says something about how deeply people work in Roxy.
    // Keyed by the NEW session, which is the one whose life just began.
    trackFeature(chat.id, 'fork')
    if (!wantsWorktree) return chat
    // Parked, not created: like any new session, the worktree is materialized on
    // the first turn, so a fork that is opened and abandoned costs nothing.
    repo.setChatWorktreePending(chat.id, { mode: 'new', ...(baseRef ? { baseRef } : {}) })
    return repo.getChat(chat.id) ?? chat
  })
  ipcMain.handle(CHANNELS.chatsRename, (_e, id: string, title: string) =>
    repo.renameChat(id, title)
  )
  ipcMain.handle(CHANNELS.chatsSetConfig, (_e, id: string, patch: SessionConfigPatch) =>
    repo.setChatConfig(id, patch)
  )
  ipcMain.handle(CHANNELS.chatsRemove, (_e, id: string) => {
    // Cancel any background subagents this session launched before it's deleted,
    // so detached work doesn't keep running against a gone parent.
    cancelSessionBackgroundJobs(id)
    // Drop any live subagent stream for this session (and, when a parent goes,
    // for its delegates too). The run itself is cancelled above or dies with the
    // parent turn; this just stops a gone session pinning a registry entry that
    // would keep broadcasting to a chat view nobody can open.
    endSubagentRuns(id)
    // Stop this session's background processes (dev servers, watchers). Every
    // process is registered under a ROOT session id, so passing `id` raw does the
    // right thing both ways: deleting a main session also stops the servers its
    // subagents started, while deleting a sub session matches nothing and leaves
    // its parent's servers alone. Without this they'd live until app quit.
    killSessionBackground(id)
    // Close this session's browser window (if any) so it doesn't linger orphaned.
    browser.disposeSession(id)
    // Remove this session's worktree, if it owns one no other session shares.
    // Fire-and-forget: deletion must never block on git, so a failure here is
    // logged and the session goes anyway (`git:prune-worktrees` sweeps up
    // whatever is left behind). It re-kills the session's processes internally
    // and awaits them â€” the ordering that keeps removal working on Windows.
    void removeWorktreeForChat(id).then(
      (r) => {
        if (!r.ok && r.error) console.warn('[worktree] remove on delete failed:', r.error)
      },
      (e) => console.warn('[worktree] remove on delete threw:', e)
    )
    return repo.removeChat(id)
  })
  ipcMain.handle(CHANNELS.chatsReorder, (_e, workspacePath: string | null, ids: string[]) =>
    repo.reorderSessions(workspacePath, ids)
  )

  // ---- projects (workspace display order) ----
  ipcMain.handle(CHANNELS.projectsListOrder, () => repo.listProjectOrder())
  ipcMain.handle(CHANNELS.projectsReorder, (_e, paths: string[]) => repo.reorderProjects(paths))

  // ---- messages ----
  ipcMain.handle(CHANNELS.messagesList, (_e, chatId: string) => repo.listMessages(chatId))
  ipcMain.handle(CHANNELS.messagesAdd, (_e, input: AddMessageInput) => repo.addMessage(input))

  // ---- integrations ----
  ipcMain.handle(CHANNELS.integrationsList, () => repo.listIntegrations())
  ipcMain.handle(CHANNELS.integrationsSetEnabled, (_e, id: string, enabled: boolean) =>
    repo.setIntegrationEnabled(id, enabled)
  )

  // ---- MCP servers (Phase 13) ----
  ipcMain.handle(CHANNELS.mcpList, () => listMcpServersWithStatus())
  ipcMain.handle(CHANNELS.mcpUpsert, (_e, input: UpsertMcpServerInput) => {
    repo.upsertMcpServer(input)
    return listMcpServersWithStatus()
  })
  ipcMain.handle(CHANNELS.mcpRemove, async (_e, id: string) => {
    await disposeConnection(id)
    repo.deleteMcpServer(id)
    return listMcpServersWithStatus()
  })
  ipcMain.handle(CHANNELS.mcpSetEnabled, async (_e, id: string, enabled: boolean) => {
    repo.setMcpServerEnabled(id, enabled)
    // Disabling should immediately tear down the live connection; enabling connects
    // lazily on the next agent turn (or via an explicit reconnect).
    if (!enabled) await disposeConnection(id)
    return listMcpServersWithStatus()
  })
  ipcMain.handle(CHANNELS.mcpReconnect, async (_e, id: string) => {
    const rec = repo.listMcpServers().find((r) => r.id === id)
    if (rec) await reconnectMcpServer(rec, app.getPath('home'))
    return listMcpServersWithStatus()
  })

  // ---- skills (SKILL.md discovery) ----
  ipcMain.handle(CHANNELS.skillsList, (_e, cwd?: string) => discoverSkillViews(cwd))
  ipcMain.handle(CHANNELS.skillsRefresh, (_e, cwd?: string) => {
    refreshSkills(cwd || undefined)
    return discoverSkillViews(cwd)
  })
  ipcMain.handle(CHANNELS.skillsRead, async (_e, name: string, cwd?: string) => {
    const skill = await readSkill(name, cwd || app.getPath('home'))
    if (!skill) return null
    const { name: n, description, location, source, content } = skill
    return { name: n, description, location, source, body: content }
  })
  // The Skills page has no workspace context, so it authors GLOBAL skills by
  // default (~/.roxy/skills); the agent's `skill_manage` tool can target either
  // scope. Both go through the same writeSkill/deleteSkill service.
  ipcMain.handle(CHANNELS.skillsCreate, async (_e, input: SkillWriteInput, cwd?: string) => {
    await writeSkill({ ...input, scope: input.scope ?? 'global' }, cwd || '', { mode: 'create' })
    return discoverSkillViews(cwd)
  })
  ipcMain.handle(CHANNELS.skillsUpdate, async (_e, input: SkillWriteInput, cwd?: string) => {
    await writeSkill({ ...input, scope: input.scope ?? 'global' }, cwd || '', { mode: 'edit' })
    return discoverSkillViews(cwd)
  })
  ipcMain.handle(CHANNELS.skillsRemove, async (_e, name: string, cwd?: string) => {
    await deleteSkill(name, cwd || '')
    return discoverSkillViews(cwd)
  })
  // Install skill(s) from a remote source (GitHub repo/URL or a direct SKILL.md).
  // The Skills page has no workspace context, so it installs GLOBAL skills; the
  // agent's `skill_manage` install action can target the workspace.
  ipcMain.handle(CHANNELS.skillsInstall, async (_e, source: string, cwd?: string) => {
    const res = await installSkillFromSource(source, {
      scope: cwd ? 'workspace' : 'global',
      cwd: cwd || undefined
    })
    return {
      ok: res.ok,
      installed: res.installed.map(({ name, location }) => ({ name, location })),
      skipped: res.skipped,
      error: res.error,
      skills: await discoverSkillViews(cwd)
    }
  })

  // ---- system ----
  ipcMain.handle(CHANNELS.systemGetVersions, () => ({
    app: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  }))

  // ---- clipboard / right-click editing menu ----
  //
  // The menu is drawn in the renderer (themed, portalled) but the two things it
  // needs from the OS live here: whether Paste has anything to offer, and the
  // commands themselves. Both act on `event.sender`, so a call from the app
  // window and one from the browser chrome each hit their own webContents
  // rather than a guessed "focused window".
  ipcMain.handle(CHANNELS.clipboardHasContent, () => clipboardHasContent())
  ipcMain.handle(CHANNELS.clipboardExec, (event, action: ClipboardAction, linkUrl?: string) =>
    runClipboardAction(event.sender, action, linkUrl)
  )

  // ---- auto-update (GitHub Releases) ----
  ipcMain.handle(CHANNELS.updateCheck, () => checkForUpdates())
  ipcMain.handle(CHANNELS.updateInstall, () => quitAndInstall())
  ipcMain.handle(CHANNELS.updateGetState, () => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    state: getUpdateState()
  }))
  ipcMain.handle(CHANNELS.systemOpenExternal, async (_e, url: string) => {
    // Only allow web URLs â€” never file:, javascript:, or other schemes.
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        await shell.openExternal(url)
      }
    } catch {
      // ignore malformed URLs
    }
  })

  // ---- github copilot device flow ----
  ipcMain.handle(CHANNELS.copilotStart, () => copilot.startDeviceFlow())
  ipcMain.handle(CHANNELS.copilotPoll, async (_e, deviceCode: string, interval: number) => {
    const token = await copilot.pollForToken(deviceCode, interval)
    const provider = repo.storeCopilotCredential(token)
    repo.setActiveProvider(provider.id, provider.defaultModel ?? null)
    return provider
  })

  // ---- subscription providers (CLIProxyAPI sidecar) ----
  // The renderer drives one high-level `login` rather than the individual
  // install/start/auth-url/poll steps: every one of them can fail, and the panel
  // has nothing useful to do with a partial success except retry the whole
  // thing. Progress reaches the UI through `cliproxy:state` pushes instead.
  //
  // Every call carries a provider id. One sidecar process serves both ChatGPT
  // and Gemini, so "which subscription" is never inferable from the process.
  ipcMain.handle(CHANNELS.cliproxyStatus, () => cliproxy.status())
  ipcMain.handle(CHANNELS.cliproxyLogin, async (_e, providerId: string) => {
    try {
      const { url, state } = await cliproxy.startLogin(providerId)
      await shell.openExternal(url)
      const result = await cliproxy.pollLogin(state)
      if (result.ok) {
        // Register the provider only once a credential actually exists, so a
        // cancelled sign-in never leaves a connected-but-dead provider row.
        const base = cliproxy.baseUrl()
        if (base) {
          const provider = repo.storeCliProxyProvider(
            providerId,
            base,
            await cliproxy.localApiKey()
          )
          // Make it the active provider with its newest model, mirroring what
          // connecting any other provider does.
          const models = await listModels(provider.id)
          repo.setActiveProvider(provider.id, pickDefaultModel(models) ?? null)
        }
      }
      return result
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        accounts: (await cliproxy.status()).accounts
      }
    }
  })
  ipcMain.handle(CHANNELS.cliproxySignOut, async (_e, providerId: string, file: string) => {
    await cliproxy.signOut(file)
    const next = await cliproxy.status()
    // THIS provider's last account just went: it can no longer serve a request,
    // so drop its row rather than leave a dead entry in the picker. Scoped by
    // provider - the other subscription's accounts are none of its business.
    if (accountsFor(next, providerId).length === 0) repo.disconnectProvider(providerId)
    return next
  })
  ipcMain.handle(CHANNELS.cliproxyStop, () => cliproxy.stop())
  ipcMain.handle(CHANNELS.cliproxyInstallFile, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const filters = [
      { name: 'CLIProxyAPI release', extensions: process.platform === 'win32' ? ['zip'] : ['gz'] }
    ]
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openFile'], filters })
      : await dialog.showOpenDialog({ properties: ['openFile'], filters })
    if (result.canceled || result.filePaths.length === 0) return cliproxy.status()
    return cliproxy.installFromFile(result.filePaths[0])
  })

  // ---- dialogs ----
  ipcMain.handle(CHANNELS.dialogOpenWorkspace, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: 'Open a workspace folder',
      properties: ['openDirectory', 'createDirectory'] as const
    }
    const result = win
      ? await dialog.showOpenDialog(win, { ...options, properties: [...options.properties] })
      : await dialog.showOpenDialog({ ...options, properties: [...options.properties] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // ---- portable config (export/import global skills + MCP servers) ----
  // Export builds the bundle, then a native Save dialog picks the destination;
  // import reads a file via an Open dialog and applies it. Both degrade to a
  // structured result (never throw), and treat a cancelled dialog as a no-op.
  ipcMain.handle(CHANNELS.configExport, async (event) => {
    const built = await buildExport()
    const win = BrowserWindow.fromWebContents(event.sender)
    const opts = {
      title: 'Export Roxy config',
      defaultPath: BUNDLE_FILENAME,
      filters: [{ name: 'Roxy config', extensions: ['json'] }]
    }
    const result = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (result.canceled || !result.filePath) {
      return {
        ok: false,
        skills: built.skills,
        mcpServers: built.mcpServers,
        summary: built.summary
      }
    }
    try {
      await fsp.writeFile(result.filePath, built.text, 'utf8')
    } catch (e) {
      return {
        ok: false,
        skills: built.skills,
        mcpServers: built.mcpServers,
        summary: built.summary,
        error: (e as Error).message
      }
    }
    return {
      ok: true,
      path: result.filePath,
      skills: built.skills,
      mcpServers: built.mcpServers,
      summary: built.summary
    }
  })
  ipcMain.handle(CHANNELS.configImport, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const opts = {
      title: 'Import Roxy config',
      properties: ['openFile'] as const,
      filters: [{ name: 'Roxy config', extensions: ['json'] }]
    }
    const result = win
      ? await dialog.showOpenDialog(win, { ...opts, properties: [...opts.properties] })
      : await dialog.showOpenDialog({ ...opts, properties: [...opts.properties] })
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, cancelled: true, skills: [], mcpServers: [], skipped: [], summary: '' }
    }
    let text: string
    try {
      text = await fsp.readFile(result.filePaths[0], 'utf8')
    } catch (e) {
      return {
        ok: false,
        skills: [],
        mcpServers: [],
        skipped: [],
        summary: '',
        error: (e as Error).message
      }
    }
    return applyImport(text)
  })

  // ---- loops ----
  ipcMain.handle(CHANNELS.loopsList, () => repo.listLoops())
  ipcMain.handle(CHANNELS.loopsCreate, (_e, input: CreateLoopInput) => repo.createLoop(input))
  ipcMain.handle(CHANNELS.loopsSetEnabled, (_e, id: string, enabled: boolean) =>
    repo.setLoopEnabled(id, enabled)
  )
  ipcMain.handle(CHANNELS.loopsRemove, (_e, id: string) => repo.removeLoop(id))

  // ---- tools ----
  ipcMain.handle(
    CHANNELS.toolsRun,
    async (_e, sessionId: string, name: string, input: Record<string, unknown>) => {
      // Same cwd the agent turn would use (worktree-aware), so a manual tool
      // card and the agent never operate on different trees.
      const cwd = sessionCwd(sessionId)
      // Browser & loop tools don't need a workspace; file/bash tools do.
      const needsWorkspace = !name.startsWith('browser_') && !name.startsWith('loop_')
      if (!cwd && needsWorkspace) {
        return { ok: false, output: 'No workspace is open for this session.' }
      }
      return runTool(name, input ?? {}, { cwd: cwd ?? '', sessionId })
    }
  )
  // Cancel one in-flight tool call without touching the turn around it. The call
  // unwinds through its own exit path (see cancelToolCall), which is what keeps
  // the model's tool_calls -> role:'tool' pairing intact, so there is nothing to
  // clean up here.
  ipcMain.handle(CHANNELS.toolsCancel, (_e, callId: string) => cancelToolCall(callId))

  // ---- queue ----
  // Each mutation re-mirrors the shared queue to any paired phone (remote is a
  // no-op when nothing is shared), so desktop-side edits stay in sync on both ends.
  ipcMain.handle(CHANNELS.queueList, (_e, chatId: string) => repo.listQueue(chatId))
  ipcMain.handle(
    CHANNELS.queueAdd,
    (_e, chatId: string, content: string, images?: QueueImage[]) => {
      const item = repo.enqueue(chatId, content, images)
      remote.notifyQueueChanged()
      return item
    }
  )
  ipcMain.handle(CHANNELS.queueRemove, (_e, id: string) => {
    repo.removeQueueItem(id)
    remote.notifyQueueChanged()
  })
  ipcMain.handle(CHANNELS.queueReorder, (_e, chatId: string, ids: string[]) => {
    repo.reorderQueue(chatId, ids)
    remote.notifyQueueChanged()
  })
  ipcMain.handle(CHANNELS.queueUpdate, (_e, id: string, content: string, images?: QueueImage[]) => {
    const item = repo.updateQueueItem(id, content, images)
    remote.notifyQueueChanged()
    return item
  })

  // ---- usage / cost dashboard ----
  ipcMain.handle(CHANNELS.usageStats, () => getUsageStats())

  // ---- activity (Settings contribution graph) ----
  ipcMain.handle(CHANNELS.activityStats, () => getActivityStats())

  // ---- llm (streamed model completions) ----
  // The turn body lives in runSessionTurn so the remote host (phone-driven)
  // path runs the exact same code. Here we just own the AbortController (for
  // llm:abort) and stream each event to the renderer that started the turn.
  ipcMain.handle(CHANNELS.llmStart, async (event, input: LlmStartInput) => {
    const controller = new AbortController()
    llmControllers.set(input.requestId, controller)
    const untrack = trackSession(input.sessionId, controller)
    // Stop can be pressed in the gap between the renderer asking for the turn
    // and this handler running. `abortSession` would have found nothing to
    // abort, so honour a stop that already landed for this session.
    if (controller.signal.aborted) {
      llmControllers.delete(input.requestId)
      untrack()
      return { ok: false, error: 'Stopped.' }
    }
    // If this session is shared to a phone, relay the turn there too so the phone
    // streams a desktop-typed reply live (the mirror of a phone turn on the PC).
    // The current prompt is the last user message; announce it so the phone shows
    // the bubble it never echoed. `null` when nothing's shared â†’ zero overhead.
    const lastUser = [...input.messages].reverse().find((m) => m.role === 'user')
    const relay = remote.relayLocalTurnStart(input.sessionId, lastUser?.content)
    try {
      return await runSessionTurn(
        input,
        (llmEvent) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send(CHANNELS.llmDelta, { requestId: input.requestId, event: llmEvent })
          }
          if (relay) remote.relayLocalTurnEvent(relay, llmEvent)
        },
        controller.signal
      )
    } finally {
      llmControllers.delete(input.requestId)
      untrack()
      if (relay) remote.relayLocalTurnEnd(relay)
    }
  })
  ipcMain.handle(CHANNELS.llmAbort, (_e, requestId: string) => {
    llmControllers.get(requestId)?.abort()
  })
  // Stop, as the UI means it: end everything this session has in flight,
  // whatever stage it's at. Also cancels the session's delegates â€” stopping a
  // turn while it waits on a subagent has to stop the subagent, or the work
  // carries on invisibly after the transcript says it stopped.
  ipcMain.handle(CHANNELS.llmAbortSession, (_e, sessionId: string) => {
    abortSession(sessionId)
    cancelSubagentRunsFor(sessionId)
    // Belt and braces: the turn's own signal already cascades into every call's
    // controller, so this is normally a no-op. It matters for a call registered
    // by work that ISN'T the tracked turn (compaction, a loop tick), which would
    // otherwise keep running with nobody left to read its result.
    cancelToolCallsFor(sessionId)
  })

  // ---- background subagent tasks (Phase 11) ----
  ipcMain.handle(CHANNELS.tasksListRunning, (_e, sessionId: string) =>
    listRunningBackgroundJobs(sessionId)
  )
  ipcMain.handle(CHANNELS.tasksCancel, (_e, jobId: string) => cancelBackgroundJob(jobId))

  // ---- subagent live sessions ----
  // A subagent's own session streams like any other chat: `subagent:delta` is
  // pushed to every window (the run outlives the launching request, so it can't
  // ride the requestId-keyed llm:delta channel), and these two reads let a window
  // that opens mid-run, or reloads entirely, catch up instead of showing a stale
  // prompt with no reply.
  ipcMain.handle(CHANNELS.subagentSnapshot, (_e, subChatId: string) => subagentSnapshot(subChatId))
  ipcMain.handle(CHANNELS.subagentListRunning, () => listRunningSubagents())
  ipcMain.handle(CHANNELS.subagentSetViewed, (_e, chatId: string | null) =>
    setViewedSubChat(chatId)
  )
  // Cancel one delegate without stopping the turn that launched it. The run
  // tears itself down through its own exit path (see cancelSubagentRun), so
  // there's nothing to clean up here.
  ipcMain.handle(CHANNELS.subagentCancel, (_e, subChatId: string) => cancelSubagentRun(subChatId))

  // ---- models (models.dev catalog) ----
  ipcMain.handle(CHANNELS.modelsList, (_e, providerId: string) => listModels(providerId))
  ipcMain.handle(CHANNELS.modelsRecent, (_e, providerId: string) =>
    repo.listRecentModels(providerId)
  )
  ipcMain.handle(CHANNELS.modelsPinned, () => repo.listPinnedModels())
  ipcMain.handle(
    CHANNELS.modelsSetPinned,
    (_e, providerId: string, model: string, pinned: boolean) =>
      repo.setModelPinned(providerId, model, pinned)
  )

  // ---- context (compaction) ----
  ipcMain.handle(
    CHANNELS.contextCompact,
    async (_e, chatId: string, providerId: string, model: string) => {
      // Registered against the session so Stop reaches it: compaction runs
      // ahead of the turn it makes room for, and is often the longest thing
      // standing between pressing Stop and anything happening.
      const controller = new AbortController()
      const untrack = trackSession(chatId, controller)
      try {
        return await compactChat(chatId, providerId, model, controller.signal)
      } finally {
        untrack()
      }
    }
  )
  ipcMain.handle(CHANNELS.contextInstructions, (_e, cwd: string) => projectInstructions(cwd))

  // ---- browser (URL bar + manual control) ----
  // The manual "Open browser" button drives the shared default window. The chrome's
  // own controls (URL bar / tab strip) come from a SESSION browser window's
  // webContents, so resolve that window's key from the sender and drive exactly
  // that session's browser -- never another chat's.
  const keyOf = (e: Electron.IpcMainInvokeEvent): string | undefined =>
    browser.keyForContents(e.sender) ?? undefined
  ipcMain.handle(CHANNELS.browserOpen, async (_e, url?: string) => {
    browser.openWindow()
    if (url) await browser.navigate(url)
  })
  ipcMain.handle(CHANNELS.browserNavigate, (e, url: string) => browser.navigate(url, keyOf(e)))
  ipcMain.handle(CHANNELS.browserBack, (e) => browser.back(keyOf(e)))
  ipcMain.handle(CHANNELS.browserForward, (e) => browser.forward(keyOf(e)))
  ipcMain.handle(CHANNELS.browserReload, (e) => browser.reload(keyOf(e)))
  ipcMain.handle(CHANNELS.browserStop, (e) => browser.stop(keyOf(e)))
  ipcMain.handle(CHANNELS.browserNewTab, (e, url?: string) => browser.newTab(url, keyOf(e)))
  ipcMain.handle(CHANNELS.browserCloseTab, (e, id: string) => browser.closeTab(id, keyOf(e)))
  ipcMain.handle(CHANNELS.browserActivateTab, (e, id: string) => browser.activateTab(id, keyOf(e)))
  ipcMain.handle(CHANNELS.browserMoveTab, (e, id: string, toIndex: number) =>
    browser.moveTab(id, toIndex, keyOf(e))
  )

  // ---- cookies (the built-in Cookie-Editor) ----
  // One jar, shared by every session: the browser's persisted partition is
  // global, so these are deliberately NOT keyed off the sender. Both surfaces
  // -- the browser window's Cookies panel and Settings -> Browser -- call the
  // same handlers and see the same cookies.
  ipcMain.handle(CHANNELS.cookiesList, (_e, url?: string) => cookies.list(url))
  ipcMain.handle(CHANNELS.cookiesSet, (_e, row: Partial<CookieRow>) => cookies.set(row))
  ipcMain.handle(CHANNELS.cookiesRemove, (_e, row: CookieRow) => cookies.remove(row))
  ipcMain.handle(CHANNELS.cookiesClear, (_e, host?: string) => cookies.clear(host))
  ipcMain.handle(CHANNELS.cookiesImport, (_e, text: string) => cookies.importJson(text))
  ipcMain.handle(CHANNELS.browserChromeHeight, (e, height: number) =>
    browser.setChromeHeight(height, keyOf(e))
  )

  // ---- services (a session's background processes) ----
  // Every handler resolves the ROOT session first: a subagent's dev server is
  // registered under its parent, and the parent's panel is where it belongs.
  ipcMain.handle(CHANNELS.servicesList, (_e, sessionId: string) =>
    listServices(repo.rootSessionId(sessionId))
  )
  ipcMain.handle(CHANNELS.servicesOutput, (_e, sessionId: string, id: string) =>
    serviceOutput(id, repo.rootSessionId(sessionId))
  )
  ipcMain.handle(CHANNELS.servicesStop, (_e, sessionId: string, id: string) =>
    stopService(id, repo.rootSessionId(sessionId))
  )
  ipcMain.handle(CHANNELS.servicesRestart, (_e, sessionId: string, id: string) =>
    restartService(id, repo.rootSessionId(sessionId))
  )
  ipcMain.handle(CHANNELS.servicesOpen, async (_e, sessionId: string, port: number) => {
    // The browser is already isolated per session (keyed by chat id), so each
    // workstream previews its own dev server in its own window.
    const key = repo.rootSessionId(sessionId)
    const title = repo.getChat(key)?.title
    if (title) browser.setLabel(key, title)
    await browser.navigate(`http://localhost:${port}`, key)
  })

  // ---- git (worktree-backed sessions) ----
  // Every handler degrades instead of throwing: a folder that isn't a repo, or a
  // machine with no git, gets an empty/false answer so the UI simply hides.
  ipcMain.handle(CHANNELS.gitAvailable, () => git.isGitAvailable())

  ipcMain.handle(CHANNELS.gitStatus, async (_e, cwd: string): Promise<GitStatusView> => {
    const empty: GitStatusView = {
      isRepo: false,
      root: null,
      branch: null,
      dirty: false,
      changed: 0,
      ahead: 0,
      behind: 0,
      hasUpstream: false,
      defaultBranch: null
    }
    if (!cwd || !(await git.isGitAvailable())) return empty
    const root = await git.repoRoot(cwd)
    if (!root) return empty
    const [st, def] = await Promise.all([git.status(cwd), git.defaultBranch(cwd)])
    return {
      isRepo: true,
      root,
      branch: st?.branch ?? null,
      dirty: st?.dirty ?? false,
      changed: st?.changed ?? 0,
      ahead: st?.ahead ?? 0,
      behind: st?.behind ?? 0,
      hasUpstream: st?.hasUpstream ?? false,
      defaultBranch: def
    }
  })

  /**
   * The repos a session's git UI acts on, and where their checkouts live.
   *
   * Two sources, and the fallback is the whole point:
   *
   *   1. the session's own `repos` links - a materialized composite worktree,
   *      one child checkout per repo. Authoritative when present.
   *   2. the PROJECT's repos, discovered on disk.
   *
   * (2) covers the state a multi-repo session spends its entire life in before
   * its first turn: worktrees are materialized lazily, so a session with a
   * PENDING workstream has no links at all. Returning nothing for it was the
   * bug - every per-repo status came back empty, which took the repo list, the
   * count badge and both sync buttons off screen and left a bare "branch
   * pending" with no way to update or reset anything. Meanwhile the session was
   * genuinely running in the project folder, so those checkouts were exactly
   * the ones the user was asking about.
   *
   * `pending: true` marks that second case so callers can say which tree they
   * are about to touch: the project's own checkouts are shared with the user's
   * editor and every other session, and a reset there is a much bigger claim
   * than a reset inside a throwaway worktree.
   */
  const reposForSession = (
    sessionId: string
  ): { name: string; worktreePath: string; branch: string | null; pending: boolean }[] => {
    const chat = repo.getChat(sessionId)
    // A sub-session acts on its parent's workstream, exactly as the strip does.
    const owner = chat?.kind === 'sub' && chat.parentId ? repo.getChat(chat.parentId) : chat
    if (!owner) return []

    const links = owner.repos
    if (links?.length) {
      return links.map((l) => ({
        name: l.name,
        worktreePath: l.worktreePath,
        branch: l.branch,
        pending: false
      }))
    }

    if (!owner.workspacePath) return []
    const { layout, roots } = discoverRepos(owner.workspacePath)
    // Only the multi-repo layout: a `single` project is already served by the
    // plain `git:status` path, and answering here too would give the UI two
    // sources for one repo that could disagree mid-poll.
    if (layout !== 'multi') return []
    return roots.map((root) => ({
      name: nodePath.basename(root),
      worktreePath: root,
      branch: null,
      pending: true
    }))
  }

  /**
   * Per-repo status for a multi-repo session.
   *
   * Takes a SESSION id, not a path: the composite root is not a repository, so
   * there is nothing at that path to interrogate — the session's `repos` links
   * are the only record of which repos it spans and where their checkouts are.
   *
   * Every repo is queried independently and a failure degrades to
   * `isRepo:false` for that entry alone, so one deleted checkout reports itself
   * as gone instead of blanking the whole workstream.
   */
  ipcMain.handle(
    CHANNELS.gitStatusMulti,
    async (_e, sessionId: string): Promise<RepoStatusView[]> => {
      if (!sessionId || !(await git.isGitAvailable())) return []
      const links = reposForSession(sessionId)
      if (!links.length) return []

      return Promise.all(
        links.map(async (link): Promise<RepoStatusView> => {
          const base = {
            name: link.name,
            worktreePath: link.worktreePath,
            branch: link.branch,
            pending: link.pending,
            dirty: false,
            changed: 0,
            ahead: 0,
            behind: 0,
            hasUpstream: false,
            defaultBranch: null,
            forge: null,
            sync: null
          }
          try {
            const root = await git.repoRoot(link.worktreePath)
            if (!root) return { ...base, isRepo: false }
            const [st, def, fg, sync] = await Promise.all([
              git.status(link.worktreePath),
              git.defaultBranch(link.worktreePath),
              forge.forgeStatus(link.worktreePath, { force: false }),
              // What this repo would sync against - `origin/<base>` when the
              // branch was never pushed, which is the normal state of a fresh
              // composite workstream and the whole reason Update/Reset can be
              // offered for one at all.
              git.syncTargetFor(link.worktreePath)
            ])
            return {
              ...base,
              isRepo: true,
              branch: st?.branch ?? link.branch,
              dirty: st?.dirty ?? false,
              changed: st?.changed ?? 0,
              ahead: st?.ahead ?? 0,
              behind: st?.behind ?? 0,
              hasUpstream: st?.hasUpstream ?? false,
              defaultBranch: def,
              forge: fg,
              sync
            }
          } catch {
            // This repo alone is unreadable; the rest of the workstream stands.
            return { ...base, isRepo: false }
          }
        })
      )
    }
  )

  ipcMain.handle(CHANNELS.gitProjectRepos, async (_e, workspacePath: string) => {
    if (!workspacePath || !(await git.isGitAvailable())) {
      return { layout: 'none' as const, names: [] }
    }
    const { layout, roots } = discoverRepos(workspacePath)
    return { layout, names: roots.map((r) => nodePath.basename(r)) }
  })

  ipcMain.handle(CHANNELS.gitBranches, async (_e, cwd: string) =>
    (await git.isGitAvailable()) ? git.listBranches(cwd) : []
  )

  ipcMain.handle(CHANNELS.gitWorktrees, async (_e, cwd: string) => {
    if (!cwd || !(await git.isGitAvailable())) return []
    const root = await git.repoRoot(cwd)
    return root ? git.listWorktrees(root) : []
  })

  ipcMain.handle(
    CHANNELS.gitCreateWorktree,
    async (_e, input: CreateWorktreeInput): Promise<CreateWorktreeResult> => {
      if (!(await git.isGitAvailable())) return { ok: false, error: 'Git isnâ€™t installed.' }
      const root = await git.repoRoot(input.cwd)
      if (!root) return { ok: false, error: 'This folder isnâ€™t a git repository.' }
      const r =
        input.mode === 'new'
          ? await git.createWorktree({
              repoRoot: root,
              branch: input.branch?.trim() || git.temporaryBranchName()
            })
          : await git.attachWorktree({ repoRoot: root, branch: input.branch?.trim() ?? '' })
      return { ok: r.ok, worktree: r.worktree, attached: r.attached, error: r.error }
    }
  )

  ipcMain.handle(CHANNELS.gitRemoveWorktree, async (_e, worktreePath: string, force?: boolean) => {
    if (!(await git.isGitAvailable())) return { ok: false, error: 'Git isnâ€™t installed.' }
    return git.removeWorktree(worktreePath, { force: force ?? false })
  })

  ipcMain.handle(CHANNELS.gitRenameBranch, (_e, sessionId: string, to: string) =>
    renameWorkstreamBranch(sessionId, to)
  )
  ipcMain.handle(CHANNELS.gitPruneWorktrees, (_e, cwd: string, dryRun?: boolean) =>
    pruneWorktrees(cwd, { dryRun: dryRun ?? true, force: true })
  )

  // ---- forge (the git host behind `origin`: PR state for the branch) ----
  // Same degrade-never-throw contract as the git handlers above: no remote, an
  // unknown host, no credential and a dead network all return a usable object.
  ipcMain.handle(CHANNELS.forgeStatus, async (_e, cwd: string, force?: boolean) => {
    if (!cwd || !(await git.isGitAvailable())) return null
    return forge.forgeStatus(cwd, { force: force ?? false })
  })

  ipcMain.handle(CHANNELS.forgePush, async (_e, cwd: string) => {
    if (!cwd || !(await git.isGitAvailable()))
      return { ok: false, error: 'Git isn\u2019t installed.' }
    const branch = await git.currentBranch(cwd)
    if (!branch) return { ok: false, error: 'Not on a branch (detached HEAD).' }
    const st = await git.status(cwd)
    const r = await git.pushBranch(cwd, branch, { setUpstream: !st?.hasUpstream })
    // The remote just changed, so every cached PR answer is suspect - drop it
    // rather than let the chip show pre-push state for up to a minute.
    if (r.ok) forge.invalidate()
    return r
  })

  // Update + reset are separate channels rather than one `sync(mode)` because
  // they are separate promises: one can only ever move the branch forward, the
  // other can throw away local work. Collapsing them into a parameter is how a
  // caller ends up destructive by typo.
  ipcMain.handle(CHANNELS.forgePull, async (_e, cwd: string): Promise<SyncOutcome> => {
    if (!cwd || !(await git.isGitAvailable()))
      return { ok: false, error: 'Git isn\u2019t installed.' }
    return git.pullFastForward(cwd)
  })

  ipcMain.handle(CHANNELS.forgeReset, async (_e, cwd: string): Promise<SyncOutcome> => {
    if (!cwd || !(await git.isGitAvailable()))
      return { ok: false, error: 'Git isn\u2019t installed.' }
    const r = await git.resetToUpstream(cwd)
    // The local branch just moved to whatever the server has, so anything we
    // cached about "this branch vs its PR" describes a commit that is no longer
    // HEAD. Drop it rather than show pre-reset state until the TTL expires.
    if (r.ok) forge.invalidate()
    return r
  })

  /**
   * Update or reset EVERY repo of a composite workstream.
   *
   * Takes a session id because the composite root is not a repository - see
   * `gitStatusMulti`. One shared implementation for both modes, because the
   * only thing that differs is which per-repo primitive runs; everything around
   * it (resolve the links, run them independently, collect outcomes) is
   * identical, and duplicating it is how the two drift.
   *
   * Repos run SEQUENTIALLY. They are separate repositories so they could run in
   * parallel, but each one fetches, and N parallel fetches against the same
   * host is how you get rate-limited or throttled by a corporate proxy. In
   * practice N is under a dozen and the fetches dominate either way.
   *
   * A failure in one repo never stops the others: they are independent
   * checkouts, and stopping at the first error would leave the workstream in a
   * state that is neither "before" nor "after", with no record of which repos
   * moved.
   */
  const syncEveryRepo = async (
    sessionId: string,
    mode: 'pull' | 'reset' | 'push'
  ): Promise<MultiSyncOutcome> => {
    if (!sessionId) return { repos: [], error: 'No session.' }
    if (!(await git.isGitAvailable())) return { repos: [], error: 'Git isn\u2019t installed.' }

    // Same resolver the status handler uses, so the buttons act on exactly the
    // repos the panel just listed - including a PENDING workstream's, which are
    // the project's own checkouts. Sharing this is the point: a second copy
    // that only understood links is how "Reset all" silently did nothing on a
    // session whose worktree had not been created yet.
    const links = reposForSession(sessionId)
    if (!links.length) return { repos: [], error: 'This session is not multi-repo.' }

    const results: RepoSyncResult[] = []
    for (const link of links) {
      const r = await syncOneRepo(link.worktreePath, mode)
      results.push({
        name: link.name,
        ok: r.ok,
        error: r.error,
        ref: r.upstream,
        updated: r.updated,
        stashed: r.stashed
      })
    }

    // Every branch that moved may now disagree with what we cached about its
    // PR, so drop the lot rather than show pre-sync state until the TTL expires.
    if (results.some((r) => r.ok && r.updated)) forge.invalidate()
    return { repos: results }
  }

  /**
   * One repo's half of a multi-repo sync.
   *
   * `push` is not simply `pushBranch`: it has to resolve the branch first and
   * decide whether this is the repo's first push (`--set-upstream`), which the
   * single-repo handler does inline. Pulling it out here keeps `syncEveryRepo`
   * a loop over one uniform operation rather than a switch with three shapes.
   *
   * `updated` is reported as false for an already-pushed branch so the summary
   * can say "already up to date" instead of claiming N repos moved.
   */
  const syncOneRepo = async (
    cwd: string,
    mode: 'pull' | 'reset' | 'push'
  ): Promise<git.SyncResult> => {
    if (mode === 'pull') return git.pullFastForward(cwd)
    if (mode === 'reset') return git.resetToUpstream(cwd)

    const st = await git.status(cwd)
    if (!st?.branch) return { ok: false, error: 'Not on a branch (detached HEAD).' }
    // Nothing local to publish. Reported as a success that changed nothing,
    // because "push all" across four repos where two are already current is a
    // normal outcome, not two failures.
    if (st.hasUpstream && st.ahead === 0) {
      return { ok: true, upstream: st.upstream ?? undefined, updated: false }
    }
    const r = await git.pushBranch(cwd, st.branch, { setUpstream: !st.hasUpstream })
    return r.ok
      ? { ok: true, upstream: st.upstream ?? `origin/${st.branch}`, updated: true }
      : { ok: false, error: r.error }
  }

  ipcMain.handle(
    CHANNELS.forgePullMulti,
    (_e, sessionId: string): Promise<MultiSyncOutcome> => syncEveryRepo(sessionId, 'pull')
  )

  ipcMain.handle(
    CHANNELS.forgeResetMulti,
    (_e, sessionId: string): Promise<MultiSyncOutcome> => syncEveryRepo(sessionId, 'reset')
  )

  /**
   * Push EVERY repo of a composite workstream.
   *
   * The missing third of the trio. Without it the panel's primary button ran
   * `forge:push` against ONE repo's path - whichever happened to be first - so
   * on a four-repo workstream "Push" published a quarter of the work and left
   * the chip saying the same thing it did before the click.
   */
  ipcMain.handle(
    CHANNELS.forgePushMulti,
    async (_e, sessionId: string): Promise<MultiSyncOutcome> => {
      const out = await syncEveryRepo(sessionId, 'push')
      // The remote just changed, so every cached PR answer is suspect.
      if (out.repos.some((r) => r.ok && r.updated)) forge.invalidate()
      return out
    }
  )

  ipcMain.handle(CHANNELS.forgeCreateUrl, async (_e, cwd: string) => {
    if (!cwd || !(await git.isGitAvailable())) return null
    return forge.createPullUrl(cwd)
  })
  ipcMain.handle(CHANNELS.forgeListHosts, () => forge.listHosts())

  ipcMain.handle(CHANNELS.forgeSetHostKind, (_e, host: string, kind: ForgeKind | null) => {
    forge.setHostKind(host, kind)
  })
  // ---- remote (Remote Workspace: share a session to a phone via roxy.gg) ----
  ipcMain.handle(CHANNELS.remoteStart, (_e, input: RemoteStartInput) => remote.start(input))
  ipcMain.handle(CHANNELS.remoteStop, () => remote.stop())
  ipcMain.handle(CHANNELS.remoteStatus, () => remote.status())
}
