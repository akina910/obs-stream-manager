import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const backgroundLaunchArgument = '--background'
export const quitApplicationArgument = '--quit'
export const windowsAppId = 'io.github.akina910.obs-stream-manager'
export const windowsStartupTaskName = 'OBS Stream Manager'
export const windowsCompanionRegistryKey = 'HKCU\\Software\\OBS Stream Manager'

export type WindowsStartupRegistration = 'disabled' | 'login-item' | 'task'

type LoginItemSettings = {
  openAtLogin: boolean
  path: string
  args: string[]
}

type StartupTaskRunner = (args: string[]) => Promise<void>
type LoginItemSetter = (settings: LoginItemSettings) => void

export type DesktopIntegrationSettings = {
  startWithWindows: boolean
  supported: boolean
}

type StoredDesktopPreferences = {
  version: 1
  startWithWindows: boolean
}

export function hasDesktopArgument(args: string[], argument: string): boolean {
  return args.includes(argument)
}

export function shouldShowWindowForSecondInstance(args: string[]): boolean {
  return !hasDesktopArgument(args, quitApplicationArgument) && !hasDesktopArgument(args, backgroundLaunchArgument)
}

export function supportsWindowsLoginStart(isPackaged: boolean, portableExecutableFile: string | undefined, installedMarkerExists: boolean): boolean {
  return isPackaged && !portableExecutableFile && installedMarkerExists
}

export function windowsStartupTaskArguments(enabled: boolean, executablePath: string): string[] {
  if (!enabled) return ['/Delete', '/F', '/TN', windowsStartupTaskName]
  if (/["\r\n]/.test(executablePath)) throw new Error('The application path cannot be registered as a Windows startup task')
  return [
    '/Create',
    '/F',
    '/SC',
    'ONLOGON',
    '/RL',
    'LIMITED',
    '/TN',
    windowsStartupTaskName,
    '/TR',
    `"${executablePath}" ${backgroundLaunchArgument}`,
  ]
}

export async function runWindowsStartupTaskCommand(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile('schtasks.exe', args, { timeout: 5_000, windowsHide: true }, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

export function windowsCompanionRegistrationArguments(executablePath: string): string[] {
  if (!executablePath.trim() || /[\r\n\0]/.test(executablePath)) throw new Error('The companion application path cannot be registered')
  return ['ADD', windowsCompanionRegistryKey, '/v', 'ExecutablePath', '/t', 'REG_SZ', '/d', executablePath, '/f']
}

export async function registerWindowsCompanionExecutable(executablePath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile('reg.exe', windowsCompanionRegistrationArguments(executablePath), { timeout: 5_000, windowsHide: true }, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

export async function syncWindowsStartupRegistration(
  enabled: boolean,
  executablePath: string,
  runTask: StartupTaskRunner,
  setLoginItem: LoginItemSetter,
): Promise<WindowsStartupRegistration> {
  if (!enabled) {
    await runTask(windowsStartupTaskArguments(false, executablePath)).catch(() => undefined)
    setLoginItem({ openAtLogin: false, path: executablePath, args: [] })
    return 'disabled'
  }

  try {
    await runTask(windowsStartupTaskArguments(true, executablePath))
    // Task Scheduler starts ONLOGON tasks before Windows processes its delayed
    // startup-app queue. Keep only one registration to avoid duplicate launches.
    setLoginItem({ openAtLogin: false, path: executablePath, args: [] })
    return 'task'
  } catch {
    setLoginItem({ openAtLogin: true, path: executablePath, args: [backgroundLaunchArgument] })
    return 'login-item'
  }
}

export function parseDesktopPreferences(value: unknown, defaultStartWithWindows: boolean): StoredDesktopPreferences {
  if (!value || typeof value !== 'object') return { version: 1, startWithWindows: defaultStartWithWindows }
  const candidate = value as Partial<StoredDesktopPreferences>
  return {
    version: 1,
    startWithWindows: typeof candidate.startWithWindows === 'boolean' ? candidate.startWithWindows : defaultStartWithWindows,
  }
}

export class DesktopPreferenceStore {
  private readonly filename: string

  constructor(dataDirectory: string, private readonly defaultStartWithWindows: boolean) {
    this.filename = path.join(dataDirectory, 'config', 'desktop.json')
  }

  async read(): Promise<StoredDesktopPreferences> {
    try {
      return parseDesktopPreferences(JSON.parse(await readFile(this.filename, 'utf8')), this.defaultStartWithWindows)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
      const preferences = parseDesktopPreferences(null, this.defaultStartWithWindows)
      await this.write(preferences)
      return preferences
    }
  }

  async setStartWithWindows(startWithWindows: boolean): Promise<StoredDesktopPreferences> {
    const preferences = { version: 1 as const, startWithWindows }
    await this.write(preferences)
    return preferences
  }

  private async write(preferences: StoredDesktopPreferences): Promise<void> {
    await mkdir(path.dirname(this.filename), { recursive: true })
    const temporary = `${this.filename}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify(preferences, null, 2), 'utf8')
    await rename(temporary, this.filename)
  }
}
