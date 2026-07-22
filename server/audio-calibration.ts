import OBSWebSocket, { EventSubscription } from 'obs-websocket-js'
import { STOCK_BGM_INPUT_NAME } from '../shared/bgm.js'
import type { AppConfig, CaptureMethod, GameProfile } from '../shared/contracts.js'
import {
  AUDIO_CALIBRATION_ROLES,
  AUDIO_CALIBRATION_TARGETS,
  analyzeAudioSamples,
  audioFieldForRole,
  recommendInputVolume,
  type AudioCalibrationReading,
  type AudioCalibrationResult,
  type AudioCalibrationRole,
  type AudioManagedFilterResult,
  type AudioMeasurement,
  type AudioMeterSample,
} from '../shared/audio-calibration.js'

export type AudioObsClient = Pick<OBSWebSocket, 'call' | 'connect' | 'disconnect' | 'on' | 'off'>
type AudioClientFactory = () => AudioObsClient
type Sleep = (milliseconds: number) => Promise<void>

type AudioSource = {
  role: AudioCalibrationRole
  sourceName: string
  required: boolean
}

type SourceState = AudioSource & {
  currentDb?: number
  muted?: boolean
  missing?: boolean
}

type RawFilter = {
  filterName: string
  filterKind: string
  filterEnabled: boolean
  filterSettings: Record<string, string | number | boolean | null>
}

type ManagedFilterSpec = {
  sourceName: string
  filterName: string
  filterKind: string
  filterSettings: Record<string, string | number | boolean>
  compatible: (filter: RawFilter) => boolean
  legacyNames?: string[]
  enabled?: boolean
}

type RollbackAction = {
  label: string
  run: () => Promise<void>
}

const sleep: Sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const asStatusError = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode })

function activeGameSource(config: AppConfig, method: CaptureMethod): string {
  if (method === 'geforce_now') return config.sources.geforceNow
  if (method === 'elgato') return config.sources.switchGame
  return config.sources.pcGame
}

function sourceMap(config: AppConfig, method: CaptureMethod): AudioSource[] {
  return [
    { role: 'microphone', sourceName: config.sources.microphone, required: true },
    { role: 'game', sourceName: activeGameSource(config, method), required: true },
    { role: 'discord', sourceName: config.sources.discord, required: false },
    { role: 'bgm', sourceName: config.sources.bgm, required: false },
  ]
}

function channelArrays(value: unknown): unknown[][] {
  if (!Array.isArray(value)) return []
  return value.filter((channel): channel is unknown[] => Array.isArray(channel))
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function maximum(values: number[]): number {
  return values.reduce((current, value) => Math.max(current, value), -100)
}

function multiplierToDb(value: number): number {
  if (value <= 0) return -100
  return Math.max(-100, 20 * Math.log10(value))
}

function sampleFromMeterEntry(entry: unknown): { sourceName: string; sample: AudioMeterSample } | null {
  if (!entry || typeof entry !== 'object') return null
  const candidate = entry as Record<string, unknown>
  if (typeof candidate.inputName !== 'string') return null
  const dbChannels = channelArrays(candidate.inputLevelsDb)
  const multiplierChannels = channelArrays(candidate.inputLevelsMul)
  const channels = dbChannels.length ? dbChannels : multiplierChannels
  if (!channels.length) return null
  const asDb = dbChannels.length
    ? finiteNumber
    : (value: unknown) => {
        const multiplier = finiteNumber(value)
        return multiplier === undefined ? undefined : multiplierToDb(multiplier)
      }
  const magnitudes = channels.flatMap((channel) => {
    const value = asDb(channel[0])
    return value === undefined ? [] : [value]
  })
  const peaks = channels.flatMap((channel) => [asDb(channel[1]), asDb(channel[2])]).filter((value): value is number => value !== undefined)
  if (!magnitudes.length) return null
  return {
    sourceName: candidate.inputName,
    sample: {
      magnitudeDb: maximum(magnitudes),
      peakDb: maximum(peaks.length ? peaks : magnitudes),
    },
  }
}

function rawFilters(value: unknown): RawFilter[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return []
    const filter = candidate as Record<string, unknown>
    if (typeof filter.filterName !== 'string' || typeof filter.filterKind !== 'string') return []
    const settings = filter.filterSettings && typeof filter.filterSettings === 'object'
      ? Object.fromEntries(Object.entries(filter.filterSettings as Record<string, unknown>).filter((entry): entry is [string, string | number | boolean | null] => {
        const setting = entry[1]
        return setting === null || typeof setting === 'string' || typeof setting === 'number' || typeof setting === 'boolean'
      }))
      : {}
    return [{
      filterName: filter.filterName,
      filterKind: filter.filterKind,
      filterEnabled: filter.filterEnabled !== false,
      filterSettings: settings,
    }]
  })
}

function filterLabel(kind: string): string {
  if (kind.includes('noise_suppress')) return 'ノイズ抑制'
  if (kind.includes('expander')) return 'エキスパンダー'
  if (kind.includes('compressor')) return 'コンプレッサー'
  if (kind.includes('limiter')) return 'リミッター'
  return kind
}

export class AudioCalibrationService {
  private calibrationInProgress = false

  constructor(
    private readonly clientFactory: AudioClientFactory = () => new OBSWebSocket(),
    private readonly wait: Sleep = sleep,
  ) {}

  private async measure(
    client: AudioObsClient,
    sourceNames: Set<string>,
    durationMs: number,
  ): Promise<Map<string, AudioMeterSample[]>> {
    const samples = new Map([...sourceNames].map((sourceName) => [sourceName, [] as AudioMeterSample[]]))
    const listener = ({ inputs }: { inputs: unknown[] }) => {
      if (!Array.isArray(inputs)) return
      for (const entry of inputs) {
        const parsed = sampleFromMeterEntry(entry)
        if (parsed && sourceNames.has(parsed.sourceName)) samples.get(parsed.sourceName)?.push(parsed.sample)
      }
    }
    client.on('InputVolumeMeters', listener)
    try {
      await this.wait(durationMs)
    } finally {
      client.off('InputVolumeMeters', listener)
    }
    return samples
  }

  private analyze(samples: AudioMeterSample[] | undefined, durationMs: number): AudioMeasurement | null {
    return analyzeAudioSamples(samples ?? [], Math.max(4, Math.floor(durationMs / 500)))
  }

  async assertOutputsInactive(client: AudioObsClient): Promise<void> {
    const replayStatusRequest = client.call('GetReplayBufferStatus').catch((error: unknown) => {
      const code = typeof error === 'object' && error !== null && 'code' in error ? Number(error.code) : null
      if (code === 604 || code === 703) return { outputActive: false }
      throw error
    })
    const [streamStatus, recordStatus, replayStatus] = await Promise.all([
      client.call('GetStreamStatus'),
      client.call('GetRecordStatus'),
      replayStatusRequest,
    ])
    if (streamStatus.outputActive || recordStatus.outputActive || replayStatus.outputActive) {
      throw asStatusError('配信・録画・リプレイ中は音声の自動調整を実行できません。すべて停止してから再実行してください', 409)
    }
  }

  private async sourceStates(client: AudioObsClient, sources: AudioSource[]): Promise<SourceState[]> {
    const inputList = await client.call('GetInputList')
    const inputNames = new Set(inputList.inputs.map(({ inputName }) => inputName))
    const resolvedSources = sources.map((source) => source.role === 'bgm' && inputNames.has(STOCK_BGM_INPUT_NAME)
      ? { ...source, sourceName: STOCK_BGM_INPUT_NAME }
      : source)
    const uniqueNames = new Set<string>()
    for (const source of resolvedSources) {
      if (uniqueNames.has(source.sourceName)) throw asStatusError(`音声ソース名「${source.sourceName}」が複数用途で重複しています。設定画面で別々のOBSソース名を指定してください`, 400)
      uniqueNames.add(source.sourceName)
    }
    return Promise.all(resolvedSources.map(async (source) => {
      if (!inputNames.has(source.sourceName)) return { ...source, missing: true }
      const [volume, mute] = await Promise.all([
        client.call('GetInputVolume', { inputName: source.sourceName }),
        client.call('GetInputMute', { inputName: source.sourceName }),
      ])
      return { ...source, currentDb: volume.inputVolumeDb, muted: mute.inputMuted }
    }))
  }

  private async filterList(client: AudioObsClient, sourceName: string): Promise<RawFilter[]> {
    const response = await client.call('GetSourceFilterList', { sourceName })
    return rawFilters(response?.filters)
  }

  private async ensureFilter(
    client: AudioObsClient,
    spec: ManagedFilterSpec,
    rollbacks: RollbackAction[],
    warnings: string[],
  ): Promise<AudioManagedFilterResult | null> {
    const filters = await this.filterList(client, spec.sourceName)
    const managed = filters.find(({ filterName }) => filterName === spec.filterName)
    const legacy = filters.find(({ filterName }) => spec.legacyNames?.includes(filterName))
    const compatible = filters.find((filter) => spec.compatible(filter))
    const desiredEnabled = spec.enabled !== false

    if (!desiredEnabled) {
      const target = managed ?? legacy
      if (!target) {
        if (compatible?.filterEnabled) warnings.push(`${spec.sourceName}のカスタム${filterLabel(compatible.filterKind)}「${compatible.filterName}」は管理対象外のため無効化していません`)
        return null
      }
      if (!target.filterEnabled) {
        return { sourceName: spec.sourceName, filterName: target.filterName, filterKind: target.filterKind, status: 'disabled', message: `${target.filterName}は無効です` }
      }
      await client.call('SetSourceFilterEnabled', { sourceName: spec.sourceName, filterName: target.filterName, filterEnabled: false })
      rollbacks.push({
        label: `${spec.sourceName}/${target.filterName}の有効状態`,
        run: () => client.call('SetSourceFilterEnabled', { sourceName: spec.sourceName, filterName: target.filterName, filterEnabled: target.filterEnabled }),
      })
      return { sourceName: spec.sourceName, filterName: target.filterName, filterKind: target.filterKind, status: 'disabled', message: `${target.filterName}を無効化しました` }
    }

    if (managed || legacy) {
      const target = managed ?? legacy as RawFilter
      await client.call('SetSourceFilterSettings', {
        sourceName: spec.sourceName,
        filterName: target.filterName,
        filterSettings: spec.filterSettings,
        overlay: false,
      })
      rollbacks.push({
        label: `${spec.sourceName}/${target.filterName}の設定`,
        run: async () => {
          await Promise.all([
            client.call('SetSourceFilterSettings', {
              sourceName: spec.sourceName,
              filterName: target.filterName,
              filterSettings: target.filterSettings,
              overlay: false,
            }),
            client.call('SetSourceFilterEnabled', { sourceName: spec.sourceName, filterName: target.filterName, filterEnabled: target.filterEnabled }),
          ])
        },
      })
      if (!target.filterEnabled) {
        await client.call('SetSourceFilterEnabled', { sourceName: spec.sourceName, filterName: target.filterName, filterEnabled: true })
      }
      return { sourceName: spec.sourceName, filterName: target.filterName, filterKind: target.filterKind, status: 'updated', message: `${target.filterName}を安全設定へ更新しました` }
    }

    if (compatible?.filterEnabled) {
      warnings.push(`${spec.sourceName}の既存${filterLabel(compatible.filterKind)}「${compatible.filterName}」を変更せず再利用しました`)
      return { sourceName: spec.sourceName, filterName: compatible.filterName, filterKind: compatible.filterKind, status: 'reused', message: `${compatible.filterName}を再利用しました` }
    }
    if (compatible) warnings.push(`${spec.sourceName}の既存${filterLabel(compatible.filterKind)}「${compatible.filterName}」は無効のため変更せず、管理フィルターを追加しました`)

    await client.call('CreateSourceFilter', {
      sourceName: spec.sourceName,
      filterName: spec.filterName,
      filterKind: spec.filterKind,
      filterSettings: spec.filterSettings,
    })
    rollbacks.push({
      label: `${spec.sourceName}/${spec.filterName}の追加`,
      run: () => client.call('RemoveSourceFilter', { sourceName: spec.sourceName, filterName: spec.filterName }),
    })
    return { sourceName: spec.sourceName, filterName: spec.filterName, filterKind: spec.filterKind, status: 'created', message: `${spec.filterName}を追加しました` }
  }

  private microphoneFilterSpecs(sourceName: string): ManagedFilterSpec[] {
    return [
      {
        sourceName,
        filterName: 'OBS Stream Manager - Noise Suppression',
        filterKind: 'noise_suppress_filter_v2',
        filterSettings: { method: 'rnnoise', suppress_level: -30 },
        compatible: ({ filterKind }) => filterKind === 'noise_suppress_filter_v2' || filterKind === 'noise_suppress_filter',
      },
      {
        sourceName,
        filterName: 'OBS Stream Manager - Expander',
        filterKind: 'expander_filter',
        filterSettings: { attack_time: 10, detector: 'RMS', output_gain: 0, presets: 'expander', ratio: 1.5, release_time: 120, threshold: -50 },
        compatible: ({ filterKind }) => filterKind === 'expander_filter' || filterKind === 'noise_gate_filter',
      },
      {
        sourceName,
        filterName: 'OBS Stream Manager - Compressor',
        filterKind: 'compressor_filter',
        filterSettings: { attack_time: 6, output_gain: 6, ratio: 3, release_time: 60, sidechain_source: 'none', threshold: -18 },
        compatible: ({ filterKind, filterSettings }) => filterKind === 'compressor_filter' && (!filterSettings.sidechain_source || filterSettings.sidechain_source === 'none'),
      },
      {
        sourceName,
        filterName: 'OBS Stream Manager - Limiter',
        filterKind: 'limiter_filter',
        filterSettings: { release_time: 60, threshold: -2 },
        compatible: ({ filterKind }) => filterKind === 'limiter_filter',
      },
    ]
  }

  private gameFilterSpecs(sourceName: string, microphoneSource: string, duckingDb: number): ManagedFilterSpec[] {
    const duckingEnabled = duckingDb < 0
    const duckingThreshold = Math.max(-36, Math.min(-18, AUDIO_CALIBRATION_TARGETS.microphone.referenceDb - Math.abs(duckingDb)))
    return [
      {
        sourceName,
        filterName: 'OBS Stream Manager - Ducking',
        filterKind: 'compressor_filter',
        filterSettings: { attack_time: 10, output_gain: 0, ratio: 10, release_time: 400, sidechain_source: microphoneSource, threshold: duckingThreshold },
        compatible: ({ filterKind, filterName, filterSettings }) => filterKind === 'compressor_filter'
          && (filterSettings.sidechain_source === microphoneSource || filterName.toLowerCase().includes('duck')),
        legacyNames: ['MIC Ducking', 'Game Ducking'],
        enabled: duckingEnabled,
      },
      {
        sourceName,
        filterName: 'OBS Stream Manager - Limiter',
        filterKind: 'limiter_filter',
        filterSettings: { release_time: 60, threshold: -3 },
        compatible: ({ filterKind }) => filterKind === 'limiter_filter',
      },
    ]
  }

  private optionalLimiterSpec(sourceName: string): ManagedFilterSpec {
    return {
      sourceName,
      filterName: 'OBS Stream Manager - Limiter',
      filterKind: 'limiter_filter',
      filterSettings: { release_time: 60, threshold: -3 },
      compatible: ({ filterKind }) => filterKind === 'limiter_filter',
    }
  }

  async applyManagedMicrophoneFilters(client: AudioObsClient, sourceName: string): Promise<{ filters: AudioManagedFilterResult[]; warnings: string[] }> {
    await this.assertOutputsInactive(client)
    const filters: AudioManagedFilterResult[] = []
    const warnings: string[] = []
    const rollbacks: RollbackAction[] = []
    try {
      for (const spec of this.microphoneFilterSpecs(sourceName)) {
        await this.assertOutputsInactive(client)
        const result = await this.ensureFilter(client, spec, rollbacks, warnings)
        if (result) filters.push(result)
      }
      return { filters, warnings }
    } catch (error) {
      for (const rollback of [...rollbacks].reverse()) await rollback.run().catch(() => undefined)
      throw error
    }
  }

  async calibrate(
    config: AppConfig,
    password: string | undefined,
    profile: GameProfile,
    method: CaptureMethod,
    requestedDurationMs = 15_000,
    persistProfile?: (profile: GameProfile) => Promise<GameProfile>,
  ): Promise<AudioCalibrationResult> {
    if (this.calibrationInProgress) throw asStatusError('音声の自動調整はすでに実行中です。完了してから再実行してください', 409)
    this.calibrationInProgress = true
    try {
      return await this.runCalibration(config, password, profile, method, requestedDurationMs, persistProfile)
    } finally {
      this.calibrationInProgress = false
    }
  }

  private async runCalibration(
    config: AppConfig,
    password: string | undefined,
    profile: GameProfile,
    method: CaptureMethod,
    requestedDurationMs = 15_000,
    persistProfile?: (profile: GameProfile) => Promise<GameProfile>,
  ): Promise<AudioCalibrationResult> {
    const startedAt = new Date()
    const durationMs = Math.max(9_000, Math.min(30_000, Math.round(requestedDurationMs)))
    const baselineDurationMs = Math.floor(durationMs * 0.54)
    const firstVerificationDurationMs = Math.floor(durationMs * 0.27)
    const finalVerificationDurationMs = durationMs - baselineDurationMs - firstVerificationDurationMs
    const configuredSources = sourceMap(config, method)
    const client = this.clientFactory()
    const warnings: string[] = []
    const filterResults: AudioManagedFilterResult[] = []
    const rollbacks: RollbackAction[] = []
    let connected = false

    try {
      await client.connect(config.obs.url, password, { eventSubscriptions: EventSubscription.InputVolumeMeters })
      connected = true
      await this.assertOutputsInactive(client)

      const states = await this.sourceStates(client, configuredSources)
      const sources: AudioSource[] = states.map(({ role, sourceName, required }) => ({ role, sourceName, required }))
      const sourceNames = new Set(sources.map(({ sourceName }) => sourceName))
      const unavailableRequired = states.filter(({ required, missing, muted }) => required && (missing || muted))
      if (unavailableRequired.length) {
        const detail = unavailableRequired.map(({ role, sourceName, missing }) => `${role === 'microphone' ? 'マイク' : 'ゲーム音'}「${sourceName}」${missing ? 'が見つかりません' : 'がミュートされています'}`).join(' / ')
        throw asStatusError(`${detail}。OBSで音声ソースを有効にしてから再実行してください`, 422)
      }

      const baselineSamples = await this.measure(client, sourceNames, baselineDurationMs)
      const baseline = new Map<AudioCalibrationRole, AudioMeasurement | null>()
      for (const source of sources) baseline.set(source.role, this.analyze(baselineSamples.get(source.sourceName), baselineDurationMs))
      const silentRequired = sources.filter(({ role, required }) => required && !baseline.get(role))
      if (silentRequired.length) {
        const names = silentRequired.map(({ role, sourceName }) => `${role === 'microphone' ? 'マイク' : 'ゲーム音'}「${sourceName}」`).join('と')
        throw asStatusError(`${names}の音声を測定できませんでした。普段の声量で話しながらゲーム音を鳴らし、もう一度実行してください`, 422)
      }

      await this.assertOutputsInactive(client)

      for (const spec of this.microphoneFilterSpecs(config.sources.microphone)) {
        await this.assertOutputsInactive(client)
        const result = await this.ensureFilter(client, spec, rollbacks, warnings)
        if (result) filterResults.push(result)
      }
      for (const spec of this.gameFilterSpecs(activeGameSource(config, method), config.sources.microphone, profile.audio.duckingDb)) {
        await this.assertOutputsInactive(client)
        const result = await this.ensureFilter(client, spec, rollbacks, warnings)
        if (result) filterResults.push(result)
      }
      for (const source of sources.filter(({ role }) => (role === 'discord' || role === 'bgm') && baseline.get(role))) {
        await this.assertOutputsInactive(client)
        const result = await this.ensureFilter(client, this.optionalLimiterSpec(source.sourceName), rollbacks, warnings)
        if (result) filterResults.push(result)
      }

      const readings: AudioCalibrationReading[] = []
      const nextAudio = { ...profile.audio }
      for (const role of AUDIO_CALIBRATION_ROLES) {
        const source = states.find((candidate) => candidate.role === role) as SourceState
        const target = AUDIO_CALIBRATION_TARGETS[role]
        if (source.missing) {
          readings.push({ role, sourceName: source.sourceName, required: target.required, status: 'missing', targetDb: target.referenceDb, peakCeilingDb: target.peakCeilingDb, message: `${source.sourceName}がOBSにありません` })
          warnings.push(`${source.sourceName}がOBSにないため調整をスキップしました`)
          continue
        }
        if (source.muted) {
          readings.push({ role, sourceName: source.sourceName, required: target.required, status: 'muted', targetDb: target.referenceDb, peakCeilingDb: target.peakCeilingDb, previousDb: source.currentDb, message: `${source.sourceName}はミュート中です` })
          warnings.push(`${source.sourceName}がミュート中のため調整をスキップしました`)
          continue
        }
        const measurement = baseline.get(role)
        if (!measurement || source.currentDb === undefined) {
          readings.push({ role, sourceName: source.sourceName, required: target.required, status: 'no_signal', targetDb: target.referenceDb, peakCeilingDb: target.peakCeilingDb, previousDb: source.currentDb, message: `${source.sourceName}は有効な音声を測定できませんでした` })
          warnings.push(`${source.sourceName}は無音だったため現在の音量を維持しました`)
          continue
        }
        const recommendation = recommendInputVolume(source.currentDb, measurement, target)
        await this.assertOutputsInactive(client)
        await client.call('SetInputVolume', { inputName: source.sourceName, inputVolumeDb: recommendation.appliedDb })
        rollbacks.push({
          label: `${source.sourceName}の音量`,
          run: () => client.call('SetInputVolume', { inputName: source.sourceName, inputVolumeDb: source.currentDb as number }),
        })
        nextAudio[audioFieldForRole(role)] = recommendation.appliedDb
        if (recommendation.constrainedByPeak) warnings.push(`${source.sourceName}はピーク超過を防ぐため増幅量を制限しました`)
        if (recommendation.constrainedByFader) warnings.push(`${source.sourceName}は安全なフェーダー範囲内で調整しました`)
        readings.push({
          role,
          sourceName: source.sourceName,
          required: target.required,
          status: recommendation.withinTarget ? 'within_target' : 'adjusted',
          targetDb: target.referenceDb,
          peakCeilingDb: target.peakCeilingDb,
          previousDb: source.currentDb,
          appliedDb: recommendation.appliedDb,
          adjustmentDb: recommendation.adjustmentDb,
          measuredDb: measurement.referenceDb,
          measuredPeakDb: measurement.peakDb,
          sampleCount: measurement.activeSampleCount,
          message: recommendation.withinTarget ? 'すでに目標範囲内です' : `${recommendation.adjustmentDb >= 0 ? '+' : ''}${recommendation.adjustmentDb} dB調整しました`,
        })
      }

      const firstVerificationSamples = await this.measure(client, sourceNames, firstVerificationDurationMs)
      for (const reading of readings.filter(({ appliedDb }) => appliedDb !== undefined)) {
        const measurement = this.analyze(firstVerificationSamples.get(reading.sourceName), firstVerificationDurationMs)
        if (!measurement || reading.appliedDb === undefined) {
          warnings.push(`${reading.sourceName}は調整後の確認中に無音になったため、初回測定値を採用しました`)
          continue
        }
        const target = AUDIO_CALIBRATION_TARGETS[reading.role]
        const correction = recommendInputVolume(reading.appliedDb, measurement, target, 3)
        if (correction.adjustmentDb !== 0) {
          await this.assertOutputsInactive(client)
          await client.call('SetInputVolume', { inputName: reading.sourceName, inputVolumeDb: correction.appliedDb })
          nextAudio[audioFieldForRole(reading.role)] = correction.appliedDb
          reading.appliedDb = correction.appliedDb
          reading.adjustmentDb = Math.round(((reading.adjustmentDb ?? 0) + correction.adjustmentDb) * 2) / 2
        }
      }

      const finalSamples = await this.measure(client, sourceNames, finalVerificationDurationMs)
      for (const reading of readings.filter(({ appliedDb }) => appliedDb !== undefined)) {
        const measurement = this.analyze(finalSamples.get(reading.sourceName), finalVerificationDurationMs)
        if (!measurement) {
          reading.status = 'limited'
          reading.message = `${reading.message}。最終確認時は無音でした`
          continue
        }
        reading.verifiedDb = measurement.referenceDb
        reading.verifiedPeakDb = measurement.peakDb
        const target = AUDIO_CALIBRATION_TARGETS[reading.role]
        const verified = Math.abs(measurement.referenceDb - target.referenceDb) <= target.toleranceDb
          && measurement.peakDb <= target.peakCeilingDb + 1
        reading.status = verified ? ((reading.adjustmentDb ?? 0) === 0 ? 'within_target' : 'adjusted') : 'limited'
        reading.message = verified
          ? `${reading.message}。目標範囲を確認しました`
          : `${reading.message}。音源の変動が大きいため安全範囲で確定しました`
        if (!verified) warnings.push(`${reading.sourceName}は音源の変動が大きく、目標付近の安全値で確定しました`)
      }

      const updatedProfile = { ...profile, audio: nextAudio }
      const result: AudioCalibrationResult = {
        profile: updatedProfile,
        captureMethod: method,
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        durationMs,
        readings,
        filters: filterResults,
        warnings,
      }
      if (persistProfile) result.profile = await persistProfile(updatedProfile)
      return result
    } catch (error) {
      const rollbackFailures: string[] = []
      for (const rollback of [...rollbacks].reverse()) {
        try {
          await rollback.run()
        } catch (rollbackError) {
          rollbackFailures.push(`${rollback.label}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`)
        }
      }
      if (!rollbackFailures.length) throw error
      const primary = error instanceof Error ? error : new Error(String(error))
      primary.message = `${primary.message} / OBS状態のロールバックにも失敗しました: ${rollbackFailures.join(' / ')}`
      Object.assign(primary, { rollbackFailures })
      throw primary
    } finally {
      if (connected) await client.disconnect().catch(() => undefined)
    }
  }
}
