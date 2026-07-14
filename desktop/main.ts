import { appendFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'

type ServerModule = {
  startServer: () => Promise<{ url: string }>
  stopServer: () => Promise<void>
}

const dockUrl = 'http://127.0.0.1:4317'
const allowedExternalHosts = new Set([
  'accounts.google.com',
  'www.twitch.tv',
  'twitch.tv',
  'id.twitch.tv',
])

let mainWindow: BrowserWindow | null = null
let serverModule: ServerModule | null = null
let shutdownStarted = false
let shutdownComplete = false

async function markLifecycle(stage: string): Promise<void> {
  const directory = process.env.OBS_STREAM_MANAGER_DATA_DIR?.trim()
    || path.join(app.getPath('appData'), 'obs-stream-manager')
  await mkdir(path.join(directory, 'logs'), { recursive: true })
  await appendFile(path.join(directory, 'logs', 'desktop.log'), `${new Date().toISOString()} ${stage}\n`, 'utf8')
}

function safeError(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return raw
    .replace(/(access_token|refresh_token|authorization|password|stream_key|code)=?[^\s&]*/gi, '$1=[redacted]')
    .slice(0, 4_000)
}

async function writeStartupError(error: unknown): Promise<string> {
  const directory = path.join(app.getPath('appData'), 'obs-stream-manager', 'logs')
  await mkdir(directory, { recursive: true })
  const filename = path.join(directory, 'desktop-errors.log')
  await appendFile(filename, `${new Date().toISOString()} ${safeError(error)}\n`, 'utf8')
  return filename
}

async function providerBundlePath(): Promise<string | null> {
  const filename = app.isPackaged
    ? path.join(process.resourcesPath, 'provider-oauth.json')
    : path.resolve('build/provider-oauth.json')
  try {
    const bundle = JSON.parse(await readFile(filename, 'utf8')) as { youtube?: unknown; twitch?: unknown }
    return bundle.youtube || bundle.twitch ? filename : null
  } catch {
    return null
  }
}

function isAllowedExternalUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && allowedExternalHosts.has(url.hostname)
  } catch {
    return false
  }
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 820,
    height: 900,
    minWidth: 420,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#090b10',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(import.meta.dirname, 'preload.cjs'),
    },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(dockUrl)) event.preventDefault()
  })
  window.once('ready-to-show', () => window.show())
  window.on('closed', () => { mainWindow = null })
  void window.loadURL(`${dockUrl}/?desktop=1`)
  return window
}

void markLifecycle('module-loaded').catch(() => undefined)
if (!app.requestSingleInstanceLock()) {
  void markLifecycle('second-instance-exiting').catch(() => undefined)
  app.quit()
} else {
  void markLifecycle('single-instance-lock-acquired').catch(() => undefined)
  app.setAppUserModelId('io.github.akina910.obs-stream-manager')
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  ipcMain.handle('desktop:open-external', async (_event, url: unknown) => {
    if (typeof url !== 'string' || !isAllowedExternalUrl(url)) throw new Error('許可されていない外部URLです')
    await shell.openExternal(url)
  })
  ipcMain.handle('desktop:copy-dock-url', () => clipboard.writeText(dockUrl))

  app.on('before-quit', (event) => {
    if (shutdownComplete || !serverModule) return
    event.preventDefault()
    if (shutdownStarted) return
    shutdownStarted = true
    void serverModule.stopServer()
      .catch(async (error) => { await writeStartupError(error) })
      .finally(() => {
        shutdownComplete = true
        app.quit()
      })
  })
  app.on('window-all-closed', () => app.quit())

  void app.whenReady().then(async () => {
    await markLifecycle('electron-ready').catch(() => undefined)
    try {
      process.env.OBS_STREAM_MANAGER_EMBEDDED = '1'
      process.env.PORT = '4317'
      process.env.HOST = '127.0.0.1'
      process.env.OBS_STREAM_MANAGER_DATA_DIR ||= path.join(app.getPath('appData'), 'obs-stream-manager')
      const providerFile = await providerBundlePath()
      if (providerFile) process.env.OBS_STREAM_MANAGER_PROVIDER_OAUTH_FILE = providerFile
      serverModule = await import('../server/index.js') as ServerModule
      await markLifecycle('server-module-loaded').catch(() => undefined)
      await serverModule.startServer()
      await markLifecycle('server-listening').catch(() => undefined)
      mainWindow = createWindow()
      await markLifecycle('window-created').catch(() => undefined)
    } catch (error) {
      const filename = await writeStartupError(error).catch(() => '(ログを保存できませんでした)')
      dialog.showErrorBox(
        'OBS Stream Manager を起動できません',
        `${safeError(error)}\n\n詳細ログ: ${filename}\n\n別のOBS Stream Managerが起動していないか確認してください。`,
      )
      shutdownComplete = true
      app.quit()
    }
  })
}
