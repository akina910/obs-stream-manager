import type { ApplyResult, CaptureMethod, GameProfile, RuntimeStatus } from '../shared/contracts.js'
import { AppLogger } from './logger.js'
import { CaptureDetector } from './capture.js'
import { ObsController } from './obs.js'
import { PlatformServices } from './platforms.js'
import { DataStore } from './storage.js'

export type SelectionResult = ApplyResult & {
  services: Array<{ service: 'youtube' | 'twitch'; ok: boolean; message: string }>
}

export class StreamOrchestrator {
  private selected: GameProfile | null = null
  private method: CaptureMethod | null = null
  private busy = false
  private warning: string | null = null
  private serviceFailures: string[] = []

  constructor(
    private readonly store: DataStore,
    private readonly obs: ObsController,
    private readonly capture: CaptureDetector,
    private readonly platforms: PlatformServices,
    private readonly logger: AppLogger,
  ) {}

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('別の配信操作を処理中です')
    this.busy = true
    try { return await operation() } finally { this.busy = false }
  }

  private captureSource(profile: GameProfile, method: CaptureMethod): string {
    if (method === 'geforce_now') return profile.capture.geforceNowSourceName
    if (method === 'window') return profile.capture.windowSourceName ?? profile.capture.localSourceName
    if (method === 'display') return profile.capture.displaySourceName
    return profile.capture.localSourceName
  }

  async select(gameId: string, override?: CaptureMethod): Promise<SelectionResult> {
    return this.exclusive(async () => {
      const profile = await this.store.getProfile(gameId)
      if (!profile) throw new Error('ゲームプロファイルが見つかりません')
      const config = await this.store.getConfig()
      const detection = override && override !== 'auto' ? { method: override, warnings: [] } : await this.capture.detect(profile)
      const obsWarnings = await this.obs.applyProfile(config, profile, detection.method)
      const services = await this.platforms.prepare(config, profile)
      this.serviceFailures = services.filter((service) => !service.ok).map((service) => `${service.service}: ${service.message}`)
      const thumbnail = services.find((service) => service.service === 'youtube')?.thumbnail
      const thumbnailWarning = thumbnail?.status === 'failed' || thumbnail?.status === 'not_registered' ? [thumbnail.message] : []
      const updated = await this.store.saveProfile({
        ...profile,
        state: {
          ...profile.state,
          lastCaptureMethod: detection.method,
          lastUsedAt: new Date().toISOString(),
          thumbnailApplyStatus: thumbnail?.status ?? (profile.state.thumbnailFilename ? 'failed' : 'not_registered'),
          thumbnailLastAppliedAt: thumbnail?.appliedAt ?? profile.state.thumbnailLastAppliedAt,
          thumbnailLastError: thumbnail?.status === 'failed' ? thumbnail.message : undefined,
        },
      })
      this.selected = updated
      this.method = detection.method
      const warnings = [...detection.warnings, ...obsWarnings, ...thumbnailWarning, ...this.serviceFailures]
      this.warning = warnings[0] ?? null
      await this.logger.write('profile.applied', { gameId, captureMethod: detection.method, warnings, services, thumbnail })
      return { profile: updated, captureMethod: detection.method, warnings, services }
    })
  }

  async start(allowServiceFailures = false): Promise<string[]> {
    return this.exclusive(async () => {
      if (!this.selected || !this.method) throw new Error('先にゲームを選択してください')
      if (this.serviceFailures.length && !allowServiceFailures) throw new Error(`配信サービスの設定に失敗しています: ${this.serviceFailures.join(' / ')}`)
      const config = await this.store.getConfig()
      const selected = this.selected
      const method = this.method
      let ownsCurrentStream = false
      try {
        const warnings = await this.obs.start(config, selected, this.captureSource(selected, method))
        ownsCurrentStream = this.obs.ownsCurrentStream()
        await this.platforms.startYouTubeBroadcast(config, selected)
        await this.platforms.startComments(config)
        this.warning = warnings[0] ?? this.serviceFailures[0] ?? null
        await this.logger.write('stream.started', { gameId: selected.id, captureMethod: method, serviceFailures: this.serviceFailures, warnings })
        return warnings
      } catch (error) {
        const rollbackWarnings: string[] = []
        if (ownsCurrentStream) {
          let streamStopped = false
          try {
            const obsWarnings = await this.obs.stop(config, selected)
            rollbackWarnings.push(...obsWarnings.map((warning) => `OBS: ${warning}`))
            streamStopped = !await this.obs.isStreaming(config)
            if (!streamStopped) rollbackWarnings.push('OBS: 配信出力が継続しているためYouTube配信枠を終了していません')
          } catch (rollbackError) {
            rollbackWarnings.push(`OBS: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`)
          }
          if (streamStopped) {
            await this.platforms.completeYouTubeBroadcast(config, selected).catch((rollbackError) => rollbackWarnings.push(`YouTube: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`))
          }
        }
        await this.platforms.stopComments().catch((rollbackError) => rollbackWarnings.push(`comments: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`))
        this.warning = error instanceof Error ? error.message : String(error)
        await this.logger.write('stream.start_failed', { gameId: selected.id, captureMethod: method, error: this.warning, rollbackWarnings }).catch(() => undefined)
        throw error
      }
    })
  }

  async stop(): Promise<string[]> {
    return this.exclusive(async () => {
      const config = await this.store.getConfig()
      const warnings = await this.obs.stop(config, this.selected)
      try {
        if (await this.obs.isStreaming(config)) warnings.push('OBS配信出力が継続しているため、YouTube配信枠を終了していません')
        else await this.platforms.completeYouTubeBroadcast(config, this.selected)
      } catch (error) {
        warnings.push(`OBS停止確認またはYouTube配信枠の終了に失敗しました: ${error instanceof Error ? error.message : String(error)}`)
      }
      await this.platforms.stopComments()
      this.warning = warnings[0] ?? null
      await this.logger.write('stream.stopped', { gameId: this.selected?.id ?? null, warnings })
      return warnings
    })
  }

  async saveReplay(): Promise<void> {
    return this.exclusive(async () => {
      await this.obs.saveReplay(await this.store.getConfig())
      await this.logger.write('replay.saved', { gameId: this.selected?.id })
    })
  }

  async switchScene(sceneName: string): Promise<void> {
    return this.exclusive(async () => {
      await this.obs.switchScene(await this.store.getConfig(), sceneName)
      await this.logger.write('scene.changed', { sceneName })
    })
  }

  async getStatus(): Promise<RuntimeStatus> {
    return this.obs.status(await this.store.getConfig(), this.selected?.id ?? null, this.method, this.busy, this.warning)
  }

  async assertNotStreaming(): Promise<void> {
    if ((await this.getStatus()).streaming) throw Object.assign(new Error('配信中はゲーム・接続設定・バックアップを変更できません。先に配信を終了してください'), { statusCode: 409 })
  }

  invalidateProfile(gameId: string): void {
    if (this.selected?.id !== gameId) return
    this.selected = null
    this.method = null
    this.serviceFailures = []
    this.warning = 'ゲーム設定を変更しました。配信前にゲームを選び直してください'
  }

  resetSelection(message = '設定が変更されました。配信前にゲームを選び直してください'): void {
    this.selected = null
    this.method = null
    this.serviceFailures = []
    this.warning = message
  }
}
