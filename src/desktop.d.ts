export {}

import type { DesktopUpdateState } from '../shared/update-contracts'

declare global {
  interface Window {
    obsStreamManagerDesktop?: {
      dockUrl: string
      openExternal: (url: string) => Promise<void>
      copyDockUrl: () => Promise<void>
      getIntegrationSettings: () => Promise<{ startWithWindows: boolean; supported: boolean }>
      setStartWithWindows: (value: boolean) => Promise<{ startWithWindows: boolean; supported: boolean }>
      getUpdateState: () => Promise<DesktopUpdateState>
      checkForUpdates: () => Promise<DesktopUpdateState>
      downloadUpdate: () => Promise<DesktopUpdateState>
      installUpdate: () => Promise<DesktopUpdateState>
      openReleasePage: () => Promise<void>
      onUpdateState: (listener: (state: DesktopUpdateState) => void) => () => void
      quit: () => Promise<void>
    }
  }
}
