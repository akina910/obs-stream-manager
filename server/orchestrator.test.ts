import { describe, expect, it, vi } from 'vitest'
import type { CaptureDetector } from './capture.js'
import { defaultConfig } from './defaults.js'
import { starterProfiles } from './defaults.js'
import type { AppLogger } from './logger.js'
import type { ObsController } from './obs.js'
import { StreamOrchestrator } from './orchestrator.js'
import type { PlatformServices } from './platforms.js'
import type { DataStore } from './storage.js'
import type { BgmLibraryStore } from './bgm-library.js'
import type { GameProfile } from '../shared/contracts.js'

describe('StreamOrchestrator operation exclusion', () => {
  it('starts and stops recording-only without touching YouTube or Twitch services', async () => {
    const config = structuredClone(defaultConfig)
    const profile = structuredClone(starterProfiles.find(({ id }) => id === 'ark_survival_ascended')!)
    const store = { getConfig: vi.fn().mockResolvedValue(config) } as unknown as DataStore
    const obs = {
      startRecordingOnly: vi.fn().mockResolvedValue([]),
      stopRecordingOnly: vi.fn().mockResolvedValue({ warnings: [], outputPath: 'J:\\Recordings\\ASA\\capture.mkv', remuxedPath: 'J:\\Recordings\\ASA\\capture.mp4' }),
    } as unknown as ObsController
    const capture = { runningProcesses: vi.fn().mockResolvedValue(['steam.exe', 'arkascended.exe']) } as unknown as CaptureDetector
    const platforms = {
      getLiveStatus: vi.fn(),
      prepare: vi.fn(),
      startYouTubeBroadcast: vi.fn(),
      completeYouTubeBroadcast: vi.fn(),
      startComments: vi.fn(),
      stopComments: vi.fn(),
      invalidateLiveStatus: vi.fn(),
    } as unknown as PlatformServices
    const logger = { write: vi.fn().mockResolvedValue(undefined) } as unknown as AppLogger
    const orchestrator = new StreamOrchestrator(store, obs, capture, platforms, logger)
    Object.assign(orchestrator as unknown as { selected: GameProfile; method: 'local' }, { selected: profile, method: 'local' })

    await expect(orchestrator.startRecordingOnly()).resolves.toEqual([])
    expect(obs.startRecordingOnly).toHaveBeenCalledWith(config, profile, profile.capture.localSourceName, 'local')
    expect(platforms.getLiveStatus).not.toHaveBeenCalled()
    expect(platforms.prepare).not.toHaveBeenCalled()
    expect(platforms.startYouTubeBroadcast).not.toHaveBeenCalled()
    expect(platforms.startComments).not.toHaveBeenCalled()

    await expect(orchestrator.stopRecordingOnly()).resolves.toMatchObject({ remuxedPath: expect.stringContaining('capture.mp4') })
    expect(obs.stopRecordingOnly).toHaveBeenCalledWith(config)
    expect(platforms.completeYouTubeBroadcast).not.toHaveBeenCalled()
    expect(platforms.stopComments).not.toHaveBeenCalled()
    expect(platforms.invalidateLiveStatus).not.toHaveBeenCalled()
  })

  it('blocks recording-only while post-production software is running', async () => {
    const profile = structuredClone(starterProfiles.find(({ id }) => id === 'ark_survival_ascended')!)
    const obs = { startRecordingOnly: vi.fn() } as unknown as ObsController
    const capture = { runningProcesses: vi.fn().mockResolvedValue(['ArkAscended.exe', 'VOCALOID6.exe', 'AfterFX.exe']) } as unknown as CaptureDetector
    const orchestrator = new StreamOrchestrator(
      { getConfig: vi.fn().mockResolvedValue(structuredClone(defaultConfig)) } as unknown as DataStore,
      obs,
      capture,
      {} as PlatformServices,
      { write: vi.fn().mockResolvedValue(undefined) } as unknown as AppLogger,
    )
    Object.assign(orchestrator as unknown as { selected: GameProfile; method: 'local' }, { selected: profile, method: 'local' })

    await expect(orchestrator.startRecordingOnly()).rejects.toThrow('VOCALOID6、Adobe After Effects')
    expect(obs.startRecordingOnly).not.toHaveBeenCalled()
  })

  it('records any selected game without touching YouTube or Twitch', async () => {
    const config = structuredClone(defaultConfig)
    const profile = structuredClone(starterProfiles.find(({ id }) => id === 'minecraft')!)
    const obs = { startRecordingOnly: vi.fn().mockResolvedValue([]) } as unknown as ObsController
    const orchestrator = new StreamOrchestrator(
      { getConfig: vi.fn().mockResolvedValue(config) } as unknown as DataStore,
      obs,
      { runningProcesses: vi.fn().mockResolvedValue(['Minecraft.Windows.exe']) } as unknown as CaptureDetector,
      { getLiveStatus: vi.fn(), prepare: vi.fn(), startYouTubeBroadcast: vi.fn() } as unknown as PlatformServices,
      { write: vi.fn() } as unknown as AppLogger,
    )
    Object.assign(orchestrator as unknown as { selected: GameProfile; method: 'local' }, { selected: profile, method: 'local' })

    await expect(orchestrator.startRecordingOnly()).resolves.toEqual([])
    expect(obs.startRecordingOnly).toHaveBeenCalledWith(config, profile, profile.capture.localSourceName, 'local')
  })

  it('retries a deferred YouTube completion only after OBS is no longer streaming', async () => {
    const config = structuredClone(defaultConfig)
    const store = { getConfig: vi.fn().mockResolvedValue(config) } as unknown as DataStore
    const obsStatus = {
      obsConnected: true,
      streaming: true,
      recording: false,
      replayBuffer: false,
      sourceRecord: false,
      verticalRecording: false,
      selectedGameId: null,
      captureMethod: null,
      currentScene: '10_GAME_PC',
      warning: null,
      busy: false,
    }
    const obs = { status: vi.fn().mockResolvedValue(obsStatus) } as unknown as ObsController
    const liveStatus = {
      youtube: { state: 'live' as const, detail: 'YouTubeで公開配信中', checkedAt: new Date().toISOString() },
      twitch: { state: 'offline' as const, detail: 'Twitchはオフライン', checkedAt: new Date().toISOString() },
    }
    const platforms = {
      getLiveStatus: vi.fn().mockResolvedValue(liveStatus),
      retryPendingYouTubeCompletion: vi.fn().mockResolvedValue(true),
      invalidateLiveStatus: vi.fn(),
    } as unknown as PlatformServices
    const orchestrator = new StreamOrchestrator(store, obs, {} as CaptureDetector, platforms, { write: vi.fn() } as unknown as AppLogger)
    ;(orchestrator as unknown as { busy: boolean }).busy = true

    await orchestrator.getStatus()
    expect(platforms.retryPendingYouTubeCompletion).not.toHaveBeenCalled()

    vi.mocked(obs.status).mockResolvedValue({ ...obsStatus, streaming: false })
    await orchestrator.getStatus()
    expect(platforms.retryPendingYouTubeCompletion).not.toHaveBeenCalled()

    ;(orchestrator as unknown as { busy: boolean; warning: string | null }).busy = false
    ;(orchestrator as unknown as { busy: boolean; warning: string | null }).warning = 'YouTube配信枠の終了再試行に失敗しました: temporary'
    await orchestrator.getStatus()
    expect(platforms.retryPendingYouTubeCompletion).toHaveBeenCalledWith(config)
    expect(platforms.getLiveStatus).toHaveBeenCalledTimes(3)
    await vi.waitFor(() => expect(platforms.invalidateLiveStatus).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect((orchestrator as unknown as { warning: string | null }).warning).toBeNull())
  })

  it('does not hold the runtime status response open while a deferred YouTube completion is pending', async () => {
    const config = structuredClone(defaultConfig)
    const store = { getConfig: vi.fn().mockResolvedValue(config) } as unknown as DataStore
    const obs = {
      status: vi.fn().mockResolvedValue({ obsConnected: true, streaming: false, recording: false, replayBuffer: false }),
    } as unknown as ObsController
    let finishRetry!: (value: boolean) => void
    const retry = new Promise<boolean>((resolve) => { finishRetry = resolve })
    const liveStatus = {
      youtube: { state: 'stopping' as const, detail: 'YouTubeの終了確認中', checkedAt: new Date().toISOString() },
      twitch: { state: 'offline' as const, detail: 'Twitchはオフライン', checkedAt: new Date().toISOString() },
    }
    const platforms = {
      getLiveStatus: vi.fn().mockResolvedValue(liveStatus),
      retryPendingYouTubeCompletion: vi.fn().mockReturnValue(retry),
      invalidateLiveStatus: vi.fn(),
    } as unknown as PlatformServices
    const orchestrator = new StreamOrchestrator(store, obs, {} as CaptureDetector, platforms, { write: vi.fn() } as unknown as AppLogger)

    const result = await Promise.race([
      orchestrator.getStatus().then(() => 'resolved'),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 50)),
    ])
    expect(result).toBe('resolved')
    finishRetry(false)
    await retry
  })

  it('logs an idle YouTube cleanup failure without showing it as a user operation error', async () => {
    const config = structuredClone(defaultConfig)
    const store = { getConfig: vi.fn().mockResolvedValue(config) } as unknown as DataStore
    const obs = {
      status: vi.fn().mockResolvedValue({
        obsConnected: true,
        streaming: false,
        recording: false,
        replayBuffer: false,
        warning: null,
      }),
    } as unknown as ObsController
    const platforms = {
      getLiveStatus: vi.fn().mockResolvedValue({
        youtube: { state: 'offline', detail: 'YouTubeはオフライン', checkedAt: new Date().toISOString() },
        twitch: { state: 'offline', detail: 'Twitchはオフライン', checkedAt: new Date().toISOString() },
      }),
      retryPendingYouTubeCompletion: vi.fn().mockRejectedValue(new Error('400 invalid_grant')),
    } as unknown as PlatformServices
    const logger = { write: vi.fn().mockResolvedValue(undefined) } as unknown as AppLogger
    const orchestrator = new StreamOrchestrator(store, obs, {} as CaptureDetector, platforms, logger)

    const status = await orchestrator.getStatus()

    expect(status.warning).toBeNull()
    await vi.waitFor(() => expect(logger.write).toHaveBeenCalledWith('youtube.completion_retry_failed', {
      error: '400 invalid_grant',
    }))
    expect((orchestrator as unknown as { warning: string | null }).warning).toBeNull()
  })

  it('does not treat a temporary OBS WebSocket disconnect as a stopped public stream', async () => {
    const config = structuredClone(defaultConfig)
    const store = { getConfig: vi.fn().mockResolvedValue(config) } as unknown as DataStore
    const obs = {
      status: vi.fn().mockResolvedValue({
        obsConnected: false,
        streaming: false,
        recording: false,
        replayBuffer: false,
      }),
    } as unknown as ObsController
    const platforms = {
      getLiveStatus: vi.fn().mockResolvedValue({}),
      retryPendingYouTubeCompletion: vi.fn().mockResolvedValue(true),
      completeYouTubeBroadcast: vi.fn(),
      invalidateLiveStatus: vi.fn(),
    } as unknown as PlatformServices
    const orchestrator = new StreamOrchestrator(
      store,
      obs,
      {} as CaptureDetector,
      platforms,
      { write: vi.fn() } as unknown as AppLogger,
    )
    const state = orchestrator as unknown as { observedObsStreaming: boolean | null }
    state.observedObsStreaming = true

    await orchestrator.getStatus()

    expect(state.observedObsStreaming).toBe(true)
    expect(platforms.retryPendingYouTubeCompletion).not.toHaveBeenCalled()
    expect(platforms.completeYouTubeBroadcast).not.toHaveBeenCalled()
  })

  it('applies a running game profile automatically while OBS is idle', async () => {
    let config = structuredClone(defaultConfig)
    const profile = structuredClone(starterProfiles[0])
    const store = {
      listProfiles: vi.fn().mockResolvedValue([profile]),
      getProfile: vi.fn().mockResolvedValue(profile),
      getConfig: vi.fn(async () => config),
      saveProfile: vi.fn(async (value) => value),
      saveConfig: vi.fn(async (value) => value),
    } as unknown as DataStore
    const obs = {
      status: vi.fn().mockResolvedValue({ obsConnected: true, streaming: false, recording: false, replayBuffer: false }),
      applyProfile: vi.fn().mockResolvedValue({ warnings: [], audioApplied: true }),
      preparePrimaryStream: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue([]),
      ownsCurrentStream: vi.fn().mockReturnValue(true),
      isStreaming: vi.fn().mockResolvedValue(true),
    } as unknown as ObsController
    const capture = {
      detectRunningProfile: vi.fn().mockResolvedValue({ profile, method: 'local', executableName: 'arkascended.exe' }),
    } as unknown as CaptureDetector
    const platforms = {
      prepare: vi.fn().mockImplementation(async () => {
        config = { ...config, youtube: { ...config.youtube, broadcastId: 'new-broadcast-id' } }
        return [
          { service: 'youtube' as const, ok: true, message: 'ok' },
          { service: 'twitch' as const, ok: true, message: 'ok' },
        ]
      }),
      startYouTubeBroadcast: vi.fn().mockResolvedValue(undefined),
      startComments: vi.fn().mockResolvedValue(undefined),
      invalidateLiveStatus: vi.fn(),
    } as unknown as PlatformServices
    const logger = { write: vi.fn().mockResolvedValue(undefined) } as unknown as AppLogger
    const orchestrator = new StreamOrchestrator(store, obs, capture, platforms, logger)

    await expect(orchestrator.autoSelectRunningGame()).resolves.toMatchObject({
      detected: true,
      applied: false,
      gameId: profile.id,
      executableName: 'arkascended.exe',
      captureMethod: 'local',
    })
    expect(obs.applyProfile).not.toHaveBeenCalled()

    await expect(orchestrator.autoSelectRunningGame()).resolves.toMatchObject({
      detected: true,
      applied: true,
      gameId: profile.id,
      executableName: 'arkascended.exe',
      captureMethod: 'local',
    })
    expect(obs.applyProfile).toHaveBeenCalledWith(config, profile, 'local')
    expect(platforms.prepare).not.toHaveBeenCalled()
    expect(obs.preparePrimaryStream).toHaveBeenCalledOnce()
    expect(store.saveConfig).toHaveBeenCalledWith(expect.objectContaining({ ui: expect.objectContaining({ lastSelectedGameId: profile.id }) }))
    expect(logger.write).toHaveBeenCalledWith('profile.auto_detected', expect.objectContaining({ gameId: profile.id }))

    await expect(orchestrator.start()).resolves.toEqual([])
    expect(platforms.prepare).toHaveBeenCalledOnce()
    expect(obs.preparePrimaryStream).toHaveBeenCalledTimes(2)
    expect(obs.preparePrimaryStream).toHaveBeenLastCalledWith(expect.objectContaining({ youtube: expect.objectContaining({ broadcastId: 'new-broadcast-id' }) }), expect.anything())
    expect(platforms.startYouTubeBroadcast).toHaveBeenCalledWith(expect.objectContaining({ youtube: expect.objectContaining({ broadcastId: 'new-broadcast-id' }) }), expect.anything())
    expect(obs.start).toHaveBeenCalledOnce()
  })

  it('surfaces a process-inventory failure once and clears it after recovery', async () => {
    const store = { listProfiles: vi.fn().mockResolvedValue([]) } as unknown as DataStore
    const captureWarning = '実行中ソフトを確認できないため、ゲームの自動認識を一時停止しています'
    const capture = {
      detectRunningProfile: vi.fn().mockResolvedValue(null),
      processInventoryWarning: vi.fn().mockReturnValue(captureWarning),
    } as unknown as CaptureDetector
    const logger = { write: vi.fn().mockResolvedValue(undefined) } as unknown as AppLogger
    const orchestrator = new StreamOrchestrator(store, {} as ObsController, capture, {} as PlatformServices, logger)

    await orchestrator.autoSelectRunningGame()
    await orchestrator.autoSelectRunningGame()
    expect((orchestrator as unknown as { warning: string | null }).warning).toBe(captureWarning)
    expect(logger.write).toHaveBeenCalledTimes(1)
    expect(logger.write).toHaveBeenCalledWith('profile.auto_detection_unavailable', { message: captureWarning })

    vi.mocked(capture.processInventoryWarning).mockReturnValue(null)
    await orchestrator.autoSelectRunningGame()
    expect((orchestrator as unknown as { warning: string | null }).warning).toBeNull()
    expect(logger.write).toHaveBeenLastCalledWith('profile.auto_detection_recovered', {})
  })

  it('rechecks OBS inside the exclusive section and never auto-applies during an active output', async () => {
    const config = structuredClone(defaultConfig)
    const profile = structuredClone(starterProfiles[0])
    const store = {
      listProfiles: vi.fn().mockResolvedValue([profile]),
      getConfig: vi.fn().mockResolvedValue(config),
    } as unknown as DataStore
    const obs = {
      status: vi.fn().mockResolvedValue({ obsConnected: true, streaming: true, recording: false, replayBuffer: false }),
      applyProfile: vi.fn(),
    } as unknown as ObsController
    const capture = {
      detectRunningProfile: vi.fn().mockResolvedValue({ profile, method: 'local', executableName: 'arkascended.exe' }),
    } as unknown as CaptureDetector
    const logger = { write: vi.fn().mockResolvedValue(undefined) } as unknown as AppLogger
    const orchestrator = new StreamOrchestrator(store, obs, capture, {} as PlatformServices, logger)

    await expect(orchestrator.autoSelectRunningGame()).resolves.toMatchObject({ detected: true, applied: false, gameId: profile.id })
    await expect(orchestrator.autoSelectRunningGame()).resolves.toMatchObject({ detected: true, applied: false, gameId: profile.id })
    expect(obs.status).toHaveBeenCalledWith(config, null, null, true, null)
    expect(obs.applyProfile).not.toHaveBeenCalled()
  })

  it('does not create a new platform destination after a direct OBS start is already active', async () => {
    const config = structuredClone(defaultConfig)
    const profile = structuredClone(starterProfiles[0])
    profile.state.lastCaptureMethod = 'local'
    profile.state.lastUsedAt = '2026-07-23T00:00:00.000Z'
    config.ui.lastSelectedGameId = profile.id
    const store = {
      getConfig: vi.fn().mockResolvedValue(config),
      getProfile: vi.fn().mockResolvedValue(profile),
      saveProfile: vi.fn(async (value) => value),
      saveConfig: vi.fn(async (value) => value),
    } as unknown as DataStore
    const obs = {
      startSecondaryTwitchForObsStream: vi.fn().mockResolvedValue([]),
    } as unknown as ObsController
    const platforms = {
      prepare: vi.fn(),
      startYouTubeBroadcast: vi.fn().mockResolvedValue(undefined),
      startComments: vi.fn().mockResolvedValue(undefined),
      invalidateLiveStatus: vi.fn(),
    } as unknown as PlatformServices
    const logger = { write: vi.fn().mockResolvedValue(undefined) } as unknown as AppLogger
    const orchestrator = new StreamOrchestrator(store, obs, {} as CaptureDetector, platforms, logger)
    await orchestrator.restoreSelection()

    orchestrator.handleObsStreamStateChanged(true)
    await vi.waitFor(() => expect(logger.write).toHaveBeenCalledWith('stream.obs_started', expect.anything()))

    expect(platforms.prepare).not.toHaveBeenCalled()
    expect(platforms.startYouTubeBroadcast).toHaveBeenCalledWith(config, expect.objectContaining({ id: profile.id }))
    expect(logger.write).toHaveBeenCalledWith('stream.obs_started', expect.objectContaining({
      warnings: expect.arrayContaining([expect.stringContaining('OBSから直接開始')]),
    }))
  })

  it('keeps a Twitch bandwidth test mutually exclusive with normal stream startup', async () => {
    let releaseTest!: () => void
    const testBlocked = new Promise<never>((resolve) => { releaseTest = resolve as () => void })
    const config = structuredClone(defaultConfig)
    const testTwitchIngest = vi.fn(() => testBlocked)
    const obs = {
      status: vi.fn().mockResolvedValue({
        obsConnected: true,
        streaming: false,
        recording: false,
        replayBuffer: false,
        sourceRecord: false,
        verticalRecording: false,
        selectedGameId: null,
        captureMethod: null,
        currentScene: '10_GAME_PC',
        warning: null,
        busy: true,
      }),
      testTwitchIngest,
      isStreaming: vi.fn().mockResolvedValue(false),
    } as unknown as ObsController
    const store = { getConfig: vi.fn().mockResolvedValue(config) } as unknown as DataStore
    const platforms = {
      getLiveStatus: vi.fn().mockResolvedValue({
        youtube: { state: 'offline', detail: 'YouTubeはオフライン', checkedAt: new Date().toISOString() },
        twitch: { state: 'offline', detail: 'Twitchはオフライン', checkedAt: new Date().toISOString() },
      }),
    } as unknown as PlatformServices
    const logger = { write: vi.fn().mockResolvedValue(undefined) } as unknown as AppLogger
    const orchestrator = new StreamOrchestrator(store, obs, {} as CaptureDetector, platforms, logger)

    const pendingTest = orchestrator.testTwitchOutput()
    await vi.waitFor(() => expect(testTwitchIngest).toHaveBeenCalledOnce())
    await expect(orchestrator.start()).rejects.toThrow('別の配信操作を処理中です')

    releaseTest()
    await expect(pendingTest).resolves.toBeUndefined()
  })

  it('does not treat Twitch bandwidth-test events as a real broadcast lifecycle', async () => {
    const config = structuredClone(defaultConfig)
    const profile = structuredClone(starterProfiles[0])
    const store = {
      getProfile: vi.fn().mockResolvedValue(profile),
      getConfig: vi.fn().mockResolvedValue(config),
      saveProfile: vi.fn(async (value) => value),
      saveConfig: vi.fn(async (value) => value),
    } as unknown as DataStore
    const obs = {
      status: vi.fn().mockResolvedValue({
        obsConnected: true,
        streaming: false,
        recording: false,
        replayBuffer: false,
        sourceRecord: false,
        verticalRecording: false,
        selectedGameId: profile.id,
        captureMethod: 'window',
        currentScene: profile.obs.sceneName,
        warning: null,
        busy: true,
      }),
      applyProfile: vi.fn().mockResolvedValue({ warnings: [], audioApplied: true }),
      preparePrimaryStream: vi.fn().mockResolvedValue(undefined),
      isStreaming: vi.fn().mockResolvedValue(false),
      testTwitchIngest: vi.fn(),
      startSecondaryTwitchForObsStream: vi.fn(),
      finishObsTriggeredStream: vi.fn().mockResolvedValue([]),
    } as unknown as ObsController
    const platforms = {
      prepare: vi.fn().mockResolvedValue([
        { service: 'youtube', ok: true, message: 'ok' },
        { service: 'twitch', ok: true, message: 'ok' },
      ]),
      getLiveStatus: vi.fn().mockResolvedValue({
        youtube: { state: 'ready', detail: 'YouTube公開開始待ち', checkedAt: new Date().toISOString() },
        twitch: { state: 'offline', detail: 'Twitchはオフライン', checkedAt: new Date().toISOString() },
      }),
      startYouTubeBroadcast: vi.fn(),
      completeYouTubeBroadcast: vi.fn(),
      startComments: vi.fn(),
      stopComments: vi.fn(),
      invalidateLiveStatus: vi.fn(),
    } as unknown as PlatformServices
    const logger = { write: vi.fn().mockResolvedValue(undefined) } as unknown as AppLogger
    const orchestrator = new StreamOrchestrator(store, obs, {} as CaptureDetector, platforms, logger)
    vi.mocked(obs.testTwitchIngest).mockImplementation(async () => {
      orchestrator.handleObsStreamStateChanged(true)
      orchestrator.handleObsStreamStateChanged(false)
      return { ok: true, durationMs: 1, bytesSent: 1, totalFrames: 1, skippedFrames: 0, congestion: 0 }
    })

    await orchestrator.select(profile.id, 'window')
    await expect(orchestrator.testTwitchOutput()).resolves.toMatchObject({ ok: true })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(obs.startSecondaryTwitchForObsStream).not.toHaveBeenCalled()
    expect(obs.finishObsTriggeredStream).not.toHaveBeenCalled()
    expect(platforms.startYouTubeBroadcast).not.toHaveBeenCalled()
    expect(platforms.completeYouTubeBroadcast).not.toHaveBeenCalled()
    expect(platforms.startComments).not.toHaveBeenCalled()
    expect(platforms.stopComments).not.toHaveBeenCalled()
    expect(logger.write).not.toHaveBeenCalledWith('stream.obs_started', expect.anything())
    expect(logger.write).not.toHaveBeenCalledWith('stream.obs_stopped', expect.anything())
  })

  it('rejects scene changes while a replay save is still running', async () => {
    let releaseReplay!: () => void
    const replayBlocked = new Promise<void>((resolve) => { releaseReplay = resolve })
    const saveReplay = vi.fn(() => replayBlocked)
    const switchScene = vi.fn().mockResolvedValue(undefined)
    const store = { getConfig: vi.fn().mockResolvedValue(structuredClone(defaultConfig)) } as unknown as DataStore
    const obs = { saveReplay, switchScene } as unknown as ObsController
    const logger = { write: vi.fn().mockResolvedValue(undefined) } as unknown as AppLogger
    const orchestrator = new StreamOrchestrator(store, obs, {} as CaptureDetector, {} as PlatformServices, logger)

    const pendingReplay = orchestrator.saveReplay()
    await vi.waitFor(() => expect(saveReplay).toHaveBeenCalledOnce())
    await expect(orchestrator.switchScene('20_TALK')).rejects.toThrow('別の配信操作を処理中です')
    expect(switchScene).not.toHaveBeenCalled()

    releaseReplay()
    await expect(pendingReplay).resolves.toBeUndefined()
  })

  it('lets a user operation wait for background audio recovery instead of failing with a busy error', async () => {
    const config = structuredClone(defaultConfig)
    const profile = structuredClone(starterProfiles[0])
    profile.state.lastCaptureMethod = 'local'
    profile.state.lastUsedAt = '2026-07-22T07:00:00.000Z'
    config.ui.lastSelectedGameId = profile.id
    const store = {
      getConfig: vi.fn().mockResolvedValue(config),
      listProfiles: vi.fn().mockResolvedValue([profile]),
      getProfile: vi.fn().mockResolvedValue(profile),
      saveConfig: vi.fn(async (value) => value),
    } as unknown as DataStore
    let releaseAudio!: () => void
    const audioBlocked = new Promise<void>((resolve) => { releaseAudio = resolve })
    const applyProfile = vi.fn(async () => {
      await audioBlocked
      return { warnings: ['managed audio warning'], audioApplied: true }
    })
    const switchScene = vi.fn().mockResolvedValue(undefined)
    const obs = {
      status: vi.fn(async (_config: unknown, selectedGameId: string | null, captureMethod: string | null, busy: boolean, warning: string | null) => ({
        obsConnected: true,
        streaming: false,
        recording: false,
        replayBuffer: false,
        sourceRecord: false,
        verticalRecording: false,
        selectedGameId,
        captureMethod,
        currentScene: profile.obs.sceneName,
        warning,
        busy,
      })),
      applyProfile,
      switchScene,
    } as unknown as ObsController
    const platforms = {
      invalidateLiveStatus: vi.fn(),
      getLiveStatus: vi.fn().mockResolvedValue({
        youtube: { state: 'offline', detail: 'offline', checkedAt: new Date().toISOString() },
        twitch: { state: 'offline', detail: 'offline', checkedAt: new Date().toISOString() },
      }),
    } as unknown as PlatformServices
    const logger = { write: vi.fn().mockResolvedValue(undefined) } as unknown as AppLogger
    const orchestrator = new StreamOrchestrator(store, obs, {} as CaptureDetector, platforms, logger)
    ;(orchestrator as unknown as { warning: string | null }).warning = 'important existing warning'
    await orchestrator.restoreSelection()

    const pendingAudio = orchestrator.ensureSelectedAudio()
    await vi.waitFor(() => expect(applyProfile).toHaveBeenCalledOnce())
    const pendingScene = orchestrator.switchScene('20_TALK')
    await Promise.resolve()
    expect(switchScene).not.toHaveBeenCalled()

    releaseAudio()
    await expect(pendingAudio).resolves.toEqual({ applied: true, warnings: ['managed audio warning'] })
    await expect(pendingScene).resolves.toBeUndefined()
    expect(switchScene).toHaveBeenCalledOnce()
    await orchestrator.getStatus()
    expect(obs.status).toHaveBeenLastCalledWith(config, profile.id, 'local', false, 'important existing warning')

    let releaseSecondAudio!: () => void
    const secondAudioBlocked = new Promise<void>((resolve) => { releaseSecondAudio = resolve })
    applyProfile.mockImplementationOnce(async () => {
      await secondAudioBlocked
      return { warnings: [], audioApplied: true }
    })
    profile.audio.microphoneDb += 1
    const staleAudio = orchestrator.ensureSelectedAudio()
    await vi.waitFor(() => expect(applyProfile).toHaveBeenCalledTimes(2))
    await orchestrator.invalidateProfile(profile.id)
    releaseSecondAudio()

    await expect(staleAudio).resolves.toEqual({ applied: false, warnings: [] })
    await expect(orchestrator.getStatus()).resolves.toMatchObject({ selectedGameId: null, captureMethod: null })
  })

  it('rejects profile and config changes until external live states have ended', async () => {
    const config = structuredClone(defaultConfig)
    const obs = {
      status: vi.fn().mockResolvedValue({
        obsConnected: true,
        streaming: false,
        recording: false,
        replayBuffer: false,
        sourceRecord: false,
        verticalRecording: false,
        selectedGameId: null,
        captureMethod: null,
        currentScene: '90_ENDING',
        warning: null,
        busy: false,
      }),
    } as unknown as ObsController
    const store = { getConfig: vi.fn().mockResolvedValue(config) } as unknown as DataStore
    const getLiveStatus = vi.fn().mockResolvedValue({
      youtube: { state: 'live', detail: 'YouTubeでライブ中', checkedAt: new Date().toISOString() },
      twitch: { state: 'offline', detail: 'Twitchはオフライン', checkedAt: new Date().toISOString() },
    })
    const platforms = { getLiveStatus } as unknown as PlatformServices
    const logger = { write: vi.fn().mockResolvedValue(undefined) } as unknown as AppLogger
    const orchestrator = new StreamOrchestrator(store, obs, {} as CaptureDetector, platforms, logger)

    await expect(orchestrator.assertNotStreaming()).rejects.toMatchObject({ statusCode: 409 })

    getLiveStatus.mockResolvedValue({
      youtube: { state: 'offline', detail: 'YouTubeはオフライン', checkedAt: new Date().toISOString() },
      twitch: { state: 'offline', detail: 'Twitchはオフライン', checkedAt: new Date().toISOString() },
    })
    await expect(orchestrator.assertNotStreaming()).resolves.toBeUndefined()
  })
})

describe('StreamOrchestrator selection recovery', () => {
  it('replaces another profile source and BGM instead of sharing their runtime state', async () => {
    let config = structuredClone(defaultConfig)
    const first = structuredClone(starterProfiles[0])
    const second = structuredClone(starterProfiles[1])
    first.capture.localSourceName = 'ARK Capture'
    second.capture.localSourceName = 'Second Game Capture'
    first.bgm = {
      trackId: '00000000-0000-4000-8000-000000000001',
      playbackMode: 'loop',
      autoPlay: true,
    }
    second.bgm = { trackId: null, playbackMode: 'once', autoPlay: false }
    const profiles = new Map([[first.id, first], [second.id, second]])
    const store = {
      getProfile: vi.fn(async (id: string) => profiles.get(id) ?? null),
      listProfiles: vi.fn(async () => [...profiles.values()]),
      getConfig: vi.fn(async () => config),
      saveProfile: vi.fn(async (value) => value),
      saveConfig: vi.fn(async (value) => { config = value as typeof config; return config }),
    } as unknown as DataStore
    const obs = {
      status: vi.fn().mockResolvedValue({
        obsConnected: true,
        streaming: false,
        recording: false,
        replayBuffer: false,
        sourceRecord: false,
        verticalRecording: false,
        currentScene: '90_ENDING',
      }),
      applyProfile: vi.fn().mockResolvedValue({ warnings: [], audioApplied: true }),
      stopBgm: vi.fn().mockResolvedValue(undefined),
      prepareBgm: vi.fn().mockResolvedValue(undefined),
      preparePrimaryStream: vi.fn().mockResolvedValue(undefined),
    } as unknown as ObsController
    const track = {
      id: first.bgm.trackId,
      name: 'ARK Loop',
      originalName: 'ark-loop.mp3',
      filename: `${first.bgm.trackId}.mp3`,
      mime: 'audio/mpeg' as const,
      size: 10,
      addedAt: new Date().toISOString(),
    }
    const bgm = {
      getTrack: vi.fn(async (id: string) => id === track.id ? track : null),
      trackPath: vi.fn(() => 'C:\\BGM\\ark-loop.mp3'),
      selectTrack: vi.fn().mockResolvedValue({}),
      releaseRetainedFiles: vi.fn().mockResolvedValue(undefined),
    } as unknown as BgmLibraryStore
    const platforms = {
      invalidateLiveStatus: vi.fn(),
      getLiveStatus: vi.fn().mockResolvedValue({
        youtube: { state: 'offline', detail: 'offline', checkedAt: new Date().toISOString() },
        twitch: { state: 'offline', detail: 'offline', checkedAt: new Date().toISOString() },
      }),
    } as unknown as PlatformServices
    const orchestrator = new StreamOrchestrator(
      store,
      obs,
      {} as CaptureDetector,
      platforms,
      { write: vi.fn().mockResolvedValue(undefined) } as unknown as AppLogger,
      undefined,
      bgm,
    )

    await orchestrator.select(first.id, 'local', false)
    await orchestrator.select(second.id, 'local', false)

    expect(obs.applyProfile).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ obs: config.obs }),
      first,
      'local',
      undefined,
      expect.arrayContaining(['Second Game Capture']),
    )
    expect(obs.applyProfile).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ obs: config.obs }),
      second,
      'local',
      undefined,
      expect.arrayContaining(['ARK Capture']),
    )
    expect(obs.prepareBgm).toHaveBeenCalledWith(expect.objectContaining({ obs: config.obs }), 'C:\\BGM\\ark-loop.mp3', first.audio.bgmDb, 'loop', true)
    expect(obs.stopBgm).toHaveBeenCalledTimes(2)
    expect(vi.mocked(obs.stopBgm).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(obs.applyProfile).mock.invocationCallOrder[0])
    expect(vi.mocked(obs.stopBgm).mock.invocationCallOrder[1]).toBeLessThan(vi.mocked(obs.applyProfile).mock.invocationCallOrder[1])
    expect(bgm.selectTrack).toHaveBeenNthCalledWith(1, first.bgm.trackId, 'loop')
    expect(bgm.selectTrack).toHaveBeenNthCalledWith(2, null, 'once')

    orchestrator.syncSavedProfile({ ...second, favorite: !second.favorite })
    await expect(orchestrator.ensureSelectedAudio()).resolves.toEqual({ applied: true, warnings: [] })
    expect(obs.applyProfile).toHaveBeenCalledTimes(2)
    expect(obs.stopBgm).toHaveBeenCalledTimes(2)

    const secondWithBgm = {
      ...second,
      bgm: { trackId: track.id, playbackMode: 'loop' as const, autoPlay: true },
    }
    profiles.set(second.id, secondWithBgm)
    orchestrator.syncSavedProfile(secondWithBgm)
    await expect(orchestrator.ensureSelectedAudio()).resolves.toEqual({ applied: true, warnings: [] })
    expect(obs.applyProfile).toHaveBeenCalledTimes(2)
    expect(obs.stopBgm).toHaveBeenCalledTimes(3)
    expect(obs.prepareBgm).toHaveBeenLastCalledWith(expect.objectContaining({ obs: config.obs }), 'C:\\BGM\\ark-loop.mp3', second.audio.bgmDb, 'loop', true)
  })

  it('passes the detected GeForce NOW window through to OBS when selecting a game', async () => {
    let config = structuredClone(defaultConfig)
    const profile = structuredClone(starterProfiles[0])
    profile.displayName = 'PRAGMATA'
    profile.capture.preferred = 'geforce_now'
    profile.capture.geforceNowEnabled = true
    const store = {
      getProfile: vi.fn().mockResolvedValue(profile),
      getConfig: vi.fn(async () => config),
      saveProfile: vi.fn(async (value) => value),
      saveConfig: vi.fn(async (value) => { config = value as typeof config; return config }),
    } as unknown as DataStore
    const obs = {
      applyProfile: vi.fn().mockResolvedValue({ warnings: [], audioApplied: true }),
      preparePrimaryStream: vi.fn().mockResolvedValue(undefined),
    } as unknown as ObsController
    const capture = {
      detect: vi.fn().mockResolvedValue({
        method: 'geforce_now',
        warnings: [],
        windowTitle: 'GeForce NOW のPRAGMATA',
      }),
    } as unknown as CaptureDetector
    const platforms = { invalidateLiveStatus: vi.fn() } as unknown as PlatformServices
    const logger = { write: vi.fn().mockResolvedValue(undefined) } as unknown as AppLogger
    const orchestrator = new StreamOrchestrator(store, obs, capture, platforms, logger)

    await orchestrator.select(profile.id, 'geforce_now', false)

    expect(obs.applyProfile).toHaveBeenCalledWith(
      expect.objectContaining({ obs: config.obs }),
      profile,
      'geforce_now',
      'GeForce NOW のPRAGMATA',
    )
  })

  it('keeps the active selection when the selected profile is saved', () => {
    const selected = structuredClone(starterProfiles[0])
    const saved = {
      ...selected,
      displayName: `${selected.displayName} updated`,
      favorite: !selected.favorite,
    }
    const platforms = { invalidateLiveStatus: vi.fn() } as unknown as PlatformServices
    const orchestrator = new StreamOrchestrator(
      {} as DataStore,
      {} as ObsController,
      {} as CaptureDetector,
      platforms,
      {} as AppLogger,
    )
    const state = orchestrator as unknown as {
      selected: typeof selected | null
      method: 'local' | null
      platformPreparationPending: boolean
      ensuredAudioKey: string | null
      appliedBgmKey: string | null
    }
    state.selected = selected
    state.method = 'local'
    state.platformPreparationPending = false
    state.ensuredAudioKey = 'old-profile-state'
    state.appliedBgmKey = 'old-bgm-state'

    orchestrator.syncSavedProfile(saved, true)

    expect(state.selected).toBe(saved)
    expect(state.method).toBe('local')
    expect(state.platformPreparationPending).toBe(true)
    expect(state.ensuredAudioKey).toBe('old-profile-state')
    expect(state.appliedBgmKey).toBe('old-bgm-state')
    expect(platforms.invalidateLiveStatus).toHaveBeenCalledOnce()
  })

  it('ignores a saved profile that is not the active selection', () => {
    const selected = structuredClone(starterProfiles[0])
    const other = structuredClone(starterProfiles[1])
    const platforms = { invalidateLiveStatus: vi.fn() } as unknown as PlatformServices
    const orchestrator = new StreamOrchestrator(
      {} as DataStore,
      {} as ObsController,
      {} as CaptureDetector,
      platforms,
      {} as AppLogger,
    )
    const state = orchestrator as unknown as {
      selected: typeof selected | null
      method: 'local' | null
      platformPreparationPending: boolean
    }
    state.selected = selected
    state.method = 'local'
    state.platformPreparationPending = false

    orchestrator.syncSavedProfile(other, true)

    expect(state.selected).toBe(selected)
    expect(state.method).toBe('local')
    expect(state.platformPreparationPending).toBe(false)
    expect(platforms.invalidateLiveStatus).not.toHaveBeenCalled()
  })

  it('migrates and restores the most recently applied game after an app restart', async () => {
    let config = structuredClone(defaultConfig)
    delete config.ui.lastSelectedGameId
    const older = structuredClone(starterProfiles[1])
    older.state.lastUsedAt = '2026-07-16T10:00:00.000Z'
    older.state.lastCaptureMethod = 'window'
    const latest = structuredClone(starterProfiles[0])
    latest.state.lastUsedAt = '2026-07-16T18:01:39.722Z'
    latest.state.lastCaptureMethod = 'local'
    const store = {
      getConfig: vi.fn(async () => config),
      saveConfig: vi.fn(async (value) => { config = value as typeof config; return config }),
      listProfiles: vi.fn().mockResolvedValue([older, latest]),
      getProfile: vi.fn(async (id: string) => id === latest.id ? latest : null),
    } as unknown as DataStore
    let obsConnected = true
    const obs = {
      applyProfile: vi.fn().mockResolvedValue({ warnings: [], audioApplied: true }),
      status: vi.fn(async (_config: unknown, selectedGameId: string | null, captureMethod: string | null) => ({
        obsConnected,
        streaming: false,
        recording: false,
        replayBuffer: false,
        sourceRecord: false,
        verticalRecording: false,
        selectedGameId,
        captureMethod,
        currentScene: latest.obs.sceneName,
        warning: null,
        busy: false,
      })),
    } as unknown as ObsController
    const platforms = {
      invalidateLiveStatus: vi.fn(),
      getLiveStatus: vi.fn().mockResolvedValue({
        youtube: { state: 'offline', detail: 'offline', checkedAt: new Date().toISOString() },
        twitch: { state: 'offline', detail: 'offline', checkedAt: new Date().toISOString() },
      }),
    } as unknown as PlatformServices
    const logger = { write: vi.fn().mockResolvedValue(undefined) } as unknown as AppLogger
    const orchestrator = new StreamOrchestrator(store, obs, {} as CaptureDetector, platforms, logger)

    await orchestrator.restoreSelection()

    await expect(orchestrator.getStatus()).resolves.toMatchObject({ selectedGameId: latest.id, captureMethod: 'local' })
    await expect(orchestrator.ensureSelectedAudio()).resolves.toEqual({ applied: true, warnings: [] })
    await expect(orchestrator.ensureSelectedAudio()).resolves.toEqual({ applied: true, warnings: [] })
    expect(obs.applyProfile).toHaveBeenCalledOnce()
    obsConnected = false
    await orchestrator.getStatus()
    obsConnected = true
    await expect(orchestrator.ensureSelectedAudio()).resolves.toEqual({ applied: true, warnings: [] })
    expect(store.saveConfig).toHaveBeenCalledWith(expect.objectContaining({ ui: expect.objectContaining({ lastSelectedGameId: latest.id }) }))
    expect(platforms.invalidateLiveStatus).toHaveBeenCalledOnce()
    expect(obs.applyProfile).toHaveBeenCalledTimes(2)
    expect(obs.applyProfile).toHaveBeenCalledWith(config, latest, 'local', undefined, [], true)
  })
})

describe('StreamOrchestrator stream startup rollback', () => {
  it('advances a persisted Part number only after startup succeeds', async () => {
    const config = structuredClone(defaultConfig)
    let profile = structuredClone(starterProfiles[0])
    profile.youtube.titleTemplate = '{game} | Part {part}'
    const store = {
      getProfile: vi.fn(async () => profile),
      getConfig: vi.fn().mockResolvedValue(config),
      saveProfile: vi.fn(async (value) => { profile = value; return value }),
      saveConfig: vi.fn(async (value) => value),
    } as unknown as DataStore
    const obs = {
      applyProfile: vi.fn().mockResolvedValue({ warnings: [], audioApplied: true }),
      preparePrimaryStream: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue([]),
      isStreaming: vi.fn().mockResolvedValue(true),
      ownsCurrentStream: vi.fn().mockReturnValue(true),
    } as unknown as ObsController
    const platforms = {
      prepare: vi.fn().mockResolvedValue([
        { service: 'youtube', ok: true, message: 'ok' },
        { service: 'twitch', ok: true, message: 'ok' },
      ]),
      startYouTubeBroadcast: vi.fn().mockResolvedValue(undefined),
      startComments: vi.fn().mockResolvedValue(undefined),
      invalidateLiveStatus: vi.fn(),
    } as unknown as PlatformServices
    const logger = { write: vi.fn().mockResolvedValue(undefined) } as unknown as AppLogger
    const orchestrator = new StreamOrchestrator(store, obs, {} as CaptureDetector, platforms, logger)

    await orchestrator.select(profile.id, 'window')
    expect(profile.state.nextPartNumber).toBe(1)
    await expect(orchestrator.start()).resolves.toEqual([])
    expect(profile.state.nextPartNumber).toBe(2)
    expect(store.saveProfile).toHaveBeenCalledTimes(2)
  })

  it('stops OBS and closes any partial YouTube lifecycle when publication fails', async () => {
    const config = structuredClone(defaultConfig)
    const profile = structuredClone(starterProfiles[0])
    const store = {
      getProfile: vi.fn().mockResolvedValue(profile),
      getConfig: vi.fn().mockResolvedValue(config),
      saveProfile: vi.fn(async (value) => value),
      saveConfig: vi.fn(async (value) => value),
    } as unknown as DataStore
    const obs = {
      applyProfile: vi.fn().mockResolvedValue({ warnings: [], audioApplied: true }),
      preparePrimaryStream: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue([]),
      rollbackStart: vi.fn().mockResolvedValue([]),
      stop: vi.fn().mockResolvedValue([]),
      isStreaming: vi.fn().mockResolvedValue(false),
      ownsCurrentStream: vi.fn().mockReturnValue(true),
    } as unknown as ObsController
    const platforms = {
      prepare: vi.fn().mockResolvedValue([
        { service: 'youtube', ok: true, message: 'ok' },
        { service: 'twitch', ok: true, message: 'ok' },
      ]),
      startYouTubeBroadcast: vi.fn().mockRejectedValue(new Error('YouTube transition failed')),
      completeYouTubeBroadcast: vi.fn().mockResolvedValue(undefined),
      startComments: vi.fn().mockResolvedValue(undefined),
      stopComments: vi.fn().mockResolvedValue(undefined),
      invalidateLiveStatus: vi.fn(),
    } as unknown as PlatformServices
    const logger = { write: vi.fn().mockResolvedValue(undefined) } as unknown as AppLogger
    const orchestrator = new StreamOrchestrator(store, obs, {} as CaptureDetector, platforms, logger)

    await orchestrator.select(profile.id, 'window')
    await expect(orchestrator.start()).rejects.toThrow('YouTube transition failed')

    expect(obs.rollbackStart).toHaveBeenCalledWith(config, expect.objectContaining({ id: profile.id }))
    expect(platforms.completeYouTubeBroadcast).toHaveBeenCalledWith(config, expect.objectContaining({ id: profile.id }))
    expect(platforms.stopComments).toHaveBeenCalledOnce()
    expect(logger.write).toHaveBeenCalledWith('stream.start_failed', expect.objectContaining({ error: 'YouTube transition failed' }))
    expect(logger.write).not.toHaveBeenCalledWith('stream.started', expect.anything())

    vi.mocked(platforms.completeYouTubeBroadcast).mockClear()
    vi.mocked(obs.isStreaming).mockResolvedValue(true)
    await expect(orchestrator.stop()).resolves.toEqual(expect.arrayContaining([expect.stringContaining('YouTube配信枠を終了していません')]))
    expect(platforms.completeYouTubeBroadcast).not.toHaveBeenCalled()
  })

  it('does not roll back a stream that was already active before the managed start attempt', async () => {
    const config = structuredClone(defaultConfig)
    const profile = structuredClone(starterProfiles[0])
    const store = {
      getProfile: vi.fn().mockResolvedValue(profile),
      getConfig: vi.fn().mockResolvedValue(config),
      saveProfile: vi.fn(async (value) => value),
      saveConfig: vi.fn(async (value) => value),
    } as unknown as DataStore
    const obs = {
      applyProfile: vi.fn().mockResolvedValue({ warnings: [], audioApplied: true }),
      preparePrimaryStream: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue([]),
      rollbackStart: vi.fn().mockResolvedValue([]),
      isStreaming: vi.fn().mockResolvedValue(true),
      ownsCurrentStream: vi.fn().mockReturnValue(false),
    } as unknown as ObsController
    const platforms = {
      prepare: vi.fn().mockResolvedValue([
        { service: 'youtube', ok: true, message: 'ok' },
        { service: 'twitch', ok: true, message: 'ok' },
      ]),
      startYouTubeBroadcast: vi.fn().mockRejectedValue(new Error('YouTube transition failed')),
      completeYouTubeBroadcast: vi.fn().mockResolvedValue(undefined),
      startComments: vi.fn().mockResolvedValue(undefined),
      stopComments: vi.fn().mockResolvedValue(undefined),
      invalidateLiveStatus: vi.fn(),
    } as unknown as PlatformServices
    const logger = { write: vi.fn().mockResolvedValue(undefined) } as unknown as AppLogger
    const orchestrator = new StreamOrchestrator(store, obs, {} as CaptureDetector, platforms, logger)

    await orchestrator.select(profile.id, 'window')
    await expect(orchestrator.start()).rejects.toThrow('YouTube transition failed')

    expect(obs.ownsCurrentStream).toHaveBeenCalledOnce()
    expect(obs.rollbackStart).not.toHaveBeenCalled()
    expect(platforms.completeYouTubeBroadcast).not.toHaveBeenCalled()
    await expect(obs.isStreaming(config)).resolves.toBe(true)
  })

  it('does not touch OBS when YouTube preparation already failed', async () => {
    const config = structuredClone(defaultConfig)
    const profile = structuredClone(starterProfiles[0])
    const store = {
      getProfile: vi.fn().mockResolvedValue(profile),
      getConfig: vi.fn().mockResolvedValue(config),
      saveProfile: vi.fn(async (value) => value),
      saveConfig: vi.fn(async (value) => value),
    } as unknown as DataStore
    const obs = {
      applyProfile: vi.fn().mockResolvedValue({ warnings: [], audioApplied: true }),
      preparePrimaryStream: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue([]),
      rollbackStart: vi.fn().mockResolvedValue([]),
      isStreaming: vi.fn().mockResolvedValue(false),
      ownsCurrentStream: vi.fn().mockReturnValue(false),
    } as unknown as ObsController
    const platforms = {
      prepare: vi.fn().mockResolvedValue([
        { service: 'youtube', ok: false, message: 'client_secret is missing' },
        { service: 'twitch', ok: true, message: 'ok' },
      ]),
      startYouTubeBroadcast: vi.fn(),
      startComments: vi.fn(),
      invalidateLiveStatus: vi.fn(),
    } as unknown as PlatformServices
    const logger = { write: vi.fn().mockResolvedValue(undefined) } as unknown as AppLogger
    const orchestrator = new StreamOrchestrator(store, obs, {} as CaptureDetector, platforms, logger)

    await orchestrator.select(profile.id, 'window')
    await expect(orchestrator.start()).rejects.toThrow('配信サービスの設定に失敗')
    await expect(orchestrator.start(true)).rejects.toThrow('OBSへ触れずに開始を中止')

    expect(obs.start).not.toHaveBeenCalled()
    expect(obs.rollbackStart).not.toHaveBeenCalled()
    expect(platforms.startYouTubeBroadcast).not.toHaveBeenCalled()
  })

  it('does not silently retry external startup after a failed managed start', async () => {
    const config = structuredClone(defaultConfig)
    const profile = structuredClone(starterProfiles[0])
    const store = {
      getProfile: vi.fn().mockResolvedValue(profile),
      getConfig: vi.fn().mockResolvedValue(config),
      saveProfile: vi.fn(async (value) => value),
      saveConfig: vi.fn(async (value) => value),
    } as unknown as DataStore
    const obs = {
      applyProfile: vi.fn().mockResolvedValue({ warnings: [], audioApplied: true }),
      preparePrimaryStream: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue([]),
      rollbackStart: vi.fn().mockResolvedValue([]),
      isStreaming: vi.fn().mockResolvedValue(true),
      ownsCurrentStream: vi.fn().mockReturnValue(true),
    } as unknown as ObsController
    const platforms = {
      prepare: vi.fn().mockResolvedValue([
        { service: 'youtube', ok: true, message: 'ok' },
        { service: 'twitch', ok: true, message: 'ok' },
      ]),
      startYouTubeBroadcast: vi.fn().mockRejectedValue(new Error('YouTube transition failed')),
      completeYouTubeBroadcast: vi.fn().mockResolvedValue(undefined),
      startComments: vi.fn().mockResolvedValue(undefined),
      stopComments: vi.fn().mockResolvedValue(undefined),
      invalidateLiveStatus: vi.fn(),
    } as unknown as PlatformServices
    const logger = { write: vi.fn().mockResolvedValue(undefined) } as unknown as AppLogger
    const orchestrator = new StreamOrchestrator(store, obs, {} as CaptureDetector, platforms, logger)
    vi.mocked(obs.start).mockImplementationOnce(async () => {
      orchestrator.handleObsStreamStateChanged(true)
      return []
    })

    await orchestrator.select(profile.id, 'window')
    await expect(orchestrator.start()).rejects.toThrow('YouTube transition failed')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(platforms.startYouTubeBroadcast).toHaveBeenCalledTimes(1)
    expect(platforms.startComments).not.toHaveBeenCalled()
  })
})

describe('StreamOrchestrator OBS-triggered external sync', () => {
  it('starts and stops prepared external services when OBS is operated manually', async () => {
    const config = structuredClone(defaultConfig)
    const profile = structuredClone(starterProfiles[0])
    const store = {
      getProfile: vi.fn().mockResolvedValue(profile),
      getConfig: vi.fn().mockResolvedValue(config),
      saveProfile: vi.fn(async (value) => value),
      saveConfig: vi.fn(async (value) => value),
    } as unknown as DataStore
    const obs = {
      applyProfile: vi.fn().mockResolvedValue({ warnings: [], audioApplied: true }),
      preparePrimaryStream: vi.fn().mockResolvedValue(undefined),
      startSecondaryTwitchForObsStream: vi.fn().mockResolvedValue([]),
      finishObsTriggeredStream: vi.fn().mockResolvedValue([]),
      start: vi.fn().mockResolvedValue([]),
      isStreaming: vi.fn().mockResolvedValue(true),
      ownsCurrentStream: vi.fn().mockReturnValue(true),
    } as unknown as ObsController
    const platformDiagnostics = {
      active: false,
      comments: {
        youtube: { received: 2, failures: 0 },
        twitch: { received: 1, failures: 0 },
      },
    }
    const platforms = {
      prepare: vi.fn().mockResolvedValue([
        { service: 'youtube', ok: true, message: 'ok' },
        { service: 'twitch', ok: true, message: 'ok' },
      ]),
      startYouTubeBroadcast: vi.fn().mockResolvedValue(undefined),
      completeYouTubeBroadcast: vi.fn().mockResolvedValue(undefined),
      startComments: vi.fn().mockResolvedValue(undefined),
      stopComments: vi.fn().mockResolvedValue(undefined),
      getDiagnostics: vi.fn().mockReturnValue(platformDiagnostics),
      invalidateLiveStatus: vi.fn(),
    } as unknown as PlatformServices
    const logger = { write: vi.fn().mockResolvedValue(undefined) } as unknown as AppLogger
    const orchestrator = new StreamOrchestrator(store, obs, {} as CaptureDetector, platforms, logger)

    await orchestrator.select(profile.id, 'window')
    expect(obs.preparePrimaryStream).toHaveBeenCalledWith(config, expect.objectContaining({ id: profile.id }))
    orchestrator.handleObsStreamStateChanged(true)
    await vi.waitFor(() => expect(platforms.startYouTubeBroadcast).toHaveBeenCalledWith(config, expect.objectContaining({ id: profile.id })))
    expect(obs.startSecondaryTwitchForObsStream).toHaveBeenCalledWith(config, expect.objectContaining({ id: profile.id }))
    expect(platforms.startComments).toHaveBeenCalledWith(config)
    expect(logger.write).toHaveBeenCalledWith('stream.obs_started', expect.objectContaining({ gameId: profile.id, warnings: [] }))

    orchestrator.handleObsStreamStateChanged(false)
    await vi.waitFor(() => expect(platforms.completeYouTubeBroadcast).toHaveBeenCalledWith(config, expect.objectContaining({ id: profile.id })))
    expect(obs.finishObsTriggeredStream).toHaveBeenCalledWith(config)
    expect(platforms.stopComments).toHaveBeenCalled()
    expect(logger.write).toHaveBeenCalledWith('stream.obs_stopped', expect.objectContaining({
      gameId: profile.id,
      warnings: [],
      platformDiagnostics,
    }))

    const interruptedState = orchestrator as unknown as {
      selected: GameProfile | null
      platformPreparationPending: boolean
      interruptedStreamSelectionId: string | null
    }
    expect(interruptedState.selected?.id).toBe(profile.id)
    expect(interruptedState.platformPreparationPending).toBe(true)
    expect(interruptedState.interruptedStreamSelectionId).toBe(profile.id)

    await expect(orchestrator.autoSelectRunningGame()).resolves.toEqual({
      detected: true,
      applied: false,
      gameId: profile.id,
      captureMethod: 'window',
    })

    await expect(orchestrator.start()).resolves.toEqual([])
    expect(platforms.prepare).toHaveBeenCalledTimes(2)
    expect(platforms.prepare).toHaveBeenLastCalledWith(config, expect.objectContaining({ id: profile.id }))
    expect(obs.start).toHaveBeenCalledWith(config, expect.objectContaining({ id: profile.id }), profile.capture.localSourceName)
    expect(interruptedState.interruptedStreamSelectionId).toBeNull()
  })

  it('does not claim an external broadcast was prepared when OBS starts without a selected game', async () => {
    const config = structuredClone(defaultConfig)
    const store = { getConfig: vi.fn().mockResolvedValue(config) } as unknown as DataStore
    const platforms = {
      startYouTubeBroadcast: vi.fn(),
      startComments: vi.fn().mockResolvedValue(undefined),
      invalidateLiveStatus: vi.fn(),
    } as unknown as PlatformServices
    const logger = { write: vi.fn().mockResolvedValue(undefined) } as unknown as AppLogger
    const orchestrator = new StreamOrchestrator(store, {} as ObsController, {} as CaptureDetector, platforms, logger)

    orchestrator.handleObsStreamStateChanged(true)
    await vi.waitFor(() => expect(logger.write).toHaveBeenCalledWith('stream.obs_started', expect.objectContaining({
      gameId: null,
      warnings: [expect.stringContaining('ゲーム未選択')],
    })))
    expect(platforms.startYouTubeBroadcast).not.toHaveBeenCalled()
    expect(platforms.startComments).toHaveBeenCalledWith(config)
  })

  it('queues an OBS state change that arrives while another operation is busy', async () => {
    const config = structuredClone(defaultConfig)
    let releaseReplay!: () => void
    const replayBlocked = new Promise<void>((resolve) => { releaseReplay = resolve })
    const store = { getConfig: vi.fn().mockResolvedValue(config) } as unknown as DataStore
    const obs = { saveReplay: vi.fn(() => replayBlocked) } as unknown as ObsController
    const platforms = {
      startYouTubeBroadcast: vi.fn(),
      startComments: vi.fn().mockResolvedValue(undefined),
      invalidateLiveStatus: vi.fn(),
    } as unknown as PlatformServices
    const logger = { write: vi.fn().mockResolvedValue(undefined) } as unknown as AppLogger
    const orchestrator = new StreamOrchestrator(store, obs, {} as CaptureDetector, platforms, logger)

    const replay = orchestrator.saveReplay()
    await vi.waitFor(() => expect(obs.saveReplay).toHaveBeenCalledOnce())
    orchestrator.handleObsStreamStateChanged(true)
    expect(platforms.startComments).not.toHaveBeenCalled()

    releaseReplay()
    await replay
    await vi.waitFor(() => expect(platforms.startComments).toHaveBeenCalledWith(config))
    expect(logger.write).toHaveBeenCalledWith('stream.obs_started', expect.objectContaining({ gameId: null }))
  })

  it('uses an idle OBS state as the startup baseline without firing a stop sync', async () => {
    const config = structuredClone(defaultConfig)
    const store = { getConfig: vi.fn().mockResolvedValue(config) } as unknown as DataStore
    const obs = {
      status: vi.fn().mockResolvedValue({
        obsConnected: true,
        streaming: false,
        recording: false,
        replayBuffer: false,
        sourceRecord: false,
        verticalRecording: false,
        selectedGameId: null,
        captureMethod: null,
        currentScene: '90_ENDING',
        warning: null,
        busy: false,
      }),
    } as unknown as ObsController
    const platforms = {
      getLiveStatus: vi.fn().mockResolvedValue({
        youtube: { state: 'offline', detail: 'offline', checkedAt: new Date().toISOString() },
        twitch: { state: 'offline', detail: 'offline', checkedAt: new Date().toISOString() },
      }),
      completeYouTubeBroadcast: vi.fn(),
      stopComments: vi.fn(),
    } as unknown as PlatformServices
    const logger = { write: vi.fn().mockResolvedValue(undefined) } as unknown as AppLogger
    const orchestrator = new StreamOrchestrator(store, obs, {} as CaptureDetector, platforms, logger)

    await expect(orchestrator.getStatus()).resolves.toMatchObject({ streaming: false })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(platforms.completeYouTubeBroadcast).not.toHaveBeenCalled()
    expect(platforms.stopComments).not.toHaveBeenCalled()
  })

  it('reconciles external services when the server starts while OBS is already streaming', async () => {
    const config = structuredClone(defaultConfig)
    const store = { getConfig: vi.fn().mockResolvedValue(config) } as unknown as DataStore
    const obs = {
      status: vi.fn().mockResolvedValue({
        obsConnected: true,
        streaming: true,
        recording: false,
        replayBuffer: false,
        sourceRecord: false,
        verticalRecording: false,
        selectedGameId: null,
        captureMethod: null,
        currentScene: '20_TALK',
        warning: null,
        busy: false,
      }),
    } as unknown as ObsController
    const platforms = {
      getLiveStatus: vi.fn().mockResolvedValue({
        youtube: { state: 'ready', detail: 'ready', checkedAt: new Date().toISOString() },
        twitch: { state: 'offline', detail: 'offline', checkedAt: new Date().toISOString() },
      }),
      startYouTubeBroadcast: vi.fn(),
      startComments: vi.fn().mockResolvedValue(undefined),
      invalidateLiveStatus: vi.fn(),
    } as unknown as PlatformServices
    const logger = { write: vi.fn().mockResolvedValue(undefined) } as unknown as AppLogger
    const orchestrator = new StreamOrchestrator(store, obs, {} as CaptureDetector, platforms, logger)

    await expect(orchestrator.getStatus()).resolves.toMatchObject({ streaming: true })
    await vi.waitFor(() => expect(platforms.startComments).toHaveBeenCalledWith(config))
    expect(platforms.startYouTubeBroadcast).not.toHaveBeenCalled()
  })

  it('does not let a stale status snapshot reverse a newer OBS event', async () => {
    const config = structuredClone(defaultConfig)
    let releaseStatus!: () => void
    const statusBlocked = new Promise<void>((resolve) => { releaseStatus = resolve })
    const store = { getConfig: vi.fn().mockResolvedValue(config) } as unknown as DataStore
    const obs = {
      status: vi.fn(async () => {
        await statusBlocked
        return {
          obsConnected: true,
          streaming: false,
          recording: false,
          replayBuffer: false,
          sourceRecord: false,
          verticalRecording: false,
          selectedGameId: null,
          captureMethod: null,
          currentScene: '90_ENDING',
          warning: null,
          busy: false,
        }
      }),
    } as unknown as ObsController
    const platforms = {
      getLiveStatus: vi.fn().mockResolvedValue({
        youtube: { state: 'ready', detail: 'ready', checkedAt: new Date().toISOString() },
        twitch: { state: 'offline', detail: 'offline', checkedAt: new Date().toISOString() },
      }),
      startYouTubeBroadcast: vi.fn(),
      completeYouTubeBroadcast: vi.fn(),
      startComments: vi.fn().mockResolvedValue(undefined),
      stopComments: vi.fn().mockResolvedValue(undefined),
      invalidateLiveStatus: vi.fn(),
    } as unknown as PlatformServices
    const logger = { write: vi.fn().mockResolvedValue(undefined) } as unknown as AppLogger
    const orchestrator = new StreamOrchestrator(store, obs, {} as CaptureDetector, platforms, logger)

    const staleStatus = orchestrator.getStatus()
    await vi.waitFor(() => expect(obs.status).toHaveBeenCalledOnce())
    orchestrator.handleObsStreamStateChanged(true)
    await vi.waitFor(() => expect(platforms.startComments).toHaveBeenCalledWith(config))
    releaseStatus()
    await staleStatus
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(platforms.completeYouTubeBroadcast).not.toHaveBeenCalled()
    expect(platforms.stopComments).not.toHaveBeenCalled()
  })
})
