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
})

describe('StreamOrchestrator stream startup rollback', () => {
  it('stops OBS and closes any partial YouTube lifecycle when publication fails', async () => {
    const config = structuredClone(defaultConfig)
    const profile = structuredClone(starterProfiles[0])
    const store = {
      getProfile: vi.fn().mockResolvedValue(profile),
      getConfig: vi.fn().mockResolvedValue(config),
      saveProfile: vi.fn(async (value) => value),
    } as unknown as DataStore
    const obs = {
      applyProfile: vi.fn().mockResolvedValue([]),
      start: vi.fn().mockResolvedValue([]),
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
    } as unknown as PlatformServices
    const logger = { write: vi.fn().mockResolvedValue(undefined) } as unknown as AppLogger
    const orchestrator = new StreamOrchestrator(store, obs, {} as CaptureDetector, platforms, logger)

    await orchestrator.select(profile.id, 'window')
    await expect(orchestrator.start()).rejects.toThrow('YouTube transition failed')

    expect(obs.stop).toHaveBeenCalledWith(config, expect.objectContaining({ id: profile.id }))
    expect(platforms.completeYouTubeBroadcast).toHaveBeenCalledWith(config, expect.objectContaining({ id: profile.id }))
    expect(platforms.stopComments).toHaveBeenCalledOnce()
    expect(logger.write).toHaveBeenCalledWith('stream.start_failed', expect.objectContaining({ error: 'YouTube transition failed' }))
    expect(logger.write).not.toHaveBeenCalledWith('stream.started', expect.anything())

    vi.mocked(platforms.completeYouTubeBroadcast).mockClear()
    vi.mocked(obs.isStreaming).mockResolvedValue(true)
    await expect(orchestrator.stop()).resolves.toEqual(expect.arrayContaining([expect.stringContaining('YouTube配信枠を終了していません')]))
    expect(platforms.completeYouTubeBroadcast).not.toHaveBeenCalled()

    vi.mocked(obs.stop).mockClear()
    vi.mocked(obs.ownsCurrentStream).mockReturnValue(false)
    await expect(orchestrator.start()).rejects.toThrow('YouTube transition failed')
    expect(obs.stop).not.toHaveBeenCalled()
    expect(platforms.completeYouTubeBroadcast).not.toHaveBeenCalled()
  })
})
