import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const backgroundLaunchArgument = '--background'
export const quitApplicationArgument = '--quit'
export const windowsAppId = 'io.github.akina910.obs-stream-manager'

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

export function supportsWindowsLoginStart(isPackaged: boolean, portableExecutableFile: string | undefined, installedMarkerExists: boolean): boolean {
  return isPackaged && !portableExecutableFile && installedMarkerExists
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
