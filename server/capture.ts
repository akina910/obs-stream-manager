import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { CaptureMethod, GameProfile } from '../shared/contracts.js'

const execFileAsync = promisify(execFile)

export class CaptureDetector {
  async runningProcesses(): Promise<string[]> {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('tasklist', ['/fo', 'csv', '/nh'], { windowsHide: true })
      return stdout.split(/\r?\n/).map((line) => line.match(/^"([^"]+)"/)?.[1]?.toLowerCase()).filter((name): name is string => Boolean(name))
    }
    const { stdout } = await execFileAsync('ps', ['-A', '-o', 'comm='])
    return stdout.split(/\r?\n/).map((name) => name.trim().split('/').pop()?.toLowerCase()).filter((name): name is string => Boolean(name))
  }

  async detect(profile: GameProfile): Promise<{ method: CaptureMethod; warnings: string[] }> {
    if (profile.platformGroup === 'switch') return { method: 'elgato', warnings: [] }
    const warnings: string[] = []
    const processes: string[] = await this.runningProcesses().catch(() => [])
    const isRunning = (candidate: string) => processes.includes(candidate.toLowerCase())
    const localRunning = profile.capture.executableNames.some(isRunning)
    const gfnRunning = processes.some((name) => name.includes('geforcenow') || name.includes('geforce now'))

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
