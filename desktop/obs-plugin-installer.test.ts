import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  installObsPluginFiles,
  ObsPluginInstallRetry,
  obsPluginDiscoveryEnvironment,
  obsPluginDiscoveryPaths,
  obsPluginInstallPaths,
  windowsObsPluginDiscoveryArguments,
  type ObsPluginInstallState,
} from './obs-plugin-installer.js'

const directories: string[] = []

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'obs-stream-manager-plugin-'))
  directories.push(directory)
  const source = path.join(directory, 'source.dll')
  const pluginRoot = path.join(directory, 'plugin')
  const paths = obsPluginInstallPaths(pluginRoot)
  await mkdir(paths.targetDirectory, { recursive: true })
  await writeFile(source, 'new-plugin')
  await writeFile(paths.target, 'old-plugin')
  return { pluginRoot, source, paths }
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('OBS plugin installer', () => {
  it('registers the isolated binary and data roots that OBS loads on Windows', () => {
    const pluginRoot = 'C:\\Users\\tester\\AppData\\Roaming\\obs-studio\\plugins\\obs-stream-manager-output-v2'
    expect(obsPluginDiscoveryPaths(pluginRoot)).toEqual({
      pluginPath: path.join(pluginRoot, 'bin', '64bit'),
      dataPath: path.join(pluginRoot, 'data'),
    })
    const args = windowsObsPluginDiscoveryArguments()
    expect(args.join(' ')).toContain('EnvironmentVariableTarget')
    expect(args.join(' ')).toContain('OBS_STREAM_MANAGER_DISCOVERY_PLUGIN_PATH')
    expect(obsPluginDiscoveryEnvironment(pluginRoot, { SAFE_EXISTING: 'preserved' })).toMatchObject({
      SAFE_EXISTING: 'preserved',
      OBS_STREAM_MANAGER_DISCOVERY_PLUGIN_PATH: path.join(pluginRoot, 'bin', '64bit'),
      OBS_STREAM_MANAGER_DISCOVERY_DATA_PATH: path.join(pluginRoot, 'data'),
    })
  })

  it('rejects unsafe OBS discovery paths before invoking PowerShell', () => {
    expect(() => obsPluginDiscoveryEnvironment('C:\\plugins\nmalformed')).toThrow()
  })

  it('stages a locked DLL outside the OBS load directory and promotes it on retry', async () => {
    const test = await fixture()
    let targetCopyAttempts = 0
    const operations = {
      copyFile: async (source: string, destination: string) => {
        if (destination === test.paths.target && targetCopyAttempts++ === 0) {
          const error = new Error('locked') as NodeJS.ErrnoException
          error.code = 'EBUSY'
          throw error
        }
        await copyFile(source, destination)
      },
      mkdir: async (directory: string) => { await mkdir(directory, { recursive: true }) },
      readFile: async (filename: string) => readFile(filename),
      rename,
      rm: async (filename: string) => { await rm(filename, { force: true }) },
      exists: async (filename: string) => {
        try { await stat(filename); return true } catch { return false }
      },
    }

    await expect(installObsPluginFiles({ source: test.source, pluginRoot: test.pluginRoot, operations })).resolves.toBe('pending')
    await expect(readFile(test.paths.target, 'utf8')).resolves.toBe('old-plugin')
    await expect(readFile(test.paths.pending, 'utf8')).resolves.toBe('new-plugin')
    expect(path.dirname(test.paths.pending)).not.toBe(test.paths.targetDirectory)

    await expect(installObsPluginFiles({ source: test.source, pluginRoot: test.pluginRoot })).resolves.toBe('current')
    await expect(readFile(test.paths.target, 'utf8')).resolves.toBe('new-plugin')
    await expect(stat(test.paths.pending)).rejects.toThrow()
  })

  it('keeps a matching installed DLL and removes stale staged data', async () => {
    const test = await fixture()
    await writeFile(test.paths.target, 'new-plugin')
    await mkdir(path.dirname(test.paths.pending), { recursive: true })
    await writeFile(test.paths.pending, 'stale-plugin')

    await expect(installObsPluginFiles({ source: test.source, pluginRoot: test.pluginRoot })).resolves.toBe('current')
    await expect(readFile(test.paths.target, 'utf8')).resolves.toBe('new-plugin')
    await expect(stat(test.paths.pending)).rejects.toThrow()
  })

  it('removes the legacy pending DLL from the OBS module load directory', async () => {
    const test = await fixture()
    await writeFile(test.paths.target, 'new-plugin')
    await writeFile(test.paths.legacyPending, 'old-staged-plugin')

    await expect(installObsPluginFiles({ source: test.source, pluginRoot: test.pluginRoot })).resolves.toBe('current')
    await expect(stat(test.paths.legacyPending)).rejects.toThrow()
  })

  it('stages the update once and reports a non-retrying permission failure', async () => {
    const test = await fixture()
    let stagedCopies = 0
    const operations = {
      copyFile: async (source: string, destination: string) => {
        if (destination === test.paths.target) {
          const error = new Error('access denied') as NodeJS.ErrnoException
          error.code = 'EACCES'
          throw error
        }
        if (destination === test.paths.pending) stagedCopies += 1
        await copyFile(source, destination)
      },
      mkdir: async (directory: string) => { await mkdir(directory, { recursive: true }) },
      readFile: async (filename: string) => readFile(filename),
      rename,
      rm: async (filename: string) => {
        if (filename === test.paths.target) {
          const error = new Error('access denied') as NodeJS.ErrnoException
          error.code = 'EACCES'
          throw error
        }
        await rm(filename, { force: true })
      },
      exists: async (filename: string) => {
        try { await stat(filename); return true } catch { return false }
      },
    }

    const options = { source: test.source, pluginRoot: test.pluginRoot, operations, isObsRunning: async () => false }
    await expect(installObsPluginFiles(options)).resolves.toBe('permission_required')
    await expect(readFile(test.paths.pending, 'utf8')).resolves.toBe('new-plugin')
    await expect(installObsPluginFiles(options)).resolves.toBe('permission_required')
    expect(stagedCopies).toBe(1)

    const install = vi.fn(async (): Promise<ObsPluginInstallState> => 'permission_required')
    const retry = new ObsPluginInstallRetry(install, vi.fn(), 500)
    retry.start('permission_required')
    expect(retry.isActive()).toBe(false)
  })

  it('classifies an ACL-blocked legacy DLL as a permission failure while OBS is stopped', async () => {
    const test = await fixture()
    await writeFile(test.paths.target, 'new-plugin')
    await writeFile(test.paths.legacyPending, 'old-staged-plugin')
    const operations = {
      copyFile,
      mkdir: async (directory: string) => { await mkdir(directory, { recursive: true }) },
      readFile: async (filename: string) => readFile(filename),
      rename,
      rm: async (filename: string) => {
        if (filename === test.paths.legacyPending) {
          const error = new Error('access denied') as NodeJS.ErrnoException
          error.code = 'EACCES'
          throw error
        }
        await rm(filename, { force: true })
      },
      exists: async (filename: string) => {
        try { await stat(filename); return true } catch { return false }
      },
    }

    await expect(installObsPluginFiles({
      source: test.source,
      pluginRoot: test.pluginRoot,
      operations,
      isObsRunning: async () => false,
    })).resolves.toBe('permission_required')
  })

  it('keeps retrying transient unavailable results until installation succeeds', async () => {
    vi.useFakeTimers()
    const states: ObsPluginInstallState[] = ['unavailable', 'pending', 'current']
    const install = vi.fn(async () => states.shift() ?? 'current')
    const onState = vi.fn()
    const retry = new ObsPluginInstallRetry(install, onState, 500)

    retry.start('pending')
    expect(retry.isActive()).toBe(true)

    await vi.advanceTimersByTimeAsync(500)
    expect(onState).toHaveBeenLastCalledWith('pending', 'unavailable')
    expect(retry.isActive()).toBe(true)

    await vi.advanceTimersByTimeAsync(500)
    expect(onState).toHaveBeenLastCalledWith('pending', 'pending')
    expect(retry.isActive()).toBe(true)

    await vi.advanceTimersByTimeAsync(500)
    expect(onState).toHaveBeenLastCalledWith('current', 'current')
    expect(retry.isActive()).toBe(false)
    expect(install).toHaveBeenCalledTimes(3)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(install).toHaveBeenCalledTimes(3)
  })

  it('does not report the same pending retry state on every interval', async () => {
    vi.useFakeTimers()
    const install = vi.fn(async (): Promise<ObsPluginInstallState> => 'pending')
    const onState = vi.fn()
    const retry = new ObsPluginInstallRetry(install, onState, 500)

    retry.start('pending')
    await vi.advanceTimersByTimeAsync(1_500)

    expect(install).toHaveBeenCalledTimes(3)
    expect(onState).not.toHaveBeenCalled()
    retry.stop()
  })
})
