import { ipcMain } from 'electron'
import { CHANNELS } from '../../shared/ipc'
import {
  getKernelStatus,
  installKernelTools,
  setKernelAgentAccess,
  startKernelDriver,
  toggleTestSigning,
  uninstallKernelTools
} from '../services/kernel'

export function registerKernelIpc(): void {
  ipcMain.handle(CHANNELS.kernelStatus, () => getKernelStatus())
  ipcMain.handle(CHANNELS.kernelInstall, () => installKernelTools())
  ipcMain.handle(CHANNELS.kernelStart, () => startKernelDriver())
  ipcMain.handle(CHANNELS.kernelSetAgentAccess, (_event, enable: boolean) =>
    setKernelAgentAccess(enable === true)
  )
  ipcMain.handle(CHANNELS.kernelUninstall, (_event, disableSigning: boolean) => {
    if (typeof disableSigning !== 'boolean')
      throw new TypeError('disableSigning must be a boolean.')
    return uninstallKernelTools(disableSigning)
  })
  ipcMain.handle(CHANNELS.kernelToggleTestSigning, (_event, enable: boolean) => {
    if (typeof enable !== 'boolean') throw new TypeError('enable must be a boolean.')
    return toggleTestSigning(enable)
  })
}
