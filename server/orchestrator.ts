import type { ApplyResult, AudioProfile, CaptureMethod, GameProfile, RuntimeStatus } from '../shared/contracts.js'
import type { AudioCalibrationResult } from '../shared/audio-calibration.js'
import type { GameExitAction, GameExitPrompt, GameExitResponse } from '../shared/game-exit.js'
import { AppLogger } from './logger.js'
import { CaptureDetector, type RunningGameMatch } from './capture.js'
import { ObsController } from './obs.js'
import { PlatformServices } from './platforms.js'
import { DataStore } from './storage.js'
import type { CommonTemplateService } from './common-template.js'
import type { BgmLibraryStore } from './bgm-library.js'
import { GameExitMonitor, gameExitServerPollMs, gameExitGraceMs, gameExitCountdownMs, type GameExitTarget } from './game-exit-monitor.js'

export type SelectionResult = ApplyResult & {
  services: Array<{ service: 'youtube' | 'twitch'; ok: boolean; message: string }>
}

export function streamPreparationErrorServices(error: unknown): SelectionResult['services'] | undefined {
  if (!error || typeof error !== 'object' || !('services' in error) || !Array.isArray(error.services)) return undefined
  if (!error.services.length || !error.services.every((item: unknown) => item && typeof item === 'object'
    && 'service' in item && (item.service === 'youtube' || item.service === 'twitch')
    && 'ok' in item && typeof item.ok === 'boolean' && 'message' in item && typeof item.message === 'string')) return undefined
  return (error.services as SelectionResult['services']).map(({ service, ok, message }) => ({ service, ok, message }))
}

export type AutomaticGameDetectionResult = {
  detected: boolean
  applied: boolean
  gameId?: string
  executableName?: string
  captureMethod?: CaptureMethod
}

const recordingOnlyPostProductionProcesses = new Map([
  ['vocaloid6.exe', 'VOCALOID6'],
  ['mikumikudance.exe', 'MikuMikuDance'],
  ['mikumikumoving.exe', 'MikuMikuMoving'],
  ['ymm4.exe', 'ゆっくりMovieMaker4'],
  ['yukkurimoviemaker4.exe', 'ゆっくりMovieMaker4'],
  ['adobe premiere pro.exe', 'Adobe Premiere Pro'],
  ['afterfx.exe', 'Adobe After Effects'],
  ['adobe media encoder.exe', 'Adobe Media Encoder'],
  ['resolve.exe', 'DaVinci Resolve'],
  ['vegaspro.exe', 'VEGAS Pro'],
  ['filmora.exe', 'Filmora'],
  ['capcut.exe', 'CapCut'],
  ['topaz video ai.exe', 'Topaz Video AI'],
])

export class StreamOrchestrator {
  private selected: GameProfile | null = null
  private method: CaptureMethod | null = null
  private busy = false
  private externalSyncing = false
  private pendingObsStreamState: boolean | null = null
  private pendingObsStreamStopRecordingEpoch: number | null = null
  private localRecordingOutputEpoch = 0
  private observedObsStreaming: boolean | null = null
  private obsStreamStateRevision = 0
  private warning: string | null = null
  private ensuredAudioKey: string | null = null
  private appliedBgmKey: string | null = null
  private lastPlatformHealthSignature: string | null = null
  private backgroundAudioEnsure: Promise<{ applied: boolean; warnings: string[] }> | null = null
  private backgroundAudioEnsurePhase: 'checking' | 'applying' | null = null
  private backgroundAudioEnsureRevision = 0
  private serviceFailures: string[] = []
  private servicePreparationResults: SelectionResult['services'] = []
  private readonly failedServices = new Set<'youtube' | 'twitch'>()
  private partAdvancedForCurrentStream = false
  private pendingAutoSelection: { key: string; observations: number } | null = null
  private platformPreparationPending = false
  private automaticDetectionWarning: string | null = null
  private interruptedStreamSelectionId: string | null = null
  private recordingOnlyOperation = false
  private recordingOnlyOperationRevision = 0
  private readonly gameExitMonitor = new GameExitMonitor()
  private gameExitPollGeneration = 0
  private respondingGameExitId: string | null = null
  private committedGameExitId: string | null = null
  private gameExitTimer: ReturnType<typeof setInterval> | null = null
  private gameExitPollInFlight: Promise<GameExitPrompt | null> | null = null
  private lastGameExitObservationFailure: string | null = null
  private managedGameExitSession: { gameId: string; method: CaptureMethod; guard: () => void } | null = null

  constructor(
    private readonly store: DataStore,
    private readonly obs: ObsController,
    private readonly capture: CaptureDetector,
    private readonly platforms: PlatformServices,
    private readonly logger: AppLogger,
    private readonly commonTemplates?: CommonTemplateService,
    private readonly bgm?: BgmLibraryStore,
  ) {}

  private async exclusive<T>(operation: () => Promise<T>, localRecordingOperation = false): Promise<T> {
    if (this.busy || this.externalSyncing) throw new Error('別の配信操作を処理中です')
    if (localRecordingOperation && this.backgroundAudioEnsure && this.backgroundAudioEnsurePhase === 'checking') {
      // A background provider status read has not touched OBS yet. Invalidate
      // that work instead of making local recording wait for OAuth/network.
      // Once OBS audio application begins it must still finish under the lock.
      this.backgroundAudioEnsureRevision += 1
      this.backgroundAudioEnsure = null
      this.backgroundAudioEnsurePhase = null
    }
    if (this.backgroundAudioEnsure) await this.backgroundAudioEnsure.catch(() => undefined)
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

  private profileCaptureSources(profile: GameProfile): string[] {
    return [
      profile.capture.localSourceName,
      profile.capture.geforceNowSourceName,
      profile.capture.windowSourceName,
      profile.capture.displaySourceName,
      profile.platformGroup === 'switch' ? 'Elgato Game Capture' : undefined,
    ].filter((name): name is string => Boolean(name?.trim()))
  }

  private async inactiveCaptureSources(profile: GameProfile): Promise<string[]> {
    let profiles = this.selected && this.selected.id !== profile.id ? [this.selected, profile] : [profile]
    try {
      profiles = await this.store.listProfiles()
    } catch {
      // Tests and a partially recovered profile directory can still apply the
      // current/previous selection without leaving the previous source active.
    }
    const active = new Set(this.profileCaptureSources(profile))
    return [...new Set(profiles.flatMap((candidate) => this.profileCaptureSources(candidate)))]
      .filter((sourceName) => !active.has(sourceName))
  }

  private profileApplicationKey(profile: GameProfile, method: CaptureMethod): string {
    return `${profile.id}:${method}:${JSON.stringify({
      capture: profile.capture,
      obs: profile.obs,
      audio: profile.audio,
      recording: profile.recording,
    })}`
  }

  private profileBgmApplicationKey(profile: GameProfile): string {
    return `${profile.id}:${JSON.stringify({ bgm: profile.bgm, volumeDb: profile.audio.bgmDb })}`
  }

  private async applyObsProfile(
    config: Awaited<ReturnType<DataStore['getConfig']>>,
    profile: GameProfile,
    method: CaptureMethod,
    captureWindowTitle?: string,
    preserveMicrophoneMute = false,
    recordingOnly = false,
  ) {
    const inactiveSources = await this.inactiveCaptureSources(profile)
    if (recordingOnly) {
      return this.obs.applyProfile(config, profile, method, captureWindowTitle, inactiveSources, preserveMicrophoneMute, true)
    }
    if (preserveMicrophoneMute) {
      return this.obs.applyProfile(config, profile, method, captureWindowTitle, inactiveSources, true)
    }
    if (captureWindowTitle) {
      return inactiveSources.length
        ? this.obs.applyProfile(config, profile, method, captureWindowTitle, inactiveSources)
        : this.obs.applyProfile(config, profile, method, captureWindowTitle)
    }
    return inactiveSources.length
      ? this.obs.applyProfile(config, profile, method, undefined, inactiveSources)
      : this.obs.applyProfile(config, profile, method)
  }

  private async applyProfileBgm(
    config: Awaited<ReturnType<DataStore['getConfig']>>,
    profile: GameProfile,
    warnings: string[],
    force = false,
    previousStopped = false,
  ): Promise<void> {
    if (!this.bgm) return
    const applicationKey = this.profileBgmApplicationKey(profile)
    if (!force && this.appliedBgmKey === applicationKey) return
    try {
      if (!previousStopped) await this.obs.stopBgm(config)
      const track = profile.bgm.trackId ? await this.bgm.getTrack(profile.bgm.trackId) : null
      if (!profile.bgm.trackId) {
        await this.bgm.selectTrack(null, profile.bgm.playbackMode)
        this.appliedBgmKey = applicationKey
        return
      }
      if (!track) {
        await this.bgm.selectTrack(null, profile.bgm.playbackMode)
        this.appliedBgmKey = applicationKey
        warnings.push(`このゲームに設定したBGMがストックから削除されています。別の曲を選び直してください`)
        return
      }
      await this.obs.prepareBgm(
        config,
        this.bgm.trackPath(track),
        profile.audio.bgmDb,
        profile.bgm.playbackMode,
        profile.bgm.autoPlay,
      )
      await this.bgm.selectTrack(track.id, profile.bgm.playbackMode)
      await this.bgm.releaseRetainedFiles().catch(() => undefined)
      this.appliedBgmKey = applicationKey
    } catch (error) {
      this.appliedBgmKey = null
      warnings.push(`ゲーム別BGMを適用できませんでした: ${error instanceof Error ? error.message : String(error)}`)
    }
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

  private async persistDetectedProfile(match: RunningGameMatch): Promise<void> {
    let profile = match.profile
    if ((match.method === 'local' || match.method === 'window')
      && !profile.capture.executableNames.some((name) => name.trim().toLowerCase() === match.executableName.trim().toLowerCase())) {
      profile = { ...profile, capture: { ...profile.capture, executableNames: [...profile.capture.executableNames, match.executableName] } }
    }
    const saved = await this.store.getProfile(profile.id)
    if (!saved) {
      await this.store.saveProfile(profile)
      return
    }
    const knownExecutables = new Set(saved.capture.executableNames.map((name) => name.trim().toLowerCase()))
    const recognizedAliases = profile.capture.executableNames.filter((name) => !knownExecutables.has(name.trim().toLowerCase()))
    if (recognizedAliases.length) {
      await this.store.saveProfile({ ...saved, capture: { ...saved.capture, executableNames: [...saved.capture.executableNames, ...recognizedAliases] } })
    }
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
    // Restoring the local selection must not spend platform quota during app
    // startup. Refresh the external metadata and stream binding only when the
    // user actually starts a stream.
    this.platformPreparationPending = true
    this.platforms.invalidateLiveStatus()
  }

  async autoSelectRunningGame(): Promise<AutomaticGameDetectionResult> {
    if (this.busy || this.externalSyncing || this.backgroundAudioEnsure) return { detected: false, applied: false }
    // A transport interruption must not turn the short offline window into a
    // profile change. Keep the game that was actually being broadcast until
    // the user resumes it or explicitly selects another profile.
    if (this.interruptedStreamSelectionId && this.selected?.id === this.interruptedStreamSelectionId && this.method) {
      this.pendingAutoSelection = null
      return { detected: true, applied: false, gameId: this.selected.id, captureMethod: this.method }
    }
    const profiles = await this.store.listProfiles()
    const match = await this.capture.detectRunningProfile(profiles, this.selected?.id)
    const processWarning = this.capture.processInventoryWarning?.() ?? null
    if (processWarning) {
      this.pendingAutoSelection = null
      if (this.automaticDetectionWarning !== processWarning) {
        await this.logger.write('profile.auto_detection_unavailable', { message: processWarning }).catch(() => undefined)
      }
      if (!this.warning || this.warning === this.automaticDetectionWarning) this.warning = processWarning
      this.automaticDetectionWarning = processWarning
      return { detected: false, applied: false }
    }
    if (this.automaticDetectionWarning) {
      const previousWarning = this.automaticDetectionWarning
      this.automaticDetectionWarning = null
      if (this.warning === previousWarning) this.warning = null
      await this.logger.write('profile.auto_detection_recovered', {}).catch(() => undefined)
    }
    if (!match) {
      this.pendingAutoSelection = null
      return { detected: false, applied: false }
    }
    if (this.selected?.id === match.profile.id && this.method === match.method) {
      this.pendingAutoSelection = null
      return { detected: true, applied: false, gameId: match.profile.id, executableName: match.executableName, captureMethod: match.method }
    }

    // Process lists briefly lose a game during loading screens and expose helper
    // executables while launchers update. Requiring the same new candidate in two
    // consecutive scans prevents scene/profile oscillation and avoids repeatedly
    // spending YouTube metadata/thumbnail quota on a transient match.
    const candidateKey = `${match.profile.id}:${match.method}:${match.executableName.toLowerCase()}:${match.windowTitle ?? ''}`
    if (this.pendingAutoSelection?.key !== candidateKey) {
      this.pendingAutoSelection = { key: candidateKey, observations: 1 }
      return { detected: true, applied: false, gameId: match.profile.id, executableName: match.executableName, captureMethod: match.method }
    }
    this.pendingAutoSelection.observations += 1
    if (this.pendingAutoSelection.observations < 2) {
      return { detected: true, applied: false, gameId: match.profile.id, executableName: match.executableName, captureMethod: match.method }
    }

    return this.exclusive(async () => {
      const config = await this.store.getConfig()
      const status = await this.obs.status(config, this.selected?.id ?? null, this.method, true, this.warning)
      if (!status.obsConnected || status.streaming || status.recording || status.replayBuffer
        || status.sourceRecord || status.verticalRecording || status.twitchOutputPlugin?.outputActive) {
        return { detected: true, applied: false, gameId: match.profile.id, executableName: match.executableName, captureMethod: match.method }
      }

      await this.persistDetectedProfile(match)
      await this.applySelection(match.profile.id, match.method, false, match.windowTitle)
      await this.logger.write('profile.auto_detected', {
        gameId: match.profile.id,
        executableName: match.executableName,
        captureMethod: match.method,
      }).catch(() => undefined)
      return { detected: true, applied: true, gameId: match.profile.id, executableName: match.executableName, captureMethod: match.method }
    })
  }

  private async preparePlatformServices(
    config: Awaited<ReturnType<DataStore['getConfig']>>,
    profile: GameProfile,
    obsWarnings: string[],
  ) {
      const services = await this.platforms.prepare(config, profile)
      const primaryService = config.features.youtube && profile.youtube.enabled
        ? 'youtube'
        : config.features.twitch && profile.twitch.enabled
          ? 'twitch'
          : null
      const primaryPreparation = primaryService ? services.find((service) => service.service === primaryService) : undefined
      if (!primaryPreparation || primaryPreparation.ok) {
        try {
          // Platform preparation can persist a new broadcast id or other
          // connection state. Read the just-saved config before binding OBS.
          await this.obs.preparePrimaryStream(await this.store.getConfig(), profile)
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
      this.servicePreparationResults = services.map(({ service, ok, message }) => ({ service, ok, message }))
      for (const service of services) if (!service.ok) this.failedServices.add(service.service)
      this.serviceFailures = services.filter((service) => !service.ok).map((service) => `${service.service}: ${service.message}`)
      this.platformPreparationPending = false
      const thumbnail = services.find((service) => service.service === 'youtube')?.thumbnail
      const thumbnailWarning = thumbnail?.status === 'failed' || thumbnail?.status === 'not_registered' ? [thumbnail.message] : []
      return { services, thumbnail, thumbnailWarning }
  }

  private async applySelection(gameId: string, override?: CaptureMethod, preparePlatforms = false, captureWindowTitle?: string, localOnly = false): Promise<SelectionResult> {
      this.pendingAutoSelection = null
      this.interruptedStreamSelectionId = null
      const profile = await this.store.getProfile(gameId)
      if (!profile) throw new Error('ゲームプロファイルが見つかりません')
      const config = await this.store.getConfig()
      let detection = override && override !== 'auto'
        ? { method: override, warnings: [] as string[], windowTitle: captureWindowTitle }
        : await this.capture.detect(profile)
      if (detection.method === 'geforce_now' && !detection.windowTitle) {
        const detected = await this.capture.detect(profile)
        detection = {
          method: 'geforce_now',
          warnings: [...detection.warnings, ...detected.warnings],
          windowTitle: detected.windowTitle,
        }
      }
      if (this.bgm) await this.obs.stopBgm(config)
      const appliedProfile = await this.applyObsProfile(config, profile, detection.method, detection.windowTitle, false, localOnly)
      const obsWarnings = appliedProfile.warnings
      await this.applyProfileBgm(config, profile, obsWarnings, true, true)
      this.ensuredAudioKey = appliedProfile.audioApplied ? this.profileApplicationKey(profile, detection.method) : null
      if (this.commonTemplates) {
        try {
          const renderedTemplate = await this.commonTemplates.renderProfile(profile)
          if (renderedTemplate) await this.obs.applyCommonTemplate(config, renderedTemplate)
        } catch (error) {
          obsWarnings.push(error instanceof Error ? error.message : String(error))
        }
      }
      let services: Awaited<ReturnType<PlatformServices['prepare']>> = []
      let thumbnail: Awaited<ReturnType<PlatformServices['prepare']>>[number]['thumbnail'] | undefined
      let thumbnailWarning: string[] = []
      if (preparePlatforms && !localOnly) {
        ({ services, thumbnail, thumbnailWarning } = await this.preparePlatformServices(config, profile, obsWarnings))
      } else {
        // Automatic process detection runs every few seconds. Applying OBS's
        // local scene/audio state is cheap, but updating YouTube metadata and
        // thumbnails here can exhaust the daily API quota while games and
        // launchers come and go. Keep the known stream destination in OBS and
        // defer all external writes until an intentional stream start.
        this.failedServices.clear()
        this.serviceFailures = []
        this.servicePreparationResults = []
        this.platformPreparationPending = true
        if (!localOnly) {
          try {
            await this.obs.preparePrimaryStream(config, profile)
          } catch (error) {
            obsWarnings.push(`保存済みのOBS配信先を維持できませんでした。配信開始時に再準備します: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
      const updated = await this.store.saveProfile({
        ...profile,
        state: {
          ...profile.state,
          lastCaptureMethod: detection.method,
          lastUsedAt: new Date().toISOString(),
          thumbnailApplyStatus: thumbnail?.status ?? profile.state.thumbnailApplyStatus,
          thumbnailLastAppliedAt: thumbnail?.appliedAt ?? profile.state.thumbnailLastAppliedAt,
          thumbnailLastError: thumbnail ? (thumbnail.status === 'failed' ? thumbnail.message : undefined) : profile.state.thumbnailLastError,
        },
      })
      this.selected = updated
      this.method = detection.method
      await this.persistSelectedGame(updated.id)
      const warnings = [...detection.warnings, ...obsWarnings, ...thumbnailWarning, ...this.serviceFailures]
      this.warning = warnings[0] ?? null
      if (!localOnly) this.platforms.invalidateLiveStatus()
      await this.logger.write('profile.applied', { gameId, captureMethod: detection.method, warnings, services, thumbnail, platformPreparationDeferred: !preparePlatforms })
      return { profile: updated, captureMethod: detection.method, warnings, services }
  }

  async select(gameId: string, override?: CaptureMethod, preparePlatforms = false): Promise<SelectionResult> {
    return this.exclusive(() => this.applySelection(gameId, override, preparePlatforms))
  }

  syncSavedProfile(profile: GameProfile, preparePlatforms = false): void {
    if (this.selected?.id !== profile.id) return
    this.selected = profile
    if (preparePlatforms) {
      this.platformPreparationPending = true
      this.platforms.invalidateLiveStatus()
    }
  }

  async runExclusiveLocalOperation<T>(operation: () => Promise<T>): Promise<T> {
    return this.exclusive(operation)
  }

  async start(allowServiceFailures = false): Promise<string[]> {
    return this.exclusive(async () => {
      if (!this.selected || !this.method) throw new Error('先にゲームを選択してください')
      let config = await this.store.getConfig()
      const preparationWarnings: string[] = []
      if (this.platformPreparationPending || (!allowServiceFailures && this.serviceFailures.length > 0)) {
        const preparation = await this.preparePlatformServices(config, this.selected, preparationWarnings)
        const thumbnail = preparation.thumbnail
        this.selected = await this.store.saveProfile({
          ...this.selected,
          state: {
            ...this.selected.state,
            thumbnailApplyStatus: thumbnail?.status ?? this.selected.state.thumbnailApplyStatus,
            thumbnailLastAppliedAt: thumbnail?.appliedAt ?? this.selected.state.thumbnailLastAppliedAt,
            thumbnailLastError: thumbnail ? (thumbnail.status === 'failed' ? thumbnail.message : undefined) : this.selected.state.thumbnailLastError,
          },
        })
        preparationWarnings.push(...preparation.thumbnailWarning)
        // YouTube preparation may create and persist a new broadcast id. Use
        // that saved config for the immediately following lifecycle calls.
        config = await this.store.getConfig()
      }
      if (this.serviceFailures.length && !allowServiceFailures) throw Object.assign(
        new Error(`配信サービスの設定に失敗しています: ${this.serviceFailures.join(' / ')}`),
        { services: [...this.servicePreparationResults] },
      )
      if (allowServiceFailures && this.failedServices.has('youtube')) {
        throw Object.assign(new Error('YouTubeの配信準備に失敗しているため、OBSへ触れずに開始を中止しました。現在のゲーム設定は保持されます。YouTubeを再接続して配信開始をもう一度実行してください'), { services: [...this.servicePreparationResults] })
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
        const warnings = [...preparationWarnings, ...await this.obs.start(runtimeConfig, selected, this.captureSource(selected, method))]
        await this.rememberManagedGameExitSession(runtimeConfig, selected, method)
        obsStartCompleted = true
        lastManagedStateRevision = this.obsStreamStateRevision
        ownsCurrentStream = this.obs.ownsCurrentStream()
        await this.platforms.startYouTubeBroadcast(runtimeConfig, selected)
        await this.platforms.startComments(runtimeConfig)
        this.lastPlatformHealthSignature = null
        if (!await this.obs.isStreaming(runtimeConfig)) throw new Error('外部サービスの開始処理中にOBS配信出力が停止しました')
        await this.advancePartNumber(selected).catch((error) => warnings.push(`次回のPart番号を保存できませんでした: ${error instanceof Error ? error.message : String(error)}`))
        this.platforms.invalidateLiveStatus()
        this.markManagedObsState(true)
        this.interruptedStreamSelectionId = null
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
            this.platformPreparationPending = true
            this.interruptedStreamSelectionId = selected.id
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
        await this.logger.write('stream.start_failed', {
          gameId: selected.id,
          captureMethod: method,
          error: this.warning,
          rollbackWarnings,
          platformDiagnostics: this.platforms.getDiagnostics?.() ?? null,
        }).catch(() => undefined)
        throw error
      }
    })
  }

  async stop(): Promise<string[]> {
    return this.exclusive(() => this.stopCurrentOutputs())
  }

  private async stopCurrentOutputs(expectedRevision?: number): Promise<string[]> {
      const guard = expectedRevision === undefined ? () => undefined : this.obs.createOutputStopGuard(expectedRevision)
      const config = await this.store.getConfig()
      const warnings = expectedRevision === undefined
        ? await this.obs.stop(config, this.selected)
        : await this.obs.stop(config, this.selected, expectedRevision)
      let obsStillStreaming: boolean | null = null
      try {
        obsStillStreaming = await this.obs.isStreaming(config)
        guard()
        if (obsStillStreaming) warnings.push('OBS配信出力が継続しているため、YouTube配信枠を終了していません')
        else {
          if (expectedRevision === undefined) await this.platforms.completeYouTubeBroadcast(config, this.selected)
          else await this.platforms.completeYouTubeBroadcast(config, this.selected, guard)
          guard()
          this.platformPreparationPending = true
          this.interruptedStreamSelectionId = null
        }
      } catch (error) {
        warnings.push(`OBS停止確認またはYouTube配信枠の終了に失敗しました: ${error instanceof Error ? error.message : String(error)}`)
      }
      guard()
      if (obsStillStreaming !== null) this.markManagedObsState(obsStillStreaming)
      await this.platforms.stopComments()
      this.platforms.invalidateLiveStatus()
      this.warning = warnings[0] ?? null
      await this.logger.write('stream.stopped', {
        gameId: this.selected?.id ?? null,
        warnings,
        platformDiagnostics: this.platforms.getDiagnostics?.() ?? null,
      })
      this.lastPlatformHealthSignature = null
      return warnings
  }

  async startRecordingOnly(): Promise<string[]> {
    return this.exclusive(async () => {
      this.recordingOnlyOperation = true
      this.recordingOnlyOperationRevision += 1
      try {
        const config = await this.store.getConfig()
        const assertIdle = async () => {
          const status = await this.obs.status(config, this.selected?.id ?? null, this.method, true, this.warning)
          if (!status.obsConnected) throw Object.assign(new Error('OBSへ接続してから録画を開始してください'), { statusCode: 409 })
          if (status.streaming || status.recording || status.replayBuffer || status.sourceRecord
            || status.verticalRecording || status.twitchOutputPlugin?.outputActive) {
            throw Object.assign(new Error('配信・録画・リプレイ・Twitch副出力をすべて停止してから「録画のみ」を開始してください'), { statusCode: 409 })
          }
          // OBS is authoritative here: an old queued/disconnected stream-stop
          // notification cannot own the local recording about to be started.
          this.markManagedObsState(false)
        }
        await assertIdle()
        const runningProcesses = await this.capture.runningProcesses().catch((error) => {
          throw new Error(`録画前に編集ソフトの停止を確認できませんでした: ${error instanceof Error ? error.message : String(error)}`)
        })
        const conflicts = [...new Set(runningProcesses.flatMap((processName) => {
          const label = recordingOnlyPostProductionProcesses.get(processName.trim().toLowerCase())
          return label ? [label] : []
        }))]
        if (conflicts.length) {
          throw Object.assign(new Error(`録画負荷を増やさないため、録画後に使う音声・字幕・編集ソフトを終了してください: ${conflicts.join('、')}`), { statusCode: 409 })
        }
        // A recording click must not race the five-second background detector
        // and freeze yesterday's game into the recording identity. Explicit
        // HDMI/display sources have no local game process to discover.
        const manualSource = this.selected && (this.method === 'elgato' || this.method === 'display')
        const detected = manualSource
          ? null
          : await this.capture.detectRunningProfile(await this.store.listProfiles(), this.selected?.id)
        if (!manualSource && !detected) {
          throw Object.assign(new Error(this.capture.processInventoryWarning?.()
            ?? '録画するゲームを自動認識できません。ゲームを起動し、ゲーム設定の認識対象を確認してください'), { statusCode: 409 })
        }
        await assertIdle()
        if (detected) await this.persistDetectedProfile(detected)
        const selection = detected
          ? await this.applySelection(detected.profile.id, detected.method, false, detected.windowTitle, true)
          : await this.applySelection(this.selected!.id, this.method!, false, undefined, true)
        const selected = selection.profile
        const method = selection.captureMethod
        // This path deliberately does not call PlatformServices. Recording-only
        // must never create, start, stop, or otherwise mutate a live platform.
        const recordingWarnings = await this.obs.startRecordingOnly(await this.store.getConfig(), selected, this.captureSource(selected, method), method)
        this.localRecordingOutputEpoch += 1
        await this.rememberManagedGameExitSession(await this.store.getConfig(), selected, method)
        const warnings = [...selection.warnings, ...recordingWarnings]
        this.warning = warnings[0] ?? null
        await this.logger.write('recording_only.started', { gameId: selected.id, captureMethod: method, warnings })
        return warnings
      } catch (error) {
        this.warning = error instanceof Error ? error.message : String(error)
        await this.logger.write('recording_only.start_failed', { gameId: this.selected?.id ?? null, captureMethod: this.method, error: this.warning }).catch(() => undefined)
        throw error
      } finally {
        this.recordingOnlyOperation = false
      }
    }, true)
  }

  async stopRecordingOnly(): Promise<{ warnings: string[]; outputPath: string | null; remuxedPath: string | null }> {
    return this.exclusive(() => this.stopRecordingOnlyCurrentOutput(), true)
  }

  private async stopRecordingOnlyCurrentOutput(expectedRevision?: number, beforeStop?: () => void, onStopCommitted?: () => void): Promise<{ warnings: string[]; outputPath: string | null; remuxedPath: string | null }> {
    this.recordingOnlyOperation = true
    this.recordingOnlyOperationRevision += 1
    try {
      const config = await this.store.getConfig()
      const result = expectedRevision === undefined
        ? await this.obs.stopRecordingOnly(config)
        : beforeStop ? await this.obs.stopRecordingOnly(config, expectedRevision, beforeStop, onStopCommitted) : await this.obs.stopRecordingOnly(config, expectedRevision)
      this.localRecordingOutputEpoch += 1
      this.warning = result.warnings[0] ?? null
      await this.logger.write('recording_only.stopped', {
        gameId: this.selected?.id ?? null,
        warnings: result.warnings,
        outputPath: result.outputPath,
        remuxedPath: result.remuxedPath,
      })
      return result
    } finally {
      this.recordingOnlyOperation = false
    }
  }

  private async rememberManagedGameExitSession(config: Awaited<ReturnType<DataStore['getConfig']>>, profile: GameProfile, method: CaptureMethod): Promise<void> {
    this.managedGameExitSession = null
    // Reconcile initial OBS state before capturing the session guard. Ownership
    // is intentionally memory-only: old profile metadata cannot authorize an
    // unattended stop after a Manager restart or an unrelated manual OBS start.
    if (!this.obs.getOutputSessionRevision) return
    try {
      const status = await this.obs.status(config, profile.id, method, true, this.warning)
      if (!status.obsConnected || !(status.recording || status.sourceRecord || status.verticalRecording)) return
      this.managedGameExitSession = { gameId: profile.id, method, guard: this.obs.createOutputStopGuard(this.obs.getOutputSessionRevision()) }
    } catch {
      await this.logGameExit('ownership_unavailable', { gameId: profile.id, reason: 'managed-start-status-unavailable' })
    }
  }

  private async currentGameExitTarget(): Promise<{
    target: GameExitTarget; profile: GameProfile; method: CaptureMethod; revision: number; recordingOnly: boolean
  } | null> {
    const config = await this.store.getConfig()
    const status = await this.obs.status(config, this.selected?.id ?? null, this.method, this.busy || this.externalSyncing, this.warning)
    const revision = this.obs.getOutputSessionRevision()
    if (!status.obsConnected) return null
    const streaming = status.streaming || status.twitchOutputPlugin?.outputActive === true
    const recording = status.recording || status.sourceRecord || status.verticalRecording
    if (!streaming && !recording) return null
    const gameId = status.recordingOnly ? status.recordingGameId : this.selected?.id
    if (!gameId) return null
    const profile = await this.store.getProfile(gameId)
    if (!profile) return null
    const method = status.recordingOnly
      ? profile.state.lastCaptureMethod ?? (profile.capture.preferred !== 'auto' ? profile.capture.preferred : null)
      : this.method
    if (!method || !['local', 'window', 'geforce_now'].includes(method)) return null
    const kind = streaming ? recording ? 'stream-and-recording' : 'stream' : 'recording'
    let automaticStopAllowed = false
    if (this.managedGameExitSession) {
      try {
        this.managedGameExitSession.guard()
        automaticStopAllowed = this.managedGameExitSession.gameId === gameId && this.managedGameExitSession.method === method
      } catch {
        this.managedGameExitSession = null
      }
    }
    return {
      target: {
        key: JSON.stringify([revision, gameId, method, status.streaming, status.twitchOutputPlugin?.outputActive === true,
          status.recording, status.sourceRecord, status.verticalRecording, status.recordingOnly, automaticStopAllowed]),
        gameId,
        gameName: status.recordingOnly ? status.recordingGameName || profile.displayName : profile.displayName,
        kind,
        automaticStopAllowed,
      },
      profile, method, revision, recordingOnly: status.recordingOnly,
    }
  }

  private async logGameExit(event: string, details: Record<string, unknown>): Promise<void> {
    await Promise.resolve(this.logger.write(`game_exit.${event}`, details)).catch(() => undefined)
  }

  private async cancelGameExitPrompt(reason: string): Promise<void> {
    const prompt = this.gameExitMonitor.currentPrompt()
    this.gameExitMonitor.invalidate()
    if (prompt) await this.logGameExit('cancelled', { ...prompt, reason })
  }

  startGameExitMonitoring(): void {
    if (this.gameExitTimer) return
    this.gameExitTimer = setInterval(() => { void this.pollGameExitPromptNow() }, gameExitServerPollMs)
    this.gameExitTimer.unref()
    void this.logGameExit('monitor_started', { pollIntervalMs: gameExitServerPollMs, graceMs: gameExitGraceMs, countdownMs: gameExitCountdownMs })
    void this.pollGameExitPromptNow()
  }

  async stopGameExitMonitoring(): Promise<void> {
    if (this.gameExitTimer) clearInterval(this.gameExitTimer)
    this.gameExitTimer = null
    this.gameExitPollGeneration += 1
    await this.cancelGameExitPrompt('server-shutdown')
    await this.gameExitPollInFlight?.catch(() => undefined)
  }

  async pollGameExitPrompt(): Promise<GameExitPrompt | null> {
    // The backend owns process/OBS sampling. Desktop polls only consume its
    // snapshot so an open native dialog cannot double the process scan load.
    if (this.gameExitTimer) return this.gameExitMonitor.currentPrompt()
    return this.pollGameExitPromptNow()
  }

  private async pollGameExitPromptNow(): Promise<GameExitPrompt | null> {
    if (this.respondingGameExitId) return this.gameExitMonitor.getPending(this.respondingGameExitId)?.prompt ?? null
    if (this.gameExitPollInFlight) return this.gameExitPollInFlight
    const operation = this.observeGameExitPrompt()
    this.gameExitPollInFlight = operation
    try { return await operation } finally {
      if (this.gameExitPollInFlight === operation) this.gameExitPollInFlight = null
    }
  }

  private async observeGameExitPrompt(): Promise<GameExitPrompt | null> {
    const generation = ++this.gameExitPollGeneration
    if (this.busy || this.externalSyncing || this.backgroundAudioEnsure) {
      await this.cancelGameExitPrompt('operation-busy')
      return null
    }
    try {
      const current = await this.currentGameExitTarget()
      const presence = current ? await this.capture.probeRunningGame(current.profile, current.method) : 'unknown'
      if (generation !== this.gameExitPollGeneration) return null
      if (this.busy || this.externalSyncing || this.backgroundAudioEnsure
        || current && current.revision !== this.obs.getOutputSessionRevision()) {
        await this.cancelGameExitPrompt('operation-or-session-changed')
        return null
      }
      if (this.lastGameExitObservationFailure) {
        this.lastGameExitObservationFailure = null
        await this.logGameExit('observation_recovered', { reason: 'observation-completed' })
      }
      const previous = this.gameExitMonitor.currentPrompt()
      const prompt = this.gameExitMonitor.observe(current?.target ?? null, presence)
      if (previous && previous.id !== prompt?.id) {
        await this.logGameExit('cancelled', { ...previous, reason: !current ? 'output-inactive-or-unavailable' : presence === 'running' ? 'game-running' : presence === 'unknown' ? 'observation-unknown' : 'session-changed' })
      }
      if (prompt && prompt.id !== previous?.id) {
        await this.logGameExit('detected', { ...prompt, reason: 'confirmed-game-exit' })
        if (prompt.autoStopAt !== null) await this.logGameExit('deadline_scheduled', { ...prompt, reason: 'recording-without-live-stream' })
      }
      if (prompt && this.gameExitMonitor.automaticStopDue(prompt.id)) {
        await this.logGameExit('deadline_reached', { ...prompt, reason: 'countdown-expired' })
        await this.stopForGameExit(prompt.id, 'countdown-expired')
        return this.gameExitMonitor.currentPrompt()
      }
      return prompt
    } catch (error) {
      if (generation === this.gameExitPollGeneration) {
        await this.cancelGameExitPrompt('observation-failed')
        const message = error instanceof Error ? error.message : String(error)
        if (this.lastGameExitObservationFailure !== message) await this.logGameExit('observation_failed', { reason: 'observation-failed', error: message })
        this.lastGameExitObservationFailure = message
      }
      return null
    }
  }

  async respondToGameExitPrompt(id: string, action: GameExitAction): Promise<GameExitResponse> {
    const pending = this.gameExitMonitor.getPending(id)
    if (!pending) return { stopped: false, warnings: [] }
    if (action === 'continue' && this.committedGameExitId === id) {
      await this.logGameExit('continue_too_late', { ...pending.prompt, reason: 'stop-command-already-issued' })
      return { stopped: false, warnings: ['録画停止処理がすでに始まっています。録画ファイルの保存完了を待ってください'] }
    }
    if (this.respondingGameExitId === id && action === 'stop') return { stopped: false, warnings: [] }
    if (action === 'dismiss') {
      await this.logGameExit('dismissed', { ...pending.prompt, reason: 'dialog-dismissed-countdown-unchanged' })
      return { stopped: false, warnings: [] }
    }
    if (action === 'continue') {
      this.gameExitPollGeneration += 1
      this.gameExitMonitor.suppress(id)
      await this.logGameExit('continued', { ...pending.prompt, reason: 'explicit-user-continue' })
      return { stopped: false, warnings: [] }
    }
    if (action !== 'stop') return { stopped: false, warnings: [] }
    return this.stopForGameExit(id, 'explicit-user-stop')
  }

  private async stopForGameExit(id: string, reason: 'explicit-user-stop' | 'countdown-expired'): Promise<GameExitResponse> {
    this.gameExitPollGeneration += 1
    const pending = this.gameExitMonitor.getPending(id)
    if (!pending || reason === 'countdown-expired' && !this.gameExitMonitor.automaticStopDue(id)) return { stopped: false, warnings: [] }
    let stopCommitted = false
    try {
      return await this.exclusive(async () => {
        this.respondingGameExitId = id
        try {
          if (!this.gameExitMonitor.getPending(id)) return { stopped: false, warnings: [] }
          const current = await this.currentGameExitTarget()
          if (!current || current.target.key !== pending.target.key) {
            await this.cancelGameExitPrompt('session-changed-before-stop')
            return { stopped: false, warnings: [] }
          }
          const presence = await this.capture.probeRunningGame(current.profile, current.method)
          const latest = await this.currentGameExitTarget()
          if (presence !== 'stopped' || !latest || latest.target.key !== pending.target.key
            || current.revision !== this.obs.getOutputSessionRevision()
            || reason === 'countdown-expired' && (latest.target.kind !== 'recording' || !latest.target.automaticStopAllowed)) {
            await this.cancelGameExitPrompt(presence === 'running' ? 'game-running-before-stop' : presence === 'unknown' ? 'observation-unknown-before-stop' : 'session-changed-before-stop')
            return { stopped: false, warnings: [] }
          }
          if (!this.gameExitMonitor.getPending(id)) return { stopped: false, warnings: [] }
          if (reason === 'explicit-user-stop') this.gameExitMonitor.suppress(id)
          await this.logGameExit('stop_requested', { ...pending.prompt, reason })
          const beforeStop = reason === 'countdown-expired' ? () => {
            if (this.committedGameExitId === id) return
            if (!this.gameExitMonitor.getPending(id)) throw new Error('自動録画停止が取り消されました')
          } : undefined
          const onStopCommitted = () => { beforeStop?.(); this.committedGameExitId = id; stopCommitted = true }
          beforeStop?.()
          const warnings = latest.target.kind === 'recording'
            ? latest.recordingOnly
              ? (await this.stopRecordingOnlyCurrentOutput(latest.revision, beforeStop, onStopCommitted)).warnings
              : beforeStop
                ? await this.obs.stopRecordingOutputs(await this.store.getConfig(), latest.revision, beforeStop, onStopCommitted)
                : await this.obs.stopRecordingOutputs(await this.store.getConfig(), latest.revision)
            : await this.stopCurrentOutputs(latest.revision)
          const status = await this.obs.status(await this.store.getConfig(), this.selected?.id ?? null, this.method, true, this.warning)
          const stopped = status.obsConnected && !status.streaming && !status.twitchOutputPlugin?.outputActive
            && !status.recording && !status.sourceRecord && !status.verticalRecording
          if (!stopped && !warnings.length) warnings.push('出力の停止を確認できませんでした。OBS Stream Managerで状態を確認してください')
          this.warning = warnings[0] ?? null
          await this.logGameExit('responded', { ...pending.prompt, reason, stopped, warnings })
          if (stopped) this.gameExitMonitor.suppress(id)
          else if (reason === 'countdown-expired') await this.retryAutomaticGameExitStop(id, 'stop-not-confirmed')
          return { stopped, warnings }
        } finally {
          this.respondingGameExitId = null
          this.committedGameExitId = null
        }
      })
    } catch (error) {
      if (reason === 'countdown-expired' && !stopCommitted && !this.gameExitMonitor.getPending(id)) {
        await this.logGameExit('stop_cancelled', { ...pending.prompt, reason: 'countdown-cancelled-before-stop' })
        return { stopped: false, warnings: [] }
      }
      if (reason === 'explicit-user-stop') this.gameExitMonitor.suppress(id)
      const message = `ゲーム終了後の出力停止を完了できませんでした: ${error instanceof Error ? error.message : String(error)}`
      this.warning = message
      await this.logGameExit('stop_failed', { ...pending.prompt, reason, error: message })
      if (reason === 'countdown-expired') await this.retryAutomaticGameExitStop(id, 'stop-request-failed')
      return { stopped: false, warnings: [message] }
    }
  }

  private async retryAutomaticGameExitStop(id: string, reason: string): Promise<void> {
    const current = await this.currentGameExitTarget().catch(() => null)
    if (!current?.target.automaticStopAllowed || current.target.kind !== 'recording') {
      await this.cancelGameExitPrompt('retry-session-unavailable')
      return
    }
    const retry = this.gameExitMonitor.retryAutomaticStop(id, current.target)
    if (retry) await this.logGameExit('retry_scheduled', { ...retry.prompt, attempt: retry.attempt, reason })
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
    this.pendingObsStreamStopRecordingEpoch = active ? null : this.localRecordingOutputEpoch
    this.scheduleObsStreamStateSync()
  }

  private markManagedObsState(active: boolean): void {
    this.obsStreamStateRevision += 1
    this.observedObsStreaming = active
    this.pendingObsStreamState = null
    this.pendingObsStreamStopRecordingEpoch = null
    if (!active) this.partAdvancedForCurrentStream = false
  }

  private scheduleObsStreamStateSync(): void {
    if (this.busy || this.externalSyncing || this.backgroundAudioEnsure || this.pendingObsStreamState === null) return
    void this.processObsStreamStateChanges()
  }

  private async processObsStreamStateChanges(): Promise<void> {
    this.externalSyncing = true
    try {
      while (this.pendingObsStreamState !== null) {
        const active = this.pendingObsStreamState
        const recordingEpoch = this.pendingObsStreamStopRecordingEpoch
        this.pendingObsStreamState = null
        this.pendingObsStreamStopRecordingEpoch = null
        if (!active && recordingEpoch !== this.localRecordingOutputEpoch) {
          await this.logger.write('stream.obs_stop_superseded', { reason: 'new-local-recording-operation' }).catch(() => undefined)
          continue
        }
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
        if (this.platformPreparationPending) {
          // The OBS output is already active, so creating/binding a new
          // YouTube broadcast now could point it at a different stream key.
          // Keep the previously prepared destination for this manual start;
          // the manager's next Start operation will perform a safe preflight.
          warnings.push('自動認識後にOBSから直接開始したため、YouTube・Twitchのタイトル更新は省略しました。次回はマネージャーの「配信開始」から開始すると配信前に更新されます')
        }
        await this.obs.startSecondaryTwitchForObsStream(config, this.selected).then((secondaryWarnings) => {
          warnings.push(...secondaryWarnings)
        }).catch((error) => {
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
      // OBS/RTMP stopped outside the managed Stop operation. Preserve the
      // current game and prepare only a fresh platform destination on resume.
      // This avoids forcing a profile re-selection and prevents the automatic
      // detector from switching to a launcher or another open game meanwhile.
      if (this.selected) {
        this.platformPreparationPending = true
        this.interruptedStreamSelectionId = this.selected.id
      }
      warnings.push(...await this.obs.finishObsTriggeredStream(config))
      await this.platforms.completeYouTubeBroadcast(config, this.selected).catch((error) => {
        warnings.push(`YouTube: ${error instanceof Error ? error.message : String(error)}`)
      })
      await this.platforms.stopComments().catch((error) => {
        warnings.push(`コメント: ${error instanceof Error ? error.message : String(error)}`)
      })
      this.warning = warnings[0] ?? null
      await this.logger.write('stream.obs_stopped', {
        gameId: this.selected?.id ?? null,
        warnings,
        platformDiagnostics: this.platforms.getDiagnostics?.() ?? null,
      })
      this.lastPlatformHealthSignature = null
    }
    this.platforms.invalidateLiveStatus()
  }

  async getStatus(): Promise<RuntimeStatus> {
    const config = await this.store.getConfig()
    const stateRevision = this.obsStreamStateRevision
    const recordingOperationAtStart = this.recordingOnlyOperation
    let recordingOperationRevision = this.recordingOnlyOperationRevision
    let obsStatus = await this.obs.status(config, this.selected?.id ?? null, this.method, this.busy || this.externalSyncing, this.warning)
    const recordingChangedDuringObsRead = recordingOperationRevision !== this.recordingOnlyOperationRevision
    if (recordingChangedDuringObsRead) {
      obsStatus = await this.obs.status(config, this.selected?.id ?? null, this.method, this.busy || this.externalSyncing, this.warning)
      recordingOperationRevision = this.recordingOnlyOperationRevision
    }
    let streamOutputActive = obsStatus.streaming || obsStatus.twitchOutputPlugin?.outputActive === true
    let localRecording = !streamOutputActive && (obsStatus.recordingOnly || recordingOperationAtStart || this.recordingOnlyOperation || recordingChangedDuringObsRead)
    // Recording does not require a streaming account. Keep known external
    // status visible, but do not refresh OAuth or perform deferred stream
    // teardown as a side effect of recording/start/stop status polling.
    let platforms = localRecording
      ? this.platforms.getDeferredLiveStatus(config, this.selected)
      : await this.platforms.getLiveStatus(config, this.selected, () => recordingOperationRevision === this.recordingOnlyOperationRevision)
    if (recordingOperationRevision !== this.recordingOnlyOperationRevision) {
      // A slow provider request may have begun before Recording was clicked.
      // Do not let its stale failure/status overwrite the newer local result.
      obsStatus = await this.obs.status(config, this.selected?.id ?? null, this.method, this.busy || this.externalSyncing, this.warning)
      streamOutputActive = obsStatus.streaming || obsStatus.twitchOutputPlugin?.outputActive === true
      localRecording = !streamOutputActive
      const latestRecordingOperationRevision = this.recordingOnlyOperationRevision
      platforms = localRecording
        ? this.platforms.getDeferredLiveStatus(config, this.selected)
        : await this.platforms.getLiveStatus(config, this.selected, () => latestRecordingOperationRevision === this.recordingOnlyOperationRevision)
    }
    if (obsStatus.streaming) {
      const platformDiagnostics = this.platforms.getDiagnostics?.() ?? null
      const signature = JSON.stringify({
        youtube: [platforms.youtube.checkedAt, platforms.youtube.state, platforms.youtube.viewerCount, platforms.youtube.viewerCountState],
        twitch: [platforms.twitch.checkedAt, platforms.twitch.state, platforms.twitch.viewerCount, platforms.twitch.viewerCountState],
        comments: platformDiagnostics?.comments ?? null,
      })
      if (signature !== this.lastPlatformHealthSignature) {
        this.lastPlatformHealthSignature = signature
        void Promise.resolve(this.logger.write('stream.platform_health', {
          gameId: this.selected?.id ?? null,
          captureMethod: this.method,
          platforms,
          platformDiagnostics,
        })).catch(() => undefined)
      }
    }
    if (obsStatus.obsConnected && !streamOutputActive && !localRecording && !this.busy && !this.externalSyncing) {
      void this.platforms.retryPendingYouTubeCompletion?.(config)
        .then((retriedCompletion) => {
          if (retriedCompletion) {
            this.platforms.invalidateLiveStatus()
            if (this.warning?.startsWith('YouTube配信枠の終了再試行に失敗しました:')) this.warning = null
          }
        })
        .catch((error) => {
          void Promise.resolve(this.logger.write('youtube.completion_retry_failed', {
            error: error instanceof Error ? error.message : String(error),
          })).catch(() => undefined)
        })
    }
    if (!obsStatus.obsConnected) {
      this.ensuredAudioKey = null
      this.appliedBgmKey = null
    }
    // A WebSocket disconnect is not evidence that the RTMP output stopped.
    // Keep the last observed stream state until OBS reconnects and returns an
    // authoritative GetStreamStatus response.
    if (obsStatus.obsConnected && stateRevision === this.obsStreamStateRevision) {
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
    // OBS echoed the warning captured before asynchronous status work. A local
    // recording operation may have replaced that old platform failure with
    // success or a real capture error while the provider request was pending.
    return { ...obsStatus, warning: this.warning, platforms }
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
        const durationMs = Math.max(1_000, Math.min(30_000, options.durationMs ?? 15_000))
        const activeGameAudioInput = this.selected && this.method ? this.captureSource(this.selected, this.method) : undefined
        return await this.obs.testTwitchIngest(config, durationMs, options, activeGameAudioInput)
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
        readings: result.readings.map(({ role, sourceName, status: readingStatus, previousDb, previousBoostDb, appliedDb, appliedBoostDb, verifiedDb, verifiedPeakDb }) => ({
          role,
          sourceName,
          status: readingStatus,
          previousDb,
          previousBoostDb,
          appliedDb,
          appliedBoostDb,
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

  async ensureSelectedAudio(): Promise<{ applied: boolean; warnings: string[] }> {
    if (this.busy || this.externalSyncing || this.backgroundAudioEnsure) return { applied: false, warnings: [] }
    const revision = ++this.backgroundAudioEnsureRevision
    this.backgroundAudioEnsurePhase = 'checking'
    const operation = (async () => {
      if (!this.selected || !this.method) return { applied: false, warnings: [] }
      const selectedId = this.selected.id
      const selectedMethod = this.method
      const status = await this.getStatus()
      if (revision !== this.backgroundAudioEnsureRevision || this.busy) return { applied: false, warnings: [] }
      const externalActive = Object.values(status.platforms).some(({ state }) => ['starting', 'live', 'stopping'].includes(state))
      if (!status.obsConnected || status.streaming || status.recording || status.replayBuffer || externalActive) return { applied: false, warnings: [] }
      if (this.selected?.id !== selectedId || this.method !== selectedMethod) return { applied: false, warnings: [] }
      const config = await this.store.getConfig()
      const latest = await this.store.getProfile(selectedId)
      if (revision !== this.backgroundAudioEnsureRevision || this.busy) return { applied: false, warnings: [] }
      if (!latest) return { applied: false, warnings: [] }
      const key = this.profileApplicationKey(latest, selectedMethod)
      const bgmKey = this.profileBgmApplicationKey(latest)
      const profileReady = this.ensuredAudioKey === key
      const bgmReady = !this.bgm || this.appliedBgmKey === bgmKey
      if (profileReady && bgmReady) return { applied: true, warnings: [] }
      const warnings: string[] = []
      let audioApplied = true
      this.backgroundAudioEnsurePhase = 'applying'
      if (!profileReady) {
        const appliedProfile = await this.applyObsProfile(config, latest, selectedMethod, undefined, true)
        warnings.push(...appliedProfile.warnings)
        audioApplied = appliedProfile.audioApplied
      }
      if (!bgmReady) await this.applyProfileBgm(config, latest, warnings)
      if (this.selected?.id !== selectedId || this.method !== selectedMethod) return { applied: false, warnings: [] }
      this.ensuredAudioKey = audioApplied ? key : null
      this.selected = latest
      await this.logger.write('profile.runtime_ensured', {
        gameId: latest.id,
        captureMethod: selectedMethod,
        sceneName: latest.obs.sceneName,
        microphoneDb: latest.audio.microphoneDb,
        microphoneBoostDb: latest.audio.microphoneBoostDb,
        bgmTrackId: latest.bgm.trackId,
        warnings,
      }).catch(() => undefined)
      return { applied: audioApplied, warnings }
    })()
    this.backgroundAudioEnsure = operation
    try { return await operation } finally {
      if (this.backgroundAudioEnsure === operation) {
        this.backgroundAudioEnsure = null
        this.backgroundAudioEnsurePhase = null
      }
      void Promise.resolve().then(() => this.scheduleObsStreamStateSync())
    }
  }

  async invalidateProfile(gameId: string): Promise<void> {
    if (this.selected?.id !== gameId) return
    this.selected = null
    this.method = null
    this.serviceFailures = []
    this.servicePreparationResults = []
    this.platformPreparationPending = false
    this.interruptedStreamSelectionId = null
    this.warning = 'ゲーム設定を変更しました。配信前にゲームを選び直してください'
    this.ensuredAudioKey = null
    this.appliedBgmKey = null
    await this.persistSelectedGame(null)
  }

  async resetSelection(message = '設定が変更されました。配信前にゲームを選び直してください'): Promise<void> {
    this.selected = null
    this.method = null
    this.serviceFailures = []
    this.servicePreparationResults = []
    this.platformPreparationPending = false
    this.interruptedStreamSelectionId = null
    this.warning = message
    this.ensuredAudioKey = null
    this.appliedBgmKey = null
    await this.persistSelectedGame(null)
  }
}
