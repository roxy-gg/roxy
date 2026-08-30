import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { CHANNELS } from '../shared/ipc'
import type {
  RoxyApi,
  LlmDelta,
  TaskUpdate,
  BrowserState,
  BrowserTab,
  RemoteState,
  RemoteDelta,
  SessionsUpdated,
  SubagentDelta,
  UpdateState
} from '../shared/api'
import type { CliProxyState } from '../shared/cliproxy'
import type { McpConsentRequest, McpInstallNotice } from '../shared/mcp-trust'
import type { McpAppApprovalRequest } from '../shared/api'
import type { ResolvedTheme } from '../shared/theme'

/**
 * The typed bridge exposed to the renderer as `window.roxy`. Every method maps
 * to an ipcMain.handle channel registered in src/main/ipc/index.ts.
 */
const roxy: RoxyApi = {
  settings: {
    getAll: () => ipcRenderer.invoke(CHANNELS.settingsGetAll),
    setActiveProvider: (providerId, model) =>
      ipcRenderer.invoke(CHANNELS.settingsSetActiveProvider, providerId, model),
    setActiveAgent: (agentId) => ipcRenderer.invoke(CHANNELS.settingsSetActiveAgent, agentId),
    setReasoningEffort: (level) => ipcRenderer.invoke(CHANNELS.settingsSetReasoningEffort, level),
    setContextLimit: (limit) => ipcRenderer.invoke(CHANNELS.settingsSetContextLimit, limit),
    setAutoWorkstream: (enabled) => ipcRenderer.invoke(CHANNELS.settingsSetAutoWorkstream, enabled),
    setBranchPrefix: (prefix) => ipcRenderer.invoke(CHANNELS.settingsSetBranchPrefix, prefix),
    setLanguage: (language) => ipcRenderer.invoke(CHANNELS.settingsSetLanguage, language),
    completeOnboarding: () => ipcRenderer.invoke(CHANNELS.settingsCompleteOnboarding),
    reset: () => ipcRenderer.invoke(CHANNELS.settingsReset),
    getTelemetry: () => ipcRenderer.invoke(CHANNELS.settingsGetTelemetry),
    setTelemetry: (enabled) => ipcRenderer.invoke(CHANNELS.settingsSetTelemetry, enabled)
  },
  providers: {
    listConnected: () => ipcRenderer.invoke(CHANNELS.providersList),
    connect: (input) => ipcRenderer.invoke(CHANNELS.providersConnect, input),
    disconnect: (id) => ipcRenderer.invoke(CHANNELS.providersDisconnect, id),
    reorder: (ids) => ipcRenderer.invoke(CHANNELS.providersReorder, ids)
  },
  chats: {
    list: () => ipcRenderer.invoke(CHANNELS.chatsList),
    create: (input) => ipcRenderer.invoke(CHANNELS.chatsCreate, input),
    fork: (id, input) => ipcRenderer.invoke(CHANNELS.chatsFork, id, input),
    rename: (id, title) => ipcRenderer.invoke(CHANNELS.chatsRename, id, title),
    remove: (id) => ipcRenderer.invoke(CHANNELS.chatsRemove, id),
    reorder: (workspacePath, ids) => ipcRenderer.invoke(CHANNELS.chatsReorder, workspacePath, ids),
    setConfig: (id, patch) => ipcRenderer.invoke(CHANNELS.chatsSetConfig, id, patch),
    onUpdated: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: SessionsUpdated): void =>
        callback(payload)
      ipcRenderer.on(CHANNELS.chatsUpdated, handler)
      return () => ipcRenderer.removeListener(CHANNELS.chatsUpdated, handler)
    }
  },
  projects: {
    listOrder: () => ipcRenderer.invoke(CHANNELS.projectsListOrder),
    reorder: (paths) => ipcRenderer.invoke(CHANNELS.projectsReorder, paths)
  },
  messages: {
    list: (chatId) => ipcRenderer.invoke(CHANNELS.messagesList, chatId),
    add: (input) => ipcRenderer.invoke(CHANNELS.messagesAdd, input)
  },
  integrations: {
    list: () => ipcRenderer.invoke(CHANNELS.integrationsList),
    setEnabled: (id, enabled) => ipcRenderer.invoke(CHANNELS.integrationsSetEnabled, id, enabled)
  },
  mcp: {
    list: () => ipcRenderer.invoke(CHANNELS.mcpList),
    upsert: (input) => ipcRenderer.invoke(CHANNELS.mcpUpsert, input),
    remove: (id) => ipcRenderer.invoke(CHANNELS.mcpRemove, id),
    setEnabled: (id, enabled) => ipcRenderer.invoke(CHANNELS.mcpSetEnabled, id, enabled),
    reconnect: (id) => ipcRenderer.invoke(CHANNELS.mcpReconnect, id),
    signIn: (id) => ipcRenderer.invoke(CHANNELS.mcpSignIn, id),
    signOut: (id) => ipcRenderer.invoke(CHANNELS.mcpSignOut, id),
    app: {
      launch: (input) => ipcRenderer.invoke(CHANNELS.mcpAppLaunch, input),
      request: (req) => ipcRenderer.invoke(CHANNELS.mcpAppRequest, req),
      close: (sessionId) => ipcRenderer.invoke(CHANNELS.mcpAppClose, sessionId),
      setTheme: (theme) => ipcRenderer.send(CHANNELS.mcpAppTheme, theme),
      onApprovalRequest: (callback) => {
        const handler = (_e: Electron.IpcRendererEvent, r: McpAppApprovalRequest): void =>
          callback(r)
        ipcRenderer.on(CHANNELS.mcpAppApprovalRequest, handler)
        return () => ipcRenderer.removeListener(CHANNELS.mcpAppApprovalRequest, handler)
      },
      respondApproval: (res) => ipcRenderer.send(CHANNELS.mcpAppApprovalRespond, res)
    },
    trust: {
      list: () => ipcRenderer.invoke(CHANNELS.mcpTrustList),
      revoke: (target) => ipcRenderer.invoke(CHANNELS.mcpTrustRevoke, target),
      getPolicy: () => ipcRenderer.invoke(CHANNELS.mcpTrustGetPolicy),
      setPolicy: (confirmBeforeRun) =>
        ipcRenderer.invoke(CHANNELS.mcpTrustSetPolicy, confirmBeforeRun),
      onInstall: (callback) => {
        const handler = (_e: Electron.IpcRendererEvent, notice: McpInstallNotice): void =>
          callback(notice)
        ipcRenderer.on(CHANNELS.mcpInstallNotice, handler)
        return () => ipcRenderer.removeListener(CHANNELS.mcpInstallNotice, handler)
      },
      onRequest: (callback) => {
        const handler = (_e: Electron.IpcRendererEvent, request: McpConsentRequest): void =>
          callback(request)
        ipcRenderer.on(CHANNELS.mcpConsentRequest, handler)
        return () => ipcRenderer.removeListener(CHANNELS.mcpConsentRequest, handler)
      },
      // `send`, not `invoke`: the answer resolves a promise the main process is
      // already awaiting, and the renderer has nothing to wait for in return.
      respond: (response) => ipcRenderer.send(CHANNELS.mcpConsentRespond, response)
    }
  },
  skills: {
    list: (cwd) => ipcRenderer.invoke(CHANNELS.skillsList, cwd),
    refresh: (cwd) => ipcRenderer.invoke(CHANNELS.skillsRefresh, cwd),
    read: (name, cwd) => ipcRenderer.invoke(CHANNELS.skillsRead, name, cwd),
    create: (input, cwd) => ipcRenderer.invoke(CHANNELS.skillsCreate, input, cwd),
    update: (input, cwd) => ipcRenderer.invoke(CHANNELS.skillsUpdate, input, cwd),
    remove: (name, cwd) => ipcRenderer.invoke(CHANNELS.skillsRemove, name, cwd),
    install: (source, cwd) => ipcRenderer.invoke(CHANNELS.skillsInstall, source, cwd)
  },
  themes: {
    list: () => ipcRenderer.invoke(CHANNELS.themesList),
    refresh: () => ipcRenderer.invoke(CHANNELS.themesRefresh),
    read: (id) => ipcRenderer.invoke(CHANNELS.themesRead, id),
    resolve: (id) => ipcRenderer.invoke(CHANNELS.themesResolve, id),
    save: (id, source) => ipcRenderer.invoke(CHANNELS.themesSave, id, source),
    create: (input) => ipcRenderer.invoke(CHANNELS.themesCreate, input),
    remove: (id) => ipcRenderer.invoke(CHANNELS.themesRemove, id),
    reveal: (id) => ipcRenderer.invoke(CHANNELS.themesReveal, id),
    setActive: (id) => ipcRenderer.invoke(CHANNELS.themesSetActive, id),
    onChanged: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, theme: ResolvedTheme): void =>
        callback(theme)
      ipcRenderer.on(CHANNELS.themesChanged, handler)
      return () => ipcRenderer.removeListener(CHANNELS.themesChanged, handler)
    }
  },
  system: {
    getVersions: () => ipcRenderer.invoke(CHANNELS.systemGetVersions),
    openExternal: (url) => ipcRenderer.invoke(CHANNELS.systemOpenExternal, url)
  },
  clipboard: {
    hasContent: () => ipcRenderer.invoke(CHANNELS.clipboardHasContent),
    exec: (action, linkUrl) => ipcRenderer.invoke(CHANNELS.clipboardExec, action, linkUrl)
  },
  updates: {
    check: () => ipcRenderer.invoke(CHANNELS.updateCheck),
    install: () => ipcRenderer.invoke(CHANNELS.updateInstall),
    getState: () => ipcRenderer.invoke(CHANNELS.updateGetState),
    onStatus: (callback) => {
      const handler = (_e: Electron.IpcRendererEvent, s: UpdateState): void => callback(s)
      ipcRenderer.on(CHANNELS.updateStatus, handler)
      return () => ipcRenderer.removeListener(CHANNELS.updateStatus, handler)
    }
  },
  copilot: {
    start: () => ipcRenderer.invoke(CHANNELS.copilotStart),
    poll: (deviceCode, interval) => ipcRenderer.invoke(CHANNELS.copilotPoll, deviceCode, interval)
  },
  cliproxy: {
    status: () => ipcRenderer.invoke(CHANNELS.cliproxyStatus),
    login: (providerId) => ipcRenderer.invoke(CHANNELS.cliproxyLogin, providerId),
    signOut: (providerId, file) => ipcRenderer.invoke(CHANNELS.cliproxySignOut, providerId, file),
    stop: () => ipcRenderer.invoke(CHANNELS.cliproxyStop),
    installFromFile: () => ipcRenderer.invoke(CHANNELS.cliproxyInstallFile),
    onState: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, state: CliProxyState): void =>
        callback(state)
      ipcRenderer.on(CHANNELS.cliproxyState, handler)
      return () => ipcRenderer.removeListener(CHANNELS.cliproxyState, handler)
    }
  },
  dialog: {
    openWorkspace: () => ipcRenderer.invoke(CHANNELS.dialogOpenWorkspace)
  },
  config: {
    export: () => ipcRenderer.invoke(CHANNELS.configExport),
    import: () => ipcRenderer.invoke(CHANNELS.configImport)
  },
  loops: {
    list: () => ipcRenderer.invoke(CHANNELS.loopsList),
    create: (input) => ipcRenderer.invoke(CHANNELS.loopsCreate, input),
    setEnabled: (id, enabled) => ipcRenderer.invoke(CHANNELS.loopsSetEnabled, id, enabled),
    remove: (id) => ipcRenderer.invoke(CHANNELS.loopsRemove, id),
    onTick: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, loopId: string): void => callback(loopId)
      ipcRenderer.on(CHANNELS.loopsTick, handler)
      return () => ipcRenderer.removeListener(CHANNELS.loopsTick, handler)
    }
  },
  tools: {
    run: (sessionId, name, input) => ipcRenderer.invoke(CHANNELS.toolsRun, sessionId, name, input),
    cancel: (callId) => ipcRenderer.invoke(CHANNELS.toolsCancel, callId)
  },
  queue: {
    list: (chatId) => ipcRenderer.invoke(CHANNELS.queueList, chatId),
    add: (chatId, content, images) =>
      ipcRenderer.invoke(CHANNELS.queueAdd, chatId, content, images),
    remove: (id) => ipcRenderer.invoke(CHANNELS.queueRemove, id),
    reorder: (chatId, ids) => ipcRenderer.invoke(CHANNELS.queueReorder, chatId, ids),
    update: (id, content, images) => ipcRenderer.invoke(CHANNELS.queueUpdate, id, content, images)
  },
  usage: {
    stats: () => ipcRenderer.invoke(CHANNELS.usageStats)
  },
  activity: {
    stats: () => ipcRenderer.invoke(CHANNELS.activityStats)
  },
  llm: {
    start: (input) => ipcRenderer.invoke(CHANNELS.llmStart, input),
    abort: (requestId) => ipcRenderer.invoke(CHANNELS.llmAbort, requestId),
    abortSession: (sessionId) => ipcRenderer.invoke(CHANNELS.llmAbortSession, sessionId),
    onDelta: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: LlmDelta): void =>
        callback(payload)
      ipcRenderer.on(CHANNELS.llmDelta, handler)
      return () => ipcRenderer.removeListener(CHANNELS.llmDelta, handler)
    }
  },
  tasks: {
    listRunning: (sessionId) => ipcRenderer.invoke(CHANNELS.tasksListRunning, sessionId),
    cancel: (jobId) => ipcRenderer.invoke(CHANNELS.tasksCancel, jobId),
    onUpdate: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, update: TaskUpdate): void =>
        callback(update)
      ipcRenderer.on(CHANNELS.taskUpdate, handler)
      return () => ipcRenderer.removeListener(CHANNELS.taskUpdate, handler)
    }
  },
  subagents: {
    snapshot: (subChatId) => ipcRenderer.invoke(CHANNELS.subagentSnapshot, subChatId),
    listRunning: () => ipcRenderer.invoke(CHANNELS.subagentListRunning),
    setViewed: (chatId) => ipcRenderer.invoke(CHANNELS.subagentSetViewed, chatId),
    cancel: (subChatId) => ipcRenderer.invoke(CHANNELS.subagentCancel, subChatId),
    onDelta: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: SubagentDelta): void =>
        callback(payload)
      ipcRenderer.on(CHANNELS.subagentDelta, handler)
      return () => ipcRenderer.removeListener(CHANNELS.subagentDelta, handler)
    }
  },
  models: {
    list: (providerId) => ipcRenderer.invoke(CHANNELS.modelsList, providerId),
    recent: (providerId) => ipcRenderer.invoke(CHANNELS.modelsRecent, providerId),
    pinned: () => ipcRenderer.invoke(CHANNELS.modelsPinned),
    setPinned: (providerId, model, pinned) =>
      ipcRenderer.invoke(CHANNELS.modelsSetPinned, providerId, model, pinned)
  },
  context: {
    compact: (chatId, providerId, model) =>
      ipcRenderer.invoke(CHANNELS.contextCompact, chatId, providerId, model),
    instructions: (cwd) => ipcRenderer.invoke(CHANNELS.contextInstructions, cwd)
  },
  browser: {
    open: (url) => ipcRenderer.invoke(CHANNELS.browserOpen, url),
    navigate: (url) => ipcRenderer.invoke(CHANNELS.browserNavigate, url),
    back: () => ipcRenderer.invoke(CHANNELS.browserBack),
    forward: () => ipcRenderer.invoke(CHANNELS.browserForward),
    reload: () => ipcRenderer.invoke(CHANNELS.browserReload),
    stop: () => ipcRenderer.invoke(CHANNELS.browserStop),
    newTab: (url) => ipcRenderer.invoke(CHANNELS.browserNewTab, url),
    closeTab: (id) => ipcRenderer.invoke(CHANNELS.browserCloseTab, id),
    activateTab: (id) => ipcRenderer.invoke(CHANNELS.browserActivateTab, id),
    moveTab: (id, toIndex) => ipcRenderer.invoke(CHANNELS.browserMoveTab, id, toIndex),
    setChromeHeight: (height) => ipcRenderer.invoke(CHANNELS.browserChromeHeight, height),
    onState: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, state: BrowserState): void =>
        callback(state)
      ipcRenderer.on(CHANNELS.browserState, handler)
      return () => ipcRenderer.removeListener(CHANNELS.browserState, handler)
    },
    onTabs: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, tabs: BrowserTab[]): void =>
        callback(tabs)
      ipcRenderer.on(CHANNELS.browserTabs, handler)
      return () => ipcRenderer.removeListener(CHANNELS.browserTabs, handler)
    }
  },
  cookies: {
    list: (url) => ipcRenderer.invoke(CHANNELS.cookiesList, url),
    set: (row) => ipcRenderer.invoke(CHANNELS.cookiesSet, row),
    remove: (row) => ipcRenderer.invoke(CHANNELS.cookiesRemove, row),
    clear: (host) => ipcRenderer.invoke(CHANNELS.cookiesClear, host),
    importJson: (text) => ipcRenderer.invoke(CHANNELS.cookiesImport, text)
  },
  services: {
    list: (sessionId) => ipcRenderer.invoke(CHANNELS.servicesList, sessionId),
    output: (sessionId, id) => ipcRenderer.invoke(CHANNELS.servicesOutput, sessionId, id),
    stop: (sessionId, id) => ipcRenderer.invoke(CHANNELS.servicesStop, sessionId, id),
    restart: (sessionId, id) => ipcRenderer.invoke(CHANNELS.servicesRestart, sessionId, id),
    open: (sessionId, port) => ipcRenderer.invoke(CHANNELS.servicesOpen, sessionId, port)
  },
  git: {
    available: () => ipcRenderer.invoke(CHANNELS.gitAvailable),
    status: (cwd) => ipcRenderer.invoke(CHANNELS.gitStatus, cwd),
    statusMulti: (sessionId) => ipcRenderer.invoke(CHANNELS.gitStatusMulti, sessionId),
    projectRepos: (workspacePath) => ipcRenderer.invoke(CHANNELS.gitProjectRepos, workspacePath),
    branches: (cwd) => ipcRenderer.invoke(CHANNELS.gitBranches, cwd),
    worktrees: (cwd) => ipcRenderer.invoke(CHANNELS.gitWorktrees, cwd),
    createWorktree: (input) => ipcRenderer.invoke(CHANNELS.gitCreateWorktree, input),
    removeWorktree: (path, force) => ipcRenderer.invoke(CHANNELS.gitRemoveWorktree, path, force),
    renameBranch: (sessionId, to) => ipcRenderer.invoke(CHANNELS.gitRenameBranch, sessionId, to),
    pruneWorktrees: (cwd, dryRun) => ipcRenderer.invoke(CHANNELS.gitPruneWorktrees, cwd, dryRun)
  },
  forge: {
    status: (cwd, force) => ipcRenderer.invoke(CHANNELS.forgeStatus, cwd, force),
    push: (cwd) => ipcRenderer.invoke(CHANNELS.forgePush, cwd),
    pull: (cwd) => ipcRenderer.invoke(CHANNELS.forgePull, cwd),
    reset: (cwd) => ipcRenderer.invoke(CHANNELS.forgeReset, cwd),
    pullMulti: (sessionId) => ipcRenderer.invoke(CHANNELS.forgePullMulti, sessionId),
    resetMulti: (sessionId) => ipcRenderer.invoke(CHANNELS.forgeResetMulti, sessionId),
    pushMulti: (sessionId) => ipcRenderer.invoke(CHANNELS.forgePushMulti, sessionId),
    createUrl: (cwd) => ipcRenderer.invoke(CHANNELS.forgeCreateUrl, cwd),
    listHosts: () => ipcRenderer.invoke(CHANNELS.forgeListHosts),
    setHostKind: (host, kind) => ipcRenderer.invoke(CHANNELS.forgeSetHostKind, host, kind)
  },
  remote: {
    start: (input) => ipcRenderer.invoke(CHANNELS.remoteStart, input),
    stop: () => ipcRenderer.invoke(CHANNELS.remoteStop),
    status: () => ipcRenderer.invoke(CHANNELS.remoteStatus),
    onState: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, state: RemoteState): void =>
        callback(state)
      ipcRenderer.on(CHANNELS.remoteState, handler)
      return () => ipcRenderer.removeListener(CHANNELS.remoteState, handler)
    },
    onDelta: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: RemoteDelta): void =>
        callback(payload)
      ipcRenderer.on(CHANNELS.remoteDelta, handler)
      return () => ipcRenderer.removeListener(CHANNELS.remoteDelta, handler)
    }
  }
}

// With context isolation on (the secure default) we expose the bridge through
// the contextBridge. The `else` branch is only a fallback for sandbox-off dev.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('roxy', roxy)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (defined in index.d.ts)
  window.electron = electronAPI
  // @ts-ignore (defined in index.d.ts)
  window.roxy = roxy
}
