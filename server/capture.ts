import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { CaptureMethod, GameProfile } from '../shared/contracts.js'
import { starterProfiles } from './defaults.js'

const execFileAsync = promisify(execFile)

const ignoredInstallExecutables = new Set([
  'cmd.exe',
  'cef_subprocess.exe',
  'crashreportclient.exe',
  'crashpad_handler.exe',
  'cscript.exe',
  'dotnet.exe',
  'dxsetup.exe',
  'easyanticheat_eos_setup.exe',
  'easyanticheat_setup.exe',
  'java.exe',
  'javaw.exe',
  'launcher.exe',
  'msedgewebview2.exe',
  'node.exe',
  'obs-browser-page.exe',
  'obs-ffmpeg-mux.exe',
  'obs64.exe',
  'powershell.exe',
  'pwsh.exe',
  'python.exe',
  'pythonw.exe',
  'steam.exe',
  'steamerrorreporter.exe',
  'steamerrorreporter64.exe',
  'steamservice.exe',
  'steamwebhelper.exe',
  'unitycrashhandler32.exe',
  'unitycrashhandler64.exe',
  'ue4prereqsetup_x64.exe',
  'unrealcefsubprocess.exe',
  'unins000.exe',
  'vc_redist.x64.exe',
  'vc_redist.x86.exe',
  'wscript.exe',
])

type CaptureDetectorOptions = {
  attempts?: number
  retryDelayMs?: number
  executableCacheMs?: number
}

export type RunningGameMatch = {
  profile: GameProfile
  method: CaptureMethod
  executableName: string
  windowTitle?: string
}

type JavaGameWindow = { executableName: string; windowTitle: string }

const javaExecutables = new Set(['java.exe', 'javaw.exe'])

export function isMinecraftGameWindowTitle(title: string): boolean {
  return /^Minecraft\*?(?:\s+\d(?:\.\d+)*(?:\b|$)|\s*$)/i.test(title)
}

function configuredRunningMatch(profile: GameProfile, processes: Set<string>, javaWindows: JavaGameWindow[]): Pick<RunningGameMatch, 'executableName' | 'windowTitle'> | undefined {
  const names = profile.capture.executableNames.map((name) => name.trim().toLowerCase()).filter(Boolean)
  if (profile.id === 'minecraft' && names.some((name) => javaExecutables.has(name))) names.push('java.exe', 'javaw.exe')
  for (const executableName of names) {
    if (!processes.has(executableName)) continue
    if (profile.id === 'minecraft' && javaExecutables.has(executableName)) {
      const window = javaWindows.find((item) => item.executableName === executableName
        && isMinecraftGameWindowTitle(item.windowTitle))
      if (window) return window
      continue
    }
    return { executableName }
  }
  return undefined
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function parseCsvLine(line: string): string[] {
  const values: string[] = []
  let value = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"'
        index += 1
      } else {
        quoted = !quoted
      }
    } else if (character === ',' && !quoted) {
      values.push(value)
      value = ''
    } else {
      value += character
    }
  }
  values.push(value)
  return values
}

function normalizedTitle(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu)?.join('') ?? ''
}

function geforceNowTitleForProfile(profile: GameProfile, windowTitles: string[]): string | undefined {
  const aliases = [
    profile.displayName,
    profile.presentation.templateLabel,
    profile.twitch.categoryName,
  ].map(normalizedTitle).filter((value) => value.length >= 3)
  return windowTitles.find((title) => {
    const normalizedWindow = normalizedTitle(title)
    return aliases.some((alias) => normalizedWindow.includes(alias))
  })
}

export function windowsTasklistExecutable(systemRoot = process.env.SystemRoot): string {
  const configuredRoot = systemRoot?.trim()
  const windowsRoot = configuredRoot && path.win32.isAbsolute(configuredRoot)
    ? configuredRoot
    : 'C:\\Windows'
  return path.win32.join(windowsRoot, 'System32', 'tasklist.exe')
}

export class CaptureDetector {
  private readonly attempts: number
  private readonly retryDelayMs: number
  private readonly executableCacheMs: number
  private readonly installExecutables = new Map<string, { names: string[]; expiresAt: number }>()
  private processInventoryFailure: string | null = null

  constructor(options: CaptureDetectorOptions = {}) {
    this.attempts = Math.max(1, options.attempts ?? 4)
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 500)
    this.executableCacheMs = Math.max(0, options.executableCacheMs ?? 5 * 60_000)
  }

  async runningProcesses(): Promise<string[]> {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync(windowsTasklistExecutable(), ['/fo', 'csv', '/nh'], { windowsHide: true })
      return stdout.split(/\r?\n/).map((line) => line.match(/^"([^"]+)"/)?.[1]?.toLowerCase()).filter((name): name is string => Boolean(name))
    }
    const { stdout } = await execFileAsync('ps', ['-A', '-o', 'comm='])
    return stdout.split(/\r?\n/).map((name) => name.trim().split('/').pop()?.toLowerCase()).filter((name): name is string => Boolean(name))
  }

  async runningGeForceNowWindowTitles(): Promise<string[]> {
    if (process.platform !== 'win32') return []
    const { stdout } = await execFileAsync(windowsTasklistExecutable(), [
      '/v',
      '/fi',
      'imagename eq GeForceNOW.exe',
      '/fo',
      'csv',
      '/nh',
    ], { windowsHide: true })
    return stdout
      .split(/\r?\n/)
      .map((line) => parseCsvLine(line).at(-1)?.trim())
      .filter((title): title is string => Boolean(title && title !== 'N/A' && title !== 'OleMainThreadWndName'))
  }

  async runningJavaGameWindows(): Promise<JavaGameWindow[]> {
    if (process.platform !== 'win32') return []
    const { stdout } = await execFileAsync(windowsTasklistExecutable(), [
      '/v', '/fi', 'imagename eq java*.exe', '/fo', 'csv', '/nh',
    ], { windowsHide: true })
    return stdout.split(/\r?\n/).flatMap((line) => {
      const columns = parseCsvLine(line)
      const executableName = columns[0]?.trim().toLowerCase()
      const windowTitle = columns[8]?.trim()
      return executableName && javaExecutables.has(executableName) && windowTitle
        ? [{ executableName, windowTitle }]
        : []
    })
  }

  private async minecraftWindows(profiles: GameProfile[], processes: Set<string>): Promise<JavaGameWindow[]> {
    if (!profiles.some(({ id }) => id === 'minecraft') || ![...javaExecutables].some((name) => processes.has(name))) return []
    return this.runningJavaGameWindows().catch(() => [])
  }

  private async safeRunningProcesses(): Promise<string[]> {
    try {
      const processes = await this.runningProcesses()
      this.processInventoryFailure = null
      return processes
    } catch (error) {
      this.processInventoryFailure = error instanceof Error ? error.message : String(error)
      return []
    }
  }

  processInventoryWarning(): string | null {
    return this.processInventoryFailure
      ? '実行中ソフトを確認できないため、ゲームの自動認識を一時停止しています'
      : null
  }

  private async installedExecutableNames(profile: GameProfile): Promise<string[]> {
    const installDirectory = profile.library.installDirectory?.trim()
    if (!installDirectory) return []
    const cacheKey = installDirectory.toLowerCase()
    const cached = this.installExecutables.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) return cached.names

    const names = [...new Set((await readdir(installDirectory, { recursive: true, withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.exe'))
      .map((entry) => entry.name.toLowerCase())
      .filter((name) => !ignoredInstallExecutables.has(name) && !/^unins\d*\.exe$/i.test(name)))]
    this.installExecutables.set(cacheKey, { names, expiresAt: Date.now() + this.executableCacheMs })
    return names
  }

  private async detectRunning(profile: GameProfile): Promise<{ localRunning: boolean; gfnRunning: boolean; gfnWindowTitle?: string }> {
    const processes = new Set(await this.safeRunningProcesses())
    const configuredRunning = Boolean(configuredRunningMatch(profile, processes, await this.minecraftWindows([profile], processes)))
    const installedRunning = configuredRunning
      ? false
      : (await this.installedExecutableNames(profile).catch(() => [])).some((name) => processes.has(name))
    const gfnRunning = [...processes].some((name) => name.includes('geforcenow') || name.includes('geforce now'))
    const gfnWindowTitle = gfnRunning
      ? geforceNowTitleForProfile(profile, await this.runningGeForceNowWindowTitles().catch(() => []))
      : undefined
    return {
      localRunning: configuredRunning || installedRunning,
      gfnRunning,
      gfnWindowTitle,
    }
  }

  async detectRunningProfile(profiles: GameProfile[], preferredProfileId?: string | null): Promise<RunningGameMatch | null> {
    const processes = new Set((await this.safeRunningProcesses())
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean))
    if (!processes.size) return null
    const candidates: Array<RunningGameMatch & { score: number }> = []
    const existingIds = new Set(profiles.map(({ id }) => id))
    const eligible = [
      ...profiles,
      ...starterProfiles.filter(({ id, platformGroup }) => platformGroup !== 'switch' && !existingIds.has(id)).map((profile) => structuredClone(profile)),
    ].filter(({ hidden, platformGroup }) => !hidden && platformGroup !== 'switch')
    const javaWindows = await this.minecraftWindows(eligible, processes)

    for (const profile of eligible) {
      const configured = configuredRunningMatch(profile, processes, javaWindows)
      if (!configured) continue
      const method = profile.capture.preferred === 'auto' ? 'local' : profile.capture.preferred
      const matchedProfile = profile.capture.executableNames.some((name) => name.toLowerCase() === configured.executableName)
        ? profile
        : { ...profile, capture: { ...profile.capture, executableNames: [...profile.capture.executableNames, configured.executableName] } }
      candidates.push({
        profile: matchedProfile,
        method,
        ...configured,
        score: 100 + (profile.id === preferredProfileId ? 1_000 : 0) + (profile.favorite ? 10 : 0),
      })
    }

    const gfnRunning = [...processes].some((name) => name.includes('geforcenow') || name.includes('geforce now'))
    if (gfnRunning) {
      const windowTitles = await this.runningGeForceNowWindowTitles().catch(() => [])
      for (const profile of eligible.filter(({ capture }) => capture.geforceNowEnabled || capture.preferred === 'geforce_now')) {
        const windowTitle = geforceNowTitleForProfile(profile, windowTitles)
        if (!windowTitle) continue
        candidates.push({
          profile,
          method: 'geforce_now',
          executableName: 'GeForceNOW.exe',
          windowTitle,
          score: 2_000 + (profile.favorite ? 10 : 0),
        })
      }
    }

    const matchedProfileIds = new Set(candidates.map(({ profile }) => profile.id))
    let bestCandidateScore = candidates.reduce((score, candidate) => Math.max(score, candidate.score), -Infinity)
    for (const profile of eligible.filter(({ id, library }) => Boolean(library.installDirectory) && !matchedProfileIds.has(id))) {
      const score = 50 + (profile.id === preferredProfileId ? 1_000 : 0) + (profile.favorite ? 10 : 0)
      // Avoid scanning whole game installations when they cannot beat a known
      // match. Equal scores still need the existing last-used tie breaker.
      if (score < bestCandidateScore) continue
      const installed = (await this.installedExecutableNames(profile).catch(() => []))
        .map((name) => name.trim().toLowerCase())
        .filter(Boolean)
        .find((name) => processes.has(name))
      if (!installed) continue
      const method = profile.capture.preferred === 'auto' ? 'local' : profile.capture.preferred
      candidates.push({
        profile,
        method,
        executableName: installed,
        score,
      })
      bestCandidateScore = Math.max(bestCandidateScore, score)
    }

    const selected = candidates.sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score
      return (right.profile.state.lastUsedAt ?? '').localeCompare(left.profile.state.lastUsedAt ?? '')
    })[0]
    return selected ? {
      profile: selected.profile,
      method: selected.method,
      executableName: selected.executableName,
      windowTitle: selected.windowTitle,
    } : null
  }

  async detect(profile: GameProfile): Promise<{ method: CaptureMethod; warnings: string[]; windowTitle?: string }> {
    if (profile.platformGroup === 'switch') return { method: 'elgato', warnings: [] }
    const warnings: string[] = []
    let localRunning = false
    let gfnRunning = false
    let gfnWindowTitle: string | undefined
    for (let attempt = 0; attempt < this.attempts; attempt += 1) {
      const detected = await this.detectRunning(profile)
      localRunning = detected.localRunning
      gfnRunning = detected.gfnRunning
      gfnWindowTitle = detected.gfnWindowTitle
      if (localRunning || gfnWindowTitle || attempt === this.attempts - 1) break
      await wait(this.retryDelayMs)
    }
    const inventoryWarning = this.processInventoryWarning()
    if (inventoryWarning) warnings.push(inventoryWarning)

    if (profile.capture.preferred !== 'auto') {
      if (profile.capture.preferred === 'local' && !localRunning) warnings.push('設定されたローカルゲームのプロセスを確認できません')
      if (profile.capture.preferred === 'geforce_now' && !gfnRunning) warnings.push('GeForce NOW のプロセスを確認できません')
      if (profile.capture.preferred === 'geforce_now' && gfnRunning && !gfnWindowTitle) warnings.push(`GeForce NOWで「${profile.displayName}」のウィンドウを確認できません`)
      return { method: profile.capture.preferred, warnings, windowTitle: gfnWindowTitle }
    }
    if (localRunning) return { method: 'local', warnings }
    if (profile.capture.geforceNowEnabled && gfnRunning) return { method: 'geforce_now', warnings, windowTitle: gfnWindowTitle }
    if (profile.capture.allowDisplayFallback) return { method: 'display', warnings: ['ゲームを検出できないため、許可された画面キャプチャを使用します'] }
    if (profile.capture.windowSourceName && profile.state.lastCaptureMethod === 'window') return { method: 'window', warnings: ['前回使用したウィンドウキャプチャを使用します'] }
    if (profile.state.lastCaptureMethod && !['auto', 'display'].includes(profile.state.lastCaptureMethod)) return { method: profile.state.lastCaptureMethod, warnings: ['実行中ゲームを判定できないため、前回のキャプチャ方式を使用します'] }
    throw new Error('ゲームまたは GeForce NOW を検出できません。ゲーム設定でキャプチャ方式を選択してください。')
  }
}
