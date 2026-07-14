import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('obsStreamManagerDesktop', {
  dockUrl: 'http://127.0.0.1:4317',
  openExternal: (url: string) => ipcRenderer.invoke('desktop:open-external', url) as Promise<void>,
  copyDockUrl: () => ipcRenderer.invoke('desktop:copy-dock-url') as Promise<void>,
})
