import { describe, expect, it, vi } from 'vitest'
import { starterProfiles, defaultConfig } from './defaults.js'
import { ObsController } from './obs.js'
import { SecretStore } from './secrets.js'

describe('ObsController recording fallbacks', () => {
  it('reports OBS as connected when the replay buffer is unavailable', async () => {
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string) => {
        if (request === 'GetReplayBufferStatus') throw Object.assign(new Error('Replay buffer is not available.'), { code: 604 })
        if (request === 'GetCurrentProgramScene') return { currentProgramSceneName: '00_STARTING' }
        return { outputActive: false }
      }),
    }
    const controller = new ObsController(new SecretStore())
    ;(controller as unknown as { obs: typeof fake }).obs = fake

    const status = await controller.status(structuredClone(defaultConfig), null, null, false, null)

    expect(status.obsConnected).toBe(true)
    expect(status.replayBuffer).toBe(false)
    expect(status.currentScene).toBe('00_STARTING')
  })

  it('reports OBS as disconnected for a non-604 replay buffer error', async () => {
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string) => {
        if (request === 'GetReplayBufferStatus') throw Object.assign(new Error('Connection lost'), { code: 500 })
        if (request === 'GetCurrentProgramScene') return { currentProgramSceneName: '00_STARTING' }
        return { outputActive: false }
      }),
    }
    const controller = new ObsController(new SecretStore())
    ;(controller as unknown as { obs: typeof fake }).obs = fake

    const status = await controller.status(structuredClone(defaultConfig), null, null, false, null)

    expect(status.obsConnected).toBe(false)
  })

  it('starts the stream even when optional recording outputs are unavailable', async () => {
    const calls: string[] = []
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string) => {
        calls.push(request)
        if (request === 'GetSourceActive') return { videoActive: true }
        if (request === 'GetReplayBufferStatus') throw Object.assign(new Error('Replay buffer is not available.'), { code: 604 })
        if (request === 'GetRecordStatus' || request === 'GetStreamStatus') return { outputActive: false }
        if (request === 'StartRecord' || request === 'StartReplayBuffer' || request === 'CallVendorRequest') throw new Error('not available')
        return {}
      }),
    }
    const controller = new ObsController(new SecretStore())
    ;(controller as unknown as { obs: typeof fake }).obs = fake
    const profile = structuredClone(starterProfiles[0])
    const config = structuredClone(defaultConfig)
    config.obs.startDelaySeconds = 0
    const warnings = await controller.start(config, profile, profile.capture.localSourceName)
    expect(calls).toContain('StartStream')
    expect(warnings).toHaveLength(4)
    expect(warnings.join(' ')).toContain('通常録画')
    expect(warnings.join(' ')).toContain('Source Record')
    expect(warnings.join(' ')).toContain('Aitum Vertical')
  })
})
