import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { CHANNELS } from '../../shared/ipc'
import {
  getKernelStatus,
  installKernelTools,
  setKernelAgentAccess,
  startKernelDriver,
  toggleTestSigning,
  uninstallKernelTools
} from '../services/kernel'

function requireMainWindow(
  event: IpcMainInvokeEvent,
  getMainWindow: () => BrowserWindow | null
): BrowserWindow {
  const mainWindow = getMainWindow()
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== mainWindow.webContents.mainFrame
  ) {
    throw new Error('Kernel Tools requests are only accepted from the main Roxy window.')
  }
  return mainWindow
}

export function registerKernelIpc(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle(CHANNELS.kernelStatus, (event) => {
    requireMainWindow(event, getMainWindow)
    return getKernelStatus()
  })
  ipcMain.handle(CHANNELS.kernelInstall, (event) => {
    requireMainWindow(event, getMainWindow)
    return installKernelTools()
  })
  ipcMain.handle(CHANNELS.kernelStart, (event) => {
    requireMainWindow(event, getMainWindow)
    return startKernelDriver()
  })
  ipcMain.handle(CHANNELS.kernelSetAgentAccess, async (event, enable: boolean) => {
    const mainWindow = requireMainWindow(event, getMainWindow)
    if (typeof enable !== 'boolean') throw new TypeError('enable must be a boolean.')
    if (enable) {
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'Enable Kernel Tools agent access?',
        message: 'This gives agents elevated access to protected system resources.',
        detail: 'Only continue in an isolated test environment with no sensitive data.',
        buttons: ['Cancel', 'Enable agent access'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
      if (response !== 1) {
        return { ok: false, error: 'Agent access was not enabled.', steps: [] }
      }
    }
    return setKernelAgentAccess(enable)
  })
  ipcMain.handle(CHANNELS.kernelUninstall, (event, disableSigning: boolean) => {
    requireMainWindow(event, getMainWindow)
    if (typeof disableSigning !== 'boolean')
      throw new TypeError('disableSigning must be a boolean.')
    return uninstallKernelTools(disableSigning)
  })
  ipcMain.handle(CHANNELS.kernelToggleTestSigning, (event, enable: boolean) => {
    requireMainWindow(event, getMainWindow)
    if (typeof enable !== 'boolean') throw new TypeError('enable must be a boolean.')
    return toggleTestSigning(enable)
  })
}
