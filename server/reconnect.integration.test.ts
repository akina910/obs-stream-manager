import { describe, expect, it, vi } from 'vitest'
import { defaultConfig, starterProfiles } from './defaults.js'
import type { CaptureDetector } from './capture.js'
import type { AppLogger } from './logger.js'
import { ObsController } from './obs.js'
import { StreamOrchestrator } from './orchestrator.js'
import type { PlatformServices } from './platforms.js'
import type { SecretStore } from './secrets.js'
import type { DataStore } from './storage.js'

describe('OBS reconnect integration', () => {
  it('keeps external services alive through reconnecting and ends them only after OBS reports stopped', async () => {
    const config = structuredClone(defaultConfig)
    const profile = structuredClone(starterProfiles[0])
    const store = {
      getConfig: vi.fn().mockResolvedValue(config),
      getProfile: vi.fn().mockResolvedValue(profile),
      saveProfile: vi.fn(async (value) => value),
    } as unknown as DataStore
    const secrets = {
      get: vi.fn().mockReturnValue(null),
      set: vi.fn(),
    } as unknown as SecretStore
    const obs = new ObsController(secrets)
    vi.spyOn(obs, 'startSecondaryTwitchForObsStream').mockResolvedValue([])
    vi.spyOn(obs, 'finishObsTriggeredStream').mockResolvedValue([])
    const platforms = {
      startYouTubeBroadcast: vi.fn().mockResolvedValue(undefined),
      completeYouTubeBroadcast: vi.fn().mockResolvedValue(undefined),
      startComments: vi.fn().mockResolvedValue(undefined),
      stopComments: vi.fn().mockResolvedValue(undefined),
      invalidateLiveStatus: vi.fn(),
    } as unknown as PlatformServices
    const logger = { write: vi.fn().mockResolvedValue(undefined) } as unknown as AppLogger
    const orchestrator = new StreamOrchestrator(store, obs, {} as CaptureDetector, platforms, logger)
    Object.assign(orchestrator as object, {
      selected: profile,
      method: 'local',
      partAdvancedForCurrentStream: true,
    })
    obs.onStreamStateChanged((active) => orchestrator.handleObsStreamStateChanged(active))
    const websocket = (obs as unknown as {
      obs: { emit: (event: string, payload: { outputActive: boolean; outputState: string }) => void }
    }).obs

    websocket.emit('StreamStateChanged', {
      outputActive: true,
      outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED',
    })
    await vi.waitFor(() => expect(platforms.startYouTubeBroadcast).toHaveBeenCalledOnce())
    expect(obs.startSecondaryTwitchForObsStream).toHaveBeenCalledOnce()
    expect(platforms.startComments).toHaveBeenCalledOnce()

    websocket.emit('StreamStateChanged', {
      outputActive: false,
      outputState: 'OBS_WEBSOCKET_OUTPUT_RECONNECTING',
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(obs.finishObsTriggeredStream).not.toHaveBeenCalled()
    expect(platforms.completeYouTubeBroadcast).not.toHaveBeenCalled()
    expect(platforms.stopComments).not.toHaveBeenCalled()

    websocket.emit('StreamStateChanged', {
      outputActive: true,
      outputState: 'OBS_WEBSOCKET_OUTPUT_RECONNECTED',
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(platforms.startYouTubeBroadcast).toHaveBeenCalledOnce()
    expect(obs.startSecondaryTwitchForObsStream).toHaveBeenCalledOnce()

    websocket.emit('StreamStateChanged', {
      outputActive: false,
      outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPING',
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(obs.finishObsTriggeredStream).not.toHaveBeenCalled()

    websocket.emit('StreamStateChanged', {
      outputActive: false,
      outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED',
    })
    await vi.waitFor(() => expect(obs.finishObsTriggeredStream).toHaveBeenCalledOnce())
    expect(platforms.completeYouTubeBroadcast).toHaveBeenCalledOnce()
    expect(platforms.stopComments).toHaveBeenCalledOnce()
  })
})
