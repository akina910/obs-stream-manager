import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { promisify } from 'node:util'
import type { CaptureMethod, GameProfile } from '../shared/contracts.js'

const execFileAsync = promisify(execFile)

const ignoredInstallExecutables = new Set([
  'crashpad_handler.exe',
  'dxsetup.exe',
  'easyanticheat_eos_setup.exe',
  'easyanticheat_setup.exe',
  'unitycrashhandler32.exe',
  'unitycrashhandler64.exe',
  'ue4prereqsetup_x64.exe',
  'unins000.exe',
  'vc_redist.x64.exe',
  'vc_redist.x86.exe',
])

type CaptureDetectorOptions = {
  attempts?: number
  retryDelayMs?: number
  executableCacheMs?: number
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export class CaptureDetector {
  private readonly attempts: number
  private readonly retryDelayMs: number
  private readonly executableCacheMs: number
  private readonly installExecutables = new Map<string, { names: string[]; expiresAt: number }>()

  constructor(options: CaptureDetectorOptions = {}) {
    this.attempts = Math.max(1, options.attempts ?? 4)
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 500)
    this.executableCacheMs = Math.max(0, options.executableCacheMs ?? 5 * 60_000)
  }

  async runningProcesses(): Promise<string[]> {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('tasklist', ['/fo', 'csv', '/nh'], { windowsHide: true })
      return stdout.split(/\r?\n/).map((line) => line.match(/^"([^"]+)"/)?.[1]?.toLowerCase()).filter((name): name is string => Boolean(name))
    }
    const { stdout } = await execFileAsync('ps', ['-A', '-o', 'comm='])
    return stdout.split(/\r?\n/).map((name) => name.trim().split('/').pop()?.toLowerCase()).filter((name): name is string => Boolean(name))
  }

  private async installedExecutableNames(profile: GameProfile): Promise<string[]> {
    const installDirectory = profile.library.installDirectory?.trim()
    if (!installDirectory) return []
    const cacheKey = installDirectory.toLowerCase()
    const cached = this.installExecutables.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) return cached.names

    const names = [...new Set((await readdir(installDirectory, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.exe'))
      .map((entry) => entry.name.toLowerCase())
      .filter((name) => !ignoredInstallExecutables.has(name) && !/^unins\d*\.exe$/i.test(name)))]
    this.installExecutables.set(cacheKey, { names, expiresAt: Date.now() + this.executableCacheMs })
    return names
  }

  private async detectRunning(profile: GameProfile): Promise<{ localRunning: boolean; gfnRunning: boolean }> {
    const processes = new Set(await this.runningProcesses().catch(() => []))
    const configuredExecutables = profile.capture.executableNames.map((name) => name.toLowerCase())
    const configuredRunning = configuredExecutables.some((name) => processes.has(name))
    const installedRunning = configuredRunning
      ? false
      : (await this.installedExecutableNames(profile).catch(() => [])).some((name) => processes.has(name))
    return {
      localRunning: configuredRunning || installedRunning,
      gfnRunning: [...processes].some((name) => name.includes('geforcenow') || name.includes('geforce now')),
    }
  }

  async detect(profile: GameProfile): Promise<{ method: CaptureMethod; warnings: string[] }> {
    if (profile.platformGroup === 'switch') return { method: 'elgato', warnings: [] }
    const warnings: string[] = []
    let localRunning = false
    let gfnRunning = false
    for (let attempt = 0; attempt < this.attempts; attempt += 1) {
      const detected = await this.detectRunning(profile)
      localRunning = detected.localRunning
      gfnRunning = detected.gfnRunning
      if (localRunning || gfnRunning || attempt === this.attempts - 1) break
      await wait(this.retryDelayMs)
    }

    if (profile.capture.preferred !== 'auto') {
      if (profile.capture.preferred === 'local' && !localRunning) warnings.push('設定されたローカルゲームのプロセスを確認できません')
      if (profile.capture.preferred === 'geforce_now' && !gfnRunning) warnings.push('GeForce NOW のプロセスを確認できません')
      return { method: profile.capture.preferred, warnings }
    }
    if (localRunning) return { method: 'local', warnings }
    if (profile.capture.geforceNowEnabled && gfnRunning) return { method: 'geforce_now', warnings }
    if (profile.capture.allowDisplayFallback) return { method: 'display', warnings: ['ゲームを検出できないため、許可された画面キャプチャを使用します'] }
    if (profile.capture.windowSourceName && profile.state.lastCaptureMethod === 'window') return { method: 'window', warnings: ['前回使用したウィンドウキャプチャを使用します'] }
    if (profile.state.lastCaptureMethod && !['auto', 'display'].includes(profile.state.lastCaptureMethod)) return { method: profile.state.lastCaptureMethod, warnings: ['実行中ゲームを判定できないため、前回のキャプチャ方式を使用します'] }
    throw new Error('ゲームまたは GeForce NOW を検出できません。ゲーム設定でキャプチャ方式を選択してください。')
  }
}
