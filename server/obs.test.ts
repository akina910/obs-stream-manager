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

  it('globally stops active OBS and plugin outputs after the controller state has been reset', async () => {
    const calls: Array<{ request: string; data: unknown }> = []
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string, data?: unknown) => {
        calls.push({ request, data })
        if (request === 'GetStreamStatus' || request === 'GetRecordStatus' || request === 'GetReplayBufferStatus') return { outputActive: true }
        if (request === 'CallVendorRequest') return { responseData: { success: true } }
        return {}
      }),
    }
    const controller = new ObsController(new SecretStore())
    ;(controller as unknown as { obs: typeof fake }).obs = fake
    const config = structuredClone(defaultConfig)
    config.obs.endDelaySeconds = 0
    config.features.sourceRecord = false
    config.features.verticalRecording = false

    await expect(controller.stop(config, null)).resolves.toEqual([])

    expect(calls.map(({ request }) => request)).toEqual(expect.arrayContaining(['StopStream', 'StopRecord', 'StopReplayBuffer']))
    expect(calls).toContainEqual({
      request: 'CallVendorRequest',
      data: { vendorName: 'source-record', requestType: 'record_stop', requestData: {} },
    })
    expect(calls).toContainEqual({
      request: 'CallVendorRequest',
      data: { vendorName: 'aitum-vertical-canvas', requestType: 'stop_recording', requestData: {} },
    })
  })

  it('treats an empty Source Record stop as idempotent and falls back to the Aitum stop hotkey', async () => {
    const calls: Array<{ request: string; data: unknown }> = []
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string, data?: unknown) => {
        calls.push({ request, data })
        if (request === 'GetStreamStatus' || request === 'GetRecordStatus' || request === 'GetReplayBufferStatus') return { outputActive: false }
        if (request === 'CallVendorRequest') {
          const vendorName = (data as { vendorName: string }).vendorName
          if (vendorName === 'source-record') return { responseData: { success: false, error: 'no source found' } }
          throw new Error('No vendor was found by that name.')
        }
        return {}
      }),
    }
    const controller = new ObsController(new SecretStore())
    ;(controller as unknown as { obs: typeof fake }).obs = fake
    const config = structuredClone(defaultConfig)
    config.obs.endDelaySeconds = 0

    await expect(controller.stop(config, null)).resolves.toEqual([])
    expect(calls).toContainEqual({
      request: 'TriggerHotkeyByName',
      data: { hotkeyName: 'VerticalCanvasDockStopRecording' },
    })
  })

  it('falls back to the Aitum start hotkey when its websocket vendor is unavailable', async () => {
    const calls: Array<{ request: string; data: unknown }> = []
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string, data?: unknown) => {
        calls.push({ request, data })
        if (request === 'GetSourceActive') return { videoActive: true }
        if (request === 'GetRecordStatus' || request === 'GetReplayBufferStatus' || request === 'GetStreamStatus') return { outputActive: false }
        if (request === 'CallVendorRequest') throw new Error('No vendor was found by that name.')
        return {}
      }),
    }
    const controller = new ObsController(new SecretStore())
    ;(controller as unknown as { obs: typeof fake }).obs = fake
    const profile = structuredClone(starterProfiles[0])
    const config = structuredClone(defaultConfig)
    config.obs.startDelaySeconds = 0
    config.features.recording = false
    config.features.replayBuffer = false
    config.features.sourceRecord = false

    await expect(controller.start(config, profile, profile.capture.localSourceName)).resolves.toEqual([])
    expect(calls).toContainEqual({
      request: 'TriggerHotkeyByName',
      data: { hotkeyName: 'VerticalCanvasDockStartRecording' },
    })
    expect(calls.map(({ request }) => request)).toContain('StartStream')
  })

  it('disables an existing ducking filter when the selected profile requests zero dB', async () => {
    const toggles: Array<{ filterEnabled: boolean }> = []
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string, data?: unknown) => {
        if (request === 'GetSourceActive') return { videoActive: true }
        if (request === 'GetSourceFilterList') return { filters: [{ filterKind: 'compressor_filter', filterName: 'Game Ducking' }] }
        if (request === 'GetRecordStatus') return { outputActive: false }
        if (request === 'SetSourceFilterEnabled') toggles.push(data as { filterEnabled: boolean })
        return {}
      }),
    }
    const controller = new ObsController(new SecretStore())
    ;(controller as unknown as { obs: typeof fake }).obs = fake
    const profile = structuredClone(starterProfiles[0])
    const config = structuredClone(defaultConfig)

    await controller.applyProfile(config, profile, 'local')
    profile.audio.duckingDb = 0
    await controller.applyProfile(config, profile, 'local')

    expect(toggles.map(({ filterEnabled }) => filterEnabled)).toEqual([true, false])
  })

  it('warns when no compatible OBS profile parameter can be updated', async () => {
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string) => {
        if (request === 'GetSourceActive') return { videoActive: true }
        if (request === 'GetSourceFilterList') return { filters: [{ filterKind: 'compressor_filter', filterName: 'Game Ducking' }] }
        if (request === 'GetRecordStatus') return { outputActive: false }
        if (request === 'SetProfileParameter') throw new Error('unsupported parameter')
        return {}
      }),
    }
    const controller = new ObsController(new SecretStore())
    ;(controller as unknown as { obs: typeof fake }).obs = fake
    const profile = structuredClone(starterProfiles[0])
    profile.recording.directory = 'D:\\Recordings'

    const warnings = await controller.applyProfile(structuredClone(defaultConfig), profile, 'local')

    expect(warnings).toHaveLength(2)
    expect(warnings.join(' ')).toContain('録画保存先')
    expect(warnings.join(' ')).toContain('リプレイバッファ時間')
  })
})
