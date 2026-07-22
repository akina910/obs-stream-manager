import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  backgroundLaunchArgument,
  DesktopPreferenceStore,
  hasDesktopArgument,
  parseDesktopPreferences,
  quitApplicationArgument,
  windowsCompanionRegistrationArguments,
  windowsCompanionRegistryKey,
  syncWindowsStartupRegistration,
  shouldShowWindowForSecondInstance,
  supportsWindowsLoginStart,
  windowsAppId,
  windowsStartupTaskArguments,
  windowsStartupTaskName,
} from './integration.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('desktop integration lifecycle', () => {
  it('distinguishes background and explicit quit launches', () => {
    expect(hasDesktopArgument(['app.exe', backgroundLaunchArgument], backgroundLaunchArgument)).toBe(true)
    expect(hasDesktopArgument(['app.exe', quitApplicationArgument], quitApplicationArgument)).toBe(true)
    expect(hasDesktopArgument(['app.exe'], backgroundLaunchArgument)).toBe(false)
    expect(shouldShowWindowForSecondInstance(['app.exe'])).toBe(true)
    expect(shouldShowWindowForSecondInstance(['app.exe', backgroundLaunchArgument])).toBe(false)
    expect(shouldShowWindowForSecondInstance(['app.exe', quitApplicationArgument])).toBe(false)
  })

  it('enables Windows login start only for installed packaged builds', () => {
    expect(supportsWindowsLoginStart(true, undefined, true)).toBe(true)
    expect(supportsWindowsLoginStart(true, 'C:\\portable\\OBS Stream Manager.exe', true)).toBe(false)
    expect(supportsWindowsLoginStart(true, undefined, false)).toBe(false)
    expect(supportsWindowsLoginStart(false, undefined, true)).toBe(false)
  })

  it('builds an immediate per-user logon task for the installed app', () => {
    expect(windowsStartupTaskArguments(true, 'C:\\Program Files\\OBS Stream Manager\\OBS Stream Manager.exe')).toEqual([
      '/Create',
      '/F',
      '/SC',
      'ONLOGON',
      '/RL',
      'LIMITED',
      '/TN',
      windowsStartupTaskName,
      '/TR',
      '"C:\\Program Files\\OBS Stream Manager\\OBS Stream Manager.exe" --background',
    ])
    expect(windowsStartupTaskArguments(false, 'ignored.exe')).toEqual(['/Delete', '/F', '/TN', windowsStartupTaskName])
    expect(() => windowsStartupTaskArguments(true, 'C:\\invalid"path.exe')).toThrow()
  })

  it('registers both installed and portable executables for the OBS companion plugin', () => {
    expect(windowsCompanionRegistrationArguments('D:\\Tools\\OBS Stream Manager.exe')).toEqual([
      'ADD',
      windowsCompanionRegistryKey,
      '/v',
      'ExecutablePath',
      '/t',
      'REG_SZ',
      '/d',
      'D:\\Tools\\OBS Stream Manager.exe',
      '/f',
    ])
    expect(() => windowsCompanionRegistrationArguments('bad\npath.exe')).toThrow()
  })

  it('uses the immediate task and removes the delayed login item when task registration succeeds', async () => {
    const taskArguments: string[][] = []
    const loginItems: unknown[] = []
    const registration = await syncWindowsStartupRegistration(
      true,
      'C:\\OBS Stream Manager.exe',
      async (args) => { taskArguments.push(args) },
      (settings) => { loginItems.push(settings) },
    )
    expect(registration).toBe('task')
    expect(taskArguments[0]).toEqual(windowsStartupTaskArguments(true, 'C:\\OBS Stream Manager.exe'))
    expect(loginItems).toEqual([{ openAtLogin: false, path: 'C:\\OBS Stream Manager.exe', args: [] }])
  })

  it('falls back to the login item when task registration is unavailable', async () => {
    const loginItems: unknown[] = []
    const registration = await syncWindowsStartupRegistration(
      true,
      'C:\\OBS Stream Manager.exe',
      async () => { throw new Error('access denied') },
      (settings) => { loginItems.push(settings) },
    )
    expect(registration).toBe('login-item')
    expect(loginItems).toEqual([{
      openAtLogin: true,
      path: 'C:\\OBS Stream Manager.exe',
      args: [backgroundLaunchArgument],
    }])
  })

  it('removes both startup registrations when login start is disabled', async () => {
    const taskArguments: string[][] = []
    const loginItems: unknown[] = []
    const registration = await syncWindowsStartupRegistration(
      false,
      'C:\\OBS Stream Manager.exe',
      async (args) => { taskArguments.push(args) },
      (settings) => { loginItems.push(settings) },
    )
    expect(registration).toBe('disabled')
    expect(taskArguments[0]).toEqual(windowsStartupTaskArguments(false, 'C:\\OBS Stream Manager.exe'))
    expect(loginItems).toEqual([{ openAtLogin: false, path: 'C:\\OBS Stream Manager.exe', args: [] }])
  })

  it('migrates missing or malformed preferences to the requested default', () => {
    expect(parseDesktopPreferences(null, true)).toEqual({ version: 1, startWithWindows: true })
    expect(parseDesktopPreferences({ startWithWindows: false }, true)).toEqual({ version: 1, startWithWindows: false })
    expect(parseDesktopPreferences({ startWithWindows: 'yes' }, false)).toEqual({ version: 1, startWithWindows: false })
  })

  it('persists an explicit startup choice across app restarts', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'obs-stream-manager-desktop-'))
    directories.push(directory)
    const first = new DesktopPreferenceStore(directory, true)
    await expect(first.read()).resolves.toEqual({ version: 1, startWithWindows: true })
    await first.setStartWithWindows(false)
    const restarted = new DesktopPreferenceStore(directory, true)
    await expect(restarted.read()).resolves.toEqual({ version: 1, startWithWindows: false })
    await expect(readFile(path.join(directory, 'config', 'desktop.json'), 'utf8')).resolves.toContain('"startWithWindows": false')
  })

  it('removes the exact Electron login item during NSIS uninstall', async () => {
    const installer = await readFile(new URL('../installer.nsh', import.meta.url), 'utf8')
    expect(installer).toContain(`"${windowsAppId}"`)
    expect(installer).toContain(`/TN "${windowsStartupTaskName}"`)
    expect(installer).toContain('WriteRegStr HKCU "Software\\OBS Stream Manager" "ExecutablePath"')
    expect(installer).toContain('DeleteRegKey HKCU "Software\\OBS Stream Manager"')
  })

  it('restores the OBS plugin during install so OBS can start the companion immediately after an upgrade', async () => {
    const installer = await readFile(new URL('../installer.nsh', import.meta.url), 'utf8')
    const builder = await readFile(new URL('../electron-builder.yml', import.meta.url), 'utf8')

    expect(installer).toContain('ReadEnvStr $1 "ProgramData"')
    expect(installer).toContain('CopyFiles /SILENT "$INSTDIR\\resources\\obs-plugin\\bin\\64bit\\obs-stream-manager-output.dll"')
    expect(installer).toContain('$1\\obs-studio\\plugins\\obs-stream-manager-output\\bin\\64bit\\obs-stream-manager-output.dll')
    expect(builder).toContain('oneClick: true')
    expect(builder).toContain('perMachine: true')
    expect(builder).toContain('requestExecutionLevel: admin')
  })

  it('lets the installed OBS plugin start the companion before the dock is loaded', async () => {
    const plugin = await readFile(new URL('../native/obs-stream-manager-output/src/plugin-main.c', import.meta.url), 'utf8')
    expect(plugin).toContain('RegGetValueW(HKEY_CURRENT_USER')
    expect(plugin).toContain('L"Software\\\\OBS Stream Manager"')
    expect(plugin).toContain('CreateProcessW(executable')
    expect(plugin).toContain('L"\\"%ls\\" --background"')
  })
})
