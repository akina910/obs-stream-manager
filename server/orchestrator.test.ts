import { describe, expect, it, vi } from 'vitest'
import type { CaptureDetector } from './capture.js'
import { defaultConfig } from './defaults.js'
import { starterProfiles } from './defaults.js'
import type { AppLogger } from './logger.js'
import type { ObsController } from './obs.js'
import { StreamOrchestrator } from './orchestrator.js'
import type { PlatformServices } from './platforms.js'
import type { DataStore } from './storage.js'

describe('StreamOrchestrator operation exclusion', () => {
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
      applyProfile: vi.fn().mockResolvedValue([]),
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
    const obs = {
      status: vi.fn(async (_config: unknown, selectedGameId: string | null, captureMethod: string | null) => ({
        obsConnected: true,
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
    expect(store.saveConfig).toHaveBeenCalledWith(expect.objectContaining({ ui: expect.objectContaining({ lastSelectedGameId: latest.id }) }))
    expect(platforms.invalidateLiveStatus).toHaveBeenCalledOnce()
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
      applyProfile: vi.fn().mockResolvedValue([]),
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
      applyProfile: vi.fn().mockResolvedValue([]),
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
      applyProfile: vi.fn().mockResolvedValue([]),
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
      applyProfile: vi.fn().mockResolvedValue([]),
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
      applyProfile: vi.fn().mockResolvedValue([]),
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
      applyProfile: vi.fn().mockResolvedValue([]),
      preparePrimaryStream: vi.fn().mockResolvedValue(undefined),
      startSecondaryTwitchForObsStream: vi.fn().mockResolvedValue([]),
      finishObsTriggeredStream: vi.fn().mockResolvedValue([]),
    } as unknown as ObsController
    const platforms = {
      prepare: vi.fn().mockResolvedValue([
        { service: 'youtube', ok: true, message: 'ok' },
        { service: 'twitch', ok: true, message: 'ok' },
      ]),
      startYouTubeBroadcast: vi.fn().mockResolvedValue(undefined),
      completeYouTubeBroadcast: vi.fn().mockResolvedValue(undefined),
      startComments: vi.fn().mockResolvedValue(undefined),
      stopComments: vi.fn().mockResolvedValue(undefined),
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
    expect(logger.write).toHaveBeenCalledWith('stream.obs_stopped', expect.objectContaining({ gameId: profile.id, warnings: [] }))
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
