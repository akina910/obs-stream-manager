export {}

declare global {
  interface Window {
    obsStreamManagerDesktop?: {
      dockUrl: string
      openExternal: (url: string) => Promise<void>
      copyDockUrl: () => Promise<void>
      getIntegrationSettings: () => Promise<{ startWithWindows: boolean; supported: boolean }>
      setStartWithWindows: (value: boolean) => Promise<{ startWithWindows: boolean; supported: boolean }>
      quit: () => Promise<void>
    }
  }
}
