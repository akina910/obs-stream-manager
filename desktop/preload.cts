import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopUpdateState } from '../shared/update-contracts.js'

contextBridge.exposeInMainWorld('obsStreamManagerDesktop', {
  dockUrl: 'http://127.0.0.1:4317',
  openExternal: (url: string) => ipcRenderer.invoke('desktop:open-external', url) as Promise<void>,
  copyDockUrl: () => ipcRenderer.invoke('desktop:copy-dock-url') as Promise<void>,
  getIntegrationSettings: () => ipcRenderer.invoke('desktop:get-integration-settings') as Promise<{ startWithWindows: boolean; supported: boolean }>,
  setStartWithWindows: (value: boolean) => ipcRenderer.invoke('desktop:set-start-with-windows', value) as Promise<{ startWithWindows: boolean; supported: boolean }>,
  getUpdateState: () => ipcRenderer.invoke('desktop:get-update-state') as Promise<DesktopUpdateState>,
  checkForUpdates: () => ipcRenderer.invoke('desktop:check-for-updates') as Promise<DesktopUpdateState>,
  downloadUpdate: () => ipcRenderer.invoke('desktop:download-update') as Promise<DesktopUpdateState>,
  installUpdate: () => ipcRenderer.invoke('desktop:install-update') as Promise<DesktopUpdateState>,
  openReleasePage: () => ipcRenderer.invoke('desktop:open-release-page') as Promise<void>,
  onUpdateState: (listener: (state: DesktopUpdateState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: DesktopUpdateState) => listener(state)
    ipcRenderer.on('desktop:update-state', handler)
    return () => ipcRenderer.removeListener('desktop:update-state', handler)
  },
  quit: () => ipcRenderer.invoke('desktop:quit') as Promise<void>,
})
