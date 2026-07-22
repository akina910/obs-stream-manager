import type { ApplyResult, AudioProfile, CaptureMethod, GameProfile, RuntimeStatus } from '../shared/contracts.js'
import type { AudioCalibrationResult } from '../shared/audio-calibration.js'
import { AppLogger } from './logger.js'
import { CaptureDetector } from './capture.js'
import { ObsController } from './obs.js'
import { PlatformServices } from './platforms.js'
import { DataStore } from './storage.js'
import type { CommonTemplateService } from './common-template.js'

export type SelectionResult = ApplyResult & {
  services: Array<{ service: 'youtube' | 'twitch'; ok: boolean; message: string }>
}

export class StreamOrchestrator {
  private selected: GameProfile | null = null
  private method: CaptureMethod | null = null
  private busy = false
  private externalSyncing = false
  private pendingObsStreamState: boolean | null = null
  private observedObsStreaming: boolean | null = null
  private obsStreamStateRevision = 0
  private warning: string | null = null
  private serviceFailures: string[] = []
  private readonly failedServices = new Set<'youtube' | 'twitch'>()
  private partAdvancedForCurrentStream = false

  constructor(
    private readonly store: DataStore,
    private readonly obs: ObsController,
    private readonly capture: CaptureDetector,
    private readonly platforms: PlatformServices,
    private readonly logger: AppLogger,
    private readonly commonTemplates?: CommonTemplateService,
  ) {}

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy || this.externalSyncing) throw new Error('別の配信操作を処理中です')
    this.busy = true
    try { return await operation() } finally {
      this.busy = false
      this.scheduleObsStreamStateSync()
    }
  }

  private captureSource(profile: GameProfile, method: CaptureMethod): string {
    if (method === 'geforce_now') return profile.capture.geforceNowSourceName
    if (method === 'window') return profile.capture.windowSourceName ?? profile.capture.localSourceName
    if (method === 'display') return profile.capture.displaySourceName
    return profile.capture.localSourceName
  }

  private usesPartVariable(profile: GameProfile): boolean {
    return profile.youtube.titleTemplate.includes('{part}') || profile.twitch.titleTemplate.includes('{part}')
  }

  private async advancePartNumber(profile: GameProfile): Promise<void> {
    if (this.partAdvancedForCurrentStream || !this.usesPartVariable(profile)) return
    const latest = await this.store.getProfile(profile.id) ?? profile
    const updated = await this.store.saveProfile({
      ...latest,
      state: { ...latest.state, nextPartNumber: Math.min(9999, latest.state.nextPartNumber + 1) },
    })
    if (this.selected?.id === updated.id) this.selected = updated
    this.partAdvancedForCurrentStream = true
  }

  private async persistSelectedGame(gameId: string | null): Promise<void> {
    const latest = await this.store.getConfig()
    if (latest.ui.lastSelectedGameId === gameId) return
    await this.store.saveConfig({ ...latest, ui: { ...latest.ui, lastSelectedGameId: gameId } })
  }

  async restoreSelection(): Promise<void> {
    const config = await this.store.getConfig()
    let gameId = config.ui.lastSelectedGameId
    if (gameId === undefined) {
      const latest = (await this.store.listProfiles())
        .filter((profile) => profile.state.lastUsedAt && profile.state.lastCaptureMethod)
        .sort((a, b) => (b.state.lastUsedAt ?? '').localeCompare(a.state.lastUsedAt ?? ''))[0]
      gameId = latest?.id ?? null
      await this.persistSelectedGame(gameId)
    }
    if (!gameId) return
    const profile = await this.store.getProfile(gameId)
    if (!profile?.state.lastCaptureMethod) {
      await this.persistSelectedGame(null)
      return
    }
    this.selected = profile
    this.method = profile.state.lastCaptureMethod
    this.platforms.invalidateLiveStatus()
  }

  async select(gameId: string, override?: CaptureMethod): Promise<SelectionResult> {
    return this.exclusive(async () => {
      const profile = await this.store.getProfile(gameId)
      if (!profile) throw new Error('ゲームプロファイルが見つかりません')
      const config = await this.store.getConfig()
      const detection = override && override !== 'auto' ? { method: override, warnings: [] } : await this.capture.detect(profile)
      const obsWarnings = await this.obs.applyProfile(config, profile, detection.method)
      if (this.commonTemplates) {
        try {
          const renderedTemplate = await this.commonTemplates.renderProfile(profile)
          if (renderedTemplate) await this.obs.applyCommonTemplate(config, renderedTemplate)
        } catch (error) {
          obsWarnings.push(error instanceof Error ? error.message : String(error))
        }
      }
      const services = await this.platforms.prepare(config, profile)
      const primaryService = config.features.youtube && profile.youtube.enabled
        ? 'youtube'
        : config.features.twitch && profile.twitch.enabled
          ? 'twitch'
          : null
      const primaryPreparation = primaryService ? services.find((service) => service.service === primaryService) : undefined
      if (!primaryPreparation || primaryPreparation.ok) {
        try {
          await this.obs.preparePrimaryStream(config, profile)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (primaryPreparation) {
            primaryPreparation.ok = false
            primaryPreparation.message = `OBS配信先を準備できませんでした: ${message}`
          } else {
            obsWarnings.push(`OBS配信先を準備できませんでした: ${message}`)
          }
        }
      }
      this.failedServices.clear()
      for (const service of services) if (!service.ok) this.failedServices.add(service.service)
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
      await this.persistSelectedGame(updated.id)
      const warnings = [...detection.warnings, ...obsWarnings, ...thumbnailWarning, ...this.serviceFailures]
      this.warning = warnings[0] ?? null
      this.platforms.invalidateLiveStatus()
      await this.logger.write('profile.applied', { gameId, captureMethod: detection.method, warnings, services, thumbnail })
      return { profile: updated, captureMethod: detection.method, warnings, services }
    })
  }

  async start(allowServiceFailures = false): Promise<string[]> {
    return this.exclusive(async () => {
      if (!this.selected || !this.method) throw new Error('先にゲームを選択してください')
      if (this.serviceFailures.length && !allowServiceFailures) throw new Error(`配信サービスの設定に失敗しています: ${this.serviceFailures.join(' / ')}`)
      const config = await this.store.getConfig()
      if (allowServiceFailures && this.failedServices.has('youtube')) {
        throw new Error('YouTubeの配信準備に失敗しているため、OBSへ触れずに開始を中止しました。YouTubeを再接続してゲームを選び直してください')
      }
      const runtimeConfig = allowServiceFailures && this.failedServices.has('twitch')
        ? { ...config, features: { ...config.features, twitch: false } }
        : config
      const selected = this.selected
      const method = this.method
      let ownsCurrentStream = false
      let obsStartCompleted = false
      let lastManagedStateRevision = this.obsStreamStateRevision
      try {
        const warnings = await this.obs.start(runtimeConfig, selected, this.captureSource(selected, method))
        obsStartCompleted = true
        lastManagedStateRevision = this.obsStreamStateRevision
        ownsCurrentStream = this.obs.ownsCurrentStream()
        await this.platforms.startYouTubeBroadcast(runtimeConfig, selected)
        await this.platforms.startComments(runtimeConfig)
        if (!await this.obs.isStreaming(runtimeConfig)) throw new Error('外部サービスの開始処理中にOBS配信出力が停止しました')
        await this.advancePartNumber(selected).catch((error) => warnings.push(`次回のPart番号を保存できませんでした: ${error instanceof Error ? error.message : String(error)}`))
        this.platforms.invalidateLiveStatus()
        this.markManagedObsState(true)
        this.warning = warnings[0] ?? this.serviceFailures[0] ?? null
        await this.logger.write('stream.started', { gameId: selected.id, captureMethod: method, serviceFailures: this.serviceFailures, warnings })
        return warnings
      } catch (error) {
        const rollbackWarnings: string[] = []
        let streamStateAfterFailure: boolean | null = null
        if (ownsCurrentStream) {
          let streamStopped = false
          try {
            const obsWarnings = await this.obs.rollbackStart(runtimeConfig, selected)
            rollbackWarnings.push(...obsWarnings.map((warning) => `OBS: ${warning}`))
            streamStopped = !await this.obs.isStreaming(runtimeConfig)
            streamStateAfterFailure = !streamStopped
            if (!streamStopped) rollbackWarnings.push('OBS: 配信出力が継続しているためYouTube配信枠を終了していません')
          } catch (rollbackError) {
            rollbackWarnings.push(`OBS: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`)
            streamStateAfterFailure = await this.obs.isStreaming(runtimeConfig).catch(() => null)
          }
          if (streamStopped) {
            await this.platforms.completeYouTubeBroadcast(runtimeConfig, selected).catch((rollbackError) => rollbackWarnings.push(`YouTube: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`))
          }
        } else if (obsStartCompleted) {
          streamStateAfterFailure = await this.obs.isStreaming(runtimeConfig).catch(() => null)
        }
        if (streamStateAfterFailure === null) {
          if (this.obsStreamStateRevision === lastManagedStateRevision) this.pendingObsStreamState = null
        } else {
          this.markManagedObsState(streamStateAfterFailure)
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
      let obsStillStreaming: boolean | null = null
      try {
        obsStillStreaming = await this.obs.isStreaming(config)
        if (obsStillStreaming) warnings.push('OBS配信出力が継続しているため、YouTube配信枠を終了していません')
        else await this.platforms.completeYouTubeBroadcast(config, this.selected)
      } catch (error) {
        warnings.push(`OBS停止確認またはYouTube配信枠の終了に失敗しました: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (obsStillStreaming !== null) this.markManagedObsState(obsStillStreaming)
      await this.platforms.stopComments()
      this.platforms.invalidateLiveStatus()
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

  handleObsStreamStateChanged(active: boolean): void {
    this.obsStreamStateRevision += 1
    if (this.observedObsStreaming === active) return
    if (!active) this.partAdvancedForCurrentStream = false
    this.observedObsStreaming = active
    this.pendingObsStreamState = active
    this.scheduleObsStreamStateSync()
  }

  private markManagedObsState(active: boolean): void {
    this.obsStreamStateRevision += 1
    this.observedObsStreaming = active
    this.pendingObsStreamState = null
    if (!active) this.partAdvancedForCurrentStream = false
  }

  private scheduleObsStreamStateSync(): void {
    if (this.busy || this.externalSyncing || this.pendingObsStreamState === null) return
    void this.processObsStreamStateChanges()
  }

  private async processObsStreamStateChanges(): Promise<void> {
    this.externalSyncing = true
    try {
      while (this.pendingObsStreamState !== null) {
        const active = this.pendingObsStreamState
        this.pendingObsStreamState = null
        try {
          await this.syncExternalServicesFromObs(active)
        } catch (error) {
          this.warning = `OBS連動処理に失敗しました: ${error instanceof Error ? error.message : String(error)}`
          await this.logger.write('stream.obs_sync_failed', { active, error: this.warning }).catch(() => undefined)
        }
      }
    } finally {
      this.externalSyncing = false
      this.scheduleObsStreamStateSync()
    }
  }

  private async syncExternalServicesFromObs(active: boolean): Promise<void> {
    const config = await this.store.getConfig()
    const warnings: string[] = []
    if (active) {
      if (this.selected) {
        await this.obs.startSecondaryTwitchForObsStream(config, this.selected).catch((error) => {
          warnings.push(`Twitch副出力: ${error instanceof Error ? error.message : String(error)}`)
        })
        await this.platforms.startYouTubeBroadcast(config, this.selected).catch((error) => {
          warnings.push(`YouTube: ${error instanceof Error ? error.message : String(error)}`)
        })
      } else {
        warnings.push('ゲーム未選択のため、OBS映像の送信だけを検出しました。外部サービスの実状態を確認してください')
      }
      await this.platforms.startComments(config).catch((error) => {
        warnings.push(`コメント: ${error instanceof Error ? error.message : String(error)}`)
      })
      if (this.selected) await this.advancePartNumber(this.selected).catch((error) => {
        warnings.push(`次回のPart番号を保存できませんでした: ${error instanceof Error ? error.message : String(error)}`)
      })
      this.warning = warnings[0] ?? null
      await this.logger.write('stream.obs_started', { gameId: this.selected?.id ?? null, warnings })
    } else {
      warnings.push(...await this.obs.finishObsTriggeredStream(config))
      await this.platforms.completeYouTubeBroadcast(config, this.selected).catch((error) => {
        warnings.push(`YouTube: ${error instanceof Error ? error.message : String(error)}`)
      })
      await this.platforms.stopComments().catch((error) => {
        warnings.push(`コメント: ${error instanceof Error ? error.message : String(error)}`)
      })
      this.warning = warnings[0] ?? null
      await this.logger.write('stream.obs_stopped', { gameId: this.selected?.id ?? null, warnings })
    }
    this.platforms.invalidateLiveStatus()
  }

  async getStatus(): Promise<RuntimeStatus> {
    const config = await this.store.getConfig()
    const stateRevision = this.obsStreamStateRevision
    const [obsStatus, platforms] = await Promise.all([
      this.obs.status(config, this.selected?.id ?? null, this.method, this.busy || this.externalSyncing, this.warning),
      this.platforms.getLiveStatus(config, this.selected),
    ])
    if (stateRevision === this.obsStreamStateRevision) {
      if (this.observedObsStreaming === null) {
        if (obsStatus.streaming) this.handleObsStreamStateChanged(true)
        else {
          this.observedObsStreaming = false
          this.obsStreamStateRevision += 1
        }
      } else if (this.observedObsStreaming !== obsStatus.streaming) {
        this.handleObsStreamStateChanged(obsStatus.streaming)
      }
    }
    return { ...obsStatus, platforms }
  }

  async assertNotStreaming(): Promise<void> {
    const status = await this.getStatus()
    const externalActive = Object.values(status.platforms).some(({ state }) => ['starting', 'live', 'stopping'].includes(state))
    if (status.streaming || externalActive) throw Object.assign(new Error('配信中はゲーム・接続設定・バックアップを変更できません。先に配信を終了してください'), { statusCode: 409 })
  }

  async testTwitchOutput(options: { durationMs?: number; includeSecondary?: boolean; includeRecording?: boolean; includeReplayBuffer?: boolean } = {}) {
    return this.exclusive(async () => {
      const status = await this.getStatus()
      const externalActive = Object.values(status.platforms).some(({ state }) => ['starting', 'live', 'stopping'].includes(state))
      if (status.streaming || externalActive) {
        throw Object.assign(new Error('配信中はTwitch出力テストを実行できません。配信を停止してから再実行してください'), { statusCode: 409 })
      }
      const config = await this.store.getConfig()
      try {
        const durationMs = Math.max(0, Math.min(30_000, options.durationMs ?? 15_000))
        return await this.obs.testTwitchIngest(config, durationMs, options)
      } finally {
        const active = await this.obs.isStreaming(config).catch(() => null)
        if (active === null) {
          this.obsStreamStateRevision += 1
          this.observedObsStreaming = null
          this.pendingObsStreamState = null
        } else {
          this.markManagedObsState(active)
        }
      }
    })
  }

  async autoAdjustAudio(gameId: string, durationMs = 15_000, audio?: AudioProfile): Promise<AudioCalibrationResult> {
    return this.exclusive(async () => {
      if (!this.selected || !this.method || this.selected.id !== gameId) {
        throw Object.assign(new Error('音声を調整するゲームを先に選択して、OBSへプロファイルを適用してください'), { statusCode: 409 })
      }
      const status = await this.getStatus()
      const externalActive = Object.values(status.platforms).some(({ state }) => ['starting', 'live', 'stopping'].includes(state))
      if (status.streaming || status.recording || status.replayBuffer || externalActive) {
        throw Object.assign(new Error('配信・録画・リプレイ中は音声を自動調整できません。すべて停止してから再実行してください'), { statusCode: 409 })
      }
      const config = await this.store.getConfig()
      const previous = this.selected
      const calibrationProfile = audio === undefined ? previous : { ...previous, audio }
      const result = await this.obs.autoAdjustAudio(config, calibrationProfile, this.method, durationMs, (profile) => this.store.saveProfile(profile))
      const saved = result.profile
      this.selected = saved
      this.warning = result.warnings[0] ?? null
      await this.logger.write('audio.auto_adjusted', {
        gameId,
        captureMethod: this.method,
        durationMs: result.durationMs,
        readings: result.readings.map(({ role, sourceName, status: readingStatus, previousDb, appliedDb, verifiedDb, verifiedPeakDb }) => ({
          role,
          sourceName,
          status: readingStatus,
          previousDb,
          appliedDb,
          verifiedDb,
          verifiedPeakDb,
        })),
        filters: result.filters.map(({ sourceName, filterName, filterKind, status: filterStatus }) => ({ sourceName, filterName, filterKind, status: filterStatus })),
        warnings: result.warnings,
      }).catch((error) => {
        const warning = `音声自動調整の監査ログを保存できませんでした: ${error instanceof Error ? error.message : String(error)}`
        result.warnings.push(warning)
        this.warning ??= warning
      })
      return { ...result, profile: saved }
    })
  }

  async invalidateProfile(gameId: string): Promise<void> {
    if (this.selected?.id !== gameId) return
    this.selected = null
    this.method = null
    this.serviceFailures = []
    this.warning = 'ゲーム設定を変更しました。配信前にゲームを選び直してください'
    await this.persistSelectedGame(null)
  }

  async resetSelection(message = '設定が変更されました。配信前にゲームを選び直してください'): Promise<void> {
    this.selected = null
    this.method = null
    this.serviceFailures = []
    this.warning = message
    await this.persistSelectedGame(null)
  }
}
