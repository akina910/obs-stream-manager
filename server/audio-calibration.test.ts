import type OBSWebSocket from 'obs-websocket-js'
import { describe, expect, it, vi } from 'vitest'
import { defaultConfig, starterProfiles } from './defaults.js'
import { AudioCalibrationService } from './audio-calibration.js'

type Listener = (event: { inputs: unknown[] }) => void
type Filter = { filterName: string; filterKind: string; filterEnabled: boolean; filterSettings: Record<string, unknown>; filterIndex?: number }

class FakeAudioObs {
  readonly calls: Array<{ request: string; data?: Record<string, unknown> }> = []
  readonly listeners = new Set<Listener>()
  readonly volumes = new Map([
    ['MIC', -3],
    ['GAME_PC', -15],
    ['GAME_GFN', -100],
    ['GAME_SWITCH', -100],
    ['DISCORD', -18],
    ['BGM', -25],
  ])
  readonly muted = new Map([
    ['MIC', false],
    ['GAME_PC', false],
    ['GAME_GFN', true],
    ['GAME_SWITCH', true],
    ['DISCORD', true],
    ['BGM', true],
  ])
  readonly filters = new Map<string, Filter[]>([
    ['MIC', []],
    ['GAME_PC', [{ filterName: 'MIC Ducking', filterKind: 'compressor_filter', filterEnabled: true, filterSettings: { attack_time: 10, release_time: 250, ratio: 10, threshold: -20, sidechain_source: 'MIC' } }]],
  ])
  outputActive = false

  connect = vi.fn(async () => ({ obsWebSocketVersion: '5.7.3', negotiatedRpcVersion: 1 }))
  disconnect = vi.fn(async () => undefined)

  on(event: string, listener: Listener) {
    if (event === 'InputVolumeMeters') this.listeners.add(listener)
    return this
  }

  off(event: string, listener: Listener) {
    if (event === 'InputVolumeMeters') this.listeners.delete(listener)
    return this
  }

  emit(levels: Record<string, { magnitudeDb: number; peakDb: number }>, count: number) {
    const inputs = Object.entries(levels).map(([inputName, level]) => ({
      inputName,
      inputLevelsDb: [[level.magnitudeDb, level.peakDb, level.peakDb]],
    }))
    this.emitInputs(inputs, count)
  }

  emitInputs(inputs: unknown[], count: number) {
    for (let index = 0; index < count; index += 1) {
      for (const listener of this.listeners) listener({ inputs })
    }
  }

  async call(request: string, data?: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.calls.push({ request, data })
    if (request === 'GetStreamStatus' || request === 'GetRecordStatus' || request === 'GetReplayBufferStatus') return { outputActive: this.outputActive }
    if (request === 'GetInputList') return { inputs: [...this.volumes.keys()].map((inputName) => ({ inputName })) }
    if (request === 'GetInputVolume') {
      const value = this.volumes.get(String(data?.inputName))
      if (value === undefined) throw new Error('missing input')
      return { inputVolumeDb: value, inputVolumeMul: 1 }
    }
    if (request === 'GetInputMute') {
      const value = this.muted.get(String(data?.inputName))
      if (value === undefined) throw new Error('missing input')
      return { inputMuted: value }
    }
    if (request === 'SetInputVolume') {
      this.volumes.set(String(data?.inputName), Number(data?.inputVolumeDb))
      return {}
    }
    if (request === 'GetSourceFilterList') return { filters: this.filters.get(String(data?.sourceName)) ?? [] }
    if (request === 'CreateSourceFilter') {
      const sourceName = String(data?.sourceName)
      const current = this.filters.get(sourceName) ?? []
      current.push({
        filterName: String(data?.filterName),
        filterKind: String(data?.filterKind),
        filterEnabled: true,
        filterSettings: data?.filterSettings as Record<string, unknown>,
      })
      this.filters.set(sourceName, current)
      return {}
    }
    if (request === 'RemoveSourceFilter') {
      const sourceName = String(data?.sourceName)
      this.filters.set(sourceName, (this.filters.get(sourceName) ?? []).filter(({ filterName }) => filterName !== data?.filterName))
      return {}
    }
    if (request === 'SetSourceFilterSettings') {
      const filter = (this.filters.get(String(data?.sourceName)) ?? []).find(({ filterName }) => filterName === data?.filterName)
      if (!filter) throw new Error('missing filter')
      filter.filterSettings = data?.filterSettings as Record<string, unknown>
      return {}
    }
    if (request === 'SetSourceFilterEnabled') {
      const filter = (this.filters.get(String(data?.sourceName)) ?? []).find(({ filterName }) => filterName === data?.filterName)
      if (!filter) throw new Error('missing filter')
      filter.filterEnabled = data?.filterEnabled === true
      return {}
    }
    throw new Error(`Unexpected request: ${request}`)
  }
}

describe('AudioCalibrationService', () => {
  it('applies the managed microphone safety chain without requiring a calibration run', async () => {
    const fake = new FakeAudioObs()
    fake.filters.set('MIC', [{
      filterName: 'OBS Stream Manager - Compressor',
      filterKind: 'compressor_filter',
      filterEnabled: true,
      filterSettings: { attack_time: 6, output_gain: 0, ratio: 3, release_time: 60, sidechain_source: 'none', threshold: -18 },
    }])
    const service = new AudioCalibrationService()

    const result = await service.applyManagedMicrophoneFilters(fake as unknown as OBSWebSocket, 'MIC')

    expect(result.filters).toHaveLength(4)
    expect(fake.filters.get('MIC')?.find(({ filterName }) => filterName.endsWith('Compressor'))?.filterSettings).toMatchObject({ output_gain: 6 })
    expect(fake.filters.get('MIC')?.find(({ filterName }) => filterName.endsWith('Expander'))?.filterSettings).toMatchObject({ ratio: 1.5, threshold: -50 })
    expect(fake.calls.filter(({ request }) => request === 'GetStreamStatus').length).toBeGreaterThan(1)
  })

  it('measures, applies, verifies, and installs the managed safety filters', async () => {
    const fake = new FakeAudioObs()
    let phase = 0
    const service = new AudioCalibrationService(
      () => fake as unknown as OBSWebSocket,
      async () => {
        if (phase === 0) fake.emit({ MIC: { magnitudeDb: -24, peakDb: -10 }, GAME_PC: { magnitudeDb: -30, peakDb: -14 } }, 20)
        else fake.emit({ MIC: { magnitudeDb: -18, peakDb: -6 }, GAME_PC: { magnitudeDb: -24, peakDb: -10 } }, 12)
        phase += 1
      },
    )
    const profile = structuredClone(starterProfiles[0])

    const result = await service.calibrate(structuredClone(defaultConfig), undefined, profile, 'local')

    expect(result.profile.audio.microphoneDb).toBe(1)
    expect(result.profile.audio.gameDb).toBe(-11)
    expect(result.readings.find(({ role }) => role === 'microphone')).toMatchObject({ status: 'adjusted', verifiedDb: -18, verifiedPeakDb: -6 })
    expect(result.readings.find(({ role }) => role === 'game')).toMatchObject({ status: 'adjusted', verifiedDb: -24, verifiedPeakDb: -10 })
    expect(fake.filters.get('MIC')?.map(({ filterKind }) => filterKind)).toEqual([
      'noise_suppress_filter_v2',
      'expander_filter',
      'compressor_filter',
      'limiter_filter',
    ])
    expect(fake.filters.get('GAME_PC')).toHaveLength(2)
    expect(fake.filters.get('GAME_PC')?.find(({ filterName }) => filterName === 'MIC Ducking')?.filterSettings).toMatchObject({
      release_time: 400,
      sidechain_source: 'MIC',
      threshold: -24,
    })
    expect(fake.disconnect).toHaveBeenCalledOnce()
  })

  it('calibrates the managed BGM Stock source when both legacy and stock BGM inputs exist', async () => {
    const fake = new FakeAudioObs()
    fake.volumes.set('BGM Stock', -25)
    fake.muted.set('BGM Stock', false)
    let phase = 0
    const service = new AudioCalibrationService(
      () => fake as unknown as OBSWebSocket,
      async () => {
        fake.emit({
          MIC: { magnitudeDb: -18, peakDb: -6 },
          GAME_PC: { magnitudeDb: -24, peakDb: -10 },
          'BGM Stock': phase === 0 ? { magnitudeDb: -36, peakDb: -18 } : { magnitudeDb: -30, peakDb: -14 },
        }, 20)
        phase += 1
      },
    )

    const result = await service.calibrate(structuredClone(defaultConfig), undefined, structuredClone(starterProfiles[0]), 'local')

    expect(result.readings.find(({ role }) => role === 'bgm')).toMatchObject({ sourceName: 'BGM Stock', status: 'adjusted', appliedDb: -21, verifiedDb: -30 })
    expect(result.profile.audio.bgmDb).toBe(-21)
    expect(fake.calls).toContainEqual({ request: 'SetInputVolume', data: { inputName: 'BGM Stock', inputVolumeDb: -21 } })
    expect(fake.calls).not.toContainEqual({ request: 'SetInputVolume', data: { inputName: 'BGM', inputVolumeDb: expect.any(Number) } })
  })

  it('does not change OBS when a required source has no signal', async () => {
    const fake = new FakeAudioObs()
    const service = new AudioCalibrationService(
      () => fake as unknown as OBSWebSocket,
      async () => fake.emit({ MIC: { magnitudeDb: -20, peakDb: -8 } }, 20),
    )

    await expect(service.calibrate(structuredClone(defaultConfig), undefined, structuredClone(starterProfiles[0]), 'local'))
      .rejects.toThrow('ゲーム音「GAME_PC」')
    expect(fake.calls.some(({ request }) => request === 'SetInputVolume')).toBe(false)
    expect(fake.calls.some(({ request }) => request === 'CreateSourceFilter')).toBe(false)
  })

  it('rolls back filters when OBS rejects a required managed filter', async () => {
    const fake = new FakeAudioObs()
    const originalCall = fake.call.bind(fake)
    fake.call = vi.fn(async (request: string, data?: Record<string, unknown>) => {
      if (request === 'CreateSourceFilter' && data?.filterKind === 'compressor_filter' && data?.sourceName === 'MIC') {
        throw new Error('filter unavailable')
      }
      return originalCall(request, data)
    })
    const service = new AudioCalibrationService(
      () => fake as unknown as OBSWebSocket,
      async () => fake.emit({ MIC: { magnitudeDb: -24, peakDb: -10 }, GAME_PC: { magnitudeDb: -30, peakDb: -14 } }, 20),
    )

    await expect(service.calibrate(structuredClone(defaultConfig), undefined, structuredClone(starterProfiles[0]), 'local'))
      .rejects.toThrow('filter unavailable')
    expect(fake.filters.get('MIC')).toEqual([])
    expect(fake.volumes.get('MIC')).toBe(-3)
    expect(fake.volumes.get('GAME_PC')).toBe(-15)
  })

  it('rejects a second calibration while the first one is still measuring', async () => {
    const fake = new FakeAudioObs()
    let phase = 0
    let releaseBaseline: (() => void) | undefined
    const service = new AudioCalibrationService(
      () => fake as unknown as OBSWebSocket,
      () => {
        if (phase > 0) {
          fake.emit({ MIC: { magnitudeDb: -18, peakDb: -6 }, GAME_PC: { magnitudeDb: -24, peakDb: -10 } }, 20)
          phase += 1
          return Promise.resolve()
        }
        return new Promise<void>((resolve) => {
          releaseBaseline = () => {
            fake.emit({ MIC: { magnitudeDb: -24, peakDb: -10 }, GAME_PC: { magnitudeDb: -30, peakDb: -14 } }, 20)
            phase = 1
            resolve()
          }
        })
      },
    )
    const profile = structuredClone(starterProfiles[0])
    const first = service.calibrate(structuredClone(defaultConfig), undefined, profile, 'local')

    await vi.waitFor(() => expect(releaseBaseline).toBeTypeOf('function'))
    await expect(service.calibrate(structuredClone(defaultConfig), undefined, profile, 'local'))
      .rejects.toThrow('すでに実行中')
    releaseBaseline?.()
    await expect(first).resolves.toBeDefined()
  })

  it('rolls back and aborts if an OBS output starts during measurement', async () => {
    const fake = new FakeAudioObs()
    const service = new AudioCalibrationService(
      () => fake as unknown as OBSWebSocket,
      async () => {
        fake.emit({ MIC: { magnitudeDb: -24, peakDb: -10 }, GAME_PC: { magnitudeDb: -30, peakDb: -14 } }, 20)
        fake.outputActive = true
      },
    )

    await expect(service.calibrate(structuredClone(defaultConfig), undefined, structuredClone(starterProfiles[0]), 'local'))
      .rejects.toThrow('配信・録画・リプレイ中')
    expect(fake.calls.some(({ request }) => request === 'SetInputVolume')).toBe(false)
    expect(fake.calls.some(({ request }) => request === 'CreateSourceFilter')).toBe(false)
  })

  it('propagates transient OBS input errors instead of reporting the source as missing', async () => {
    const fake = new FakeAudioObs()
    const originalCall = fake.call.bind(fake)
    fake.call = vi.fn(async (request: string, data?: Record<string, unknown>) => {
      if (request === 'GetInputVolume' && data?.inputName === 'MIC') throw new Error('temporary websocket timeout')
      return originalCall(request, data)
    })
    const service = new AudioCalibrationService(() => fake as unknown as OBSWebSocket, async () => undefined)

    await expect(service.calibrate(structuredClone(defaultConfig), undefined, structuredClone(starterProfiles[0]), 'local'))
      .rejects.toThrow('temporary websocket timeout')
    expect(fake.calls.some(({ request }) => request === 'SetInputVolume')).toBe(false)
  })

  it('restores filter settings when enabling the updated filter fails', async () => {
    const fake = new FakeAudioObs()
    fake.filters.set('MIC', [{
      filterName: 'OBS Stream Manager - Noise Suppression',
      filterKind: 'noise_suppress_filter_v2',
      filterEnabled: false,
      filterSettings: { method: 'speex', suppress_level: -20 },
    }])
    const originalCall = fake.call.bind(fake)
    let rejectedEnable = false
    fake.call = vi.fn(async (request: string, data?: Record<string, unknown>) => {
      if (request === 'SetSourceFilterEnabled' && data?.sourceName === 'MIC' && !rejectedEnable) {
        rejectedEnable = true
        throw new Error('enable failed')
      }
      return originalCall(request, data)
    })
    const service = new AudioCalibrationService(
      () => fake as unknown as OBSWebSocket,
      async () => fake.emit({ MIC: { magnitudeDb: -24, peakDb: -10 }, GAME_PC: { magnitudeDb: -30, peakDb: -14 } }, 20),
    )

    await expect(service.calibrate(structuredClone(defaultConfig), undefined, structuredClone(starterProfiles[0]), 'local'))
      .rejects.toThrow('enable failed')
    expect(fake.filters.get('MIC')?.[0]).toMatchObject({
      filterEnabled: false,
      filterSettings: { method: 'speex', suppress_level: -20 },
    })
  })

  it('surfaces rollback failures together with the primary OBS error', async () => {
    const fake = new FakeAudioObs()
    const originalCall = fake.call.bind(fake)
    fake.call = vi.fn(async (request: string, data?: Record<string, unknown>) => {
      if (request === 'CreateSourceFilter' && data?.filterKind === 'compressor_filter' && data?.sourceName === 'MIC') throw new Error('filter unavailable')
      if (request === 'RemoveSourceFilter') throw new Error('remove failed')
      return originalCall(request, data)
    })
    const service = new AudioCalibrationService(
      () => fake as unknown as OBSWebSocket,
      async () => fake.emit({ MIC: { magnitudeDb: -24, peakDb: -10 }, GAME_PC: { magnitudeDb: -30, peakDb: -14 } }, 20),
    )

    await expect(service.calibrate(structuredClone(defaultConfig), undefined, structuredClone(starterProfiles[0]), 'local'))
      .rejects.toThrow('OBS状態のロールバックにも失敗しました')
  })

  it('does not compact invalid meter positions into a fake magnitude reading', async () => {
    const fake = new FakeAudioObs()
    const service = new AudioCalibrationService(
      () => fake as unknown as OBSWebSocket,
      async () => fake.emitInputs([
        { inputName: 'MIC', inputLevelsDb: [[Number.NaN, -10, -8]] },
        { inputName: 'GAME_PC', inputLevelsDb: [[-30, -14, -14]] },
      ], 20),
    )

    await expect(service.calibrate(structuredClone(defaultConfig), undefined, structuredClone(starterProfiles[0]), 'local'))
      .rejects.toThrow('マイク「MIC」')
    expect(fake.calls.some(({ request }) => request === 'SetInputVolume')).toBe(false)
  })

  it('treats an unavailable replay buffer as inactive', async () => {
    const fake = new FakeAudioObs()
    const originalCall = fake.call.bind(fake)
    fake.call = vi.fn(async (request: string, data?: Record<string, unknown>) => {
      if (request === 'GetReplayBufferStatus') throw Object.assign(new Error('replay buffer unavailable'), { code: 604 })
      return originalCall(request, data)
    })
    const service = new AudioCalibrationService(
      () => fake as unknown as OBSWebSocket,
      async () => fake.emit({ MIC: { magnitudeDb: -24, peakDb: -10 }, GAME_PC: { magnitudeDb: -30, peakDb: -14 } }, 20),
    )

    await expect(service.calibrate(structuredClone(defaultConfig), undefined, structuredClone(starterProfiles[0]), 'local'))
      .resolves.toBeDefined()
  })

  it('does not disable an unowned custom ducking filter', async () => {
    const fake = new FakeAudioObs()
    fake.filters.set('GAME_PC', [{
      filterName: 'Custom Voice Sidechain',
      filterKind: 'compressor_filter',
      filterEnabled: true,
      filterSettings: { sidechain_source: 'MIC', threshold: -20 },
    }])
    const profile = structuredClone(starterProfiles[0])
    profile.audio.duckingDb = 0
    const service = new AudioCalibrationService(
      () => fake as unknown as OBSWebSocket,
      async () => fake.emit({ MIC: { magnitudeDb: -24, peakDb: -10 }, GAME_PC: { magnitudeDb: -30, peakDb: -14 } }, 20),
    )

    const result = await service.calibrate(structuredClone(defaultConfig), undefined, profile, 'local')

    expect(fake.filters.get('GAME_PC')?.find(({ filterName }) => filterName === 'Custom Voice Sidechain')?.filterEnabled).toBe(true)
    expect(result.warnings.some((warning) => warning.includes('管理対象外'))).toBe(true)
  })

  it('rolls OBS back when persisting the calibrated profile fails', async () => {
    const fake = new FakeAudioObs()
    const originalGameFilter = structuredClone(fake.filters.get('GAME_PC'))
    const service = new AudioCalibrationService(
      () => fake as unknown as OBSWebSocket,
      async () => fake.emit({ MIC: { magnitudeDb: -24, peakDb: -10 }, GAME_PC: { magnitudeDb: -30, peakDb: -14 } }, 20),
    )

    await expect(service.calibrate(
      structuredClone(defaultConfig),
      undefined,
      structuredClone(starterProfiles[0]),
      'local',
      15_000,
      async () => { throw new Error('profile save failed') },
    )).rejects.toThrow('profile save failed')
    expect(fake.volumes.get('MIC')).toBe(-3)
    expect(fake.volumes.get('GAME_PC')).toBe(-15)
    expect(fake.filters.get('MIC')).toEqual([])
    expect(fake.filters.get('GAME_PC')).toEqual(originalGameFilter)
  })
})
