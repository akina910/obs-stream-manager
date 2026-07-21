import { existsSync } from 'node:fs'
import { appendFile, copyFile, mkdir, readFile, rename, rm } from 'node:fs/promises'
import crypto from 'node:crypto'
import path from 'node:path'
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron'
import electronUpdater from 'electron-updater'
import { RuntimeStatusSchema } from '../shared/contracts.js'
import { redactSensitiveText } from '../shared/redaction.js'
import type { DesktopUpdateState, UpdateBlockReason } from '../shared/update-contracts.js'
import {
  backgroundLaunchArgument,
  DesktopPreferenceStore,
  hasDesktopArgument,
  quitApplicationArgument,
  registerWindowsCompanionExecutable,
  runWindowsStartupTaskCommand,
  shouldShowWindowForSecondInstance,
  supportsWindowsLoginStart,
  syncWindowsStartupRegistration,
  windowsAppId,
  type DesktopIntegrationSettings,
  type WindowsStartupRegistration,
} from './integration.js'
import { hasStartupListenRetried, StartupListenTimeoutError, startupListenRetryArgs, withStartupListenTimeout } from './startup.js'
import { createElectronUpdateAdapter, getUpdateBlockReason, ManualUpdateService } from './updater.js'

type ServerModule = {
  startServer: () => Promise<{ url: string }>
  stopServer: () => Promise<void>
}

const dockUrl = 'http://127.0.0.1:4317'
const releasesUrl = 'https://github.com/akina910/obs-stream-manager/releases/latest'
const serverStartTimeoutMs = 10_000
const allowedExternalHosts = new Set([
  'accounts.google.com',
  'www.twitch.tv',
  'twitch.tv',
  'id.twitch.tv',
])

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let serverModule: ServerModule | null = null
let preferences: DesktopPreferenceStore | null = null
let integrationSettings: DesktopIntegrationSettings = { startWithWindows: false, supported: false }
let updateService: ManualUpdateService | null = null
let quitRequested = false
let shutdownStarted = false
let shutdownComplete = false
let closeNoticeShown = false

async function applyWindowsStartupRegistration(startWithWindows: boolean): Promise<WindowsStartupRegistration> {
  if (process.env.OBS_STREAM_MANAGER_DISABLE_LOGIN_ITEM === '1') return 'disabled'
  const registration = await syncWindowsStartupRegistration(
    startWithWindows,
    process.execPath,
    runWindowsStartupTaskCommand,
    (settings) => app.setLoginItemSettings(settings),
  )
  await markLifecycle(`windows-startup-${registration}`).catch(() => undefined)
  return registration
}

async function markLifecycle(stage: string): Promise<void> {
  const directory = process.env.OBS_STREAM_MANAGER_DATA_DIR?.trim()
    || path.join(app.getPath('appData'), 'obs-stream-manager')
  await mkdir(path.join(directory, 'logs'), { recursive: true })
  await appendFile(path.join(directory, 'logs', 'desktop.log'), `${new Date().toISOString()} ${stage}\n`, 'utf8')
}

function safeError(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return redactSensitiveText(raw).slice(0, 4_000)
}

function broadcastUpdateState(state: Readonly<DesktopUpdateState>): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('desktop:update-state', state)
}

async function getInstallBlocker(): Promise<UpdateBlockReason | null> {
  try {
    const response = await fetch(`${dockUrl}/api/status`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(3_000),
    })
    if (!response.ok) return 'status-unavailable'
    return getUpdateBlockReason(RuntimeStatusSchema.parse(await response.json()))
  } catch {
    return 'status-unavailable'
  }
}

function requireUpdateService(): ManualUpdateService {
  if (!updateService) throw new Error('The update service is not ready yet')
  return updateService
}

async function openReleasePage(): Promise<void> {
  await shell.openExternal(releasesUrl)
}

async function checkForUpdatesFromTray(): Promise<void> {
  showMainWindow()
  const state = await requireUpdateService().check()
  if (state.phase === 'available' && tray) {
    tray.displayBalloon({
      title: 'OBS Stream Manager',
      content: `更新 ${state.availableVersion ?? ''} を利用できます / Update available`,
      iconType: 'info',
    })
  }
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

async function installObsOutputPlugin(): Promise<'unavailable' | 'current' | 'installed' | 'pending'> {
  if (!app.isPackaged) return 'unavailable'
  const source = path.join(process.resourcesPath, 'obs-plugin', 'bin', '64bit', 'obs-stream-manager-output.dll')
  if (!existsSync(source)) return 'unavailable'
  const isolatedPluginRoot = process.env.OBS_STREAM_MANAGER_OBS_PLUGIN_DIR?.trim()
  if (!isolatedPluginRoot) {
    const legacyPluginRoot = path.join(app.getPath('appData'), 'obs-studio', 'plugins', 'obs-stream-manager-output')
    await rm(legacyPluginRoot, { recursive: true, force: true }).catch(() => {
      // A running OBS instance can keep the previous DLL locked. The installer also retries this migration.
    })
  }
  const programData = process.env.PROGRAMDATA?.trim() || process.env.ProgramData?.trim() || 'C:\\ProgramData'
  const pluginRoot = isolatedPluginRoot || path.join(programData, 'obs-studio', 'plugins', 'obs-stream-manager-output')
  const targetDirectory = path.join(pluginRoot, 'bin', '64bit')
  const target = path.join(targetDirectory, 'obs-stream-manager-output.dll')
  const pending = path.join(targetDirectory, 'obs-stream-manager-output.pending.dll')
  const digest = async (filename: string) => crypto.createHash('sha256').update(await readFile(filename)).digest('hex')
  try {
    await mkdir(targetDirectory, { recursive: true })
    const localeSource = path.join(process.resourcesPath, 'obs-plugin', 'data', 'locale', 'en-US.ini')
    if (existsSync(localeSource)) {
      const localeTarget = path.join(pluginRoot, 'data', 'locale', 'en-US.ini')
      await mkdir(path.dirname(localeTarget), { recursive: true })
      await copyFile(localeSource, localeTarget)
    }
    if (existsSync(pending)) {
      try {
        await rm(target, { force: true })
        await rename(pending, target)
      } catch { /* OBS may still have the previous DLL loaded */ }
    }
    if (existsSync(target) && await digest(target) === await digest(source)) return 'current'
    try {
      await copyFile(source, target)
      return 'installed'
    } catch {
      await copyFile(source, pending)
      return 'pending'
    }
  } catch {
    // Plugin installation must not prevent the local manager from starting.
    return 'unavailable'
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

function trayImage() {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#6f8dff"/><path d="M7 12V9a2 2 0 0 1 2-2h3M20 7h3a2 2 0 0 1 2 2v3M25 20v3a2 2 0 0 1-2 2h-3M12 25H9a2 2 0 0 1-2-2v-3" fill="none" stroke="#090b10" stroke-width="3" stroke-linecap="round"/><circle cx="16" cy="16" r="4" fill="#090b10"/></svg>'
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`).resize({ width: 16, height: 16 })
}

function requestApplicationQuit(): void {
  quitRequested = true
  app.quit()
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

async function setStartWithWindows(startWithWindows: boolean): Promise<DesktopIntegrationSettings> {
  if (!preferences || !integrationSettings.supported) return integrationSettings
  await preferences.setStartWithWindows(startWithWindows)
  integrationSettings = { ...integrationSettings, startWithWindows }
  await applyWindowsStartupRegistration(startWithWindows)
  rebuildTrayMenu()
  return integrationSettings
}

function rebuildTrayMenu(): void {
  if (!tray) return
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'OBS Stream Manager を開く / Open', click: showMainWindow },
    { label: 'ドックURLをコピー / Copy dock URL', click: () => clipboard.writeText(dockUrl) },
    {
      label: '更新を確認 / Check for updates',
      enabled: updateService !== null,
      click: () => { void checkForUpdatesFromTray().catch((error) => void writeStartupError(error)) },
    },
    { type: 'separator' },
    {
      label: 'Windowsログイン時に準備 / Start with Windows',
      type: 'checkbox',
      checked: integrationSettings.startWithWindows,
      enabled: integrationSettings.supported,
      click: (item) => { void setStartWithWindows(item.checked).catch((error) => void writeStartupError(error)) },
    },
    { type: 'separator' },
    { label: '完全に終了 / Quit completely', click: requestApplicationQuit },
  ]))
}

function createTray(): void {
  if (tray) return
  tray = new Tray(trayImage())
  tray.setToolTip('OBS Stream Manager - OBS dock server is running')
  tray.on('double-click', showMainWindow)
  rebuildTrayMenu()
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
      sandbox: true,
      preload: path.join(import.meta.dirname, 'preload.cjs'),
    },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(dockUrl)) event.preventDefault()
  })
  window.once('ready-to-show', () => window.show())
  window.on('close', (event) => {
    if (quitRequested) return
    event.preventDefault()
    window.hide()
    if (!closeNoticeShown && tray) {
      closeNoticeShown = true
      tray.displayBalloon({
        title: 'OBS Stream Manager',
        content: 'OBSドックを維持するためバックグラウンドで動作しています。完全終了はトレイメニューから選べます。',
        iconType: 'info',
      })
    }
  })
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
  app.setName('OBS Stream Manager')
  app.setAppUserModelId(windowsAppId)
  app.on('second-instance', (_event, argv) => {
    if (hasDesktopArgument(argv, quitApplicationArgument)) {
      requestApplicationQuit()
      return
    }
    if (shouldShowWindowForSecondInstance(argv)) showMainWindow()
  })

  ipcMain.handle('desktop:open-external', async (_event, url: unknown) => {
    if (typeof url !== 'string' || !isAllowedExternalUrl(url)) throw new Error('許可されていない外部URLです')
    await shell.openExternal(url)
  })
  ipcMain.handle('desktop:copy-dock-url', () => clipboard.writeText(dockUrl))
  ipcMain.handle('desktop:get-integration-settings', () => integrationSettings)
  ipcMain.handle('desktop:set-start-with-windows', async (_event, value: unknown) => {
    if (typeof value !== 'boolean') throw new Error('自動起動設定が不正です')
    return setStartWithWindows(value)
  })
  ipcMain.handle('desktop:get-update-state', () => requireUpdateService().getState())
  ipcMain.handle('desktop:check-for-updates', () => requireUpdateService().check())
  ipcMain.handle('desktop:download-update', () => requireUpdateService().download())
  ipcMain.handle('desktop:install-update', () => requireUpdateService().install())
  ipcMain.handle('desktop:open-release-page', openReleasePage)
  ipcMain.handle('desktop:quit', requestApplicationQuit)

  app.on('before-quit', (event) => {
    quitRequested = true
    if (shutdownComplete || !serverModule) return
    event.preventDefault()
    if (shutdownStarted) return
    shutdownStarted = true
    void serverModule.stopServer()
      .catch(async (error) => { await writeStartupError(error) })
      .finally(() => {
        shutdownComplete = true
        updateService?.dispose()
        updateService = null
        tray?.destroy()
        tray = null
        app.quit()
      })
  })
  app.on('window-all-closed', () => undefined)
  app.on('activate', showMainWindow)

  void app.whenReady().then(async () => {
    if (hasDesktopArgument(process.argv, quitApplicationArgument)) {
      requestApplicationQuit()
      return
    }
    await markLifecycle('electron-ready').catch(() => undefined)
    try {
      process.env.OBS_STREAM_MANAGER_EMBEDDED = '1'
      process.env.PORT = '4317'
      process.env.HOST = '127.0.0.1'
      process.env.OBS_STREAM_MANAGER_DATA_DIR ||= path.join(app.getPath('appData'), 'obs-stream-manager')
      const installedMarkerExists = existsSync(path.join(process.resourcesPath, 'installed-by-nsis'))
      const loginItemSupported = supportsWindowsLoginStart(app.isPackaged, process.env.PORTABLE_EXECUTABLE_FILE, installedMarkerExists)
      preferences = new DesktopPreferenceStore(process.env.OBS_STREAM_MANAGER_DATA_DIR, loginItemSupported)
      const storedPreferences = await preferences.read()
      integrationSettings = { supported: loginItemSupported, startWithWindows: loginItemSupported && storedPreferences.startWithWindows }
      if (loginItemSupported) await applyWindowsStartupRegistration(integrationSettings.startWithWindows)
      const providerFile = await providerBundlePath()
      if (providerFile) process.env.OBS_STREAM_MANAGER_PROVIDER_OAUTH_FILE = providerFile
      if (app.isPackaged && process.platform === 'win32') {
        try {
          await registerWindowsCompanionExecutable(process.execPath)
          await markLifecycle('obs-companion-registered').catch(() => undefined)
        } catch {
          await markLifecycle('obs-companion-registration-unavailable').catch(() => undefined)
        }
      }
      const obsPluginState = await installObsOutputPlugin()
      process.env.OBS_STREAM_MANAGER_OBS_PLUGIN_INSTALL_STATE = obsPluginState
      await markLifecycle(`obs-output-plugin-${obsPluginState}`).catch(() => undefined)
      serverModule = await import('../server/index.js') as ServerModule
      await markLifecycle('server-module-loaded').catch(() => undefined)
      await withStartupListenTimeout(serverModule.startServer(), serverStartTimeoutMs)
      await markLifecycle('server-listening').catch(() => undefined)
      const portableBuild = Boolean(process.env.PORTABLE_EXECUTABLE_FILE)
      updateService = new ManualUpdateService(createElectronUpdateAdapter(electronUpdater.autoUpdater), {
        currentVersion: app.getVersion(),
        packaged: app.isPackaged,
        portable: portableBuild,
        installSupported: app.isPackaged && process.platform === 'win32' && installedMarkerExists && !portableBuild,
        getInstallBlocker,
        onStateChange: broadcastUpdateState,
      })
      createTray()
      if (!hasDesktopArgument(process.argv, backgroundLaunchArgument)) {
        mainWindow = createWindow()
        await markLifecycle('window-created').catch(() => undefined)
      } else {
        await markLifecycle('background-ready').catch(() => undefined)
      }
    } catch (error) {
      if (error instanceof StartupListenTimeoutError && !hasStartupListenRetried(process.argv)) {
        await markLifecycle('server-listen-timeout-retrying').catch(() => undefined)
        app.relaunch({ args: startupListenRetryArgs(process.argv.slice(1)) })
        shutdownComplete = true
        app.exit(0)
        return
      }
      const filename = await writeStartupError(error).catch(() => '(ログを保存できませんでした)')
      dialog.showErrorBox(
        'OBS Stream Manager を起動できません',
        `${safeError(error)}\n\n詳細ログ: ${filename}\n\n別のOBS Stream Managerが起動していないか確認してください。`,
      )
      quitRequested = true
      shutdownComplete = true
      app.quit()
    }
  })
}
