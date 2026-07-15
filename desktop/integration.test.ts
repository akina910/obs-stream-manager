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
  supportsWindowsLoginStart,
  windowsAppId,
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
  })

  it('enables Windows login start only for installed packaged builds', () => {
    expect(supportsWindowsLoginStart(true, undefined, true)).toBe(true)
    expect(supportsWindowsLoginStart(true, 'C:\\portable\\OBS Stream Manager.exe', true)).toBe(false)
    expect(supportsWindowsLoginStart(true, undefined, false)).toBe(false)
    expect(supportsWindowsLoginStart(false, undefined, true)).toBe(false)
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
  })
})
