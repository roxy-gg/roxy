import type { CheatState } from '../shared/cheat'
import type { EngineeringState } from '../shared/engineering-tools'
import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { exposeNarrete } from './narrete'
import { CHANNELS } from '../shared/ipc'
import type {
  AutomationDelta,
  RoxyApi,
  LlmDelta,
  BrowserState,
  BrowserTab,
  BrowserProxyConfig,
  RemoteState,
  RemoteDelta,
  SessionsUpdated,
  SubagentDelta,
  UpdateState
} from '../shared/api'
import type { CliProxyState } from '../shared/cliproxy'
import type { ResolvedTheme } from '../shared/theme'
import type { MotionPreference } from '../shared/motion'
import type { BackgroundState } from '../shared/background'
import type { VoiceEvent } from '../shared/voice'
import type { NotificationSoundLibrary } from '../shared/notification-sounds'

/**
 * The typed bridge exposed to the renderer as `window.roxy`. Every method maps
 * to an ipcMain.handle channel registered in src/main/ipc/index.ts.
 */
const roxy: RoxyApi = {
  cheat: {
    state: () => ipcRenderer.invoke(CHANNELS.cheatState),
    update: (patch) => ipcRenderer.invoke(CHANNELS.cheatUpdate, patch),
    download: (id) => ipcRenderer.invoke(CHANNELS.cheatDownload, id),
    cancel: () => ipcRenderer.invoke(CHANNELS.cheatCancel),
    onChanged: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, state: CheatState): void =>
        callback(state)
      ipcRenderer.on(CHANNELS.cheatChanged, handler)
      return () => ipcRenderer.removeListener(CHANNELS.cheatChanged, handler)
    }
  },
  engineering: {
    state: () => ipcRenderer.invoke(CHANNELS.engineeringState),
    install: (id, consent, repair) =>
      ipcRenderer.invoke(CHANNELS.engineeringInstall, id, consent, repair),
    installAll: (consent) => ipcRenderer.invoke(CHANNELS.engineeringInstallAll, consent),
    update: (patch) => ipcRenderer.invoke(CHANNELS.engineeringUpdate, patch),
    cancel: () => ipcRenderer.invoke(CHANNELS.engineeringCancel),
    onChanged: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, state: EngineeringState): void =>
        callback(state)
      ipcRenderer.on(CHANNELS.engineeringChanged, handler)
      return () => ipcRenderer.removeListener(CHANNELS.engineeringChanged, handler)
    }
  },
  narrete: {
    start: (id, chatId) => ipcRenderer.invoke(CHANNELS.narreteStart, id, chatId),
    cancel: (id) => ipcRenderer.invoke(CHANNELS.narreteCancel, id)
  },
  voice: {
    state: () => ipcRenderer.invoke(CHANNELS.voiceState),
    update: (patch) => ipcRenderer.invoke(CHANNELS.voiceUpdate, patch),
    devices: () => ipcRenderer.invoke(CHANNELS.voiceDevices),
    privacy: () => ipcRenderer.invoke(CHANNELS.voicePrivacy),
    download: (id) => ipcRenderer.invoke(CHANNELS.voiceDownload, id),
    cancelDownload: () => ipcRenderer.invoke(CHANNELS.voiceCancelDownload),
    remove: (id) => ipcRenderer.invoke(CHANNELS.voiceRemove, id),
    start: (id, chatId) => ipcRenderer.invoke(CHANNELS.voiceStart, id, chatId),
    stop: (id, finalize) => ipcRenderer.invoke(CHANNELS.voiceStop, id, finalize),
    onEvent: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, event: VoiceEvent): void =>
        callback(event)
      ipcRenderer.on(CHANNELS.voiceEvent, handler)
      return () => ipcRenderer.removeListener(CHANNELS.voiceEvent, handler)
    }
  },
  bots: {
    list: () => ipcRenderer.invoke(CHANNELS.botsList),
    reorder: (ids) => ipcRenderer.invoke(CHANNELS.botsReorder, ids),
    create: (username) => ipcRenderer.invoke(CHANNELS.botsCreate, username),
    update: (id, patch) => ipcRenderer.invoke(CHANNELS.botsUpdate, id, patch),
    remove: (id) => ipcRenderer.invoke(CHANNELS.botsRemove, id),
    jobs: (botId) => ipcRenderer.invoke(CHANNELS.botsJobs, botId),
    saveJob: (input, id) => ipcRenderer.invoke(CHANNELS.botsSaveJob, input, id),
    removeJob: (id) => ipcRenderer.invoke(CHANNELS.botsRemoveJob, id),
    runJob: (id) => ipcRenderer.invoke(CHANNELS.botsRunJob, id),
    onChanged: (callback) => {
      const handler = (): void => callback()
      ipcRenderer.on(CHANNELS.botsChanged, handler)
      return () => ipcRenderer.removeListener(CHANNELS.botsChanged, handler)
    }
  },
  automation: {
    snapshot: () => ipcRenderer.invoke(CHANNELS.automationSnapshot),
    wake: () => ipcRenderer.invoke(CHANNELS.automationWake),
    onChanged: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, chatId: string): void => callback(chatId)
      ipcRenderer.on(CHANNELS.automationChanged, handler)
      return () => ipcRenderer.removeListener(CHANNELS.automationChanged, handler)
    },
    onDelta: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: AutomationDelta): void =>
        callback(payload)
      ipcRenderer.on(CHANNELS.automationDelta, handler)
      return () => ipcRenderer.removeListener(CHANNELS.automationDelta, handler)
    }
  },
  settings: {
    getAll: () => ipcRenderer.invoke(CHANNELS.settingsGetAll),
    setActiveProvider: (providerId, model) =>
      ipcRenderer.invoke(CHANNELS.settingsSetActiveProvider, providerId, model),
    setActiveAgent: (agentId) => ipcRenderer.invoke(CHANNELS.settingsSetActiveAgent, agentId),
    setReasoningEffort: (level) => ipcRenderer.invoke(CHANNELS.settingsSetReasoningEffort, level),
    setContextLimit: (limit) => ipcRenderer.invoke(CHANNELS.settingsSetContextLimit, limit),
    setAutoWorkstream: (enabled) => ipcRenderer.invoke(CHANNELS.settingsSetAutoWorkstream, enabled),
    setFreshWorkstream: (enabled) =>
      ipcRenderer.invoke(CHANNELS.settingsSetFreshWorkstream, enabled),
    setWorktreeSetupCommand: (command) =>
      ipcRenderer.invoke(CHANNELS.settingsSetWorktreeSetupCommand, command),
    setBranchPrefix: (prefix) => ipcRenderer.invoke(CHANNELS.settingsSetBranchPrefix, prefix),
    setNotifyOnComplete: (enabled) =>
      ipcRenderer.invoke(CHANNELS.settingsSetNotifyOnComplete, enabled),
    setNarreteEnabled: (enabled) => ipcRenderer.invoke(CHANNELS.settingsSetNarreteEnabled, enabled),
    setLanguage: (language) => ipcRenderer.invoke(CHANNELS.settingsSetLanguage, language),
    setMotion: (motion) => ipcRenderer.invoke(CHANNELS.settingsSetMotion, motion),
    onMotionChanged: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, motion: MotionPreference): void =>
        callback(motion)
      ipcRenderer.on(CHANNELS.settingsMotionChanged, handler)
      return () => ipcRenderer.removeListener(CHANNELS.settingsMotionChanged, handler)
    },
    completeOnboarding: () => ipcRenderer.invoke(CHANNELS.settingsCompleteOnboarding),
    reset: () => ipcRenderer.invoke(CHANNELS.settingsReset),
    getTelemetry: () => ipcRenderer.invoke(CHANNELS.settingsGetTelemetry),
    setTelemetry: (enabled) => ipcRenderer.invoke(CHANNELS.settingsSetTelemetry, enabled)
  },
  notifications: {
    soundLibrary: () => ipcRenderer.invoke(CHANNELS.notifySoundsGet),
    importSound: () => ipcRenderer.invoke(CHANNELS.notifySoundsImport),
    selectSound: (id) => ipcRenderer.invoke(CHANNELS.notifySoundsSelect, id),
    deleteSound: (id) => ipcRenderer.invoke(CHANNELS.notifySoundsDelete, id),
    soundAudio: (id) => ipcRenderer.invoke(CHANNELS.notifySoundsAudio, id),
    onSoundsChanged: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, state: NotificationSoundLibrary): void =>
        callback(state)
      ipcRenderer.on(CHANNELS.notifySoundsChanged, handler)
      return () => ipcRenderer.removeListener(CHANNELS.notifySoundsChanged, handler)
    },
    toast: (title, subtitle, body, chatId) =>
      ipcRenderer.invoke(CHANNELS.notifyToast, title, subtitle, body, chatId),
    takePendingActivation: () => ipcRenderer.invoke(CHANNELS.notifyTakePending),
    onActivated: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, chatId: string): void => callback(chatId)
      ipcRenderer.on(CHANNELS.notifyActivated, handler)
      return () => ipcRenderer.removeListener(CHANNELS.notifyActivated, handler)
    }
  },
  providers: {
    listConnected: () => ipcRenderer.invoke(CHANNELS.providersList),
    connect: (input) => ipcRenderer.invoke(CHANNELS.providersConnect, input),
    disconnect: (id) => ipcRenderer.invoke(CHANNELS.providersDisconnect, id),
    rename: (id, name) => ipcRenderer.invoke(CHANNELS.providersRename, id, name),
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
  catalog: {
    search: (kind, query, cursor) =>
      ipcRenderer.invoke(CHANNELS.catalogSearch, kind, query, cursor),
    skillDetail: (id) => ipcRenderer.invoke(CHANNELS.catalogSkillDetail, id),
    installSkill: (id, reviewId) => ipcRenderer.invoke(CHANNELS.catalogInstallSkill, id, reviewId),
    mcpSetup: (id) => ipcRenderer.invoke(CHANNELS.catalogMcpSetup, id),
    installMcp: (input) => ipcRenderer.invoke(CHANNELS.catalogInstallMcp, input)
  },
  mcp: {
    list: () => ipcRenderer.invoke(CHANNELS.mcpList),
    upsert: (input) => ipcRenderer.invoke(CHANNELS.mcpUpsert, input),
    remove: (id) => ipcRenderer.invoke(CHANNELS.mcpRemove, id),
    setEnabled: (id, enabled) => ipcRenderer.invoke(CHANNELS.mcpSetEnabled, id, enabled),
    reconnect: (id) => ipcRenderer.invoke(CHANNELS.mcpReconnect, id)
  },
  skills: {
    readRaw: (name, cwd) => ipcRenderer.invoke(CHANNELS.skillsReadRaw, name, cwd),
    saveRaw: (input, cwd) => ipcRenderer.invoke(CHANNELS.skillsSaveRaw, input, cwd),
    list: (cwd) => ipcRenderer.invoke(CHANNELS.skillsList, cwd),
    refresh: (cwd) => ipcRenderer.invoke(CHANNELS.skillsRefresh, cwd),
    read: (name, cwd) => ipcRenderer.invoke(CHANNELS.skillsRead, name, cwd),
    create: (input, cwd) => ipcRenderer.invoke(CHANNELS.skillsCreate, input, cwd),
    update: (input, cwd) => ipcRenderer.invoke(CHANNELS.skillsUpdate, input, cwd),
    remove: (name, cwd) => ipcRenderer.invoke(CHANNELS.skillsRemove, name, cwd),
    install: (source, cwd) => ipcRenderer.invoke(CHANNELS.skillsInstall, source, cwd)
  },
  background: {
    listCustom: () => ipcRenderer.invoke(CHANNELS.backgroundListCustom),
    applyCustom: (id) => ipcRenderer.invoke(CHANNELS.backgroundApplyCustom, id),
    deleteCustom: (id) => ipcRenderer.invoke(CHANNELS.backgroundDeleteCustom, id),
    renameCustom: (id, title) => ipcRenderer.invoke(CHANNELS.backgroundRenameCustom, id, title),
    thumbnail: (id, sha256) => ipcRenderer.invoke(CHANNELS.backgroundThumbnail, id, sha256),
    preview: (id) => ipcRenderer.invoke(CHANNELS.backgroundPreview, id),
    previewCustom: (id) => ipcRenderer.invoke(CHANNELS.backgroundPreviewCustom, id),
    search: (input) => ipcRenderer.invoke(CHANNELS.backgroundSearch, input),
    applyCatalog: (id) => ipcRenderer.invoke(CHANNELS.backgroundApplyCatalog, id),
    submit: (input) => ipcRenderer.invoke(CHANNELS.backgroundSubmit, input),
    get: () => ipcRenderer.invoke(CHANNELS.backgroundGet),
    choose: () => ipcRenderer.invoke(CHANNELS.backgroundChoose),
    remove: () => ipcRenderer.invoke(CHANNELS.backgroundRemove),
    update: (settings) => ipcRenderer.invoke(CHANNELS.backgroundUpdate, settings),
    onChanged: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, state: BackgroundState): void =>
        callback(state)
      ipcRenderer.on(CHANNELS.backgroundChanged, handler)
      return () => ipcRenderer.removeListener(CHANNELS.backgroundChanged, handler)
    }
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
    needsReauthentication: (connectionId) =>
      ipcRenderer.invoke(CHANNELS.copilotNeedsReauthentication, connectionId),
    start: () => ipcRenderer.invoke(CHANNELS.copilotStart),
    poll: (deviceCode, interval, connectionId) =>
      ipcRenderer.invoke(CHANNELS.copilotPoll, deviceCode, interval, connectionId)
  },
  cliproxy: {
    status: () => ipcRenderer.invoke(CHANNELS.cliproxyStatus),
    login: (providerId, connectionId) =>
      ipcRenderer.invoke(CHANNELS.cliproxyLogin, providerId, connectionId),
    signOut: (providerId, file) => ipcRenderer.invoke(CHANNELS.cliproxySignOut, providerId, file),
    stop: () => ipcRenderer.invoke(CHANNELS.cliproxyStop),
    quota: (connectionId, force) => ipcRenderer.invoke(CHANNELS.cliproxyQuota, connectionId, force),
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
  workspace: {
    preview: (sessionId, rootId, file) =>
      ipcRenderer.invoke(CHANNELS.workspacePreview, sessionId, rootId, file),
    inspect: (sessionId) => ipcRenderer.invoke(CHANNELS.workspaceInspect, sessionId),
    list: (sessionId, rootId, directory) =>
      ipcRenderer.invoke(CHANNELS.workspaceList, sessionId, rootId, directory),
    read: (sessionId, rootId, file, comparison) =>
      ipcRenderer.invoke(CHANNELS.workspaceRead, sessionId, rootId, file, comparison),
    write: (sessionId, rootId, file, content, expectedRevision) =>
      ipcRenderer.invoke(
        CHANNELS.workspaceWrite,
        sessionId,
        rootId,
        file,
        content,
        expectedRevision
      ),
    confirmDiscard: (message, discard, cancel) =>
      ipcRenderer.invoke(CHANNELS.workspaceConfirmDiscard, message, discard, cancel)
  },
  tools: {
    run: (sessionId, name, input) => ipcRenderer.invoke(CHANNELS.toolsRun, sessionId, name, input),
    cancel: (callId) => ipcRenderer.invoke(CHANNELS.toolsCancel, callId)
  },
  queue: {
    list: (chatId) => ipcRenderer.invoke(CHANNELS.queueList, chatId),
    add: (chatId, content, images, options) =>
      ipcRenderer.invoke(CHANNELS.queueAdd, chatId, content, images, options),
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
    finish: (requestId) => ipcRenderer.invoke(CHANNELS.llmFinish, requestId),
    abort: (requestId) => ipcRenderer.invoke(CHANNELS.llmAbort, requestId),
    abortSession: (sessionId) => ipcRenderer.invoke(CHANNELS.llmAbortSession, sessionId),
    onDelta: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: LlmDelta): void =>
        callback(payload)
      ipcRenderer.on(CHANNELS.llmDelta, handler)
      return () => ipcRenderer.removeListener(CHANNELS.llmDelta, handler)
    }
  },
  subagents: {
    snapshot: (subChatId) => ipcRenderer.invoke(CHANNELS.subagentSnapshot, subChatId),
    listRunning: () => ipcRenderer.invoke(CHANNELS.subagentListRunning),
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
    hidden: () => ipcRenderer.invoke(CHANNELS.modelsHidden),
    setHidden: (providerId, model, hidden) =>
      ipcRenderer.invoke(CHANNELS.modelsSetHidden, providerId, model, hidden),
    setProviderHidden: (providerId, models) =>
      ipcRenderer.invoke(CHANNELS.modelsSetProviderHidden, providerId, models)
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
    toggleDevTools: () => ipcRenderer.invoke(CHANNELS.browserToggleDevTools),
    inspectElement: () => ipcRenderer.invoke(CHANNELS.browserInspectElement),
    newTab: (url) => ipcRenderer.invoke(CHANNELS.browserNewTab, url),
    closeTab: (id) => ipcRenderer.invoke(CHANNELS.browserCloseTab, id),
    activateTab: (id) => ipcRenderer.invoke(CHANNELS.browserActivateTab, id),
    moveTab: (id, toIndex) => ipcRenderer.invoke(CHANNELS.browserMoveTab, id, toIndex),
    setChromeHeight: (height) => ipcRenderer.invoke(CHANNELS.browserChromeHeight, height),
    getProxy: () => ipcRenderer.invoke(CHANNELS.browserProxyGet),
    setProxy: (input) => ipcRenderer.invoke(CHANNELS.browserProxySet, input),
    onProxyChanged: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, config: BrowserProxyConfig): void =>
        callback(config)
      ipcRenderer.on(CHANNELS.browserProxyChanged, handler)
      return () => ipcRenderer.removeListener(CHANNELS.browserProxyChanged, handler)
    },
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
if (process.argv.includes('--narrete-overlay')) {
  exposeNarrete()
} else if (process.contextIsolated) {
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
