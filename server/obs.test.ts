import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { starterProfiles, defaultConfig } from './defaults.js'
import { ObsController, recordingFilenameFormat, recordingGameName, recordingOnlyPreset } from './obs.js'
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
  it('creates a dedicated 1440p recording profile and leaves the stream profile available', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'obs-recording-only-'))
    const calls: Array<{ request: string; data: unknown }> = []
    let currentProfile = 'MAIN_YOUTUBE_TWITCH'
    const profiles = ['MAIN_YOUTUBE_TWITCH']
    const fake = {
      call: vi.fn(async (request: string, data?: unknown) => {
        calls.push({ request, data })
        if (request === 'GetProfileList') return { currentProfileName: currentProfile, profiles: [...profiles] }
        if (request === 'CreateProfile') {
          const profileName = (data as { profileName: string }).profileName
          profiles.push(profileName)
          currentProfile = profileName
          return {}
        }
        if (request === 'SetCurrentProfile') {
          currentProfile = (data as { profileName: string }).profileName
          return {}
        }
        if (request === 'GetVideoSettings') return {
          baseWidth: 2560,
          baseHeight: 1440,
          outputWidth: 2560,
          outputHeight: 1440,
          fpsNumerator: 60,
          fpsDenominator: 1,
        }
        if (request === 'CallVendorRequest') return { responseData: {
          success: true, advancedHandlerReady: true, profilePersisted: true,
          rateControl: 'VBR', videoBitrateKbps: 8_000, maxVideoBitrateKbps: 10_000,
        } }
        return {}
      }),
    }
    const controller = new ObsController(memorySecrets())
    ;(controller as unknown as { obs: typeof fake }).obs = fake

    try {
      await (controller as unknown as { configureRecordingOnlyProfile(directory: string, filenameFormat: string): Promise<void> })
        .configureRecordingOnlyProfile(directory, 'ARK_%CCYY-%MM-%DD_%hh-%mm-%ss')

      expect(profiles).toEqual(['MAIN_YOUTUBE_TWITCH', recordingOnlyPreset.profileName])
      expect(currentProfile).toBe(recordingOnlyPreset.profileName)
      expect(calls).not.toContainEqual({ request: 'SetVideoSettings', data: expect.anything() })
      expect(calls).toContainEqual({ request: 'SetProfileParameter', data: {
        parameterCategory: 'Output',
        parameterName: 'FilenameFormatting',
        parameterValue: 'ARK_%CCYY-%MM-%DD_%hh-%mm-%ss',
      } })
      expect(calls).toContainEqual({ request: 'SetProfileParameter', data: {
        parameterCategory: 'Video',
        parameterName: 'BaseCX',
        parameterValue: '2560',
      } })
      expect(calls).toContainEqual({ request: 'SetProfileParameter', data: {
        parameterCategory: 'Video',
        parameterName: 'OutputCY',
        parameterValue: '1440',
      } })
      expect(calls).toContainEqual({ request: 'SetProfileParameter', data: {
        parameterCategory: 'Video',
        parameterName: 'FPSNum',
        parameterValue: '60',
      } })
      expect(calls).toContainEqual({ request: 'SetProfileParameter', data: {
        parameterCategory: 'Video',
        parameterName: 'AutoRemux',
        parameterValue: 'true',
      } })
      expect(calls).toContainEqual({ request: 'SetProfileParameter', data: {
        parameterCategory: 'AdvOut',
        parameterName: 'RecTracks',
        parameterValue: '63',
      } })
      expect(calls).toContainEqual({ request: 'CallVendorRequest', data: {
        vendorName: 'obs-stream-manager-output-v2',
        requestType: 'configure_recording',
        requestData: { rateControl: 'VBR', videoBitrateKbps: 8_000, maxVideoBitrateKbps: 10_000, audioBitrateKbps: 160 },
      } })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.each([
    {},
    { rateControl: 'CQP', videoBitrateKbps: 8_000, maxVideoBitrateKbps: 10_000 },
    { rateControl: 'VBR', videoBitrateKbps: 8_000, maxVideoBitrateKbps: 100_000 },
  ])('rejects an old or unbounded recording plugin response: %j', async (response) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'obs-recording-cap-'))
    const controller = new ObsController(memorySecrets())
    const call = vi.fn(async (request: string) => {
      if (request === 'GetProfileList') return {
        currentProfileName: recordingOnlyPreset.profileName, profiles: [recordingOnlyPreset.profileName],
      }
      if (request === 'GetVideoSettings') return {
        baseWidth: 2560, baseHeight: 1440, outputWidth: 2560, outputHeight: 1440, fpsNumerator: 60, fpsDenominator: 1,
      }
      if (request === 'CallVendorRequest') return { responseData: { success: true, ...response } }
      return {}
    })
    ;(controller as unknown as { obs: { call: typeof call } }).obs = { call }
    try {
      await expect((controller as unknown as {
        configureRecordingOnlyProfile(directory: string, filenameFormat: string): Promise<void>
      }).configureRecordingOnlyProfile(directory, 'Game_%CCYY-%MM-%DD_%hh-%mm-%ss')).rejects.toThrow('録画ビットレート上限の適用を確認できませんでした')
      expect(call.mock.calls.some(([request]) => request === 'StartRecord')).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('uses the selected game label in a Windows-safe recording filename', () => {
    const profile = structuredClone(starterProfiles.find(({ id }) => id === 'ark_survival_ascended')!)
    profile.presentation.templateLabel = 'ARK: ASA / Main*'

    expect(recordingGameName(profile)).toBe('ARK_ASA_Main')
    expect(recordingFilenameFormat(profile)).toBe('ARK_ASA_Main_%CCYY-%MM-%DD_%hh-%mm-%ss')
  })

  it('reports a plugin permission failure instead of an endless OBS restart wait', async () => {
    const previous = process.env.OBS_STREAM_MANAGER_OBS_PLUGIN_INSTALL_STATE
    process.env.OBS_STREAM_MANAGER_OBS_PLUGIN_INSTALL_STATE = 'permission_required'
    try {
      const controller = new ObsController(memorySecrets())
      ;(controller as unknown as { obs: { call: ReturnType<typeof vi.fn> } }).obs = {
        call: vi.fn(async () => { throw new Error('No vendor was found') }),
      }

      await expect((controller as unknown as {
        getTwitchOutputPluginStatus(): Promise<{ state: string; detail: string }>
      }).getTwitchOutputPluginStatus()).resolves.toMatchObject({
        state: 'install_failed',
        detail: expect.stringContaining('更新権限がありません'),
      })
    } finally {
      if (previous === undefined) delete process.env.OBS_STREAM_MANAGER_OBS_PLUGIN_INSTALL_STATE
      else process.env.OBS_STREAM_MANAGER_OBS_PLUGIN_INSTALL_STATE = previous
    }
  })

  it('ignores transitional stream states so an OBS reconnect is not reported as a final stop', () => {
    const controller = new ObsController(memorySecrets())
    const websocket = (controller as unknown as { obs: { emit: (event: string, payload: unknown) => void } }).obs
    const listener = vi.fn()
    const unsubscribe = controller.onStreamStateChanged(listener)

    websocket.emit('StreamStateChanged', { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED' })
    expect(listener).toHaveBeenCalledWith(true)

    websocket.emit('StreamStateChanged', { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_RECONNECTING' })
    websocket.emit('StreamStateChanged', { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_RECONNECTED' })
    expect(listener).toHaveBeenNthCalledWith(2, true)

    websocket.emit('StreamStateChanged', { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPING' })
    expect(listener).toHaveBeenCalledTimes(2)

    websocket.emit('StreamStateChanged', { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED' })
    expect(listener).toHaveBeenNthCalledWith(3, false)

    unsubscribe()
    websocket.emit('StreamStateChanged', { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED' })
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('uses the configured Switch game-audio fallback for a custom capture-card source name', () => {
    const controller = new ObsController(memorySecrets())
    const profile = structuredClone(starterProfiles.find(({ platformGroup }) => platformGroup === 'switch')!)
    profile.capture.localSourceName = 'Custom HDMI Capture'

    const inputName = (controller as unknown as {
      legacyGameAudioInput(config: typeof defaultConfig, profile: typeof profile, selectedSource: string): string
    }).legacyGameAudioInput(structuredClone(defaultConfig), profile, profile.capture.localSourceName)

    expect(inputName).toBe(defaultConfig.sources.switchGame)
  })
})

describe('ObsController BGM stock', () => {
  it('creates one managed media input, adds it to every scene, and starts it at the requested volume', async () => {
    const calls: Array<{ request: string; data: unknown }> = []
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string, data?: unknown) => {
        calls.push({ request, data })
        if (request === 'GetSceneList') return {
          currentProgramSceneName: '00_STARTING',
          scenes: [{ sceneName: '20_TALK' }, { sceneName: '00_STARTING' }],
        }
        if (request === 'GetInputSettings') throw new Error('No source was found')
        if (request === 'GetSceneItemId') throw new Error('No scene item was found')
        return {}
      }),
    }
    const controller = new ObsController(memorySecrets())
    ;(controller as unknown as { obs: typeof fake }).obs = fake

    await controller.playBgm(structuredClone(defaultConfig), 'C:\\BGM\\stock.mp3', -21)

    expect(calls.find(({ request }) => request === 'CreateInput')?.data).toMatchObject({
      sceneName: '00_STARTING',
      inputName: 'BGM Stock',
      inputKind: 'ffmpeg_source',
      inputSettings: { local_file: 'C:\\BGM\\stock.mp3', looping: true, restart_on_activate: false },
    })
    expect(calls.find(({ request }) => request === 'CreateSceneItem')?.data).toEqual({
      sceneName: '20_TALK',
      sourceName: 'BGM Stock',
      sceneItemEnabled: true,
    })
    expect(calls.find(({ request }) => request === 'SetInputVolume')?.data).toEqual({ inputName: 'BGM Stock', inputVolumeDb: -21 })
    expect(calls.find(({ request }) => request === 'SetInputAudioTracks')?.data).toEqual({
      inputName: 'BGM Stock',
      inputAudioTracks: { '1': true, '2': false, '3': false, '4': false, '5': true, '6': false },
    })
    expect(calls.find(({ request }) => request === 'TriggerMediaInputAction')?.data).toEqual({
      inputName: 'BGM Stock',
      mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART',
    })
  })

  it('reports managed media playback without failing when OBS has no stock source', async () => {
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string) => {
        if (request === 'GetMediaInputStatus') return { mediaState: 'OBS_MEDIA_STATE_PAUSED', mediaCursor: 1_200, mediaDuration: 5_000 }
        return {}
      }),
    }
    const controller = new ObsController(memorySecrets())
    ;(controller as unknown as { obs: typeof fake }).obs = fake

    await expect(controller.bgmPlaybackStatus(structuredClone(defaultConfig))).resolves.toEqual({ state: 'paused', cursorMs: 1_200, durationMs: 5_000 })

    fake.call.mockRejectedValueOnce(new Error('No source was found'))
    await expect(controller.bgmPlaybackStatus(structuredClone(defaultConfig))).resolves.toEqual({ state: 'unavailable', cursorMs: null, durationMs: null })
  })

  it('removes the managed media input before deleting its selected file', async () => {
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string) => {
        if (request === 'GetSceneList') return { scenes: [{ sceneName: '00_STARTING' }, { sceneName: '20_TALK' }] }
        if (request === 'GetSceneItemList') return { sceneItems: [{ sourceName: 'BGM Stock', sceneItemId: 7 }, { sourceName: 'Other', sceneItemId: 8 }] }
        return {}
      }),
    }
    const controller = new ObsController(memorySecrets())
    ;(controller as unknown as { obs: typeof fake }).obs = fake

    await controller.clearBgm(structuredClone(defaultConfig))

    expect(fake.call.mock.calls).toEqual(expect.arrayContaining([
      ['TriggerMediaInputAction', { inputName: 'BGM Stock', mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP' }],
      ['RemoveSceneItem', { sceneName: '00_STARTING', sceneItemId: 7 }],
      ['RemoveSceneItem', { sceneName: '20_TALK', sceneItemId: 7 }],
      ['RemoveInput', { inputName: 'BGM Stock' }],
    ]))
  })

  it('stops a previous game BGM without failing when no managed media input exists', async () => {
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn().mockRejectedValue(new Error('No source was found')),
    }
    const controller = new ObsController(memorySecrets())
    ;(controller as unknown as { obs: typeof fake }).obs = fake

    await expect(controller.stopBgm(structuredClone(defaultConfig))).resolves.toBeUndefined()
    expect(fake.call).toHaveBeenCalledWith('TriggerMediaInputAction', {
      inputName: 'BGM Stock',
      mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP',
    })
  })
})

describe('ObsController recording fallbacks', () => {
  it('switches a 4K profile to managed FHD and suppresses extra encoders during simultaneous outputs', async () => {
    const calls: Array<{ request: string; data: unknown }> = []
    let streaming = false
    let twitchActive = false
    let streamFrames = 0
    let twitchFrames = 0
    let videoSettings = { baseWidth: 3840, baseHeight: 2160, outputWidth: 3840, outputHeight: 2160, fpsNumerator: 60, fpsDenominator: 1 }
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string, data?: unknown) => {
        calls.push({ request, data })
        if (request === 'GetSourceActive') return { videoActive: true }
        if (request === 'GetCurrentProgramScene') return { currentProgramSceneName: '10_GAME_PC' }
        if (request === 'GetInputList') return { inputs: [] }
        if (request === 'GetProfileParameter') return { parameterValue: 'Advanced' }
        if (request === 'GetVideoSettings') return videoSettings
        if (request === 'SetVideoSettings') { videoSettings = structuredClone(data) as typeof videoSettings; return {} }
        if (request === 'GetStreamStatus') return { outputActive: streaming, outputTotalFrames: streaming ? (streamFrames += 10) : 0 }
        if (request === 'GetRecordStatus' || request === 'GetReplayBufferStatus') return { outputActive: false }
        if (request === 'GetStreamServiceSettings') return { streamServiceType: 'rtmp_common', streamServiceSettings: { service: 'YouTube - RTMPS', server: 'auto' } }
        if (request === 'StartStream') { streaming = true; return {} }
        if (request === 'StartRecord' || request === 'StartReplayBuffer') return {}
        if (request === 'CallVendorRequest') {
          const vendor = data as { vendorName: string; requestType: string }
          if (vendor.vendorName === 'obs-stream-manager-output-v2') {
            if (vendor.requestType === 'start_twitch') twitchActive = true
            return { responseData: { success: true, pluginVersion: '0.2.3', apiVersion: 4, outputActive: twitchActive, totalFrames: twitchActive ? (twitchFrames += 10) : 0, dedicatedEncoder: twitchActive, dedicatedVideoEncoder: twitchActive, sharedPrimaryAudioEncoder: twitchActive, audioMixerIndex: 5, videoWidth: 1920, videoHeight: 1080, fpsNumerator: 60, fpsDenominator: 1 } }
          }
          if (vendor.vendorName === 'aitum-vertical-canvas' && vendor.requestType === 'status') {
            return { responseData: { success: true, backtrack: true } }
          }
          return { responseData: { success: true } }
        }
        return {}
      }),
    }
    const controller = new ObsController(memorySecrets([
      ['youtube-stream-key', 'youtube-key'],
      ['youtube-stream-server', 'rtmps://youtube.example/live2'],
      ['twitch-stream-key', 'twitch-key'],
      ['twitch-stream-server', 'rtmp://twitch.example/app'],
    ]), 50)
    ;(controller as unknown as { obs: typeof fake }).obs = fake
    const config = structuredClone(defaultConfig)
    const profile = structuredClone(starterProfiles[0])
    config.obs.startDelaySeconds = 0
    config.features.sourceRecord = true
    config.features.verticalRecording = true
    profile.recording.sourceRecord = true
    profile.recording.verticalRecording = true

    const warnings = await controller.start(config, profile, profile.capture.localSourceName)

    expect(calls.map(({ request }) => request)).toEqual(expect.arrayContaining(['StartStream', 'StartRecord', 'StartReplayBuffer']))
    expect(calls.some(({ request, data }) => request === 'CallVendorRequest' && (data as { vendorName?: string; requestType?: string }).vendorName === 'source-record' && (data as { requestType?: string }).requestType === 'record_start')).toBe(false)
    const stopBacktrackIndex = calls.findIndex(({ request, data }) => request === 'CallVendorRequest' && (data as { requestType?: string }).requestType === 'stop_backtrack')
    expect(stopBacktrackIndex).toBeGreaterThanOrEqual(0)
    expect(calls.find(({ request }) => request === 'SetVideoSettings')?.data).toMatchObject({
      baseWidth: 1920,
      baseHeight: 1080,
      outputWidth: 1920,
      outputHeight: 1080,
      fpsNumerator: 60,
      fpsDenominator: 1,
    })
    expect(calls.find(({ request, data }) => request === 'CallVendorRequest' && (data as { requestType?: string }).requestType === 'configure_stream')?.data).toMatchObject({
      vendorName: 'obs-stream-manager-output-v2',
      requestType: 'configure_stream',
      requestData: {
        videoBitrateKbps: 10_000,
        primaryVideoBitrateKbps: 10_000,
        twitchVideoBitrateKbps: 6_000,
        audioBitrateKbps: 160,
      },
    })
    expect(calls).toContainEqual({
      request: 'SetProfileParameter',
      data: { parameterCategory: 'AdvOut', parameterName: 'ApplyServiceSettings', parameterValue: 'false' },
    })
    expect(calls.map(({ request }) => request)).not.toContain('TriggerHotkeyByName')
    expect(warnings.join(' ')).toContain('Source Recordは個別のフレーム落ちを監視できないため、配信中は開始しません')
    expect(warnings.join(' ')).toContain('Aitum Vertical録画は開始しませんでした')
    expect(videoSettings).toMatchObject({ baseWidth: 1920, baseHeight: 1080, outputWidth: 1920, outputHeight: 1080 })
  })

  it('does not start unobservable Source Record output during a single-platform stream', async () => {
    const calls: Array<{ request: string; data: unknown }> = []
    let streaming = false
    let streamFrames = 0
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string, data?: unknown) => {
        calls.push({ request, data })
        if (request === 'GetSourceActive') return { videoActive: true }
        if (request === 'GetCurrentProgramScene') return { currentProgramSceneName: '10_GAME_PC' }
        if (request === 'GetInputList') return { inputs: [] }
        if (request === 'GetProfileParameter') return { parameterValue: 'Advanced' }
        if (request === 'GetVideoSettings') return { baseWidth: 1920, baseHeight: 1080, outputWidth: 1920, outputHeight: 1080, fpsNumerator: 60, fpsDenominator: 1 }
        if (request === 'GetStreamStatus') {
          if (streaming) streamFrames += 10
          return { outputActive: streaming, outputTotalFrames: streamFrames, outputSkippedFrames: 0 }
        }
        if (request === 'GetRecordStatus' || request === 'GetReplayBufferStatus') return { outputActive: false }
        if (request === 'GetStreamServiceSettings') return { streamServiceType: 'rtmp_common', streamServiceSettings: { service: 'YouTube - RTMPS', server: 'auto' } }
        if (request === 'StartStream') { streaming = true; return {} }
        if (request === 'CallVendorRequest') {
          const vendor = data as { vendorName: string; requestType: string }
          if (vendor.vendorName === 'obs-stream-manager-output-v2') return { responseData: { success: true, pluginVersion: '0.2.3', apiVersion: 4, outputActive: false } }
        }
        return {}
      }),
    }
    const controller = new ObsController(youtubeSecrets(), 50)
    ;(controller as unknown as { obs: typeof fake }).obs = fake
    const config = structuredClone(defaultConfig)
    const profile = structuredClone(starterProfiles[0])
    config.obs.startDelaySeconds = 0
    config.features.twitch = false
    config.features.recording = false
    config.features.replayBuffer = false
    config.features.sourceRecord = true
    config.features.verticalRecording = false
    profile.recording.sourceRecord = true
    profile.recording.verticalRecording = false
    profile.recording.directory = 'D:\\Recordings'

    await expect(controller.start(config, profile, profile.capture.localSourceName)).resolves.toEqual(expect.arrayContaining([
      expect.stringContaining('Source Recordは個別のフレーム落ちを監視できないため、配信中は開始しません'),
    ]))

    expect(calls.some(({ request, data }) => request === 'CreateSourceFilter'
      || request === 'CallVendorRequest' && (data as { vendorName?: string; requestType?: string }).vendorName === 'source-record'
        && (data as { requestType?: string }).requestType === 'record_start')).toBe(false)
  })

  it('warns when any managed FHD profile parameter cannot be updated', async () => {
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string, data?: unknown) => {
        if (request === 'GetStreamStatus' || request === 'GetRecordStatus' || request === 'GetReplayBufferStatus') return { outputActive: false }
        if (request === 'GetVideoSettings') return { baseWidth: 3840, baseHeight: 2160, outputWidth: 1920, outputHeight: 1080, fpsNumerator: 60, fpsDenominator: 1 }
        if (request === 'CallVendorRequest') return { responseData: { success: true, pluginVersion: '0.2.12', apiVersion: 4, outputActive: false } }
        if (request === 'SetProfileParameter' && (data as { parameterName?: string }).parameterName === 'ApplyServiceSettings') {
          throw new Error('parameter is unavailable')
        }
        return {}
      }),
    }
    const controller = new ObsController(memorySecrets())
    ;(controller as unknown as { obs: typeof fake }).obs = fake
    const warnings: string[] = []

    await (controller as unknown as { configureManagedOutput(warnings: string[]): Promise<void> }).configureManagedOutput(warnings)

    expect(warnings).toEqual([expect.stringContaining('FHD配信プロファイル設定を一部更新できませんでした')])
  })

  it('does not add Twitch load to an OBS-triggered stream when the encoder cannot be made safe', async () => {
    const calls: Array<{ request: string; data: unknown }> = []
    let twitchActive = false
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string, data?: unknown) => {
        calls.push({ request, data })
        if (request !== 'CallVendorRequest') return {}
        const vendor = data as { vendorName: string; requestType: string }
        if (vendor.vendorName === 'aitum-vertical-canvas' && vendor.requestType === 'status') {
          return { responseData: { success: true, backtrack: true } }
        }
        if (vendor.vendorName === 'aitum-vertical-canvas' && vendor.requestType === 'stop_backtrack') {
          return { responseData: { success: true } }
        }
        if (vendor.requestType === 'configure_stream') return { responseData: { success: false, error: 'Unknown request type' } }
        if (vendor.requestType === 'start_twitch') { twitchActive = true; return { responseData: { success: true, outputActive: true } } }
        if (vendor.requestType === 'twitch_status') return { responseData: { success: true, pluginVersion: '0.2.3', apiVersion: 4, outputActive: twitchActive, totalFrames: twitchActive ? 1 : 0, dedicatedEncoder: twitchActive, dedicatedVideoEncoder: twitchActive, sharedPrimaryAudioEncoder: twitchActive, audioMixerIndex: 5, videoWidth: 1920, videoHeight: 1080, fpsNumerator: 60, fpsDenominator: 1 } }
        return { responseData: { success: true } }
      }),
    }
    const controller = new ObsController(memorySecrets([
      ['twitch-stream-key', 'twitch-key'],
      ['twitch-stream-server', 'rtmp://twitch.example/app'],
    ]), 50)
    ;(controller as unknown as { obs: typeof fake }).obs = fake
    const config = structuredClone(defaultConfig)
    const profile = structuredClone(starterProfiles[0])
    config.features.youtube = true
    config.features.twitch = true
    profile.youtube.enabled = true
    profile.twitch.enabled = true

    await expect(controller.startSecondaryTwitchForObsStream(config, profile))
      .rejects.toThrow('安定したFHD配信に必要なエンコーダー設定を適用できないため開始しません')
    expect(calls).toContainEqual({
      request: 'CallVendorRequest',
      data: { vendorName: 'aitum-vertical-canvas', requestType: 'stop_backtrack', requestData: {} },
    })
    expect(calls.some(({ request, data }) => request === 'CallVendorRequest' && (data as { requestType?: string }).requestType === 'start_twitch')).toBe(false)
  })

  it.each([false, true])('stops a Twitch secondary output that does not prove FHD 60fps encoding (already active: %s)', async (initiallyActive) => {
    const vendorRequests: string[] = []
    let twitchActive = initiallyActive
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string, data?: unknown) => {
        if (request !== 'CallVendorRequest') return {}
        const vendor = data as { requestType: string }
        vendorRequests.push(vendor.requestType)
        if (vendor.requestType === 'start_twitch') twitchActive = true
        if (vendor.requestType === 'stop_twitch') twitchActive = false
        if (vendor.requestType === 'twitch_status') {
          return {
            responseData: {
              success: true,
              pluginVersion: '0.2.16',
              apiVersion: 4,
              outputActive: twitchActive,
              totalFrames: twitchActive ? 1 : 0,
              dedicatedEncoder: twitchActive,
              dedicatedVideoEncoder: twitchActive,
              sharedPrimaryAudioEncoder: twitchActive,
              audioMixerIndex: 5,
              videoWidth: 1920,
              videoHeight: 1080,
              fpsNumerator: 30,
              fpsDenominator: 1,
            },
          }
        }
        return { responseData: { success: true, outputActive: twitchActive } }
      }),
    }
    const controller = new ObsController(memorySecrets([
      ['twitch-stream-key', 'twitch-key'],
      ['twitch-stream-server', 'rtmp://twitch.example/app'],
    ]), 50)
    ;(controller as unknown as { obs: typeof fake }).obs = fake
    const config = structuredClone(defaultConfig)
    const profile = structuredClone(starterProfiles[0])
    config.features.youtube = true
    config.features.twitch = true
    profile.youtube.enabled = true
    profile.twitch.enabled = true

    await expect(controller.startSecondaryTwitchForObsStream(config, profile)).rejects.toThrow('フレームレートが30.00fps')
    expect(twitchActive).toBe(false)
    expect(vendorRequests).toContain('stop_twitch')
    expect(vendorRequests.includes('start_twitch')).toBe(!initiallyActive)
  })

  it('reports when an unhealthy pre-existing Twitch secondary output cannot be stopped', async () => {
    const vendorRequests: string[] = []
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string, data?: unknown) => {
        if (request !== 'CallVendorRequest') return {}
        const vendor = data as { requestType: string }
        vendorRequests.push(vendor.requestType)
        if (vendor.requestType === 'stop_twitch') {
          return { responseData: { success: false, error: 'secondary output is wedged' } }
        }
        return {
          responseData: {
            success: true,
            pluginVersion: '0.2.16',
            apiVersion: 4,
            outputActive: true,
            totalFrames: 1,
            dedicatedEncoder: true,
            dedicatedVideoEncoder: true,
            sharedPrimaryAudioEncoder: true,
            audioMixerIndex: 5,
            videoWidth: 1920,
            videoHeight: 1080,
            fpsNumerator: 30,
            fpsDenominator: 1,
          },
        }
      }),
    }
    const controller = new ObsController(memorySecrets(), 50)
    ;(controller as unknown as { obs: typeof fake }).obs = fake
    const config = structuredClone(defaultConfig)
    const profile = structuredClone(starterProfiles[0])
    config.features.youtube = true
    config.features.twitch = true
    profile.youtube.enabled = true
    profile.twitch.enabled = true

    await expect(controller.startSecondaryTwitchForObsStream(config, profile))
      .rejects.toThrow(/異常なTwitch副出力の停止にも失敗しました.*secondary output is wedged/)
    expect(vendorRequests).toContain('stop_twitch')
    expect(vendorRequests).not.toContain('start_twitch')
  })

  it('rejects a nominal 60fps Twitch secondary output when every reported frame is skipped', async () => {
    const vendorRequests: string[] = []
    let twitchActive = false
    let totalFrames = 0
    let skippedFrames = 0
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string, data?: unknown) => {
        if (request !== 'CallVendorRequest') return {}
        const vendor = data as { requestType: string }
        vendorRequests.push(vendor.requestType)
        if (vendor.requestType === 'start_twitch') twitchActive = true
        if (vendor.requestType === 'stop_twitch') twitchActive = false
        if (vendor.requestType === 'twitch_status') {
          if (twitchActive) {
            totalFrames += 10
            skippedFrames += 10
          }
          return {
            responseData: {
              success: true,
              pluginVersion: '0.2.16',
              apiVersion: 4,
              outputActive: twitchActive,
              totalFrames,
              skippedFrames,
              dedicatedEncoder: twitchActive,
              dedicatedVideoEncoder: twitchActive,
              sharedPrimaryAudioEncoder: twitchActive,
              audioMixerIndex: 5,
              videoWidth: 1920,
              videoHeight: 1080,
              fpsNumerator: 60,
              fpsDenominator: 1,
            },
          }
        }
        return { responseData: { success: true, outputActive: twitchActive } }
      }),
    }
    const controller = new ObsController(memorySecrets([
      ['twitch-stream-key', 'twitch-key'],
      ['twitch-stream-server', 'rtmp://twitch.example/app'],
    ]), 50)
    ;(controller as unknown as { obs: typeof fake }).obs = fake
    const config = structuredClone(defaultConfig)
    const profile = structuredClone(starterProfiles[0])
    config.features.youtube = true
    config.features.twitch = true
    profile.youtube.enabled = true
    profile.twitch.enabled = true

    await expect(controller.startSecondaryTwitchForObsStream(config, profile))
      .rejects.toThrow('映像が安定した60 FPSで進みませんでした')
    expect(twitchActive).toBe(false)
    expect(vendorRequests).toContain('stop_twitch')
  })

  it('detects an empty Aitum Vertical scene before starting a black recording', async () => {
    const fake = {
      call: vi.fn(async (request: string, data?: unknown) => {
        if (request === 'CallVendorRequest') {
          expect(data).toMatchObject({ vendorName: 'aitum-vertical-canvas', requestType: 'current_scene' })
          return { responseData: { success: true, scene: 'Vertical Scene' } }
        }
        if (request === 'GetSceneItemList') return { sceneItems: [] }
        return {}
      }),
    }
    const controller = new ObsController(memorySecrets())
    ;(controller as unknown as { obs: typeof fake }).obs = fake

    const result = await (controller as unknown as { verticalSceneReady(): Promise<{ ready: boolean; sceneName: string }> }).verticalSceneReady()

    expect(result).toEqual({ ready: false, sceneName: 'Vertical Scene' })
  })

  it('warns but does not abort when Aitum Backtrack protection cannot be queried', async () => {
    const fake = {
      call: vi.fn(async () => { throw new Error('Unknown vendor request type') }),
    }
    const controller = new ObsController(memorySecrets())
    ;(controller as unknown as { obs: typeof fake }).obs = fake
    const warnings: string[] = []

    await expect((controller as unknown as {
      protectSimulcastPerformance(
        protection: { protected: boolean; width: number; height: number },
        warnings: string[],
      ): Promise<void>
    }).protectSimulcastPerformance({ protected: true, width: 1920, height: 1080 }, warnings)).resolves.toBeUndefined()

    expect(warnings.join(' ')).toContain('Backtrackの停止を確認できませんでした')
  })

  it('routes isolated recording stems to A1-A5 and the simulcast mix to A6', async () => {
    const tracks = new Map<string, Record<string, boolean>>()
    const profileParameters: Array<Record<string, unknown>> = []
    const vendorRequests: Array<Record<string, unknown>> = []
    const inputs = [
      ['GAME_PC', 'wasapi_output_capture'],
      ['GAME_GFN', 'wasapi_output_capture'],
      ['GAME_SWITCH', 'wasapi_output_capture'],
      ['DISCORD', 'wasapi_process_output_capture'],
      ['MIC', 'wasapi_input_capture'],
      ['BGM', 'wasapi_output_capture'],
      ['BGM Stock', 'ffmpeg_source'],
      ['Desktop Audio', 'wasapi_output_capture'],
      ['Mic/Aux', 'wasapi_input_capture'],
      ['PC Game Capture', 'game_capture'],
      ['Elgato Game Capture', 'dshow_input'],
      ['Alerts', 'browser_source'],
    ].map(([inputName, inputKind]) => ({ inputName, inputKind }))
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string, data?: unknown) => {
        if (request === 'GetSourceActive') return { videoActive: true }
        if (request === 'GetInputSettings') {
          const inputName = (data as { inputName: string }).inputName
          const inputKind = inputs.find((input) => input.inputName === inputName)?.inputKind
          if (!inputKind) throw new Error('missing input')
          return { inputKind, inputSettings: inputKind === 'wasapi_process_output_capture' ? { window: 'Discord:Chrome_WidgetWin_1:Discord.exe', priority: 2 } : {} }
        }
        if (request === 'GetInputList') return { inputs }
        if (request === 'GetProfileParameter') return { parameterValue: 'Advanced' }
        if (request === 'GetStreamStatus' || request === 'GetRecordStatus' || request === 'GetReplayBufferStatus') return { outputActive: false }
        if (request === 'GetSourceFilterList') return { filters: [{ filterKind: 'compressor_filter', filterName: 'MIC Ducking' }] }
        if (request === 'CallVendorRequest') {
          vendorRequests.push(data as Record<string, unknown>)
          return { responseData: { success: true, scheduledForStreamStart: true } }
        }
        if (request === 'SetInputAudioTracks') {
          const value = data as { inputName: string; inputAudioTracks: Record<string, boolean> }
          tracks.set(value.inputName, value.inputAudioTracks)
        }
        if (request === 'SetProfileParameter') profileParameters.push(data as Record<string, unknown>)
        return {}
      }),
    }
    const controller = new ObsController(memorySecrets())
    ;(controller as unknown as { obs: typeof fake }).obs = fake

    await controller.applyProfile(structuredClone(defaultConfig), structuredClone(starterProfiles[0]), 'local')

    expect(tracks.get('GAME_PC')).toEqual({ '1': false, '2': false, '3': false, '4': false, '5': false, '6': false })
    expect(tracks.get('PC Game Capture')).toEqual({ '1': true, '2': false, '3': false, '4': false, '5': false, '6': true })
    expect(tracks.get('DISCORD')).toEqual({ '1': false, '2': true, '3': false, '4': false, '5': false, '6': true })
    expect(tracks.get('MIC')).toEqual({ '1': false, '2': false, '3': true, '4': false, '5': false, '6': true })
    expect(tracks.get('BGM')).toEqual({ '1': false, '2': false, '3': false, '4': false, '5': false, '6': false })
    expect(tracks.get('BGM Stock')).toEqual({ '1': false, '2': false, '3': false, '4': true, '5': false, '6': true })
    expect(tracks.get('Desktop Audio')).toEqual({ '1': false, '2': false, '3': false, '4': false, '5': true, '6': false })
    expect(tracks.get('Mic/Aux')).toEqual({ '1': false, '2': false, '3': false, '4': false, '5': true, '6': false })
    expect(tracks.get('Alerts')).toEqual({ '1': false, '2': false, '3': false, '4': false, '5': true, '6': true })
    expect(fake.call).toHaveBeenCalledWith('SetInputSettings', {
      inputName: 'PC Game Capture',
      inputSettings: { capture_audio: true },
      overlay: true,
    })
    expect(profileParameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ parameterCategory: 'AdvOut', parameterName: 'TrackIndex', parameterValue: '6' }),
      expect.objectContaining({ parameterCategory: 'AdvOut', parameterName: 'RecTracks', parameterValue: '63' }),
      expect.objectContaining({ parameterCategory: 'AdvOut', parameterName: 'RecEncoder', parameterValue: 'none' }),
      expect.objectContaining({ parameterCategory: 'AdvOut', parameterName: 'Track5Name', parameterValue: 'AUX CAPTURE' }),
    ]))
    expect(vendorRequests).toContainEqual({
      vendorName: 'obs-stream-manager-output-v2',
      requestType: 'configure_stream',
      requestData: {
        videoBitrateKbps: 10_000,
        primaryVideoBitrateKbps: 10_000,
        twitchVideoBitrateKbps: 6_000,
        audioBitrateKbps: 160,
      },
    })
  })

  it('targets the detected GeForce NOW game window instead of any fullscreen window', async () => {
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string) => {
        if (request === 'GetInputSettings') {
          return {
            inputKind: 'game_capture',
            inputSettings: { capture_mode: 'any_fullscreen', window: '', priority: 0 },
          }
        }
        if (request === 'GetStreamStatus' || request === 'GetRecordStatus' || request === 'GetReplayBufferStatus') {
          return { outputActive: false }
        }
        return {}
      }),
    }
    const controller = new ObsController(memorySecrets())
    ;(controller as unknown as { obs: typeof fake }).obs = fake
    const warnings: string[] = []

    await (controller as unknown as {
      prepareGeForceNowWindow(sourceName: string, windowTitle: string, warnings: string[]): Promise<void>
    }).prepareGeForceNowWindow('GFN Capture', 'GeForce NOW のPRAGMATA', warnings)

    expect(warnings).toEqual([])
    expect(fake.call).toHaveBeenCalledWith('SetInputSettings', {
      inputName: 'GFN Capture',
      inputSettings: {
        capture_mode: 'window',
        priority: 0,
        window: 'GeForce NOW のPRAGMATA:CEFCLIENT:GeForceNOW.exe',
      },
      overlay: true,
    })
  })

  it('migrates a duplicate whole-device Discord source to application audio capture', async () => {
    const calls: Array<{ request: string; data: unknown }> = []
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string, data?: unknown) => {
        calls.push({ request, data })
        if (request === 'GetInputSettings') return { inputKind: 'wasapi_output_capture', inputSettings: { device_id: 'default' } }
        if (request === 'GetInputKindList') return { inputKinds: ['wasapi_output_capture', 'wasapi_process_output_capture'] }
        if (request === 'GetInputList') return { inputs: [{ inputName: 'DISCORD', inputKind: 'wasapi_output_capture' }] }
        if (request === 'GetInputMute') return { inputMuted: false }
        if (request === 'GetInputAudioTracks') return { inputAudioTracks: { '1': false, '2': true, '3': false, '4': false, '5': false, '6': true } }
        if (request === 'GetSceneList') return { scenes: [{ sceneName: '10_GAME_PC' }, { sceneName: '11_GAME_SWITCH' }] }
        if (request === 'GetSceneItemId' && (data as { sceneName: string }).sceneName === '11_GAME_SWITCH') return { sceneItemId: 42 }
        return {}
      }),
    }
    const controller = new ObsController(memorySecrets())
    ;(controller as unknown as { obs: typeof fake }).obs = fake
    const warnings: string[] = []

    await (controller as unknown as {
      ensureDiscordApplicationAudio(sceneName: string, inputName: string, warnings: string[]): Promise<void>
    }).ensureDiscordApplicationAudio('10_GAME_PC', 'DISCORD', warnings)

    expect(calls).toEqual(expect.arrayContaining([
      { request: 'SetInputName', data: { inputName: 'DISCORD', newInputName: 'DISCORD (旧デバイス音声)' } },
      { request: 'SetInputMute', data: { inputName: 'DISCORD (旧デバイス音声)', inputMuted: true } },
      { request: 'SetInputAudioTracks', data: { inputName: 'DISCORD (旧デバイス音声)', inputAudioTracks: { '1': false, '2': false, '3': false, '4': false, '5': false, '6': false } } },
      {
        request: 'CreateInput',
        data: {
          sceneName: '10_GAME_PC',
          inputName: 'DISCORD',
          inputKind: 'wasapi_process_output_capture',
          inputSettings: { window: 'Discord:Chrome_WidgetWin_1:Discord.exe', priority: 2 },
          sceneItemEnabled: true,
        },
      },
      { request: 'CreateSceneItem', data: { sceneName: '11_GAME_SWITCH', sourceName: 'DISCORD', sceneItemEnabled: true } },
    ]))
    expect(warnings.join(' ')).toContain('Discord.exeだけのA2分離キャプチャ')
  })

  it('rolls Discord migration back when application audio creation fails', async () => {
    const calls: Array<{ request: string; data: unknown }> = []
    const previousTracks = { '1': false, '2': true, '3': false, '4': false, '5': false, '6': true }
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string, data?: unknown) => {
        calls.push({ request, data })
        if (request === 'GetInputSettings') return { inputKind: 'wasapi_output_capture', inputSettings: { device_id: 'default' } }
        if (request === 'GetInputKindList') return { inputKinds: ['wasapi_process_output_capture'] }
        if (request === 'GetInputList') return { inputs: [{ inputName: 'DISCORD', inputKind: 'wasapi_output_capture' }] }
        if (request === 'GetInputMute') return { inputMuted: false }
        if (request === 'GetInputAudioTracks') return { inputAudioTracks: previousTracks }
        if (request === 'CreateInput') throw new Error('create failed')
        return {}
      }),
    }
    const controller = new ObsController(memorySecrets())
    ;(controller as unknown as { obs: typeof fake }).obs = fake
    const warnings: string[] = []

    await (controller as unknown as {
      ensureDiscordApplicationAudio(sceneName: string, inputName: string, warnings: string[]): Promise<void>
    }).ensureDiscordApplicationAudio('10_GAME_PC', 'DISCORD', warnings)

    expect(calls).toEqual(expect.arrayContaining([
      { request: 'SetInputName', data: { inputName: 'DISCORD (旧デバイス音声)', newInputName: 'DISCORD' } },
      { request: 'SetInputMute', data: { inputName: 'DISCORD', inputMuted: false } },
      { request: 'SetInputAudioTracks', data: { inputName: 'DISCORD', inputAudioTracks: previousTracks } },
    ]))
    expect(warnings.join(' ')).toContain('元のOBSソースへ戻しました')
  })

  it('does not migrate Discord unless mute and track rollback state are both readable', async () => {
    const calls: Array<{ request: string; data: unknown }> = []
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string, data?: unknown) => {
        calls.push({ request, data })
        if (request === 'GetInputSettings') return { inputKind: 'wasapi_output_capture', inputSettings: { device_id: 'default' } }
        if (request === 'GetInputKindList') return { inputKinds: ['wasapi_process_output_capture'] }
        if (request === 'GetInputList') return { inputs: [{ inputName: 'DISCORD', inputKind: 'wasapi_output_capture' }] }
        if (request === 'GetInputMute') return { inputMuted: false }
        if (request === 'GetInputAudioTracks') throw new Error('unavailable')
        return {}
      }),
    }
    const controller = new ObsController(memorySecrets())
    ;(controller as unknown as { obs: typeof fake }).obs = fake
    const warnings: string[] = []

    await (controller as unknown as {
      ensureDiscordApplicationAudio(sceneName: string, inputName: string, warnings: string[]): Promise<void>
    }).ensureDiscordApplicationAudio('10_GAME_PC', 'DISCORD', warnings)

    expect(calls.some(({ request }) => request === 'SetInputName')).toBe(false)
    expect(warnings.join(' ')).toContain('安全なアプリ音声移行を中止しました')
  })

  it('preserves Discord Canary executable matching and only adds a missing scene item', async () => {
    const calls: Array<{ request: string; data: unknown }> = []
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string, data?: unknown) => {
        calls.push({ request, data })
        if (request === 'GetInputSettings') return { inputKind: 'wasapi_process_output_capture', inputSettings: { window: 'Discord Canary:Chrome_WidgetWin_1:DiscordCanary.exe', priority: 2 } }
        if (request === 'GetSceneItemId') throw new Error('missing scene item')
        return {}
      }),
    }
    const controller = new ObsController(memorySecrets())
    ;(controller as unknown as { obs: typeof fake }).obs = fake
    const warnings: string[] = []

    await (controller as unknown as {
      ensureDiscordApplicationAudio(sceneName: string, inputName: string, warnings: string[]): Promise<void>
    }).ensureDiscordApplicationAudio('11_GAME_SWITCH', 'DISCORD', warnings)

    expect(calls.some(({ request }) => request === 'SetInputSettings')).toBe(false)
    expect(calls).toContainEqual({ request: 'CreateSceneItem', data: { sceneName: '11_GAME_SWITCH', sourceName: 'DISCORD', sceneItemEnabled: true } })
  })

  it('does not migrate or retarget Discord while any OBS output is active', async () => {
    const calls: Array<{ request: string; data: unknown }> = []
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string, data?: unknown) => {
        calls.push({ request, data })
        if (request === 'GetInputSettings') return { inputKind: 'wasapi_output_capture', inputSettings: { device_id: 'default' } }
        if (request === 'GetStreamStatus') return { outputActive: true }
        if (request === 'GetRecordStatus' || request === 'GetReplayBufferStatus') return { outputActive: false }
        return {}
      }),
    }
    const controller = new ObsController(memorySecrets())
    ;(controller as unknown as { obs: typeof fake }).obs = fake
    const warnings: string[] = []

    await (controller as unknown as {
      ensureDiscordApplicationAudio(sceneName: string, inputName: string, warnings: string[]): Promise<void>
    }).ensureDiscordApplicationAudio('10_GAME_PC', 'DISCORD', warnings)

    expect(calls.some(({ request }) => request === 'SetInputName' || request === 'SetInputSettings')).toBe(false)
    expect(warnings.join(' ')).toContain('出力中')
  })

  it('does not enable game-capture audio while any OBS output is active', async () => {
    const calls: Array<{ request: string; data: unknown }> = []
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string, data?: unknown) => {
        calls.push({ request, data })
        if (request === 'GetInputSettings') return { inputKind: 'game_capture', inputSettings: { capture_audio: false } }
        if (request === 'GetStreamStatus') return { outputActive: true }
        if (request === 'GetRecordStatus' || request === 'GetReplayBufferStatus') return { outputActive: false }
        return {}
      }),
    }
    const controller = new ObsController(memorySecrets())
    ;(controller as unknown as { obs: typeof fake }).obs = fake
    const config = structuredClone(defaultConfig)
    const profile = structuredClone(starterProfiles[0])
    const warnings: string[] = []

    const inputName = await (controller as unknown as {
      prepareGameAudioInput(config: typeof config, profile: typeof profile, selectedSource: string, warnings: string[]): Promise<string>
    }).prepareGameAudioInput(config, profile, 'PC Game Capture', warnings)

    expect(inputName).toBe(config.sources.pcGame)
    expect(calls.some(({ request }) => request === 'SetInputSettings')).toBe(false)
    expect(warnings.join(' ')).toContain('出力中')
  })

  it('automatically switches Basic output mode to Advanced before assigning A1-A5', async () => {
    const calls: Array<{ request: string; data: unknown }> = []
    const tracks = new Map<string, Record<string, boolean>>()
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string, data?: unknown) => {
        calls.push({ request, data })
        if (request === 'GetInputList') return { inputs: [
          { inputName: 'GAME_PC', inputKind: 'wasapi_output_capture' },
          { inputName: 'MIC', inputKind: 'wasapi_input_capture' },
        ] }
        if (request === 'GetProfileParameter') return { parameterValue: 'Simple' }
        if (request === 'GetStreamStatus' || request === 'GetRecordStatus' || request === 'GetReplayBufferStatus') return { outputActive: false }
        if (request === 'SetInputAudioTracks') {
          const value = data as { inputName: string; inputAudioTracks: Record<string, boolean> }
          tracks.set(value.inputName, value.inputAudioTracks)
        }
        return {}
      }),
    }
    const controller = new ObsController(memorySecrets())
    ;(controller as unknown as { obs: typeof fake }).obs = fake
    const warnings: string[] = []

    await (controller as unknown as { configureSeparatedAudioTracks(config: typeof defaultConfig, warnings: string[]): Promise<void> })
      .configureSeparatedAudioTracks(structuredClone(defaultConfig), warnings)

    expect(calls).toContainEqual({
      request: 'SetProfileParameter',
      data: { parameterCategory: 'Output', parameterName: 'Mode', parameterValue: 'Advanced' },
    })
    expect(tracks.get('GAME_PC')).toEqual({ '1': false, '2': false, '3': false, '4': false, '5': false, '6': false })
    expect(tracks.get('MIC')).toEqual({ '1': false, '2': false, '3': true, '4': false, '5': false, '6': true })
    expect(warnings).toContain('A1〜A5の分離録音を有効にするためOBS出力モードを「詳細」へ変更しました。現在のOBS出力機構はまだ旧モードのため、OBSを再起動するまで配信・録画は開始しません')
    expect(warnings.join(' ')).toContain('旧GAME音声はA1と配信MIXへ戻しませんでした')
  })

  it('warns and routes a safe fallback when the selected game-audio source disappeared', async () => {
    const tracks = new Map<string, Record<string, boolean>>()
    const fake = {
      on: vi.fn(),
      call: vi.fn(async (request: string, data?: unknown) => {
        if (request === 'GetStreamStatus' || request === 'GetRecordStatus' || request === 'GetReplayBufferStatus') return { outputActive: false }
        if (request === 'GetInputList') return { inputs: [
          { inputName: 'GAME_PC', inputKind: 'wasapi_process_output_capture' },
          { inputName: 'MIC', inputKind: 'wasapi_input_capture' },
        ] }
        if (request === 'GetProfileParameter') return { parameterValue: 'Advanced' }
        if (request === 'SetInputAudioTracks') {
          const value = data as { inputName: string; inputAudioTracks: Record<string, boolean> }
          tracks.set(value.inputName, value.inputAudioTracks)
        }
        if (request === 'CallVendorRequest') {
          return { responseData: { success: true, pluginVersion: '0.2.16', apiVersion: 4, outputActive: false } }
        }
        return {}
      }),
    }
    const controller = new ObsController(memorySecrets())
    ;(controller as unknown as { obs: typeof fake }).obs = fake
    const warnings: string[] = []

    await (controller as unknown as {
      configureSeparatedAudioTracks(config: typeof defaultConfig, warnings: string[], activeGameAudioInput: string): Promise<void>
    }).configureSeparatedAudioTracks(structuredClone(defaultConfig), warnings, 'Missing Game Capture')

    expect(tracks.get('GAME_PC')).toEqual({ '1': true, '2': false, '3': false, '4': false, '5': false, '6': true })
    expect(warnings.join(' ')).toContain('Missing Game Capture')
    expect(warnings.join(' ')).toContain('代替ソース「GAME_PC」')
  })

  it('keeps the restart gate closed in the connection that switched OBS output mode', async () => {
    const secrets = memorySecrets()
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string, data?: unknown) => {
        if (request === 'GetStreamStatus' || request === 'GetRecordStatus' || request === 'GetReplayBufferStatus') return { outputActive: false }
        if (request === 'GetInputList') return { inputs: [] }
        if (request === 'GetProfileParameter') return { parameterValue: 'Simple' }
        if (request === 'CallVendorRequest') {
          const vendor = data as { requestType?: string }
          if (vendor.requestType === 'twitch_status') {
            return { responseData: { success: true, pluginVersion: '0.2.16', apiVersion: 4, outputActive: false } }
          }
          if (vendor.requestType === 'configure_stream') {
            return { responseData: { success: true, advancedHandlerReady: true } }
          }
        }
        return {}
      }),
    }
    const controller = new ObsController(secrets)
    ;(controller as unknown as { obs: typeof fake }).obs = fake
    const warnings: string[] = []

    await (controller as unknown as {
      configureSeparatedAudioTracks(config: typeof defaultConfig, warnings: string[]): Promise<void>
    }).configureSeparatedAudioTracks(structuredClone(defaultConfig), warnings)

    await expect((controller as unknown as { assertManagedStreamEncoderReady(primaryVideoBitrateKbps: number): Promise<void> }).assertManagedStreamEncoderReady(10_000))
      .rejects.toThrow('OBSを再起動してから開始してください')
    expect(secrets.get('obs-output-mode-reload-required')).toBe('1')
  })

  it('persists the output-mode restart gate and clears it only after the current plugin proves the Advanced handler loaded', async () => {
    const secrets = memorySecrets([['obs-output-mode-reload-required', '1']])
    const oldPlugin = {
      on: vi.fn(),
      call: vi.fn(async () => ({ responseData: { success: true } })),
    }
    const beforeRestart = new ObsController(secrets)
    ;(beforeRestart as unknown as { obs: typeof oldPlugin }).obs = oldPlugin

    await expect((beforeRestart as unknown as { assertManagedStreamEncoderReady(primaryVideoBitrateKbps: number): Promise<void> }).assertManagedStreamEncoderReady(10_000))
      .rejects.toThrow('OBSを再起動してから開始してください')
    expect(secrets.get('obs-output-mode-reload-required')).toBe('1')

    const currentPlugin = {
      on: vi.fn(),
      call: vi.fn(async () => ({ responseData: { success: true, advancedHandlerReady: true } })),
    }
    const afterRestart = new ObsController(secrets)
    ;(afterRestart as unknown as { obs: typeof currentPlugin }).obs = currentPlugin

    await expect((afterRestart as unknown as { assertManagedStreamEncoderReady(primaryVideoBitrateKbps: number): Promise<void> }).assertManagedStreamEncoderReady(10_000))
      .resolves.toBeUndefined()
    expect(secrets.get('obs-output-mode-reload-required')).toBeNull()
  })

  it('does not change separated audio tracks while only the Twitch secondary output is active', async () => {
    const calls: Array<{ request: string; data: unknown }> = []
    const fake = {
      on: vi.fn(),
      call: vi.fn(async (request: string, data?: unknown) => {
        calls.push({ request, data })
        if (request === 'GetStreamStatus' || request === 'GetRecordStatus' || request === 'GetReplayBufferStatus') return { outputActive: false }
        if (request === 'CallVendorRequest') {
          return { responseData: { success: true, pluginVersion: '0.2.16', apiVersion: 4, outputActive: true } }
        }
        return {}
      }),
    }
    const controller = new ObsController(memorySecrets())
    ;(controller as unknown as { obs: typeof fake }).obs = fake
    const warnings: string[] = []

    await (controller as unknown as {
      configureSeparatedAudioTracks(config: typeof defaultConfig, warnings: string[]): Promise<void>
    }).configureSeparatedAudioTracks(structuredClone(defaultConfig), warnings)

    expect(calls.some(({ request }) => request === 'GetInputList')).toBe(false)
    expect(calls.some(({ request }) => request === 'SetInputAudioTracks')).toBe(false)
    expect(warnings.join(' ')).toContain('Twitch副出力')
  })

  it('does not start any output until OBS reloads the newly selected Advanced output handler', async () => {
    const calls: Array<{ request: string; data: unknown }> = []
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string, data?: unknown) => {
        calls.push({ request, data })
        if (request === 'GetSourceActive') return { videoActive: true }
        if (request === 'GetCurrentProgramScene') return { currentProgramSceneName: '10_GAME_PC' }
        if (request === 'GetStreamStatus' || request === 'GetRecordStatus' || request === 'GetReplayBufferStatus') return { outputActive: false }
        if (request === 'GetVideoSettings') return { baseWidth: 1920, baseHeight: 1080, outputWidth: 1920, outputHeight: 1080, fpsNumerator: 60, fpsDenominator: 1 }
        if (request === 'GetInputList') return { inputs: [] }
        if (request === 'GetStreamServiceSettings') return { streamServiceType: 'rtmp_common', streamServiceSettings: { service: 'YouTube - RTMPS', server: 'auto' } }
        if (request === 'CallVendorRequest') {
          const vendor = data as { requestType?: string }
          if (vendor.requestType === 'configure_stream') {
            return { responseData: { success: false, restartRequired: true, error: 'The Advanced output handler has not loaded yet' } }
          }
          return { responseData: { success: true, pluginVersion: '0.2.16', apiVersion: 4, outputActive: false } }
        }
        return {}
      }),
    }
    const controller = new ObsController(memorySecrets(), 50)
    ;(controller as unknown as { obs: typeof fake }).obs = fake
    const config = structuredClone(defaultConfig)
    const profile = structuredClone(starterProfiles[0])
    config.features.youtube = false
    config.features.twitch = false
    config.features.recording = false
    config.features.replayBuffer = false

    await expect(controller.start(config, profile, profile.capture.localSourceName))
      .rejects.toThrow('OBSを再起動してから開始してください')
    expect(calls.map(({ request }) => request)).not.toContain('StartStream')
    expect(calls.map(({ request }) => request)).not.toContain('StartRecord')
    expect(calls.map(({ request }) => request)).not.toContain('StartReplayBuffer')
  })

  it('does not add recording, replay or Twitch output to an existing OBS stream when the encoder gate is not ready', async () => {
    const calls: Array<{ request: string; data: unknown }> = []
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string, data?: unknown) => {
        calls.push({ request, data })
        if (request === 'GetSourceActive') return { videoActive: true }
        if (request === 'GetCurrentProgramScene') return { currentProgramSceneName: '10_GAME_PC' }
        if (request === 'GetStreamStatus') return { outputActive: true }
        if (request === 'GetRecordStatus' || request === 'GetReplayBufferStatus') return { outputActive: false }
        if (request === 'GetVideoSettings') return { baseWidth: 1920, baseHeight: 1080, outputWidth: 1920, outputHeight: 1080, fpsNumerator: 60, fpsDenominator: 1 }
        if (request === 'CallVendorRequest') {
          const vendor = data as { vendorName?: string; requestType?: string }
          if (vendor.vendorName === 'obs-stream-manager-output-v2' && vendor.requestType === 'configure_stream') {
            return { responseData: { success: false, restartRequired: true, error: 'The Advanced output handler has not loaded yet' } }
          }
          return { responseData: { success: true, pluginVersion: '0.2.16', apiVersion: 4, outputActive: false, backtrack: false } }
        }
        return {}
      }),
    }
    const controller = new ObsController(memorySecrets(), 50)
    ;(controller as unknown as { obs: typeof fake }).obs = fake
    const config = structuredClone(defaultConfig)
    const profile = structuredClone(starterProfiles[0])
    config.features.youtube = true
    config.features.twitch = true
    config.features.recording = true
    config.features.replayBuffer = true
    config.features.sourceRecord = false
    config.features.verticalRecording = false
    profile.youtube.enabled = true
    profile.twitch.enabled = true

    await expect(controller.start(config, profile, profile.capture.localSourceName))
      .rejects.toThrow('OBSを再起動してから開始してください')
    expect(calls.map(({ request }) => request)).not.toContain('StartRecord')
    expect(calls.map(({ request }) => request)).not.toContain('StartReplayBuffer')
    expect(calls.some(({ request, data }) => request === 'CallVendorRequest'
      && (data as { requestType?: string }).requestType === 'start_twitch')).toBe(false)
  })

  it('uses the calibrated microphone in the starting scene and disables a duplicate default input', async () => {
    const calls: Array<{ request: string; data: unknown }> = []
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string, data?: unknown) => {
        calls.push({ request, data })
        if (request === 'GetSourceActive') return { videoActive: true }
        if (request === 'GetInputSettings') {
          const inputName = (data as { inputName: string }).inputName
          if (inputName === 'MIC') return { inputKind: 'wasapi_input_capture', inputSettings: { device_id: 'default' } }
          if (inputName === '音声入力キャプチャ') return { inputKind: 'wasapi_input_capture', inputSettings: {} }
          throw new Error('missing input')
        }
        if (request === 'GetSceneItemList') {
          const sceneName = (data as { sceneName: string }).sceneName
          return sceneName === '00_STARTING'
            ? { sceneItems: [{ sourceName: '音声入力キャプチャ', sceneItemId: 11, sceneItemEnabled: true }] }
            : { sceneItems: [{ sourceName: 'MIC', sceneItemId: 21, sceneItemEnabled: true }, { sourceName: '音声入力キャプチャ', sceneItemId: 22, sceneItemEnabled: true }] }
        }
        if (request === 'GetInputList') return { inputs: [] }
        if (request === 'GetStreamStatus' || request === 'GetRecordStatus' || request === 'GetReplayBufferStatus') return { outputActive: false }
        if (request === 'GetSourceFilterList') return { filters: [{ filterKind: 'compressor_filter', filterName: 'MIC Ducking' }] }
        return {}
      }),
    }
    const controller = new ObsController(memorySecrets())
    ;(controller as unknown as { obs: typeof fake }).obs = fake

    const { warnings } = await controller.applyProfile(structuredClone(defaultConfig), structuredClone(starterProfiles[0]), 'local')

    expect(calls).toContainEqual({ request: 'CreateSceneItem', data: { sceneName: '00_STARTING', sourceName: 'MIC', sceneItemEnabled: true } })
    expect(calls).toContainEqual({ request: 'SetSceneItemEnabled', data: { sceneName: '00_STARTING', sceneItemId: 11, sceneItemEnabled: false } })
    expect(calls).toContainEqual({ request: 'SetSceneItemEnabled', data: { sceneName: '10_GAME_PC', sceneItemId: 22, sceneItemEnabled: false } })
    expect(warnings.join(' ')).toContain('二重取り込み')
  })

  it('does not reconfigure the managed stream encoder while an OBS output is active', async () => {
    const calls: Array<{ request: string; data: unknown }> = []
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string, data?: unknown) => {
        calls.push({ request, data })
        if (request === 'GetStreamStatus') return { outputActive: true }
        if (request === 'GetRecordStatus' || request === 'GetReplayBufferStatus') return { outputActive: false }
        if (request === 'GetSourceActive') return { videoActive: true }
        if (request === 'GetInputSettings' || request === 'GetSceneItemId') throw new Error('missing input')
        if (request === 'CallVendorRequest') {
          const vendor = data as { requestType?: string }
          if (vendor.requestType === 'configure_stream') {
            return { responseData: { success: true, advancedHandlerReady: true } }
          }
          return { responseData: { success: true, pluginVersion: '0.2.16', apiVersion: 4, outputActive: false } }
        }
        return {}
      }),
    }
    const controller = new ObsController(memorySecrets())
    ;(controller as unknown as { obs: typeof fake }).obs = fake

    const { warnings } = await controller.applyProfile(structuredClone(defaultConfig), structuredClone(starterProfiles[0]), 'local')

    expect(calls.some(({ request, data }) => request === 'CallVendorRequest'
      && (data as { requestType?: string }).requestType === 'configure_stream')).toBe(false)
    expect(warnings.join(' ')).toContain('配信エンコーダー設定は出力中のため変更していません')
  })

  it('starts and stops a secure in-memory Twitch secondary output for simultaneous streaming', async () => {
    const calls: Array<{ request: string; data: unknown }> = []
    let streaming = false
    let twitchActive = false
    let twitchActiveStatusChecks = 0
    let streamFrames = 0
    let service = { streamServiceType: 'rtmp_common', streamServiceSettings: { service: 'YouTube - RTMPS', server: 'auto' } }
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string, data?: unknown) => {
        calls.push({ request, data })
        if (request === 'GetSourceActive') return { videoActive: true }
        if (request === 'GetCurrentProgramScene') return { currentProgramSceneName: '10_GAME_PC' }
        if (request === 'GetStreamStatus') return { outputActive: streaming, outputTotalFrames: streaming ? (streamFrames += 10) : 0 }
        if (request === 'GetRecordStatus' || request === 'GetReplayBufferStatus') return { outputActive: false }
        if (request === 'GetStreamServiceSettings') return service
        if (request === 'SetStreamServiceSettings') { service = structuredClone(data) as typeof service; return {} }
        if (request === 'StartStream') { streaming = true; return {} }
        if (request === 'StopStream') { streaming = false; return {} }
        if (request === 'CallVendorRequest') {
          const vendor = data as { vendorName: string; requestType: string }
          if (vendor.vendorName === 'obs-stream-manager-output-v2') {
            if (vendor.requestType === 'start_twitch') twitchActive = true
            if (vendor.requestType === 'stop_twitch') twitchActive = false
            if (vendor.requestType === 'twitch_status' && twitchActive) twitchActiveStatusChecks += 1
            return { responseData: { success: true, pluginVersion: '0.2.1', apiVersion: 4, outputActive: twitchActive, totalFrames: twitchActive ? twitchActiveStatusChecks * 10 : 0, dedicatedEncoder: twitchActive, dedicatedVideoEncoder: twitchActive, sharedPrimaryAudioEncoder: twitchActive, audioMixerIndex: 5, videoWidth: 1920, videoHeight: 1080, fpsNumerator: 60, fpsDenominator: 1 } }
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
    const controller = new ObsController(secrets, 600)
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
    expect(twitchActiveStatusChecks).toBeGreaterThanOrEqual(2)
    const startTwitch = calls.find(({ request, data }) => request === 'CallVendorRequest' && (data as { requestType?: string }).requestType === 'start_twitch')
    expect(startTwitch?.data).toEqual({
      vendorName: 'obs-stream-manager-output-v2',
      requestType: 'start_twitch',
      requestData: { server: 'rtmp://twitch.example/app', key: 'test-twitch-stream-key' },
    })

    await expect(controller.stop(config, profile)).resolves.toEqual([])
    const stopTwitchIndex = calls.findIndex(({ request, data }) => request === 'CallVendorRequest' && (data as { requestType?: string }).requestType === 'stop_twitch')
    const stopStreamIndex = calls.findIndex(({ request }) => request === 'StopStream')
    expect(stopTwitchIndex).toBeGreaterThan(-1)
    expect(stopStreamIndex).toBeGreaterThan(stopTwitchIndex)
  })

  it('blocks a primary-only ingest diagnostic when a Twitch secondary output is already active', async () => {
    const calls: string[] = []
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string) => {
        calls.push(request)
        if (request === 'GetStreamStatus' || request === 'GetRecordStatus' || request === 'GetReplayBufferStatus') {
          return { outputActive: false }
        }
        if (request === 'CallVendorRequest') {
          return { responseData: { success: true, pluginVersion: '0.2.16', apiVersion: 4, outputActive: true } }
        }
        return {}
      }),
    }
    const controller = new ObsController(memorySecrets(), 50)
    ;(controller as unknown as { obs: typeof fake }).obs = fake

    await expect(controller.testTwitchIngest(structuredClone(defaultConfig), 1_000, { includeSecondary: false }))
      .rejects.toThrow('Twitch副出力を停止してから再実行してください')
    expect(calls).not.toContain('StartStream')
  })

  it('sends a non-public Twitch bandwidth test and restores the previous OBS service', async () => {
    const calls: Array<{ request: string; data: unknown }> = []
    let streaming = false
    let measuring = false
    let streamFrames = 0
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
        if (request === 'GetStreamStatus') {
          if (streaming) streamFrames += measuring ? 60 : 10
          return {
            outputActive: streaming,
            outputDuration: streaming ? (measuring ? 2_500 : 1_500) : 0,
            outputBytes: streaming ? (measuring ? 3_000_000 : 2_000_000) : 0,
            outputTotalFrames: streaming ? streamFrames : 0,
            outputSkippedFrames: 0,
            outputCongestion: 0,
          }
        }
        if (request === 'GetStats') {
          const value = measuring
            ? { activeFps: 60, renderTotalFrames: 190, renderSkippedFrames: 0, outputTotalFrames: 190, outputSkippedFrames: 0 }
            : { activeFps: 60, renderTotalFrames: 100, renderSkippedFrames: 0, outputTotalFrames: 100, outputSkippedFrames: 0 }
          measuring = true
          return value
        }
        if (request === 'GetVideoSettings') return { baseWidth: 3840, baseHeight: 2160, outputWidth: 1920, outputHeight: 1080, fpsNumerator: 60, fpsDenominator: 1 }
        if (request === 'GetRecordStatus' || request === 'GetReplayBufferStatus') return { outputActive: false }
        if (request === 'CallVendorRequest') return { responseData: { success: true, pluginVersion: '0.2.12', apiVersion: 4, outputActive: false } }
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

    await expect(controller.testTwitchIngest(structuredClone(defaultConfig), 0, { includeSecondary: false })).resolves.toMatchObject({
      ok: true,
      output: {
        width: 1920,
        height: 1080,
        fpsNumerator: 60,
        fpsDenominator: 1,
        videoBitrateKbps: 6_000,
        audioBitrateKbps: 160,
        encoderConfigured: true,
      },
      skippedFrames: 0,
      measuredFps: 60,
      congestion: 0,
      secondary: null,
      recording: null,
      replayBuffer: null,
      obs: {
        activeFps: 60,
        renderTotalFrames: 90,
        renderSkippedFrames: 0,
        outputTotalFrames: 90,
        outputSkippedFrames: 0,
      },
      verticalBacktrackStopped: false,
      warnings: [],
    })

    const applied = calls.find(({ request }) => request === 'SetStreamServiceSettings')?.data as { streamServiceSettings: { key: string } }
    expect(applied.streamServiceSettings.key).toBe('test-twitch-stream-key?bandwidthtest=true')
    expect(calls.filter(({ request }) => request === 'SetStreamServiceSettings').at(-1)?.data).toEqual({
      streamServiceType: 'rtmp_common',
      streamServiceSettings: { service: 'YouTube - RTMPS', server: 'auto' },
    })
    expect(calls.map(({ request }) => request)).toEqual(expect.arrayContaining(['StartStream', 'StopStream']))
  })

  it('stress-tests primary, secondary, recording, and replay outputs without going live', async () => {
    const calls: Array<{ request: string; data: unknown }> = []
    let streaming = false
    let secondary = false
    let recording = false
    let replay = false
    let backtrack = true
    let statsCalls = 0
    let streamStatusCalls = 0
    let secondaryStatusCalls = 0
    let videoSettings = { baseWidth: 3840, baseHeight: 2160, outputWidth: 3840, outputHeight: 2160, fpsNumerator: 60, fpsDenominator: 1 }
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
        if (request === 'GetStreamStatus') {
          const outputTotalFrames = streaming ? (statsCalls ? 180 : (++streamStatusCalls <= 2 ? streamStatusCalls : 90)) : 0
          return { outputActive: streaming, outputDuration: statsCalls ? 2_500 : 1_500, outputBytes: statsCalls ? 3_000_000 : 2_000_000, outputTotalFrames, outputSkippedFrames: 0, outputCongestion: 0 }
        }
        if (request === 'GetRecordStatus') return { outputActive: recording, outputDuration: statsCalls ? 1_600 : 200, outputBytes: statsCalls ? 3_500_000 : 500_000, outputTotalFrames: statsCalls ? 94 : 10, outputSkippedFrames: 0 }
        if (request === 'GetReplayBufferStatus') return { outputActive: replay, outputDuration: statsCalls ? 1_500 : 200, outputBytes: statsCalls ? 3_000_000 : 500_000, outputTotalFrames: statsCalls ? 88 : 10, outputSkippedFrames: 0 }
        if (request === 'GetVideoSettings') return videoSettings
        if (request === 'SetVideoSettings') { videoSettings = structuredClone(data) as typeof videoSettings; return {} }
        if (request === 'GetStats') {
          statsCalls += 1
          return statsCalls === 1
            ? { activeFps: 60, renderTotalFrames: 100, renderSkippedFrames: 1, outputTotalFrames: 100, outputSkippedFrames: 2 }
            : { activeFps: 60, renderTotalFrames: 190, renderSkippedFrames: 1, outputTotalFrames: 190, outputSkippedFrames: 2 }
        }
        if (request === 'GetStreamServiceSettings') return service
        if (request === 'SetStreamServiceSettings') { service = structuredClone(data) as typeof service; return {} }
        if (request === 'StartStream') { streaming = true; return {} }
        if (request === 'StopStream') { streaming = false; return {} }
        if (request === 'StartRecord') { recording = true; return {} }
        if (request === 'StopRecord') { recording = false; return {} }
        if (request === 'StartReplayBuffer') { replay = true; return {} }
        if (request === 'StopReplayBuffer') { replay = false; return {} }
        if (request === 'CallVendorRequest') {
          const vendor = data as { vendorName: string; requestType: string }
          if (vendor.vendorName === 'aitum-vertical-canvas') {
            if (vendor.requestType === 'stop_backtrack') backtrack = false
            return { responseData: { success: true, backtrack } }
          }
          if (vendor.vendorName === 'obs-stream-manager-output-v2') {
            if (vendor.requestType === 'start_twitch') secondary = true
            if (vendor.requestType === 'stop_twitch') secondary = false
            if (vendor.requestType === 'twitch_status' && secondary) secondaryStatusCalls += 1
            const totalFrames = statsCalls ? 99 : Math.min(10, 6 + secondaryStatusCalls * 2)
            return { responseData: { success: true, pluginVersion: '0.2.3', apiVersion: 4, outputActive: secondary, bytesSent: statsCalls ? 2_100_000 : 200_000, totalFrames: secondary ? totalFrames : 0, skippedFrames: 0, dedicatedEncoder: secondary, dedicatedVideoEncoder: secondary, sharedPrimaryAudioEncoder: secondary, audioMixerIndex: 5, videoWidth: 1920, videoHeight: 1080, fpsNumerator: 60, fpsDenominator: 1 } }
          }
        }
        return {}
      }),
    }
    const controller = new ObsController(memorySecrets([
      ['twitch-stream-key', 'test-twitch-stream-key'],
      ['twitch-stream-server', 'rtmp://twitch.example/app'],
    ]), 50)
    ;(controller as unknown as { obs: typeof fake }).obs = fake

    await expect(controller.testTwitchIngest(structuredClone(defaultConfig), 0, {
      includeSecondary: true,
      includeRecording: true,
      includeReplayBuffer: true,
    })).resolves.toMatchObject({
      ok: true,
      totalFrames: 180,
      skippedFrames: 0,
      secondary: { totalFrames: 89, skippedFrames: 0 },
      recording: { durationMs: 1_400, bytesWritten: 3_000_000 },
      replayBuffer: { active: true },
      obs: { activeFps: 60, renderTotalFrames: 90, renderSkippedFrames: 0, outputTotalFrames: 90, outputSkippedFrames: 0 },
      verticalBacktrackStopped: true,
      warnings: [],
    })

    const stopBacktrackIndex = calls.findIndex(({ request, data }) => request === 'CallVendorRequest' && (data as { requestType?: string }).requestType === 'stop_backtrack')
    expect(stopBacktrackIndex).toBeGreaterThanOrEqual(0)
    expect(videoSettings).toMatchObject({ baseWidth: 1920, baseHeight: 1080, outputWidth: 1920, outputHeight: 1080, fpsNumerator: 60, fpsDenominator: 1 })
    expect(streaming).toBe(false)
    expect(secondary).toBe(false)
    expect(recording).toBe(false)
    expect(replay).toBe(false)
    expect(service).toEqual({ streamServiceType: 'rtmp_common', streamServiceSettings: { service: 'YouTube - RTMPS', server: 'auto' } })
  })

  it('fails the load test when frames move during startup but collapse during the sustained measurement', async () => {
    let streaming = false
    let measuring = false
    let streamFrames = 0
    let service = { streamServiceType: 'rtmp_common', streamServiceSettings: { service: 'Twitch', server: 'auto' } }
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string, data?: unknown) => {
        if (request === 'GetStreamStatus') {
          if (streaming) streamFrames += measuring ? 1 : 10
          return { outputActive: streaming, outputDuration: measuring ? 1_000 : 50, outputBytes: 1_000_000, outputTotalFrames: streamFrames, outputSkippedFrames: 0, outputCongestion: 0 }
        }
        if (request === 'GetRecordStatus' || request === 'GetReplayBufferStatus') return { outputActive: false }
        if (request === 'GetVideoSettings') return { baseWidth: 1920, baseHeight: 1080, outputWidth: 1920, outputHeight: 1080, fpsNumerator: 60, fpsDenominator: 1 }
        if (request === 'GetStreamServiceSettings') return service
        if (request === 'SetStreamServiceSettings') { service = structuredClone(data) as typeof service; return {} }
        if (request === 'StartStream') { streaming = true; return {} }
        if (request === 'StopStream') { streaming = false; return {} }
        if (request === 'GetStats') {
          measuring = true
          return { activeFps: 60, renderTotalFrames: 100, renderSkippedFrames: 0, outputTotalFrames: 100, outputSkippedFrames: 0 }
        }
        if (request === 'CallVendorRequest') return { responseData: { success: true, pluginVersion: '0.2.16', apiVersion: 4, outputActive: false } }
        return {}
      }),
    }
    const controller = new ObsController(memorySecrets([
      ['twitch-stream-key', 'test-twitch-stream-key'],
      ['twitch-stream-server', 'rtmp://twitch.example/app'],
    ]), 50)
    ;(controller as unknown as { obs: typeof fake }).obs = fake

    await expect(controller.testTwitchIngest(structuredClone(defaultConfig), 1_000, { includeSecondary: false }))
      .rejects.toThrow('実運用負荷で映像が安定した60 FPSに達しませんでした: 主配信')
    expect(streaming).toBe(false)
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

  it('keeps reconnecting output active in both stream checks and runtime status', async () => {
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string) => {
        if (request === 'GetStreamStatus') {
          return {
            outputActive: false,
            outputReconnecting: true,
            outputDuration: 45_678,
          }
        }
        if (request === 'GetCurrentProgramScene') return { currentProgramSceneName: '30_GAME' }
        if (request === 'CallVendorRequest') {
          return {
            responseData: {
              success: true,
              pluginVersion: '0.2.20',
              apiVersion: 4,
              outputActive: false,
            },
          }
        }
        return { outputActive: false }
      }),
    }
    const controller = new ObsController(memorySecrets())
    ;(controller as unknown as { obs: typeof fake }).obs = fake

    await expect(controller.isStreaming(structuredClone(defaultConfig))).resolves.toBe(true)
    await expect(controller.status(structuredClone(defaultConfig), 'ark', 'window', false, null)).resolves.toMatchObject({
      obsConnected: true,
      streaming: true,
      streamElapsedMs: 45_678,
      selectedGameId: 'ark',
      currentScene: '30_GAME',
    })
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
    let streamFrames = 0
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string, data?: unknown) => {
        calls.push(request)
        if (request === 'GetSourceActive') return { videoActive: true }
        if (request === 'GetReplayBufferStatus') throw Object.assign(new Error('Replay buffer is not available.'), { code: 604 })
        if (request === 'GetRecordStatus') return { outputActive: false }
        if (request === 'GetStreamStatus') return { outputActive: streaming, outputTotalFrames: streaming ? (streamFrames += 10) : 0 }
        if (request === 'GetStreamServiceSettings') return { streamServiceType: 'rtmp_common', streamServiceSettings: { service: 'YouTube - RTMPS', server: 'auto' } }
        if (request === 'StartStream') { streaming = true; return {} }
        if (request === 'CallVendorRequest' && (data as { requestType?: string }).requestType === 'configure_stream') {
          return { responseData: { success: true } }
        }
        if (request === 'StartRecord' || request === 'StartReplayBuffer' || request === 'CallVendorRequest') throw new Error('not available')
        return {}
      }),
    }
    const controller = new ObsController(youtubeSecrets(), 50)
    ;(controller as unknown as { obs: typeof fake }).obs = fake
    const profile = structuredClone(starterProfiles[0])
    const config = structuredClone(defaultConfig)
    config.features.twitch = false
    config.features.sourceRecord = true
    config.features.verticalRecording = true
    profile.recording.sourceRecord = true
    profile.recording.verticalRecording = true
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
    let streamFrames = 0
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
        if (request === 'GetStreamStatus') {
          if (streaming) streamFrames += 10
          return { outputActive: streaming, outputTotalFrames: streamFrames, outputSkippedFrames: 0 }
        }
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

  it('treats missing optional Source Record and Aitum outputs as idempotent stops', async () => {
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
        if (request === 'TriggerHotkeyByName') throw new Error('No hotkeys were found by that name.')
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
    expect(calls).toContainEqual({
      request: 'TriggerHotkeyByName',
      data: { hotkeyName: 'VerticalCanvasDockStopBacktrack' },
    })
  })

  it('falls back to the Aitum start hotkey when its websocket vendor is unavailable', async () => {
    const calls: Array<{ request: string; data: unknown }> = []
    let streaming = false
    let streamFrames = 0
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string, data?: unknown) => {
        calls.push({ request, data })
        if (request === 'GetSourceActive') return { videoActive: true }
        if (request === 'GetRecordStatus' || request === 'GetReplayBufferStatus') return { outputActive: false }
        if (request === 'GetStreamStatus') {
          if (streaming) streamFrames += 10
          return { outputActive: streaming, outputTotalFrames: streamFrames, outputSkippedFrames: 0 }
        }
        if (request === 'GetStreamServiceSettings') return { streamServiceType: 'rtmp_common', streamServiceSettings: { service: 'YouTube - RTMPS', server: 'auto' } }
        if (request === 'StartStream') { streaming = true; return {} }
        if (request === 'CallVendorRequest') {
          const vendor = data as { vendorName?: string; requestType?: string }
          if (vendor.vendorName === 'obs-stream-manager-output-v2' && vendor.requestType === 'configure_stream') {
            return { responseData: { success: true } }
          }
          throw new Error('No vendor was found by that name.')
        }
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
    config.features.verticalRecording = true
    profile.recording.verticalRecording = true

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
        if (request === 'CallVendorRequest') return { responseData: { success: true, outputActive: false, backtrack: false } }
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

  it('rolls back a primary stream that reports active while frames advance far below 60 FPS', async () => {
    const calls: Array<{ request: string; data: unknown }> = []
    let streaming = false
    let streamStatusChecks = 0
    let service = { streamServiceType: 'rtmp_common', streamServiceSettings: { service: 'YouTube - RTMPS', server: 'auto' } }
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string, data?: unknown) => {
        calls.push({ request, data })
        if (request === 'GetSourceActive') return { videoActive: true }
        if (request === 'GetCurrentProgramScene') return { currentProgramSceneName: '10_GAME_PC' }
        if (request === 'GetInputList') return { inputs: [] }
        if (request === 'GetProfileParameter') return { parameterValue: 'Advanced' }
        if (request === 'GetVideoSettings') return { baseWidth: 1920, baseHeight: 1080, outputWidth: 1920, outputHeight: 1080, fpsNumerator: 60, fpsDenominator: 1 }
        if (request === 'GetStreamStatus') {
          if (streaming) streamStatusChecks += 1
          return { outputActive: streaming, outputTotalFrames: streaming ? Math.floor(streamStatusChecks / 4) : 0 }
        }
        if (request === 'GetRecordStatus' || request === 'GetReplayBufferStatus') return { outputActive: false }
        if (request === 'GetStreamServiceSettings') return service
        if (request === 'SetStreamServiceSettings') { service = structuredClone(data) as typeof service; return {} }
        if (request === 'StartStream') { streaming = true; return {} }
        if (request === 'StopStream') { streaming = false; return {} }
        if (request === 'CallVendorRequest') return { responseData: { success: true, pluginVersion: '0.2.16', apiVersion: 4, outputActive: false } }
        return {}
      }),
    }
    const controller = new ObsController(youtubeSecrets(), 200)
    ;(controller as unknown as { obs: typeof fake }).obs = fake
    const config = structuredClone(defaultConfig)
    const profile = structuredClone(starterProfiles[0])
    config.features.twitch = false
    config.features.recording = false
    config.features.replayBuffer = false
    config.features.sourceRecord = false
    config.features.verticalRecording = false
    config.obs.startDelaySeconds = 0

    await expect(controller.start(config, profile, profile.capture.localSourceName)).rejects.toThrow('安定した60 FPSで進んでいません')

    expect(calls.map(({ request }) => request)).toEqual(expect.arrayContaining(['StartStream', 'StopStream']))
    expect(streaming).toBe(false)
  })

  it('does not count skipped primary-output frames as delivered video progress', async () => {
    let totalFrames = 0
    let skippedFrames = 0
    const controller = new ObsController(memorySecrets(), 50)

    const stable = await (controller as unknown as {
      waitForOutputFrameProgress(
        readStatus: () => Promise<{ outputActive: boolean; outputTotalFrames: number; outputSkippedFrames: number }>,
      ): Promise<boolean>
    }).waitForOutputFrameProgress(async () => {
      totalFrames += 60
      skippedFrames += 60
      return { outputActive: true, outputTotalFrames: totalFrames, outputSkippedFrames: skippedFrames }
    })

    expect(stable).toBe(false)
  })

  it('tears down Twitch when its output stays active but its encoded frames stall', async () => {
    const calls: Array<{ request: string; data: unknown }> = []
    let streaming = false
    let streamFrames = 0
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
        if (request === 'GetInputList') return { inputs: [] }
        if (request === 'GetProfileParameter') return { parameterValue: 'Advanced' }
        if (request === 'GetVideoSettings') return { baseWidth: 1920, baseHeight: 1080, outputWidth: 1920, outputHeight: 1080, fpsNumerator: 60, fpsDenominator: 1 }
        if (request === 'GetStreamStatus') {
          if (streaming) streamFrames += 10
          return { outputActive: streaming, outputTotalFrames: streamFrames, outputSkippedFrames: 0 }
        }
        if (request === 'GetRecordStatus' || request === 'GetReplayBufferStatus') return { outputActive: false }
        if (request === 'GetStreamServiceSettings') return service
        if (request === 'SetStreamServiceSettings') { service = structuredClone(data) as typeof service; return {} }
        if (request === 'StartStream') { streaming = true; return {} }
        if (request === 'StopStream') { streaming = false; return {} }
        if (request === 'CallVendorRequest') {
          const vendor = data as { vendorName?: string; requestType?: string }
          if (vendor.vendorName === 'obs-stream-manager-output-v2') {
            if (vendor.requestType === 'start_twitch') twitchActive = true
            if (vendor.requestType === 'stop_twitch') twitchActive = false
            return { responseData: { success: true, pluginVersion: '0.2.16', apiVersion: 4, outputActive: twitchActive, totalFrames: twitchActive ? 10 : 0, dedicatedEncoder: twitchActive, dedicatedVideoEncoder: twitchActive, sharedPrimaryAudioEncoder: twitchActive, audioMixerIndex: 5, videoWidth: 1920, videoHeight: 1080, fpsNumerator: 60, fpsDenominator: 1 } }
          }
          return { responseData: { success: true, backtrack: false } }
        }
        return {}
      }),
    }
    const controller = new ObsController(memorySecrets([
      ['youtube-stream-key', 'youtube-key'],
      ['youtube-stream-server', 'rtmps://youtube.example/live2'],
      ['twitch-stream-key', 'twitch-key'],
      ['twitch-stream-server', 'rtmp://twitch.example/app'],
    ]), 40)
    ;(controller as unknown as { obs: typeof fake }).obs = fake
    const config = structuredClone(defaultConfig)
    const profile = structuredClone(starterProfiles[0])
    config.features.recording = false
    config.features.replayBuffer = false
    config.features.sourceRecord = false
    config.features.verticalRecording = false
    config.obs.startDelaySeconds = 0

    await expect(controller.start(config, profile, profile.capture.localSourceName)).rejects.toThrow('Twitch副出力の映像が安定した60 FPSで進みませんでした')

    const vendorRequests = calls
      .filter(({ request }) => request === 'CallVendorRequest')
      .map(({ data }) => (data as { requestType?: string }).requestType)
    expect(vendorRequests).toContain('start_twitch')
    expect(vendorRequests).toContain('stop_twitch')
    expect(calls.map(({ request }) => request)).toContain('StopStream')
    expect(twitchActive).toBe(false)
    expect(streaming).toBe(false)
  })

  it('rolls back recording and streaming when adding the recorder stalls the primary output', async () => {
    const calls: string[] = []
    let streaming = false
    let recording = false
    let streamFrames = 0
    let recordDurationMs = 0
    let recordBytes = 0
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string) => {
        calls.push(request)
        if (request === 'GetSourceActive') return { videoActive: true }
        if (request === 'GetCurrentProgramScene') return { currentProgramSceneName: '10_GAME_PC' }
        if (request === 'GetInputList') return { inputs: [] }
        if (request === 'GetProfileParameter') return { parameterValue: 'Advanced' }
        if (request === 'GetVideoSettings') return { baseWidth: 1920, baseHeight: 1080, outputWidth: 1920, outputHeight: 1080, fpsNumerator: 60, fpsDenominator: 1 }
        if (request === 'GetStreamStatus') {
          if (streaming && !recording) streamFrames += 10
          return { outputActive: streaming, outputTotalFrames: streamFrames }
        }
        if (request === 'GetRecordStatus') {
          if (recording) { recordDurationMs += 20; recordBytes += 20_000 }
          // Match the real obs-websocket shape: recording status has no frame counter.
          return { outputActive: recording, outputDuration: recordDurationMs, outputBytes: recordBytes }
        }
        if (request === 'GetReplayBufferStatus') return { outputActive: false }
        if (request === 'GetStreamServiceSettings') return { streamServiceType: 'rtmp_common', streamServiceSettings: { service: 'YouTube - RTMPS', server: 'auto' } }
        if (request === 'StartStream') { streaming = true; return {} }
        if (request === 'StartRecord') { recording = true; return {} }
        if (request === 'StopRecord') { recording = false; return {} }
        if (request === 'StopStream') { streaming = false; return {} }
        if (request === 'CallVendorRequest') return { responseData: { success: true, pluginVersion: '0.2.16', apiVersion: 4, outputActive: false } }
        return {}
      }),
    }
    const controller = new ObsController(youtubeSecrets(), 50)
    ;(controller as unknown as { obs: typeof fake }).obs = fake
    const config = structuredClone(defaultConfig)
    const profile = structuredClone(starterProfiles[0])
    config.features.twitch = false
    config.features.replayBuffer = false
    config.features.sourceRecord = false
    config.features.verticalRecording = false
    config.obs.startDelaySeconds = 0

    await expect(controller.start(config, profile, profile.capture.localSourceName)).rejects.toThrow('録画・リプレイ開始後にOBS配信映像が安定した60 FPSで進まなくなりました')

    expect(calls).toEqual(expect.arrayContaining(['StartStream', 'StartRecord', 'StopRecord', 'StopStream']))
    expect(recording).toBe(false)
    expect(streaming).toBe(false)
  })

  it('rolls back every owned output when recording stalls Twitch after its first healthy check', async () => {
    const calls: Array<{ request: string; data: unknown }> = []
    let streaming = false
    let recording = false
    let twitchActive = false
    let streamFrames = 0
    let recordDurationMs = 0
    let recordBytes = 0
    let twitchFrames = 0
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string, data?: unknown) => {
        calls.push({ request, data })
        if (request === 'GetSourceActive') return { videoActive: true }
        if (request === 'GetCurrentProgramScene') return { currentProgramSceneName: '10_GAME_PC' }
        if (request === 'GetInputList') return { inputs: [] }
        if (request === 'GetProfileParameter') return { parameterValue: 'Advanced' }
        if (request === 'GetVideoSettings') return { baseWidth: 1920, baseHeight: 1080, outputWidth: 1920, outputHeight: 1080, fpsNumerator: 60, fpsDenominator: 1 }
        if (request === 'GetStreamStatus') {
          if (streaming) streamFrames += 10
          return { outputActive: streaming, outputTotalFrames: streamFrames }
        }
        if (request === 'GetRecordStatus') {
          if (recording) { recordDurationMs += 20; recordBytes += 20_000 }
          // Match the real obs-websocket shape: recording status has no frame counter.
          return { outputActive: recording, outputDuration: recordDurationMs, outputBytes: recordBytes }
        }
        if (request === 'GetReplayBufferStatus') return { outputActive: false }
        if (request === 'GetStreamServiceSettings') return { streamServiceType: 'rtmp_common', streamServiceSettings: { service: 'YouTube - RTMPS', server: 'auto' } }
        if (request === 'StartStream') { streaming = true; return {} }
        if (request === 'StartRecord') { recording = true; return {} }
        if (request === 'StopRecord') { recording = false; return {} }
        if (request === 'StopStream') { streaming = false; return {} }
        if (request === 'CallVendorRequest') {
          const vendor = data as { vendorName?: string; requestType?: string }
          if (vendor.vendorName === 'obs-stream-manager-output-v2') {
            if (vendor.requestType === 'start_twitch') twitchActive = true
            if (vendor.requestType === 'stop_twitch') twitchActive = false
            if (vendor.requestType === 'twitch_status' && twitchActive && !recording) twitchFrames += 10
            return { responseData: { success: true, pluginVersion: '0.2.16', apiVersion: 4, outputActive: twitchActive, totalFrames: twitchFrames, dedicatedEncoder: twitchActive, dedicatedVideoEncoder: twitchActive, sharedPrimaryAudioEncoder: twitchActive, audioMixerIndex: 5, videoWidth: 1920, videoHeight: 1080, fpsNumerator: 60, fpsDenominator: 1 } }
          }
          return { responseData: { success: true, backtrack: false } }
        }
        return {}
      }),
    }
    const controller = new ObsController(memorySecrets([
      ['youtube-stream-key', 'youtube-key'],
      ['youtube-stream-server', 'rtmps://youtube.example/live2'],
      ['twitch-stream-key', 'twitch-key'],
      ['twitch-stream-server', 'rtmp://twitch.example/app'],
    ]), 50)
    ;(controller as unknown as { obs: typeof fake }).obs = fake
    const config = structuredClone(defaultConfig)
    const profile = structuredClone(starterProfiles[0])
    config.features.replayBuffer = false
    config.features.sourceRecord = false
    config.features.verticalRecording = false
    config.obs.startDelaySeconds = 0

    await expect(controller.start(config, profile, profile.capture.localSourceName)).rejects.toThrow('Twitch副出力の映像が安定した60 FPSで進みませんでした')

    const vendorRequests = calls
      .filter(({ request }) => request === 'CallVendorRequest')
      .map(({ data }) => (data as { requestType?: string }).requestType)
    expect(vendorRequests).toEqual(expect.arrayContaining(['start_twitch', 'stop_twitch']))
    expect(calls.map(({ request }) => request)).toEqual(expect.arrayContaining(['StopRecord', 'StopStream']))
    expect(twitchActive).toBe(false)
    expect(recording).toBe(false)
    expect(streaming).toBe(false)
  })

  it('stops and warns for recording outputs whose start request never becomes active', async () => {
    const calls: string[] = []
    let streaming = false
    let streamFrames = 0
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string) => {
        calls.push(request)
        if (request === 'GetSourceActive') return { videoActive: true }
        if (request === 'GetCurrentProgramScene') return { currentProgramSceneName: '10_GAME_PC' }
        if (request === 'GetInputList') return { inputs: [] }
        if (request === 'GetProfileParameter') return { parameterValue: 'Advanced' }
        if (request === 'GetVideoSettings') return { baseWidth: 1920, baseHeight: 1080, outputWidth: 1920, outputHeight: 1080, fpsNumerator: 60, fpsDenominator: 1 }
        if (request === 'GetStreamStatus') return { outputActive: streaming, outputTotalFrames: streaming ? ++streamFrames : 0 }
        if (request === 'GetRecordStatus' || request === 'GetReplayBufferStatus') return { outputActive: false }
        if (request === 'GetStreamServiceSettings') return { streamServiceType: 'rtmp_common', streamServiceSettings: { service: 'YouTube - RTMPS', server: 'auto' } }
        if (request === 'StartStream') { streaming = true; return {} }
        if (request === 'CallVendorRequest') return { responseData: { success: true, pluginVersion: '0.2.16', apiVersion: 4, outputActive: false } }
        return {}
      }),
    }
    const controller = new ObsController(youtubeSecrets(), 40)
    ;(controller as unknown as { obs: typeof fake }).obs = fake
    const config = structuredClone(defaultConfig)
    const profile = structuredClone(starterProfiles[0])
    config.features.twitch = false
    config.features.sourceRecord = false
    config.features.verticalRecording = false
    config.obs.startDelaySeconds = 0

    const warnings = await controller.start(config, profile, profile.capture.localSourceName)

    expect(calls).toEqual(expect.arrayContaining(['StartRecord', 'StopRecord', 'StartReplayBuffer', 'StopReplayBuffer']))
    expect(warnings.join(' ')).toContain('OBSが録画開始を確認できませんでした')
    expect(warnings.join(' ')).toContain('OBSがリプレイバッファ開始を確認できませんでした')
  })

  it('rejects an idle stream start before switching scenes when recording is already active', async () => {
    const calls: string[] = []
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string) => {
        calls.push(request)
        if (request === 'GetSourceActive') return { videoActive: true }
        if (request === 'GetStreamStatus' || request === 'GetReplayBufferStatus') return { outputActive: false }
        if (request === 'GetRecordStatus') return { outputActive: true }
        return {}
      }),
    }
    const controller = new ObsController(memorySecrets())
    ;(controller as unknown as { obs: typeof fake }).obs = fake
    const profile = structuredClone(starterProfiles[0])

    await expect(controller.start(structuredClone(defaultConfig), profile, profile.capture.localSourceName)).rejects.toThrow('録画またはリプレイバッファがすでに動作中')
    expect(calls).not.toContain('SetCurrentProgramScene')
    expect(calls).not.toContain('StartStream')
  })

  it('continues stopping every output when the ending scene cannot be selected', async () => {
    const calls: string[] = []
    let streaming = true
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string) => {
        calls.push(request)
        if (request === 'SetCurrentProgramScene') throw new Error('ending scene missing')
        if (request === 'GetStreamStatus') return { outputActive: streaming }
        if (request === 'GetRecordStatus' || request === 'GetReplayBufferStatus') return { outputActive: false }
        if (request === 'StopStream') { streaming = false; return {} }
        if (request === 'CallVendorRequest') return { responseData: { success: true } }
        return {}
      }),
    }
    const controller = new ObsController(memorySecrets(), 40, 40)
    ;(controller as unknown as { obs: typeof fake }).obs = fake
    const config = structuredClone(defaultConfig)
    config.obs.endDelaySeconds = 0

    const warnings = await controller.stop(config, structuredClone(starterProfiles[0]))

    expect(calls).toContain('StopStream')
    expect(streaming).toBe(false)
    expect(warnings.join(' ')).toContain('終了シーンへ切り替えできませんでした: ending scene missing')
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

    expect(toggles.map(({ filterEnabled }) => filterEnabled)).toEqual([false])
  })

  it('reapplies calibrated per-source levels and does not force-unmute the microphone during background recovery', async () => {
    const volumes: Array<{ inputName: string; inputVolumeDb: number }> = []
    const mutes: Array<{ inputName: string; inputMuted: boolean }> = []
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string, data?: unknown) => {
        if (request === 'GetSourceActive') return { videoActive: true }
        if (request === 'GetSourceFilterList') return { filters: [{ filterKind: 'compressor_filter', filterName: 'Game Ducking' }] }
        if (request === 'GetRecordStatus') return { outputActive: false }
        if (request === 'SetInputVolume') volumes.push(data as { inputName: string; inputVolumeDb: number })
        if (request === 'SetInputMute') mutes.push(data as { inputName: string; inputMuted: boolean })
        return {}
      }),
    }
    const controller = new ObsController(memorySecrets())
    ;(controller as unknown as { obs: typeof fake }).obs = fake
    const profile = structuredClone(starterProfiles[0])
    profile.audio = { microphoneDb: 1, microphoneBoostDb: 0, gameDb: -11, discordDb: -19, bgmDb: -27, duckingDb: -6 }

    const applied = await controller.applyProfile(structuredClone(defaultConfig), profile, 'local')

    expect(volumes).toEqual(expect.arrayContaining([
      { inputName: 'MIC', inputVolumeDb: 0 },
      { inputName: 'GAME_PC', inputVolumeDb: -11 },
      { inputName: 'DISCORD', inputVolumeDb: -19 },
      { inputName: 'BGM', inputVolumeDb: -27 },
    ]))
    expect(mutes).toEqual([
      { inputName: 'MIC', inputMuted: false },
      { inputName: 'GAME_PC', inputMuted: false },
      { inputName: 'GAME_GFN', inputMuted: true },
      { inputName: 'GAME_SWITCH', inputMuted: true },
    ])
    expect(applied.audioApplied).toBe(true)
    expect(applied.warnings).toContain('マイクの正のフェーダー値をリミッター前の管理ゲインへ安全に移しました')

    mutes.length = 0
    await controller.ensureProfileAudio(structuredClone(defaultConfig), profile, 'local')
    expect(mutes).toEqual(expect.arrayContaining([
      { inputName: 'GAME_PC', inputMuted: false },
      { inputName: 'GAME_GFN', inputMuted: true },
      { inputName: 'GAME_SWITCH', inputMuted: true },
    ]))
    expect(mutes.some(({ inputName }) => inputName === 'MIC')).toBe(false)

    mutes.length = 0
    await controller.applyProfile(structuredClone(defaultConfig), profile, 'local', undefined, [], true)
    expect(mutes.some(({ inputName }) => inputName === 'MIC')).toBe(false)
  })

  it('disables and unrouts capture sources owned by other game profiles', async () => {
    const sceneToggles: Array<{ sourceName: string; enabled: boolean }> = []
    const trackRoutes: Array<{ inputName: string; inputAudioTracks: Record<string, boolean> }> = []
    const mutes: Array<{ inputName: string; inputMuted: boolean }> = []
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string, data?: unknown) => {
        const payload = data as Record<string, unknown> | undefined
        if (request === 'GetSourceActive') return { videoActive: true }
        if (request === 'GetSceneItemId') {
          sceneToggles.push({ sourceName: String(payload?.sourceName), enabled: false })
          return { sceneItemId: sceneToggles.length }
        }
        if (request === 'SetSceneItemEnabled') {
          const latest = sceneToggles.at(-1)
          if (latest) latest.enabled = Boolean(payload?.sceneItemEnabled)
          return {}
        }
        if (request === 'GetInputList') return {
          inputs: [
            { inputName: 'PC Game Capture', inputKind: 'game_capture' },
            { inputName: 'Previous Game Capture', inputKind: 'game_capture' },
            { inputName: 'MIC', inputKind: 'wasapi_input_capture' },
          ],
        }
        if (request === 'GetInputSettings') return { inputKind: 'game_capture', inputSettings: {} }
        if (request === 'GetInputAudioTracks') return { inputAudioTracks: {} }
        if (request === 'GetProfileParameter') return { parameterValue: 'Advanced' }
        if (request === 'GetSourceFilterList') return { filters: [{ filterKind: 'compressor_filter', filterName: 'Game Ducking' }] }
        if (request === 'GetStreamStatus' || request === 'GetRecordStatus' || request === 'GetReplayBufferStatus') return { outputActive: false }
        if (request === 'CallVendorRequest') return { responseData: { success: true } }
        if (request === 'SetInputAudioTracks') trackRoutes.push(payload as typeof trackRoutes[number])
        if (request === 'SetInputMute') mutes.push(payload as typeof mutes[number])
        return {}
      }),
    }
    const controller = new ObsController(memorySecrets())
    ;(controller as unknown as { obs: typeof fake }).obs = fake

    await controller.applyProfile(
      structuredClone(defaultConfig),
      structuredClone(starterProfiles[0]),
      'local',
      undefined,
      ['Previous Game Capture'],
    )

    expect(sceneToggles).toContainEqual({ sourceName: 'Previous Game Capture', enabled: false })
    expect(mutes).toContainEqual({ inputName: 'Previous Game Capture', inputMuted: true })
    expect(trackRoutes).toContainEqual({
      inputName: 'Previous Game Capture',
      inputAudioTracks: { '1': false, '2': false, '3': false, '4': false, '5': false, '6': false },
    })
  })

  it('reports that automatic microphone protection was not applied so reconnect recovery can retry it', async () => {
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string) => {
        if (request === 'GetSourceActive') return { videoActive: true }
        if (request === 'GetSourceFilterList') return { filters: [] }
        if (request === 'GetStreamStatus' || request === 'GetRecordStatus' || request === 'GetReplayBufferStatus') return { outputActive: false }
        if (request === 'CreateSourceFilter') throw new Error('filter create failed')
        return {}
      }),
    }
    const controller = new ObsController(memorySecrets())
    ;(controller as unknown as { obs: typeof fake }).obs = fake

    const result = await controller.applyProfile(structuredClone(defaultConfig), structuredClone(starterProfiles[0]), 'local')

    expect(result.audioApplied).toBe(false)
    expect(result.warnings.join(' ')).toContain('マイクの自動音量保護を適用できませんでした')
  })

  it('warns when no compatible OBS profile parameter can be updated', async () => {
    const fake = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      call: vi.fn(async (request: string, data?: unknown) => {
        if (request === 'GetSourceActive') return { videoActive: true }
        if (request === 'CallVendorRequest') return { responseData: { success: true, changed: false, previousEnabled: true, enabled: true } }
        if (request === 'GetSourceFilterList') return (data as { sourceName?: string })?.sourceName === 'MIC'
          ? { filters: [] }
          : { filters: [{ filterKind: 'compressor_filter', filterName: 'Game Ducking', filterEnabled: true, filterSettings: { sidechain_source: 'MIC' } }] }
        if (request === 'GetRecordStatus') return { outputActive: false }
        if (request === 'SetProfileParameter') throw new Error('unsupported parameter')
        return {}
      }),
    }
    const controller = new ObsController(memorySecrets())
    ;(controller as unknown as { obs: typeof fake }).obs = fake
    const profile = structuredClone(starterProfiles[0])
    profile.recording.directory = 'D:\\Recordings'

    const { warnings } = await controller.applyProfile(structuredClone(defaultConfig), profile, 'local')

    expect(warnings).toHaveLength(3)
    expect(warnings.join(' ')).toContain('FHD配信プロファイル')
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
        if (request === 'CallVendorRequest') return { responseData: { success: true, pluginVersion: '0.2.1', apiVersion: 4, outputActive: false } }
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
        if (request === 'CallVendorRequest') return { responseData: { success: true, pluginVersion: '0.2.1', apiVersion: 4, outputActive: false } }
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
