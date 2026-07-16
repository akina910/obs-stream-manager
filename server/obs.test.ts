import { describe, expect, it, vi } from 'vitest'
import { starterProfiles, defaultConfig } from './defaults.js'
import { ObsController } from './obs.js'
import type { SecretStore } from './secrets.js'

function memorySecrets(initial: Array<[string, string]> = []): SecretStore {
  const values = new Map<string, string>(initial)
  return {
    get: vi.fn((name: string) => values.get(name) ?? null),
    set: vi.fn((name: string, value: string) => {
      if (value) values.set(name, value)
      else values.delete(name)
    }),
  } as unknown as SecretStore
}

function youtubeSecrets(): SecretStore {
  return memorySecrets([
    ['youtube-stream-key', 'test-youtube-stream-key'],
    ['youtube-stream-server', 'rtmps://test.youtube/live2'],
  ])
}

describe('ObsController stream events', () => {
  it('forwards OBS stream state changes and supports unsubscribe', () => {
    const controller = new ObsController(memorySecrets())
    const websocket = (controller as unknown as { obs: { emit: (event: string, payload: unknown) => void } }).obs
    const listener = vi.fn()
    const unsubscribe = controller.onStreamStateChanged(listener)

    websocket.emit('StreamStateChanged', { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED' })
    expect(listener).toHaveBeenCalledWith(true)

    unsubscribe()
    websocket.emit('StreamStateChanged', { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED' })
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('ObsController recording fallbacks', () => {
  it('starts and stops a secure in-memory Twitch secondary output for simultaneous streaming', async () => {
    const calls: Array<{ request: string; data: unknown }> = []
    let streaming = false
    let twitchActive = false
    let service = { streamServiceType: 'rtmp_common', streamServiceSettings: { service: 'YouTube - RTMPS', server: 'auto' } }
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string, data?: unknown) => {
        calls.push({ request, data })
        if (request === 'GetSourceActive') return { videoActive: true }
        if (request === 'GetCurrentProgramScene') return { currentProgramSceneName: '10_GAME_PC' }
        if (request === 'GetStreamStatus') return { outputActive: streaming }
        if (request === 'GetRecordStatus' || request === 'GetReplayBufferStatus') return { outputActive: false }
        if (request === 'GetStreamServiceSettings') return service
        if (request === 'SetStreamServiceSettings') { service = structuredClone(data) as typeof service; return {} }
        if (request === 'StartStream') { streaming = true; return {} }
        if (request === 'StopStream') { streaming = false; return {} }
        if (request === 'CallVendorRequest') {
          const vendor = data as { vendorName: string; requestType: string }
          if (vendor.vendorName === 'obs-stream-manager-output') {
            if (vendor.requestType === 'start_twitch') twitchActive = true
            if (vendor.requestType === 'stop_twitch') twitchActive = false
            return { responseData: { success: true, pluginVersion: '0.2.1', apiVersion: 1, outputActive: twitchActive } }
          }
          return { responseData: { success: true } }
        }
        return {}
      }),
    }
    const secrets = memorySecrets([
      ['youtube-stream-key', 'test-youtube-stream-key'],
      ['youtube-stream-server', 'rtmps://test.youtube/live2'],
      ['twitch-stream-key', 'test-twitch-stream-key'],
      ['twitch-stream-server', 'rtmp://twitch.example/app'],
    ])
    const controller = new ObsController(secrets, 50)
    ;(controller as unknown as { obs: typeof fake }).obs = fake
    const profile = structuredClone(starterProfiles[0])
    const config = structuredClone(defaultConfig)
    config.obs.startDelaySeconds = 0
    config.obs.endDelaySeconds = 0
    config.features.recording = false
    config.features.replayBuffer = false
    config.features.sourceRecord = false
    config.features.verticalRecording = false

    await expect(controller.start(config, profile, profile.capture.localSourceName)).resolves.toEqual([])
    const startTwitch = calls.find(({ request, data }) => request === 'CallVendorRequest' && (data as { requestType?: string }).requestType === 'start_twitch')
    expect(startTwitch?.data).toEqual({
      vendorName: 'obs-stream-manager-output',
      requestType: 'start_twitch',
      requestData: { server: 'rtmp://twitch.example/app', key: 'test-twitch-stream-key' },
    })

    await expect(controller.stop(config, profile)).resolves.toEqual([])
    const stopTwitchIndex = calls.findIndex(({ request, data }) => request === 'CallVendorRequest' && (data as { requestType?: string }).requestType === 'stop_twitch')
    const stopStreamIndex = calls.findIndex(({ request }) => request === 'StopStream')
    expect(stopTwitchIndex).toBeGreaterThan(-1)
    expect(stopStreamIndex).toBeGreaterThan(stopTwitchIndex)
  })

  it('sends a non-public Twitch bandwidth test and restores the previous OBS service', async () => {
    const calls: Array<{ request: string; data: unknown }> = []
    let streaming = false
    let service = {
      streamServiceType: 'rtmp_common',
      streamServiceSettings: { service: 'YouTube - RTMPS', server: 'auto' },
    }
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string, data?: unknown) => {
        calls.push({ request, data })
        if (request === 'GetStreamStatus') return {
          outputActive: streaming,
          outputDuration: streaming ? 1_500 : 0,
          outputBytes: streaming ? 2_000_000 : 0,
          outputTotalFrames: streaming ? 90 : 0,
          outputSkippedFrames: 0,
          outputCongestion: 0,
        }
        if (request === 'GetStreamServiceSettings') return service
        if (request === 'SetStreamServiceSettings') { service = structuredClone(data) as typeof service; return {} }
        if (request === 'StartStream') { streaming = true; return {} }
        if (request === 'StopStream') { streaming = false; return {} }
        return {}
      }),
    }
    const secrets = memorySecrets([
      ['twitch-stream-key', 'test-twitch-stream-key'],
      ['twitch-stream-server', 'rtmp://twitch.example/app'],
    ])
    const controller = new ObsController(secrets, 50)
    ;(controller as unknown as { obs: typeof fake }).obs = fake

    await expect(controller.testTwitchIngest(structuredClone(defaultConfig), 0)).resolves.toEqual({
      ok: true,
      durationMs: 1_500,
      bytesSent: 2_000_000,
      totalFrames: 90,
      skippedFrames: 0,
      congestion: 0,
    })

    const applied = calls.find(({ request }) => request === 'SetStreamServiceSettings')?.data as { streamServiceSettings: { key: string } }
    expect(applied.streamServiceSettings.key).toBe('test-twitch-stream-key?bandwidthtest=true')
    expect(calls.filter(({ request }) => request === 'SetStreamServiceSettings').at(-1)?.data).toEqual({
      streamServiceType: 'rtmp_common',
      streamServiceSettings: { service: 'YouTube - RTMPS', server: 'auto' },
    })
    expect(calls.map(({ request }) => request)).toEqual(expect.arrayContaining(['StartStream', 'StopStream']))
  })

  it('reports OBS as connected when the replay buffer is unavailable', async () => {
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string) => {
        if (request === 'GetReplayBufferStatus') throw Object.assign(new Error('Replay buffer is not available.'), { code: 604 })
        if (request === 'GetCurrentProgramScene') return { currentProgramSceneName: '00_STARTING' }
        if (request === 'GetStreamStatus') return { outputActive: true, outputDuration: 12_345 }
        return { outputActive: false }
      }),
    }
    const controller = new ObsController(memorySecrets())
    ;(controller as unknown as { obs: typeof fake }).obs = fake

    const status = await controller.status(structuredClone(defaultConfig), null, null, false, null)

    expect(status.obsConnected).toBe(true)
    expect(status.streamElapsedMs).toBe(12_345)
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
    const controller = new ObsController(memorySecrets())
    ;(controller as unknown as { obs: typeof fake }).obs = fake

    const status = await controller.status(structuredClone(defaultConfig), null, null, false, null)

    expect(status.obsConnected).toBe(false)
  })

  it('starts the stream even when optional recording outputs are unavailable', async () => {
    const calls: string[] = []
    let streaming = false
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string) => {
        calls.push(request)
        if (request === 'GetSourceActive') return { videoActive: true }
        if (request === 'GetReplayBufferStatus') throw Object.assign(new Error('Replay buffer is not available.'), { code: 604 })
        if (request === 'GetRecordStatus') return { outputActive: false }
        if (request === 'GetStreamStatus') return { outputActive: streaming }
        if (request === 'GetStreamServiceSettings') return { streamServiceType: 'rtmp_common', streamServiceSettings: { service: 'YouTube - RTMPS', server: 'auto' } }
        if (request === 'StartStream') { streaming = true; return {} }
        if (request === 'StartRecord' || request === 'StartReplayBuffer' || request === 'CallVendorRequest') throw new Error('not available')
        return {}
      }),
    }
    const controller = new ObsController(youtubeSecrets(), 50)
    ;(controller as unknown as { obs: typeof fake }).obs = fake
    const profile = structuredClone(starterProfiles[0])
    const config = structuredClone(defaultConfig)
    config.features.twitch = false
    config.obs.startDelaySeconds = 0
    const warnings = await controller.start(config, profile, profile.capture.localSourceName)
    expect(calls).toContain('StartStream')
    expect(warnings).toHaveLength(4)
    expect(warnings.join(' ')).toContain('通常録画')
    expect(warnings.join(' ')).toContain('Source Record')
    expect(warnings.join(' ')).toContain('Aitum Vertical')
  })

  it('replaces an unpaired stale snapshot and restores the current OBS service after YouTube stops', async () => {
    const calls: Array<{ request: string; data: unknown }> = []
    const secrets = memorySecrets([
      ['youtube-stream-key', 'test-youtube-stream-key'],
      ['youtube-stream-server', 'rtmps://test.youtube/live2'],
      ['obs-previous-stream-service', JSON.stringify({ streamServiceType: 'rtmp_custom', streamServiceSettings: { server: 'rtmps://stale.example/live', key: 'stale-key' } })],
    ])
    let streaming = false
    let service = {
      streamServiceType: 'rtmp_common',
      streamServiceSettings: { service: 'YouTube - RTMPS', server: 'auto' },
    }
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string, data?: unknown) => {
        calls.push({ request, data })
        if (request === 'GetSourceActive') return { videoActive: true }
        if (request === 'GetStreamStatus') return { outputActive: streaming }
        if (request === 'GetRecordStatus' || request === 'GetReplayBufferStatus') return { outputActive: false }
        if (request === 'GetStreamServiceSettings') return service
        if (request === 'SetStreamServiceSettings') { service = structuredClone(data) as typeof service; return {} }
        if (request === 'StartStream') { streaming = true; return {} }
        if (request === 'StopStream') { streaming = false; throw new Error('already stopped') }
        if (request === 'CallVendorRequest') return { responseData: { success: true } }
        return {}
      }),
    }
    const controller = new ObsController(secrets, 50)
    ;(controller as unknown as { obs: typeof fake }).obs = fake
    const profile = structuredClone(starterProfiles[0])
    const config = structuredClone(defaultConfig)
    config.obs.startDelaySeconds = 0
    config.obs.endDelaySeconds = 0
    config.features.recording = false
    config.features.replayBuffer = false
    config.features.sourceRecord = false
    config.features.verticalRecording = false
    config.features.twitch = false

    await expect(controller.start(config, profile, profile.capture.localSourceName)).resolves.toEqual([])
    expect(service).toMatchObject({
      streamServiceType: 'rtmp_custom',
      streamServiceSettings: { server: 'rtmps://test.youtube/live2', key: 'test-youtube-stream-key' },
    })
    await expect(controller.stop(config, profile)).resolves.toEqual(expect.arrayContaining([expect.stringContaining('already stopped')]))

    expect(service).toEqual({
      streamServiceType: 'rtmp_common',
      streamServiceSettings: { service: 'YouTube - RTMPS', server: 'auto' },
    })
    expect(secrets.get('obs-previous-stream-service')).toBeNull()
    expect(calls.filter(({ request }) => request === 'SetStreamServiceSettings')).toHaveLength(2)
  })

  it('does not apply a stale restore snapshot after the user changes the OBS service', async () => {
    const previous = { streamServiceType: 'rtmp_common', streamServiceSettings: { service: 'YouTube - RTMPS', server: 'auto' } }
    const applied = { streamServiceType: 'rtmp_custom', server: 'rtmps://old.youtube/live2', key: 'old-key' }
    const secrets = memorySecrets([
      ['obs-previous-stream-service', JSON.stringify(previous)],
      ['obs-applied-stream-service', JSON.stringify(applied)],
    ])
    const setService = vi.fn()
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string, data?: unknown) => {
        if (request === 'GetStreamStatus' || request === 'GetRecordStatus' || request === 'GetReplayBufferStatus') return { outputActive: false }
        if (request === 'GetStreamServiceSettings') return { streamServiceType: 'rtmp_custom', streamServiceSettings: { server: 'rtmps://manual.example/live', key: 'manual-key' } }
        if (request === 'SetStreamServiceSettings') { setService(data); return {} }
        if (request === 'CallVendorRequest') return { responseData: { success: true } }
        return {}
      }),
    }
    const controller = new ObsController(secrets, 50)
    ;(controller as unknown as { obs: typeof fake }).obs = fake
    const config = structuredClone(defaultConfig)
    config.obs.endDelaySeconds = 0

    await expect(controller.stop(config, null)).resolves.toEqual([])

    expect(setService).not.toHaveBeenCalled()
    expect(secrets.get('obs-previous-stream-service')).toBeNull()
    expect(secrets.get('obs-applied-stream-service')).toBeNull()
  })

  it('globally stops active OBS and plugin outputs after the controller state has been reset', async () => {
    const calls: Array<{ request: string; data: unknown }> = []
    let streaming = true
    let recording = true
    let replayBuffer = true
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string, data?: unknown) => {
        calls.push({ request, data })
        if (request === 'GetStreamStatus') return { outputActive: streaming }
        if (request === 'GetRecordStatus') return { outputActive: recording }
        if (request === 'GetReplayBufferStatus') return { outputActive: replayBuffer }
        if (request === 'StopStream') { streaming = false; return {} }
        if (request === 'StopRecord') { recording = false; return {} }
        if (request === 'StopReplayBuffer') { replayBuffer = false; return {} }
        if (request === 'CallVendorRequest') return { responseData: { success: true } }
        return {}
      }),
    }
    const controller = new ObsController(memorySecrets(), 50)
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

  it('waits for delayed OBS output shutdown instead of reporting a false stop failure', async () => {
    let stopping = false
    let statusChecksAfterStop = 0
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string) => {
        if (request === 'GetStreamStatus') {
          if (!stopping) return { outputActive: true }
          statusChecksAfterStop += 1
          return { outputActive: statusChecksAfterStop < 4 }
        }
        if (request === 'GetRecordStatus' || request === 'GetReplayBufferStatus') return { outputActive: false }
        if (request === 'StopStream') { stopping = true; return {} }
        if (request === 'CallVendorRequest') return { responseData: { success: true } }
        return {}
      }),
    }
    const controller = new ObsController(memorySecrets(), 50, 1_500)
    ;(controller as unknown as { obs: typeof fake }).obs = fake
    const config = structuredClone(defaultConfig)
    config.obs.endDelaySeconds = 0
    config.features.sourceRecord = false
    config.features.verticalRecording = false

    await expect(controller.stop(config, null)).resolves.toEqual([])
    expect(statusChecksAfterStop).toBeGreaterThanOrEqual(4)
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
    const controller = new ObsController(memorySecrets())
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
    let streaming = false
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string, data?: unknown) => {
        calls.push({ request, data })
        if (request === 'GetSourceActive') return { videoActive: true }
        if (request === 'GetRecordStatus' || request === 'GetReplayBufferStatus') return { outputActive: false }
        if (request === 'GetStreamStatus') return { outputActive: streaming }
        if (request === 'GetStreamServiceSettings') return { streamServiceType: 'rtmp_common', streamServiceSettings: { service: 'YouTube - RTMPS', server: 'auto' } }
        if (request === 'StartStream') { streaming = true; return {} }
        if (request === 'CallVendorRequest') throw new Error('No vendor was found by that name.')
        return {}
      }),
    }
    const controller = new ObsController(youtubeSecrets(), 50)
    ;(controller as unknown as { obs: typeof fake }).obs = fake
    const profile = structuredClone(starterProfiles[0])
    const config = structuredClone(defaultConfig)
    config.obs.startDelaySeconds = 0
    config.features.recording = false
    config.features.replayBuffer = false
    config.features.sourceRecord = false
    config.features.twitch = false

    await expect(controller.start(config, profile, profile.capture.localSourceName)).resolves.toEqual([])
    expect(calls).toContainEqual({
      request: 'TriggerHotkeyByName',
      data: { hotkeyName: 'VerticalCanvasDockStartRecording' },
    })
    expect(calls.map(({ request }) => request)).toContain('StartStream')
  })

  it('fails and rolls back when OBS never reports an active stream output', async () => {
    const calls: Array<{ request: string; data: unknown }> = []
    let service = {
      streamServiceType: 'rtmp_common',
      streamServiceSettings: { service: 'YouTube - RTMPS', server: 'auto' },
    }
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string, data?: unknown) => {
        calls.push({ request, data })
        if (request === 'GetSourceActive') return { videoActive: true }
        if (request === 'GetCurrentProgramScene') return { currentProgramSceneName: '10_GAME_PC' }
        if (request === 'GetStreamStatus' || request === 'GetRecordStatus' || request === 'GetReplayBufferStatus') return { outputActive: false }
        if (request === 'GetStreamServiceSettings') return service
        if (request === 'SetStreamServiceSettings') { service = structuredClone(data) as typeof service; return {} }
        return {}
      }),
    }
    const controller = new ObsController(youtubeSecrets(), 20)
    ;(controller as unknown as { obs: typeof fake }).obs = fake
    const profile = structuredClone(starterProfiles[0])
    const config = structuredClone(defaultConfig)
    config.features.youtube = true
    profile.youtube.enabled = true
    config.obs.startDelaySeconds = 0
    config.features.recording = false
    config.features.replayBuffer = false
    config.features.sourceRecord = false
    config.features.verticalRecording = false

    await controller.preparePrimaryStream(config, profile)
    await expect(controller.start(config, profile, profile.capture.localSourceName)).rejects.toThrow('OBS配信出力が開始状態になりませんでした')

    expect(calls.map(({ request }) => request)).toEqual(expect.arrayContaining(['SetStreamServiceSettings', 'StartStream', 'StopStream']))
    const serviceSettings = calls.find(({ request }) => request === 'SetStreamServiceSettings')?.data as {
      streamServiceSettings: Record<string, unknown>
    }
    expect(serviceSettings.streamServiceSettings.key).toBe('test-youtube-stream-key')
    expect(serviceSettings).toMatchObject({
      streamServiceType: 'rtmp_custom',
      streamServiceSettings: { server: 'rtmps://test.youtube/live2', use_auth: false },
    })
    expect(calls.filter(({ request }) => request === 'SetStreamServiceSettings').at(-1)?.data).toEqual({
      streamServiceType: 'rtmp_common',
      streamServiceSettings: { service: 'YouTube - RTMPS', server: 'auto' },
    })
    expect(calls.filter(({ request }) => request === 'SetCurrentProgramScene').at(-1)?.data).toEqual({ sceneName: '10_GAME_PC' })
  })

  it('rolls back a failed publication without switching to the ending scene', async () => {
    const scenes: string[] = []
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string, data?: unknown) => {
        if (request === 'GetStreamStatus' || request === 'GetRecordStatus' || request === 'GetReplayBufferStatus') return { outputActive: false }
        if (request === 'CallVendorRequest') return { responseData: { success: true } }
        if (request === 'SetCurrentProgramScene') scenes.push((data as { sceneName: string }).sceneName)
        return {}
      }),
    }
    const controller = new ObsController(memorySecrets())
    ;(controller as unknown as { obs: typeof fake; rollbackScene: string | null }).obs = fake
    ;(controller as unknown as { rollbackScene: string | null }).rollbackScene = '10_GAME_PC'
    const profile = structuredClone(starterProfiles[0])

    await expect(controller.rollbackStart(structuredClone(defaultConfig), profile)).resolves.toEqual([])
    expect(scenes).toEqual(['10_GAME_PC'])
    expect(scenes).not.toContain(profile.obs.endingScene)
    expect(fake.call).not.toHaveBeenCalledWith('StopStream')
    expect(fake.call).not.toHaveBeenCalledWith('StopRecord')
    expect(fake.call).not.toHaveBeenCalledWith('StopReplayBuffer')
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
    const controller = new ObsController(memorySecrets())
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
    const controller = new ObsController(memorySecrets())
    ;(controller as unknown as { obs: typeof fake }).obs = fake
    const profile = structuredClone(starterProfiles[0])
    profile.recording.directory = 'D:\\Recordings'

    const warnings = await controller.applyProfile(structuredClone(defaultConfig), profile, 'local')

    expect(warnings).toHaveLength(2)
    expect(warnings.join(' ')).toContain('録画保存先')
    expect(warnings.join(' ')).toContain('リプレイバッファ時間')
  })

  it('prepares a Twitch-only primary stream once and preserves the original OBS service until cleanup', async () => {
    const previous = { streamServiceType: 'rtmp_common', streamServiceSettings: { service: 'Twitch', server: 'auto' } }
    let service = structuredClone(previous)
    const setService = vi.fn((value: typeof service) => { service = structuredClone(value) })
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string, data?: unknown) => {
        if (request === 'GetStreamStatus') return { outputActive: false }
        if (request === 'GetStreamServiceSettings') return service
        if (request === 'SetStreamServiceSettings') { setService(data as typeof service); return {} }
        if (request === 'CallVendorRequest') return { responseData: { success: true, pluginVersion: '0.2.1', apiVersion: 1, outputActive: false } }
        return {}
      }),
    }
    const secrets = memorySecrets([
      ['twitch-stream-key', 'test-twitch-key'],
      ['twitch-stream-server', 'rtmp://twitch.example/app'],
    ])
    const controller = new ObsController(secrets)
    ;(controller as unknown as { obs: typeof fake }).obs = fake
    const config = structuredClone(defaultConfig)
    config.features.youtube = false
    const profile = structuredClone(starterProfiles[0])

    await controller.preparePrimaryStream(config, profile)
    await controller.preparePrimaryStream(config, profile)
    expect(setService).toHaveBeenCalledTimes(1)
    expect(service).toMatchObject({ streamServiceType: 'rtmp_custom', streamServiceSettings: { key: 'test-twitch-key' } })

    await expect(controller.finishObsTriggeredStream(config)).resolves.toEqual([])
    expect(setService).toHaveBeenCalledTimes(2)
    expect(service).toEqual(previous)
  })

  it('stops recording and replay buffer when OBS itself stops streaming', async () => {
    let recording = true
    let replayBuffer = true
    const calls: string[] = []
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string) => {
        calls.push(request)
        if (request === 'GetStreamStatus') return { outputActive: false }
        if (request === 'GetRecordStatus') return { outputActive: recording }
        if (request === 'GetReplayBufferStatus') return { outputActive: replayBuffer }
        if (request === 'StopRecord') { recording = false; return {} }
        if (request === 'StopReplayBuffer') { replayBuffer = false; return {} }
        if (request === 'CallVendorRequest') return { responseData: { success: true, pluginVersion: '0.2.1', apiVersion: 1, outputActive: false } }
        return {}
      }),
    }
    const controller = new ObsController(memorySecrets(), 50, 50)
    ;(controller as unknown as { obs: typeof fake }).obs = fake

    await expect(controller.finishObsTriggeredStream(structuredClone(defaultConfig))).resolves.toEqual([])

    expect(calls).toContain('StopRecord')
    expect(calls).toContain('StopReplayBuffer')
    expect(recording).toBe(false)
    expect(replayBuffer).toBe(false)
  })

  it('does not report an old plugin without an API handshake as ready', async () => {
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string) => {
        if (request === 'GetStreamStatus' || request === 'GetRecordStatus' || request === 'GetReplayBufferStatus') return { outputActive: false }
        if (request === 'GetCurrentProgramScene') return { currentProgramSceneName: '10_GAME_PC' }
        if (request === 'CallVendorRequest') return { responseData: { success: true, outputActive: false } }
        return {}
      }),
    }
    const controller = new ObsController(memorySecrets())
    ;(controller as unknown as { obs: typeof fake }).obs = fake

    const status = await controller.status(structuredClone(defaultConfig), null, null, false, null)

    expect(status.twitchOutputPluginReady).toBe(false)
    expect(status.twitchOutputPlugin?.state).toBe('incompatible')
  })

  it('clears transient plugin-recording states when OBS is disconnected', async () => {
    const fake = {
      connect: vi.fn().mockRejectedValue(new Error('OBS is not running')),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(),
    }
    const controller = new ObsController(memorySecrets())
    ;(controller as unknown as { obs: typeof fake }).obs = fake
    ;(controller as unknown as { started: Record<string, unknown> }).started = {
      stream: true,
      twitch: true,
      record: true,
      replay: true,
      sourceRecord: true,
      vertical: true,
      sourceRecordSource: 'Game Capture',
    }

    const status = await controller.status(structuredClone(defaultConfig), null, null, false, null)

    expect(status).toMatchObject({ obsConnected: false, sourceRecord: false, verticalRecording: false })
    expect((controller as unknown as { started: { sourceRecord: boolean; vertical: boolean } }).started).toMatchObject({ sourceRecord: false, vertical: false })
  })

  it('clears transient output ownership even when websocket disconnect reports an error', async () => {
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockRejectedValue(new Error('socket already closed')),
      on: vi.fn(),
      call: vi.fn(),
    }
    const controller = new ObsController(memorySecrets())
    ;(controller as unknown as { obs: typeof fake }).obs = fake
    await controller.connect(structuredClone(defaultConfig))
    ;(controller as unknown as { started: Record<string, unknown> }).started = {
      stream: true,
      twitch: true,
      record: true,
      replay: true,
      sourceRecord: true,
      vertical: true,
      sourceRecordSource: 'Game Capture',
    }

    await expect(controller.disconnect()).rejects.toThrow('socket already closed')
    expect((controller as unknown as { started: { stream: boolean; sourceRecord: boolean; vertical: boolean } }).started)
      .toMatchObject({ stream: false, sourceRecord: false, vertical: false })
  })
})
