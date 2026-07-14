export {}

declare global {
  interface Window {
    obsStreamManagerDesktop?: {
      dockUrl: string
      openExternal: (url: string) => Promise<void>
      copyDockUrl: () => Promise<void>
    }
  }
}
