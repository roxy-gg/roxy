import { contextBridge, ipcRenderer } from 'electron'
import { CHANNELS } from '../shared/ipc'
import type { NarreteOverlayApi } from '../shared/narrete'
import type { VoiceEvent } from '../shared/voice'

const overlay: NarreteOverlayApi = {
  state: () => ipcRenderer.invoke(CHANNELS.narreteState),
  ready: () => ipcRenderer.invoke(CHANNELS.narreteReady),
  layout: (revision, rectangles) =>
    ipcRenderer.invoke(CHANNELS.narreteLayout, revision, rectangles),
  refresh: (note, selection) => ipcRenderer.invoke(CHANNELS.narreteRefresh, note, selection),
  submit: (selection, note) => ipcRenderer.invoke(CHANNELS.narreteSubmit, selection, note),
  cancel: () => ipcRenderer.invoke(CHANNELS.narreteCancel),
  onReset: (callback) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      surface: Parameters<typeof callback>[0]
    ): void => callback(surface)
    ipcRenderer.on(CHANNELS.narreteReset, handler)
    return () => ipcRenderer.removeListener(CHANNELS.narreteReset, handler)
  },
  onDrag: (callback) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      selection: Parameters<typeof callback>[0]
    ): void => callback(selection)
    ipcRenderer.on(CHANNELS.narreteDrag, handler)
    return () => ipcRenderer.removeListener(CHANNELS.narreteDrag, handler)
  }
}
export function exposeNarrete(): void {
  contextBridge.exposeInMainWorld('narrete', overlay)
  contextBridge.exposeInMainWorld('roxy', {
    voice: {
      state: () => ipcRenderer.invoke(CHANNELS.voiceState),
      start: (id: string, chatId: string) => ipcRenderer.invoke(CHANNELS.voiceStart, id, chatId),
      stop: (id: string, finalize: boolean) => ipcRenderer.invoke(CHANNELS.voiceStop, id, finalize),
      onEvent: (callback: (event: VoiceEvent) => void) => {
        const handler = (_event: Electron.IpcRendererEvent, event: VoiceEvent): void =>
          callback(event)
        ipcRenderer.on(CHANNELS.voiceEvent, handler)
        return () => ipcRenderer.removeListener(CHANNELS.voiceEvent, handler)
      }
    }
  })
}
