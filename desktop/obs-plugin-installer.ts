import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { OBS_OUTPUT_PLUGIN_DIRECTORY, OBS_OUTPUT_PLUGIN_FILENAME } from '../shared/obs-output-plugin.js'

export type ObsPluginInstallState = 'unavailable' | 'current' | 'installed' | 'pending' | 'permission_required'

type FileOperations = {
  copyFile(source: string, destination: string): Promise<void>
  mkdir(directory: string): Promise<void>
  readFile(filename: string): Promise<Buffer>
  rename(source: string, destination: string): Promise<void>
  rm(filename: string): Promise<void>
  exists(filename: string): Promise<boolean>
}

const defaultFileOperations: FileOperations = {
  copyFile,
  mkdir: async (directory) => { await mkdir(directory, { recursive: true }) },
  readFile: async (filename) => readFile(filename),
  rename,
  rm: async (filename) => { await rm(filename, { force: true }) },
  exists: async (filename) => {
    try {
      await stat(filename)
      return true
    } catch {
      return false
    }
  },
}

export type ObsPluginInstallOptions = {
  source: string
  pluginRoot: string
  localeSource?: string | null
  operations?: FileOperations
  isObsRunning?: () => Promise<boolean>
}

const obsPluginDiscoveryPowerShell = [
  "$pluginPath = $env:OBS_STREAM_MANAGER_DISCOVERY_PLUGIN_PATH",
  "$dataPath = $env:OBS_STREAM_MANAGER_DISCOVERY_DATA_PATH",
  "$target = [EnvironmentVariableTarget]::User",
  "if ([Environment]::GetEnvironmentVariable('OBS_PLUGINS_PATH', $target) -ne $pluginPath) { [Environment]::SetEnvironmentVariable('OBS_PLUGINS_PATH', $pluginPath, $target) }",
  "if ([Environment]::GetEnvironmentVariable('OBS_PLUGINS_DATA_PATH', $target) -ne $dataPath) { [Environment]::SetEnvironmentVariable('OBS_PLUGINS_DATA_PATH', $dataPath, $target) }",
].join('; ')

export function obsPluginDiscoveryPaths(pluginRoot: string) {
  if (!pluginRoot.trim() || /[\r\n\0]/.test(pluginRoot)) throw new Error('The OBS plugin directory cannot be registered')
  return {
    pluginPath: path.join(pluginRoot, 'bin', '64bit'),
    dataPath: path.join(pluginRoot, 'data'),
  }
}

export function windowsObsPluginDiscoveryArguments(): string[] {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', obsPluginDiscoveryPowerShell]
}

export function obsPluginDiscoveryEnvironment(pluginRoot: string, baseEnvironment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { pluginPath, dataPath } = obsPluginDiscoveryPaths(pluginRoot)
  return {
    ...baseEnvironment,
    OBS_STREAM_MANAGER_DISCOVERY_PLUGIN_PATH: pluginPath,
    OBS_STREAM_MANAGER_DISCOVERY_DATA_PATH: dataPath,
  }
}

export async function registerWindowsObsPluginDiscovery(pluginRoot: string): Promise<void> {
  if (process.platform !== 'win32') return
  const executable = path.join(
    process.env.SystemRoot?.trim() || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
  await new Promise<void>((resolve, reject) => {
    execFile(
      executable,
      windowsObsPluginDiscoveryArguments(),
      { timeout: 8_000, windowsHide: true, env: obsPluginDiscoveryEnvironment(pluginRoot) },
      (error) => {
        if (error) reject(error)
        else resolve()
      },
    )
  })
}

export async function isObsProcessRunning(): Promise<boolean> {
  if (process.platform !== 'win32') return false
  return new Promise<boolean>((resolve) => {
    const executable = path.join(process.env.SystemRoot?.trim() || 'C:\\Windows', 'System32', 'tasklist.exe')
    execFile(
      executable,
      ['/FI', 'IMAGENAME eq obs64.exe', '/FO', 'CSV', '/NH'],
      { timeout: 3_000, windowsHide: true },
      (error, stdout) => {
        // A failed process check must not mislabel an active OBS lock as a
        // permanent ACL problem.
        if (error) resolve(true)
        else resolve(/"obs64\.exe"/i.test(stdout))
      },
    )
  })
}

export function obsPluginInstallPaths(pluginRoot: string) {
  const targetDirectory = path.join(pluginRoot, 'bin', '64bit')
  return {
    targetDirectory,
    target: path.join(targetDirectory, OBS_OUTPUT_PLUGIN_FILENAME),
    pending: path.join(pluginRoot, 'staging', `${OBS_OUTPUT_PLUGIN_FILENAME}.new`),
    legacyPending: path.join(targetDirectory, `${OBS_OUTPUT_PLUGIN_FILENAME}.pending`),
    localeTarget: path.join(pluginRoot, 'data', 'locale', 'en-US.ini'),
    discoveryLocaleTarget: path.join(pluginRoot, 'data', OBS_OUTPUT_PLUGIN_DIRECTORY, 'locale', 'en-US.ini'),
  }
}

export async function installObsPluginFiles(options: ObsPluginInstallOptions): Promise<ObsPluginInstallState> {
  const operations = options.operations ?? defaultFileOperations
  const obsRunning = options.isObsRunning ?? isObsProcessRunning
  const { targetDirectory, target, pending, legacyPending, localeTarget, discoveryLocaleTarget } = obsPluginInstallPaths(options.pluginRoot)
  const digest = async (filename: string) =>
    crypto.createHash('sha256').update(await operations.readFile(filename)).digest('hex')
  let cachedObsRunning: boolean | null = null
  const blockedByPermission = async (error: unknown): Promise<boolean> => {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code !== 'EACCES' && code !== 'EPERM') return false
    cachedObsRunning ??= await obsRunning().catch(() => true)
    return !cachedObsRunning
  }

  try {
    if (!await operations.exists(options.source)) return 'unavailable'
    await operations.mkdir(targetDirectory)
    await operations.mkdir(path.dirname(pending))

    if (options.localeSource && await operations.exists(options.localeSource)) {
      await operations.mkdir(path.dirname(localeTarget))
      await operations.mkdir(path.dirname(discoveryLocaleTarget))
      await operations.copyFile(options.localeSource, localeTarget).catch(() => undefined)
      await operations.copyFile(options.localeSource, discoveryLocaleTarget).catch(() => undefined)
    }

    let legacyCleanupPending = false
    let legacyCleanupPermissionRequired = false
    if (await operations.exists(legacyPending)) {
      let removeError: unknown = null
      await operations.rm(legacyPending).catch((error) => { removeError = error })
      legacyCleanupPending = await operations.exists(legacyPending)
      if (legacyCleanupPending && removeError) {
        legacyCleanupPermissionRequired = await blockedByPermission(removeError)
      }
    }

    let stagedIsCurrent = false
    if (await operations.exists(pending)) {
      stagedIsCurrent = await Promise.all([digest(pending), digest(options.source)])
        .then(([pendingDigest, sourceDigest]) => pendingDigest === sourceDigest)
        .catch(() => false)
      if (!stagedIsCurrent) {
        await operations.rm(pending).catch(() => undefined)
      } else {
        try {
          await operations.rm(target)
          await operations.rename(pending, target)
        } catch {
          // OBS may still have the loaded target locked. Keep the staged file
          // outside bin/64bit and retry after OBS exits.
        }
      }
    }

    if (await operations.exists(target)) {
      const current = await Promise.all([digest(target), digest(options.source)])
        .then(([targetDigest, sourceDigest]) => targetDigest === sourceDigest)
        .catch(() => false)
      if (current) {
        await operations.rm(pending).catch(() => undefined)
        if (legacyCleanupPermissionRequired) return 'permission_required'
        return legacyCleanupPending ? 'pending' : 'current'
      }
    }

    try {
      await operations.copyFile(options.source, target)
      await operations.rm(pending).catch(() => undefined)
      if (legacyCleanupPermissionRequired) return 'permission_required'
      return legacyCleanupPending ? 'pending' : 'installed'
    } catch (targetError) {
      if (!stagedIsCurrent) {
        try {
          await operations.copyFile(options.source, pending)
          stagedIsCurrent = true
        } catch {
          // A transient scanner/filesystem failure is still retryable while the
          // packaged source exists. Do not turn it into "reinstall the app".
        }
      }
      if (legacyCleanupPermissionRequired || await blockedByPermission(targetError)) return 'permission_required'
      return 'pending'
    }
  } catch {
    return 'unavailable'
  }
}

type RetryTimer = ReturnType<typeof setInterval> & { unref?: () => void }

export class ObsPluginInstallRetry {
  private timer: RetryTimer | null = null
  private inFlight = false
  private lastReportedState: string | null = null

  constructor(
    private readonly install: () => Promise<ObsPluginInstallState>,
    private readonly onState: (effectiveState: ObsPluginInstallState, observedState: ObsPluginInstallState) => void | Promise<void>,
    private readonly intervalMs = 3_000,
  ) {}

  start(initialState: ObsPluginInstallState): void {
    if (initialState !== 'pending' || this.timer) return
    this.lastReportedState = `${initialState}:${initialState}`
    this.timer = setInterval(() => { void this.tick() }, this.intervalMs) as RetryTimer
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  isActive(): boolean {
    return this.timer !== null
  }

  private async tick(): Promise<void> {
    if (this.inFlight) return
    this.inFlight = true
    try {
      const observedState = await this.install().catch((): ObsPluginInstallState => 'unavailable')
      const effectiveState = observedState === 'unavailable' ? 'pending' : observedState
      const reportKey = `${effectiveState}:${observedState}`
      if (reportKey !== this.lastReportedState) {
        this.lastReportedState = reportKey
        await this.onState(effectiveState, observedState)
      }
      if (observedState === 'current' || observedState === 'installed' || observedState === 'permission_required') this.stop()
    } finally {
      this.inFlight = false
    }
  }
}
