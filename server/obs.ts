import OBSWebSocket, { type OBSRequestTypes } from 'obs-websocket-js'
import { mkdir, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AppConfig, BgmPlayback, BgmPlaybackMode, CaptureMethod, GameProfile, RuntimeStatus } from '../shared/contracts.js'
import type { CommonTemplateRender } from './common-template.js'
import { normalizeMicrophoneGain, type AudioCalibrationResult } from '../shared/audio-calibration.js'
import { STOCK_BGM_INPUT_NAME } from '../shared/bgm.js'
import { OBS_OUTPUT_PLUGIN_VENDOR } from '../shared/obs-output-plugin.js'
import { AudioCalibrationService } from './audio-calibration.js'
import { isMinecraftGameWindowTitle } from './capture.js'
import { SecretStore } from './secrets.js'

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))
type StreamServiceSettings = OBSRequestTypes['SetStreamServiceSettings']
type AppliedStreamService = { streamServiceType: string; server: string; key: string }
type ObsRuntimeStatus = Omit<RuntimeStatus, 'platforms'>
type TwitchOutputPluginStatus = NonNullable<ObsRuntimeStatus['twitchOutputPlugin']>
type StreamOutputStatus = { outputActive: boolean; outputReconnecting?: boolean }
const twitchOutputPluginApiVersion = 4
const outputModeReloadSecret = 'obs-output-mode-reload-required'
const streamOutputRunning = (status: StreamOutputStatus): boolean =>
  status.outputActive || status.outputReconnecting === true
export const managedOutputPreset = {
  width: 1920,
  height: 1080,
  fpsNumerator: 60,
  fpsDenominator: 1,
  videoBitrateKbps: 10_000,
  twitchVideoBitrateKbps: 6_000,
  audioBitrateKbps: 160,
} as const
export const recordingOnlyPreset = {
  profileName: 'OBS Stream Manager - Recording 1440p',
  width: 2560,
  height: 1440,
  fpsNumerator: 60,
  fpsDenominator: 1,
  encoder: 'obs_nvenc_h264_tex',
  rateControl: 'VBR',
  videoBitrateKbps: 8_000,
  maxVideoBitrateKbps: 10_000,
  preset: 'p5',
  tune: 'hq',
  multipass: 'disabled',
  lookahead: false,
  adaptiveQuantization: false,
  audioSampleRate: 48_000,
  container: 'mkv',
} as const
export const stockBgmInputName = STOCK_BGM_INPUT_NAME
export const managedSourceRecordFilterName = 'OBS Stream Manager - Source Record'
export type BgmControlAction = 'play' | 'pause' | 'stop' | 'restart'
export type ProfileApplyResult = { warnings: string[]; audioApplied: boolean }

export function recordingGameName(profile: Pick<GameProfile, 'displayName' | 'presentation'>): string {
  const preferred = profile.displayName.trim()
  const sanitized = preferred
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\p{Cc}/gu, '_')
    .replace(/[\s_]+/g, '_')
    .replace(/^[_ .]+|[_ .]+$/g, '')
  return sanitized || 'Game'
}

export function recordingFilenameFormat(profile: Pick<GameProfile, 'displayName' | 'presentation'>): string {
  return `${recordingGameName(profile)}_%CCYY-%MM-%DD_%hh-%mm-%ss`
}
export type TwitchIngestTestResult = {
  ok: true
  output: {
    width: number
    height: number
    fpsNumerator: number
    fpsDenominator: number
    videoBitrateKbps: number
    audioBitrateKbps: number
    encoderConfigured: boolean
  }
  durationMs: number
  bytesSent: number
  totalFrames: number
  skippedFrames: number
  measuredFps: number
  congestion: number
  secondary: {
    durationMs: number
    bytesSent: number
    totalFrames: number
    skippedFrames: number
    measuredFps: number
  } | null
  recording: {
    durationMs: number
    bytesWritten: number
  } | null
  replayBuffer: {
    active: true
  } | null
  obs: {
    activeFps: number
    renderTotalFrames: number
    renderSkippedFrames: number
    outputTotalFrames: number
    outputSkippedFrames: number
  }
  verticalBacktrackStopped: boolean
  warnings: string[]
}

export type TwitchIngestTestOptions = {
  includeSecondary?: boolean
  includeRecording?: boolean
  includeReplayBuffer?: boolean
}

export class ObsController {
  private readonly obs = new OBSWebSocket()
  private connected = false
  private streamServiceManaged = false
  private rollbackScene: string | null = null
  private outputModeReloadRequired = false
  private outputModeReloadSetThisConnection = false
  private readonly streamStateListeners = new Set<(active: boolean) => void>()
  private started = { stream: false, twitch: false, record: false, replay: false, sourceRecord: false, vertical: false, sourceRecordSource: null as string | null }
  private recordingOnlyActive = false
  private recordingGame: { id: string; name: string } | null = null

  constructor(
    private readonly secrets: SecretStore,
    private readonly streamStartTimeoutMs = 8_000,
    private readonly streamStopTimeoutMs = streamStartTimeoutMs,
    private readonly audioCalibration = new AudioCalibrationService(),
  ) {
    this.outputModeReloadRequired = this.secrets.get(outputModeReloadSecret) === '1'
    this.obs.on('ConnectionClosed', () => {
      this.outputModeReloadRequired = this.secrets.get(outputModeReloadSecret) === '1'
      // A fresh websocket connection is the earliest point at which the OBS
      // output handler may have been rebuilt after a restart/profile reload.
      this.outputModeReloadSetThisConnection = false
      this.connected = false
      this.resetTransientOutputOwnership()
    })
    this.obs.on('StreamStateChanged', ({ outputActive, outputState }) => {
      // STARTING/STOPPING/RECONNECTING are transitional. In particular OBS
      // reports outputActive=false while it is reconnecting; forwarding that
      // as a stop would end the YouTube broadcast and the linked outputs
      // before OBS gets the chance to reconnect.
      if (outputState === 'OBS_WEBSOCKET_OUTPUT_STARTING'
        || outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPING'
        || outputState === 'OBS_WEBSOCKET_OUTPUT_RECONNECTING') return
      for (const listener of this.streamStateListeners) listener(outputActive)
    })
  }

  async autoAdjustAudio(
    config: AppConfig,
    profile: GameProfile,
    method: CaptureMethod,
    durationMs = 15_000,
    persistProfile?: (profile: GameProfile) => Promise<GameProfile>,
  ): Promise<AudioCalibrationResult> {
    await this.connect(config)
    const sourceWarnings: string[] = []
    const selectedSource = this.captureSource(profile, method)
    const activeGameAudio = await this.prepareGameAudioInput(config, profile, selectedSource, sourceWarnings)
    const calibration = await this.audioCalibration.calibrate(
      this.withGameAudioInput(config, profile, selectedSource, activeGameAudio),
      this.secrets.get('obs-password') ?? undefined,
      profile,
      method,
      durationMs,
      persistProfile,
    )
    return { ...calibration, warnings: [...sourceWarnings, ...calibration.warnings] }
  }

  onStreamStateChanged(listener: (active: boolean) => void): () => void {
    this.streamStateListeners.add(listener)
    return () => this.streamStateListeners.delete(listener)
  }

  async connect(config: AppConfig): Promise<void> {
    if (this.connected) return
    const password = this.secrets.get('obs-password') ?? undefined
    await this.obs.connect(config.obs.url, password)
    this.connected = true
  }

  async disconnect(): Promise<void> {
    try {
      if (this.connected) await this.obs.disconnect()
    } finally {
      this.connected = false
      this.resetTransientOutputOwnership()
    }
  }

  private resetTransientOutputOwnership(): void {
    this.started = { stream: false, twitch: false, record: false, replay: false, sourceRecord: false, vertical: false, sourceRecordSource: null }
    this.recordingOnlyActive = false
    this.recordingGame = null
  }

  private captureSource(profile: GameProfile, method: CaptureMethod): string {
    if (method === 'geforce_now') return profile.capture.geforceNowSourceName
    if (method === 'window') return profile.capture.windowSourceName ?? profile.capture.localSourceName
    if (method === 'display') return profile.capture.displaySourceName
    return profile.capture.localSourceName
  }

  private async prepareGeForceNowWindow(sourceName: string, windowTitle: string, warnings: string[]): Promise<void> {
    const input = await this.obs.call('GetInputSettings', { inputName: sourceName }).catch(() => null)
    if (!input || (input.inputKind !== 'game_capture' && input.inputKind !== 'window_capture')) {
      warnings.push(`GeForce NOW映像ソース「${sourceName}」のウィンドウ対象を自動設定できませんでした`)
      return
    }
    if (await this.anyOutputActive()) {
      warnings.push('出力中のためGeForce NOW映像ソースの対象ウィンドウを変更しませんでした')
      return
    }

    const current = input.inputSettings as Record<string, unknown>
    const currentWindow = typeof current.window === 'string' ? current.window : ''
    const suffix = currentWindow.match(/:([^:]+):([^:]+)$/)
    const windowClass = suffix?.[1] || 'CEFCLIENT'
    const executable = suffix?.[2] && /geforcenow/i.test(suffix[2]) ? suffix[2] : 'GeForceNOW.exe'
    const targetWindow = `${windowTitle}:${windowClass}:${executable}`
    const inputSettings = {
      window: targetWindow,
      ...(input.inputKind === 'game_capture' ? { capture_mode: 'window' } : {}),
      ...(typeof current.priority === 'number' ? { priority: current.priority } : {}),
    }
    if (current.window === targetWindow && (input.inputKind !== 'game_capture' || current.capture_mode === 'window')) return

    await this.obs.call('SetInputSettings', {
      inputName: sourceName,
      inputSettings,
      overlay: true,
    }).catch((error) => {
      warnings.push(`GeForce NOW映像ソースを「${windowTitle}」へ切り替えられませんでした: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  private async setSceneItem(sceneName: string, sourceName: string, enabled: boolean): Promise<boolean> {
    try {
      const { sceneItemId } = await this.obs.call('GetSceneItemId', { sceneName, sourceName })
      await this.obs.call('SetSceneItemEnabled', { sceneName, sceneItemId, sceneItemEnabled: enabled })
      return true
    } catch {
      return false
    }
  }

  private async setVolume(inputName: string, inputVolumeDb: number): Promise<void> {
    try { await this.obs.call('SetInputVolume', { inputName, inputVolumeDb }) } catch { /* optional/missing input */ }
  }

  private async setMuted(inputName: string, muted: boolean): Promise<void> {
    try { await this.obs.call('SetInputMute', { inputName, inputMuted: muted }) } catch { /* optional/missing input */ }
  }

  private async anyOutputActive(): Promise<boolean> {
    const [stream, record, replay, secondary] = await Promise.all([
      this.obs.call('GetStreamStatus').catch(() => ({ outputActive: false })),
      this.obs.call('GetRecordStatus').catch(() => ({ outputActive: false })),
      this.getReplayBufferStatus().catch(() => ({ outputActive: false })),
      this.getTwitchOutputPluginStatus().catch(() => null),
    ])
    return streamOutputRunning(stream) || record.outputActive || replay.outputActive || secondary?.outputActive === true
  }

  private async reconcileMicrophoneSceneItems(config: AppConfig, profile: GameProfile, warnings: string[]): Promise<void> {
    const configured = await this.obs.call('GetInputSettings', { inputName: config.sources.microphone }).catch(() => null)
    if (!configured) return
    const configuredSettings = configured.inputSettings as Record<string, unknown>
    const configuredDevice = configured.inputKind === 'wasapi_input_capture'
      ? (typeof configuredSettings.device_id === 'string' && configuredSettings.device_id ? configuredSettings.device_id : 'default')
      : null
    const disabledDuplicates = new Set<string>()

    for (const sceneName of new Set([profile.obs.startingScene, profile.obs.sceneName])) {
      const response = await this.obs.call('GetSceneItemList', { sceneName }).catch(() => null)
      if (!response || !Array.isArray(response.sceneItems)) continue
      const configuredItem = response.sceneItems.find(({ sourceName }) => sourceName === config.sources.microphone)
      if (configuredItem && typeof configuredItem.sceneItemId === 'number') {
        await this.obs.call('SetSceneItemEnabled', { sceneName, sceneItemId: configuredItem.sceneItemId, sceneItemEnabled: true }).catch(() => undefined)
      } else {
        await this.obs.call('CreateSceneItem', { sceneName, sourceName: config.sources.microphone, sceneItemEnabled: true })
          .catch(() => warnings.push(`${sceneName}へ調整済みマイク「${config.sources.microphone}」を追加できませんでした`))
      }
      if (!configuredDevice) continue

      for (const item of response.sceneItems) {
        if (item.sourceName === config.sources.microphone || item.sceneItemEnabled !== true || typeof item.sourceName !== 'string' || typeof item.sceneItemId !== 'number') continue
        const candidate = await this.obs.call('GetInputSettings', { inputName: item.sourceName }).catch(() => null)
        if (!candidate || candidate.inputKind !== 'wasapi_input_capture') continue
        const settings = candidate.inputSettings as Record<string, unknown>
        const device = typeof settings.device_id === 'string' && settings.device_id ? settings.device_id : 'default'
        if (device !== configuredDevice) continue
        await this.obs.call('SetSceneItemEnabled', { sceneName, sceneItemId: item.sceneItemId, sceneItemEnabled: false })
        disabledDuplicates.add(item.sourceName)
      }
    }

    if (disabledDuplicates.size) {
      warnings.push(`同じマイクを二重取り込みしていたため、${[...disabledDuplicates].map((name) => `「${name}」`).join('・')}を無効化しました`)
    }
  }

  private legacyGameAudioInput(config: AppConfig, profile: GameProfile, selectedSource: string): string {
    if (selectedSource === profile.capture.geforceNowSourceName) return config.sources.geforceNow
    if (profile.platformGroup === 'switch' || selectedSource === 'Elgato Game Capture') return config.sources.switchGame
    return config.sources.pcGame
  }

  private withGameAudioInput(config: AppConfig, profile: GameProfile, selectedSource: string, inputName: string): AppConfig {
    const sources = { ...config.sources }
    const legacy = this.legacyGameAudioInput(config, profile, selectedSource)
    if (legacy === config.sources.geforceNow) sources.geforceNow = inputName
    else if (legacy === config.sources.switchGame) sources.switchGame = inputName
    else sources.pcGame = inputName
    return { ...config, sources }
  }

  private async prepareGameAudioInput(
    config: AppConfig,
    profile: GameProfile,
    selectedSource: string,
    warnings: string[],
  ): Promise<string> {
    const legacy = this.legacyGameAudioInput(config, profile, selectedSource)
    const input = await this.obs.call('GetInputSettings', { inputName: selectedSource }).catch(() => null)
    if (!input) return legacy
    if (input.inputKind === 'game_capture' || input.inputKind === 'window_capture') {
      if (await this.anyOutputActive()) {
        warnings.push(`出力中のため映像キャプチャ「${selectedSource}」のアプリ音声設定を変更しませんでした`)
        return legacy
      }
      try {
        await this.obs.call('SetInputSettings', {
          inputName: selectedSource,
          inputSettings: { capture_audio: true },
          overlay: true,
        })
        return selectedSource
      } catch (error) {
        warnings.push(`ゲーム音を映像キャプチャ「${selectedSource}」からアプリ単位で取得できませんでした: ${error instanceof Error ? error.message : String(error)}`)
        return legacy
      }
    }
    if (input.inputKind === 'dshow_input' || input.inputKind === 'decklink-input' || input.inputKind === 'wasapi_process_output_capture') {
      return selectedSource
    }
    return legacy
  }

  private async ensureDiscordApplicationAudio(sceneName: string, inputName: string, warnings: string[]): Promise<void> {
    const current = await this.obs.call('GetInputSettings', { inputName }).catch(() => null)
    if (!current) return
    const applicationSettings = { window: 'Discord:Chrome_WidgetWin_1:Discord.exe', priority: 2 }
    if (current.inputKind === 'wasapi_process_output_capture') {
      if (await this.anyOutputActive()) {
        warnings.push('出力中のためDiscordアプリ音声の対象とシーン配置を変更しませんでした')
        return
      }
      const inputSettings = current.inputSettings as Record<string, unknown>
      const currentWindow = typeof inputSettings.window === 'string' ? inputSettings.window : ''
      if (!/Discord(?:PTB|Canary|Development)?\.exe$/i.test(currentWindow)) {
        await this.obs.call('SetInputSettings', { inputName, inputSettings: applicationSettings, overlay: true })
          .catch((error) => warnings.push(`Discordのアプリ音声対象を更新できませんでした: ${error instanceof Error ? error.message : String(error)}`))
      }
      const existingItem = await this.obs.call('GetSceneItemId', { sceneName, sourceName: inputName }).catch(() => null)
      if (!existingItem) {
        await this.obs.call('CreateSceneItem', { sceneName, sourceName: inputName, sceneItemEnabled: true })
          .catch((error) => warnings.push(`${sceneName}へDiscordアプリ音声を追加できませんでした: ${error instanceof Error ? error.message : String(error)}`))
      }
      return
    }
    if (current.inputKind !== 'wasapi_output_capture') return
    if (await this.anyOutputActive()) {
      warnings.push('出力中のためDiscordのデバイス全体キャプチャをアプリ単位へ移行しませんでした')
      return
    }

    const kinds = await this.obs.call('GetInputKindList').catch(() => null)
    if (!kinds?.inputKinds.includes('wasapi_process_output_capture')) {
      warnings.push('Discordがデバイス全体の音声キャプチャになっていますが、このOBSではアプリ音声キャプチャを利用できないためA2へ分離できません')
      return
    }
    const inputList = await this.obs.call('GetInputList').catch(() => null)
    const names = new Set(inputList?.inputs.map(({ inputName: name }) => name) ?? [])
    const baseLegacyName = `${inputName} (旧デバイス音声)`
    let legacyName = baseLegacyName
    for (let suffix = 2; names.has(legacyName); suffix += 1) legacyName = `${baseLegacyName} ${suffix}`
    const previousMute = await this.obs.call('GetInputMute', { inputName }).catch(() => null)
    const previousTracks = await this.obs.call('GetInputAudioTracks', { inputName }).catch(() => null)
    if (!previousMute || !previousTracks) {
      warnings.push('Discordの元のミュート・音声トラック設定を取得できないため、安全なアプリ音声移行を中止しました')
      return
    }
    const sceneList = await this.obs.call('GetSceneList').catch(() => null)
    const targetScenes = new Set([sceneName])
    for (const scene of sceneList?.scenes ?? []) {
      if (typeof scene.sceneName !== 'string' || scene.sceneName === sceneName) continue
      const item = await this.obs.call('GetSceneItemId', { sceneName: scene.sceneName, sourceName: inputName }).catch(() => null)
      if (item) targetScenes.add(scene.sceneName)
    }
    let renamed = false
    let created = false
    try {
      await this.obs.call('SetInputName', { inputName, newInputName: legacyName })
      renamed = true
      await this.obs.call('SetInputMute', { inputName: legacyName, inputMuted: true })
      await this.obs.call('SetInputAudioTracks', { inputName: legacyName, inputAudioTracks: this.audioTrackSelection() })
      await this.obs.call('CreateInput', {
        sceneName,
        inputName,
        inputKind: 'wasapi_process_output_capture',
        inputSettings: applicationSettings,
        sceneItemEnabled: true,
      })
      created = true
    } catch (error) {
      if (renamed) {
        await this.obs.call('SetInputName', { inputName: legacyName, newInputName: inputName }).catch(() => undefined)
        await this.obs.call('SetInputMute', { inputName, inputMuted: previousMute.inputMuted }).catch(() => undefined)
        await this.obs.call('SetInputAudioTracks', { inputName, inputAudioTracks: previousTracks.inputAudioTracks }).catch(() => undefined)
      }
      warnings.push(`Discordのアプリ単位音声キャプチャを作成できなかったため、元のOBSソースへ戻しました: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!created) return
    for (const targetScene of targetScenes) {
      if (targetScene === sceneName) continue
      await this.obs.call('CreateSceneItem', { sceneName: targetScene, sourceName: inputName, sceneItemEnabled: true })
        .catch((error) => warnings.push(`${targetScene}へDiscordアプリ音声を引き継げませんでした: ${error instanceof Error ? error.message : String(error)}`))
    }
    warnings.push('Discord音声をデバイス全体の取り込みからDiscord.exeだけのA2分離キャプチャへ移行しました')
  }

  private async simulcastPerformanceProtection(config: AppConfig, profile: GameProfile): Promise<{ protected: boolean; width: number; height: number }> {
    const simulcasting = config.features.youtube && profile.youtube.enabled && config.features.twitch && profile.twitch.enabled
    if (!simulcasting) return { protected: false, width: 0, height: 0 }
    const video = await this.obs.call('GetVideoSettings').catch(() => null)
    const width = video?.outputWidth ?? 0
    const height = video?.outputHeight ?? 0
    // A separate Twitch encoder plus the normal recording and replay encoder is
    // already the safe FHD60 budget. Source Record, Aitum Vertical recording,
    // and Vertical Backtrack each add another encoder that is not represented by
    // GetStats.outputSkippedFrames. A real 1080p60 simulcast kept both public
    // outputs moving while Source Record dropped 99.7% of its frames and caused
    // the normal recording encoder to lag. Protect the public outputs and the
    // A1-A5 recording whenever both destinations are enabled, not only at 4K.
    return { protected: true, width, height }
  }

  private audioTrackSelection(...enabled: number[]): Record<string, boolean> {
    const selected = new Set(enabled)
    return Object.fromEntries(Array.from({ length: 6 }, (_, index) => [String(index + 1), selected.has(index + 1)]))
  }

  private async configureSeparatedAudioTracks(
    config: AppConfig,
    warnings: string[],
    activeGameAudioInput?: string,
    knownCaptureSources: string[] = [],
    recordingEncoder = 'none',
  ): Promise<void> {
    if (await this.anyOutputActive()) {
      warnings.push('音声トラック分離は出力中のため変更していません。配信・録画・リプレイ・Twitch副出力を停止してゲームを選び直すと反映されます')
      return
    }

    const inputList = await this.obs.call('GetInputList').catch(() => null)
    if (!inputList || !Array.isArray(inputList.inputs)) return
    const inputs = inputList.inputs.flatMap((input) => typeof input.inputName === 'string'
      ? [{ inputName: input.inputName, inputKind: typeof input.inputKind === 'string' ? input.inputKind : '' }]
      : [])
    const existing = new Set(inputs.map(({ inputName }) => inputName))
    const inputKinds = new Map(inputs.map(({ inputName, inputKind }) => [inputName, inputKind]))
    const outputMode = await this.obs.call('GetProfileParameter', { parameterCategory: 'Output', parameterName: 'Mode' })
      .then(({ parameterValue }) => parameterValue)
      .catch(() => null)
    const advanced = outputMode === 'Advanced'
    if (!advanced) {
      try {
        await this.obs.call('SetProfileParameter', {
          parameterCategory: 'Output',
          parameterName: 'Mode',
          parameterValue: 'Advanced',
        })
        this.outputModeReloadRequired = true
        this.outputModeReloadSetThisConnection = true
        this.secrets.set(outputModeReloadSecret, '1')
        warnings.push('A1〜A5の分離録音を有効にするためOBS出力モードを「詳細」へ変更しました。現在のOBS出力機構はまだ旧モードのため、OBSを再起動するまで配信・録画は開始しません')
      } catch (error) {
        warnings.push(`OBS出力モードを「詳細」へ変更できないため、A1〜A5の分離録音を設定できませんでした: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
    }
    const streamMix = 6
    const fallbackGameInputs = [...new Set([config.sources.pcGame, config.sources.geforceNow, config.sources.switchGame])]
    const managedGameInputs = [...new Set([...fallbackGameInputs, ...knownCaptureSources])]
    const requestedGameInput = activeGameAudioInput?.trim()
    const fallbackGameInput = fallbackGameInputs.find((inputName) => existing.has(inputName) && inputKinds.get(inputName) !== 'wasapi_output_capture')
    const selectedGameInput = requestedGameInput && existing.has(requestedGameInput)
      ? requestedGameInput
      : fallbackGameInput
    if (requestedGameInput && !existing.has(requestedGameInput)) {
      warnings.push(selectedGameInput
        ? `選択中ゲームの音声ソース「${requestedGameInput}」が見つからないため、代替ソース「${selectedGameInput}」をA1と配信MIXへ割り当てました`
        : `選択中ゲームの音声ソース「${requestedGameInput}」が見つからず、安全に代替できるアプリ音声もないため、ゲーム音をA1と配信MIXへ割り当てていません`)
    }
    if (!activeGameAudioInput && !selectedGameInput && managedGameInputs.some((inputName) => inputKinds.get(inputName) === 'wasapi_output_capture')) {
      warnings.push('選択中ゲームのアプリ音声ソースを特定できないため、デバイス全体を取り込む旧GAME音声はA1と配信MIXへ戻しませんでした')
    }
    const routes: Array<{ inputName: string; isolatedTrack: number; includeInStream?: boolean }> = [
      ...(selectedGameInput ? [{ inputName: selectedGameInput, isolatedTrack: 1 }] : []),
      { inputName: config.sources.microphone, isolatedTrack: 3 },
      { inputName: stockBgmInputName, isolatedTrack: 4 },
    ]
    if (inputKinds.get(config.sources.discord) === 'wasapi_process_output_capture') {
      routes.push({ inputName: config.sources.discord, isolatedTrack: 2 })
    } else if (existing.has(config.sources.discord)) {
      warnings.push(`Discord音声「${config.sources.discord}」はデバイス全体を取り込むため、ゲーム音との二重収録を防ぐ目的でA2と配信MIXから外しました`)
    }
    if (inputKinds.get(config.sources.bgm) !== 'wasapi_output_capture' && existing.has(config.sources.bgm)) {
      routes.push({ inputName: config.sources.bgm, isolatedTrack: 4 })
    } else if (existing.has(config.sources.bgm)) {
      // The legacy whole-device BGM source is intentionally excluded. This is
      // the normal migration path for BGM Stock, not an operator warning.
    }
    const managedNames = new Set([...managedGameInputs, config.sources.discord, config.sources.microphone, config.sources.bgm, stockBgmInputName, ...(activeGameAudioInput ? [activeGameAudioInput] : [])])
    const auxiliaryKinds = new Set([
      'game_capture',
      'window_capture',
      'display_capture',
      'dshow_input',
      'wasapi_output_capture',
      'wasapi_input_capture',
      'wasapi_process_output_capture',
    ])
    for (const input of inputs) {
      if (managedNames.has(input.inputName)) continue
      const audioTracks = await this.obs.call('GetInputAudioTracks', { inputName: input.inputName }).catch(() => null)
      if (!audioTracks) continue
      routes.push({
        inputName: input.inputName,
        isolatedTrack: 5,
        includeInStream: !auxiliaryKinds.has(input.inputKind),
      })
    }
    const routedNames = new Set(routes.map(({ inputName }) => inputName))
    for (const inputName of managedNames) {
      if (!existing.has(inputName) || routedNames.has(inputName)) continue
      await this.obs.call('SetInputAudioTracks', {
        inputName,
        inputAudioTracks: this.audioTrackSelection(),
      }).catch(() => warnings.push(`重複音声ソース「${inputName}」を録画・配信MIXから外せませんでした`))
    }
    for (const { inputName, isolatedTrack, includeInStream = true } of routes) {
      if (!existing.has(inputName)) continue
      await this.obs.call('SetInputAudioTracks', {
        inputName,
        inputAudioTracks: this.audioTrackSelection(isolatedTrack, ...(includeInStream ? [streamMix] : [])),
      }).catch(() => warnings.push(`音声ソース「${inputName}」の録画トラックを分離できませんでした`))
    }

    const profileSettings = [
      { parameterCategory: 'AdvOut', parameterName: 'TrackIndex', parameterValue: '6' },
      // Record A6 as well as the isolated A1-A5 stems. This makes the exact
      // public STREAM MIX auditable before a broadcast instead of validating
      // only source meters that can still feed a silent output track.
      { parameterCategory: 'AdvOut', parameterName: 'RecTracks', parameterValue: '63' },
      { parameterCategory: 'AdvOut', parameterName: 'RecEncoder', parameterValue: recordingEncoder },
      { parameterCategory: 'AdvOut', parameterName: 'RecUseRescale', parameterValue: 'false' },
      { parameterCategory: 'AdvOut', parameterName: 'Track1Name', parameterValue: 'GAME' },
      { parameterCategory: 'AdvOut', parameterName: 'Track2Name', parameterValue: 'DISCORD' },
      { parameterCategory: 'AdvOut', parameterName: 'Track3Name', parameterValue: 'MIC' },
      { parameterCategory: 'AdvOut', parameterName: 'Track4Name', parameterValue: 'BGM' },
      { parameterCategory: 'AdvOut', parameterName: 'Track5Name', parameterValue: 'AUX CAPTURE' },
      { parameterCategory: 'AdvOut', parameterName: 'Track6Name', parameterValue: 'STREAM MIX' },
    ]
    const results = await Promise.all(profileSettings.map((setting) => this.obs.call('SetProfileParameter', setting).then(() => true).catch(() => false)))
    if (results.some((result) => !result)) warnings.push('OBS録画プロファイルの一部で音声トラック名または録音対象を更新できませんでした')
  }

  private async configureManagedOutput(warnings: string[]): Promise<void> {
    const [stream, record, replay, secondary] = await Promise.all([
      this.obs.call('GetStreamStatus').catch(() => ({ outputActive: false })),
      this.obs.call('GetRecordStatus').catch(() => ({ outputActive: false })),
      this.getReplayBufferStatus().catch(() => ({ outputActive: false })),
      this.getTwitchOutputPluginStatus().catch(() => null),
    ])
    if (streamOutputRunning(stream) || record.outputActive || replay.outputActive || secondary?.outputActive) {
      warnings.push('FHD配信設定は出力中のため変更していません。配信・録画・リプレイを停止してゲームを選び直すと反映されます')
      return
    }

    const video = await this.obs.call('GetVideoSettings').catch(() => null)
    if (video) {
      const needsVideoUpdate = video.baseWidth !== managedOutputPreset.width
        || video.baseHeight !== managedOutputPreset.height
        || video.outputWidth !== managedOutputPreset.width
        || video.outputHeight !== managedOutputPreset.height
        || video.fpsNumerator !== managedOutputPreset.fpsNumerator
        || video.fpsDenominator !== managedOutputPreset.fpsDenominator
      if (needsVideoUpdate) {
        await this.obs.call('SetVideoSettings', {
          baseWidth: managedOutputPreset.width,
          baseHeight: managedOutputPreset.height,
          outputWidth: managedOutputPreset.width,
          outputHeight: managedOutputPreset.height,
          fpsNumerator: managedOutputPreset.fpsNumerator,
          fpsDenominator: managedOutputPreset.fpsDenominator,
        }).catch((error) => warnings.push(`OBS映像を1920×1080/60 FPSへ変更できませんでした: ${error instanceof Error ? error.message : String(error)}`))
      }
    }

    const profileSettings = [
      { parameterCategory: 'AdvOut', parameterName: 'ApplyServiceSettings', parameterValue: 'false' },
      { parameterCategory: 'AdvOut', parameterName: 'UseRescale', parameterValue: 'false' },
      { parameterCategory: 'AdvOut', parameterName: 'RecUseRescale', parameterValue: 'false' },
      { parameterCategory: 'AdvOut', parameterName: 'RecEncoder', parameterValue: 'none' },
      { parameterCategory: 'AdvOut', parameterName: 'RecFormat2', parameterValue: 'mkv' },
      { parameterCategory: 'Video', parameterName: 'AutoRemux', parameterValue: 'false' },
      { parameterCategory: 'Stream1', parameterName: 'EnableMultitrackVideo', parameterValue: 'false' },
      { parameterCategory: 'SimpleOutput', parameterName: 'VBitrate', parameterValue: String(managedOutputPreset.videoBitrateKbps) },
      { parameterCategory: 'SimpleOutput', parameterName: 'ABitrate', parameterValue: String(managedOutputPreset.audioBitrateKbps) },
      ...Array.from({ length: 6 }, (_, index) => ({
        parameterCategory: 'AdvOut',
        parameterName: `Track${index + 1}Bitrate`,
        parameterValue: String(managedOutputPreset.audioBitrateKbps),
      })),
    ]
    const profileResults = await Promise.all(profileSettings.map((setting) => this.obs.call('SetProfileParameter', setting).then(() => true).catch(() => false)))
    if (profileResults.some((result) => !result)) warnings.push('OBSのFHD配信プロファイル設定を一部更新できませんでした')

  }

  private primaryVideoBitrateKbps(config: AppConfig, profile: GameProfile): number {
    return config.features.youtube && profile.youtube.enabled
      ? managedOutputPreset.videoBitrateKbps
      : managedOutputPreset.twitchVideoBitrateKbps
  }

  private async configureStreamEncoder(primaryVideoBitrateKbps: number): Promise<void> {
    const response = await this.callVendor(OBS_OUTPUT_PLUGIN_VENDOR, 'configure_stream', {
      // Keep the legacy field until every installed plugin has moved to API v4.
      // API v3 rejects the higher YouTube bitrate instead of silently applying Twitch's 6 Mbps cap
      // to the primary YouTube encoder.
      videoBitrateKbps: primaryVideoBitrateKbps,
      primaryVideoBitrateKbps,
      twitchVideoBitrateKbps: managedOutputPreset.twitchVideoBitrateKbps,
      audioBitrateKbps: managedOutputPreset.audioBitrateKbps,
    })
    if (this.outputModeReloadRequired) {
      if (this.outputModeReloadSetThisConnection) {
        throw new Error('OBS output mode changed during this connection; restart OBS before loading the Advanced output handler')
      }
      if (response.advancedHandlerReady !== true) {
        throw new Error('The output plugin could not prove that the Advanced output handler was reloaded; update the plugin and restart OBS')
      }
      this.outputModeReloadRequired = false
      this.secrets.set(outputModeReloadSecret, '')
    }
  }

  private async assertManagedStreamEncoderReady(primaryVideoBitrateKbps: number): Promise<void> {
    try {
      await this.configureStreamEncoder(primaryVideoBitrateKbps)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const restart = this.outputModeReloadRequired || /output mode must be Advanced|Advanced output handler has not loaded|restart OBS|reload the current profile|cannot change the active encoder|became active while static settings/i.test(detail)
      throw new Error(restart
        ? `A1〜A5分離録画と安定したFHD配信に必要なOBS出力機構を安全に更新できません。現在の配信・録画を停止し、OBSを再起動してから開始してください（この操作では追加の出力を開始していません）。詳細: ${detail}`
        : `安定したFHD配信に必要なエンコーダー設定を適用できないため開始しません。OBS Stream Managerプラグインを更新してOBSを再起動してください。詳細: ${detail}`)
    }
  }

  private recordingDirectory(profile: GameProfile): string {
    const configured = profile.recording.directory.trim()
    if (configured) return path.resolve(configured)
    return path.join(os.homedir(), 'Videos', 'OBS Stream Manager', recordingGameName(profile))
  }

  private async restorePreviousRecordingProfile(warnings: string[] = []): Promise<void> {
    const previous = this.secrets.get('obs-recording-previous-profile')?.trim()
    if (!previous) return
    const profiles = await this.obs.call('GetProfileList').catch(() => null)
    if (!profiles || profiles.currentProfileName !== recordingOnlyPreset.profileName) {
      this.secrets.set('obs-recording-previous-profile', '')
      return
    }
    if (!profiles.profiles.some((profileName) => profileName === previous)) {
      warnings.push(`録画専用モードの前に使用していたOBSプロファイル「${previous}」が見つからないため、自動で戻せませんでした`)
      return
    }
    await this.obs.call('SetCurrentProfile', { profileName: previous })
    this.secrets.set('obs-recording-previous-profile', '')
  }

  private async configureRecordingOnlyProfile(directory: string, filenameFormat: string): Promise<void> {
    await mkdir(directory, { recursive: true })
    const profiles = await this.obs.call('GetProfileList')
    let previousProfile = profiles.currentProfileName
    const rememberedPrevious = this.secrets.get('obs-recording-previous-profile')?.trim()
    if (previousProfile === recordingOnlyPreset.profileName && rememberedPrevious) previousProfile = rememberedPrevious
    if (previousProfile !== recordingOnlyPreset.profileName) this.secrets.set('obs-recording-previous-profile', previousProfile)

    if (!profiles.profiles.some((profileName) => profileName === recordingOnlyPreset.profileName)) {
      await this.obs.call('CreateProfile', { profileName: recordingOnlyPreset.profileName })
    } else if (profiles.currentProfileName !== recordingOnlyPreset.profileName) {
      await this.obs.call('SetCurrentProfile', { profileName: recordingOnlyPreset.profileName })
    }

    const settings = [
      { parameterCategory: 'Output', parameterName: 'Mode', parameterValue: 'Advanced' },
      { parameterCategory: 'Output', parameterName: 'FilenameFormatting', parameterValue: filenameFormat },
      { parameterCategory: 'Video', parameterName: 'AutoRemux', parameterValue: 'true' },
      { parameterCategory: 'AdvOut', parameterName: 'RecType', parameterValue: 'Standard' },
      { parameterCategory: 'AdvOut', parameterName: 'RecFilePath', parameterValue: directory },
      { parameterCategory: 'AdvOut', parameterName: 'RecFormat2', parameterValue: recordingOnlyPreset.container },
      { parameterCategory: 'AdvOut', parameterName: 'RecUseRescale', parameterValue: 'false' },
      { parameterCategory: 'AdvOut', parameterName: 'RecEncoder', parameterValue: recordingOnlyPreset.encoder },
      { parameterCategory: 'AdvOut', parameterName: 'RecTracks', parameterValue: '63' },
      { parameterCategory: 'Audio', parameterName: 'SampleRate', parameterValue: String(recordingOnlyPreset.audioSampleRate) },
      // OBS 32.2.1 can crash in OBSBasic::ResetVideo when SetVideoSettings is
      // invoked through obs-websocket while a newly created profile is still
      // loading. Persist the dedicated profile's video keys and apply them by
      // reloading the inactive profile on OBS's normal UI path instead.
      { parameterCategory: 'Video', parameterName: 'BaseCX', parameterValue: String(recordingOnlyPreset.width) },
      { parameterCategory: 'Video', parameterName: 'BaseCY', parameterValue: String(recordingOnlyPreset.height) },
      { parameterCategory: 'Video', parameterName: 'OutputCX', parameterValue: String(recordingOnlyPreset.width) },
      { parameterCategory: 'Video', parameterName: 'OutputCY', parameterValue: String(recordingOnlyPreset.height) },
      { parameterCategory: 'Video', parameterName: 'FPSType', parameterValue: '2' },
      { parameterCategory: 'Video', parameterName: 'FPSCommon', parameterValue: '60' },
      { parameterCategory: 'Video', parameterName: 'FPSNum', parameterValue: String(recordingOnlyPreset.fpsNumerator) },
      { parameterCategory: 'Video', parameterName: 'FPSDen', parameterValue: String(recordingOnlyPreset.fpsDenominator) },
      { parameterCategory: 'Video', parameterName: 'ScaleType', parameterValue: 'bicubic' },
      { parameterCategory: 'Video', parameterName: 'ColorFormat', parameterValue: 'NV12' },
      { parameterCategory: 'Video', parameterName: 'ColorSpace', parameterValue: '709' },
      { parameterCategory: 'Video', parameterName: 'ColorRange', parameterValue: 'Partial' },
    ]
    for (const setting of settings) {
      await this.obs.call('SetProfileParameter', setting).catch((error) => {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`録画専用OBSプロファイルの固定設定「${setting.parameterCategory}/${setting.parameterName}」を保存できませんでした: ${detail}`)
      })
    }

    // Output mode and encoder selection are static in OBS's Advanced output
    // handler. Reload the dedicated profile before touching its encoder so the
    // recording-only path cannot accidentally reuse the streaming encoder.
    if (previousProfile && previousProfile !== recordingOnlyPreset.profileName) {
      await this.obs.call('SetCurrentProfile', { profileName: previousProfile })
      await this.obs.call('SetCurrentProfile', { profileName: recordingOnlyPreset.profileName })
    }

    const video = await this.obs.call('GetVideoSettings')
    if (
      video.baseWidth !== recordingOnlyPreset.width
      || video.baseHeight !== recordingOnlyPreset.height
      || video.outputWidth !== recordingOnlyPreset.width
      || video.outputHeight !== recordingOnlyPreset.height
      || video.fpsNumerator !== recordingOnlyPreset.fpsNumerator
      || video.fpsDenominator !== recordingOnlyPreset.fpsDenominator
    ) {
      throw new Error('録画専用OBSプロファイルを2560×1440/60 FPSで再読み込みできませんでした')
    }

    try {
      const response = await this.callVendor(OBS_OUTPUT_PLUGIN_VENDOR, 'configure_recording', {
        rateControl: recordingOnlyPreset.rateControl,
        videoBitrateKbps: recordingOnlyPreset.videoBitrateKbps,
        maxVideoBitrateKbps: recordingOnlyPreset.maxVideoBitrateKbps,
        audioBitrateKbps: managedOutputPreset.audioBitrateKbps,
      })
      // An old plugin must not silently leave the unbounded CQP preset active.
      if (response.rateControl !== recordingOnlyPreset.rateControl
        || response.videoBitrateKbps !== recordingOnlyPreset.videoBitrateKbps
        || response.maxVideoBitrateKbps !== recordingOnlyPreset.maxVideoBitrateKbps) {
        throw new Error('録画ビットレート上限の適用を確認できませんでした')
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`録画専用NVENC設定を適用できませんでした。OBS Stream Managerプラグインを更新してOBSを再起動してください。詳細: ${detail}`)
    }
  }

  private async prepareLocalRecordingCapture(profile: GameProfile, sourceName: string, method: CaptureMethod): Promise<void> {
    if (method !== 'local' && method !== 'window') return
    const input = await this.obs.call('GetInputSettings', { inputName: sourceName })
    if (input.inputKind !== 'game_capture' && input.inputKind !== 'window_capture') return
    const executables = new Set(profile.capture.executableNames.map((name) => name.trim().toLowerCase()))
    const windows = await this.obs.call('GetInputPropertiesListPropertyItems', { inputName: sourceName, propertyName: 'window' })
    const candidates = windows.propertyItems.filter((item) => {
      if (!item.itemEnabled || typeof item.itemValue !== 'string') return false
      const executable = item.itemValue.match(/:([^:]+\.exe)$/i)?.[1]?.toLowerCase()
      if (!executable || !executables.has(executable)) return false
      // A Java executable can host many unrelated applications. OBS must expose
      // a Minecraft window as well before it is used as a Minecraft recording.
      const title = item.itemValue.split(':').slice(0, -2).join(':')
      return !/^javaw?\.exe$/.test(executable) || isMinecraftGameWindowTitle(title)
    })
    const current = input.inputSettings as Record<string, unknown>
    const target = candidates.find((item) => item.itemValue === current.window) ?? candidates[0]
    if (!target || typeof target.itemValue !== 'string') {
      throw new Error(`「${profile.displayName}」のゲーム画面をOBSで確認できません。ゲーム画面が開いてから録画してください`)
    }
    await this.obs.call('SetInputSettings', {
      inputName: sourceName,
      inputSettings: {
        window: target.itemValue,
        ...(input.inputKind === 'game_capture' ? { capture_mode: 'window' } : {}),
        priority: /:javaw?\.exe$/i.test(target.itemValue) ? 0 : 2,
      },
      overlay: true,
    })
  }

  private async assertSelectedGameCapture(profile: GameProfile, selectedSource: string, method: CaptureMethod): Promise<void> {
    const input = await this.obs.call('GetInputSettings', { inputName: selectedSource }).catch(() => null)
    if (!input) {
      throw new Error(`「${profile.displayName}」の録画ソース「${selectedSource}」がOBSに見つかりません`)
    }
    const supportedKinds = method === 'elgato'
      ? new Set(['dshow_input', 'decklink-input'])
      : method === 'display'
        ? new Set(['monitor_capture', 'display_capture'])
        : method === 'window'
          ? new Set(['window_capture'])
          : new Set(['game_capture', 'window_capture'])
    if (!supportedKinds.has(input.inputKind)) {
      throw new Error(`「${profile.displayName}」の録画ソース「${selectedSource}」が選択した取得方法と一致しません（現在: ${input.inputKind}）`)
    }
    if (input.inputKind === 'game_capture' || input.inputKind === 'window_capture') {
      const settings = input.inputSettings as Record<string, unknown>
      const targetWindow = typeof settings.window === 'string' ? settings.window : ''
      const targetExecutable = targetWindow.match(/:([^:]+\.exe)$/i)?.[1]
      const expectedExecutables = method === 'geforce_now' ? ['GeForceNOW.exe'] : profile.capture.executableNames
      if (targetExecutable && (input.inputKind === 'window_capture' || settings.capture_mode === 'window')
        && !expectedExecutables.some((name) => name.localeCompare(targetExecutable, undefined, { sensitivity: 'accent' }) === 0)) {
        throw new Error(`ゲームキャプチャ「${selectedSource}」は「${profile.displayName}」ではなく${targetExecutable}を対象にしています`)
      }
    }
  }

  private async waitForRemuxedMp4(outputPath: string): Promise<string | null> {
    if (!outputPath.toLowerCase().endsWith('.mkv')) return null
    const candidate = outputPath.slice(0, -4) + '.mp4'
    const deadline = Date.now() + 30_000
    do {
      const info = await stat(candidate).catch(() => null)
      if (info?.isFile() && info.size > 0) return candidate
      await wait(500)
    } while (Date.now() < deadline)
    return null
  }

  private async ensureStockBgmInput(filename: string, playbackMode: BgmPlaybackMode): Promise<void> {
    const looping = playbackMode === 'loop'
    const sceneList = await this.obs.call('GetSceneList')
    let created = false
    try {
      const input = await this.obs.call('GetInputSettings', { inputName: stockBgmInputName })
      if (input.inputKind !== 'ffmpeg_source') throw new Error(`OBSソース「${stockBgmInputName}」がメディアソースではありません`)
      await this.obs.call('SetInputSettings', {
        inputName: stockBgmInputName,
        inputSettings: { is_local_file: true, local_file: filename, looping, restart_on_activate: false, close_when_inactive: false },
        overlay: true,
      })
    } catch (error) {
      if (error instanceof Error && error.message.includes('メディアソースではありません')) throw error
      await this.obs.call('CreateInput', {
        sceneName: sceneList.currentProgramSceneName,
        inputName: stockBgmInputName,
        inputKind: 'ffmpeg_source',
        inputSettings: { is_local_file: true, local_file: filename, looping, restart_on_activate: false, close_when_inactive: false },
        sceneItemEnabled: true,
      })
      created = true
    }

    for (const scene of sceneList.scenes) {
      const sceneName = typeof scene.sceneName === 'string' ? scene.sceneName : null
      if (!sceneName || created && sceneName === sceneList.currentProgramSceneName) continue
      const sceneItemId = await this.obs.call('GetSceneItemId', { sceneName, sourceName: stockBgmInputName })
        .then((item) => item.sceneItemId)
        .catch(() => null)
      if (sceneItemId === null) {
        await this.obs.call('CreateSceneItem', { sceneName, sourceName: stockBgmInputName, sceneItemEnabled: true })
      } else {
        await this.obs.call('SetSceneItemEnabled', { sceneName, sceneItemId, sceneItemEnabled: true })
      }
    }
  }

  private async configureStockBgm(config: AppConfig, filename: string, volumeDb: number, playbackMode: BgmPlaybackMode): Promise<void> {
    await this.connect(config)
    await this.ensureStockBgmInput(filename, playbackMode)
    const advanced = await this.obs.call('GetProfileParameter', { parameterCategory: 'Output', parameterName: 'Mode' })
      .then(({ parameterValue }) => parameterValue === 'Advanced')
      .catch(() => false)
    await this.obs.call('SetInputAudioTracks', {
      inputName: stockBgmInputName,
      inputAudioTracks: this.audioTrackSelection(advanced ? 4 : 5, advanced ? 6 : 1),
    }).catch(() => undefined)
    await this.obs.call('SetInputVolume', { inputName: stockBgmInputName, inputVolumeDb: volumeDb })
  }

  async prepareBgm(config: AppConfig, filename: string, volumeDb: number, playbackMode: BgmPlaybackMode, autoPlay: boolean): Promise<void> {
    await this.configureStockBgm(config, filename, volumeDb, playbackMode)
    await this.obs.call('TriggerMediaInputAction', {
      inputName: stockBgmInputName,
      mediaAction: autoPlay ? 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART' : 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP',
    })
  }

  async playBgm(config: AppConfig, filename: string, volumeDb = -25, restart = true, playbackMode: BgmPlaybackMode = 'loop'): Promise<void> {
    await this.configureStockBgm(config, filename, volumeDb, playbackMode)
    await this.obs.call('TriggerMediaInputAction', {
      inputName: stockBgmInputName,
      mediaAction: restart ? 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART' : 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY',
    })
  }

  async controlBgm(config: AppConfig, action: BgmControlAction): Promise<void> {
    await this.connect(config)
    const actions: Record<BgmControlAction, string> = {
      play: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY',
      pause: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE',
      stop: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP',
      restart: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART',
    }
    await this.obs.call('TriggerMediaInputAction', { inputName: stockBgmInputName, mediaAction: actions[action] })
  }

  async stopBgm(config: AppConfig): Promise<void> {
    await this.connect(config)
    await this.obs.call('TriggerMediaInputAction', {
      inputName: stockBgmInputName,
      mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP',
    }).catch(() => undefined)
  }

  async clearBgm(config: AppConfig): Promise<void> {
    await this.connect(config)
    await this.obs.call('TriggerMediaInputAction', { inputName: stockBgmInputName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP' }).catch(() => undefined)
    const sceneList = await this.obs.call('GetSceneList')
    for (const scene of sceneList.scenes) {
      const sceneName = typeof scene.sceneName === 'string' ? scene.sceneName : null
      if (!sceneName) continue
      const items = await this.obs.call('GetSceneItemList', { sceneName })
      for (const item of items.sceneItems) {
        if (item.sourceName !== stockBgmInputName || typeof item.sceneItemId !== 'number') continue
        await this.obs.call('RemoveSceneItem', { sceneName, sceneItemId: item.sceneItemId })
      }
    }
    await this.obs.call('RemoveInput', { inputName: stockBgmInputName }).catch(() => undefined)
  }

  async bgmPlaybackStatus(config: AppConfig): Promise<BgmPlayback> {
    try {
      await this.connect(config)
      const status = await this.obs.call('GetMediaInputStatus', { inputName: stockBgmInputName })
      const states: Record<string, BgmPlayback['state']> = {
        OBS_MEDIA_STATE_PLAYING: 'playing',
        OBS_MEDIA_STATE_PAUSED: 'paused',
      }
      return {
        state: states[status.mediaState] ?? 'stopped',
        cursorMs: Number.isFinite(status.mediaCursor) ? status.mediaCursor : null,
        durationMs: Number.isFinite(status.mediaDuration) ? status.mediaDuration : null,
      }
    } catch {
      return { state: 'unavailable', cursorMs: null, durationMs: null }
    }
  }

  private async callVendor(vendorName: string, requestType: string, requestData: Record<string, string | number | boolean | null> = {}): Promise<Record<string, unknown>> {
    const response = await this.obs.call('CallVendorRequest', { vendorName, requestType, requestData })
    if (response.responseData.success === false) {
      const error = typeof response.responseData.error === 'string' ? response.responseData.error : 'vendor request failed'
      throw new Error(error)
    }
    return response.responseData
  }

  private async getTwitchOutputPluginStatus(): Promise<TwitchOutputPluginStatus> {
    const installState = process.env.OBS_STREAM_MANAGER_OBS_PLUGIN_INSTALL_STATE
    const permissionDetail = 'OBS副出力プラグインの更新権限がありません。インストール版で一度更新するか、このアプリを一度だけ管理者として起動してください'
    try {
      const response = await this.callVendor(OBS_OUTPUT_PLUGIN_VENDOR, 'twitch_status')
      const version = typeof response.pluginVersion === 'string' ? response.pluginVersion : undefined
      const apiVersion = typeof response.apiVersion === 'number' ? response.apiVersion : undefined
      if (apiVersion !== twitchOutputPluginApiVersion) {
        if (installState === 'permission_required') {
          return { state: 'install_failed', version, detail: permissionDetail, outputActive: response.outputActive === true }
        }
        const restartRequired = installState === 'installed' || installState === 'pending'
        const updateDetail = installState === 'pending'
          ? 'OBS Stream Manager Outputの更新待ちです。OBSを一度終了すると自動で入れ替わり、次回起動から使えます'
          : 'OBS Stream Manager Outputを更新しました。OBSを再起動してください'
        return {
          state: restartRequired ? 'restart_required' : 'incompatible',
          version,
          detail: restartRequired
            ? updateDetail
            : 'OBS Stream Manager Outputの互換性を確認できません。アプリを再インストールしてOBSを再起動してください',
          outputActive: response.outputActive === true,
        }
      }
      return { state: 'ready', version, detail: `OBS副出力プラグイン ${version ?? '互換版'} は利用可能です`, outputActive: response.outputActive === true }
    } catch {
      if (installState === 'installed' || installState === 'pending') {
        return {
          state: 'restart_required',
          detail: installState === 'pending'
            ? 'OBS副出力プラグインの更新待ちです。OBSを一度終了すると自動で入れ替わり、次回起動から使えます'
            : 'OBS副出力プラグインを反映するためOBSを再起動してください',
          outputActive: false,
        }
      }
      if (installState === 'unavailable') {
        return { state: 'install_failed', detail: 'OBS副出力プラグインを配置できませんでした。アプリを再インストールしてください', outputActive: false }
      }
      if (installState === 'permission_required') {
        return {
          state: 'install_failed',
          detail: permissionDetail,
          outputActive: false,
        }
      }
      return { state: 'missing', detail: 'OBS副出力プラグインが読み込まれていません。OBSを再起動してください', outputActive: false }
    }
  }

  private async startTwitchSecondary(credentials?: { server: string; key: string }): Promise<void> {
    const plugin = await this.getTwitchOutputPluginStatus()
    if (plugin.state !== 'ready') throw new Error(plugin.detail)
    const startedHere = !plugin.outputActive
    if (startedHere) {
      const key = credentials?.key ?? this.secrets.get('twitch-stream-key')
      const server = credentials?.server ?? this.secrets.get('twitch-stream-server')
      if (!key || !server) throw new Error('Twitchへの映像送信準備が未完了です。Twitchを再接続してください')
      try {
        await this.callVendor(OBS_OUTPUT_PLUGIN_VENDOR, 'start_twitch', { server, key })
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        if (detail.toLowerCase().includes('no vendor was found')) {
          throw new Error('OBS Stream Manager OutputプラグインがOBSに読み込まれていません。OBSを再起動してください')
        }
        throw new Error(`Twitch副出力を開始できませんでした: ${detail}`)
      }
    }
    try {
      const deadline = Date.now() + this.streamStartTimeoutMs
      const pollIntervalMs = Math.min(250, Math.max(10, Math.floor(this.streamStartTimeoutMs / 4)))
      const measurementWindowMs = Math.min(1_000, Math.max(20, Math.floor(this.streamStartTimeoutMs / 2)))
      const minimumFrameRate = (managedOutputPreset.fpsNumerator / managedOutputPreset.fpsDenominator) * 0.85
      let baseline: { deliveredFrames: number; sampledAt: number } | null = null
      do {
        const status = await this.callVendor(OBS_OUTPUT_PLUGIN_VENDOR, 'twitch_status')
        const totalFrames = typeof status.totalFrames === 'number' && Number.isFinite(status.totalFrames)
          ? status.totalFrames
          : null
        const skippedFrames = typeof status.skippedFrames === 'number' && Number.isFinite(status.skippedFrames)
          ? status.skippedFrames
          : 0
        const deliveredFrames = totalFrames === null ? null : Math.max(0, totalFrames - skippedFrames)
        if (status.outputActive === true) {
          const width = typeof status.videoWidth === 'number' ? status.videoWidth : null
          const height = typeof status.videoHeight === 'number' ? status.videoHeight : null
          const fpsNumerator = typeof status.fpsNumerator === 'number' ? status.fpsNumerator : null
          const fpsDenominator = typeof status.fpsDenominator === 'number' ? status.fpsDenominator : null
          const fps = fpsNumerator !== null && fpsDenominator !== null && fpsDenominator > 0
            ? fpsNumerator / fpsDenominator
            : null
          const expectedFps = managedOutputPreset.fpsNumerator / managedOutputPreset.fpsDenominator
          let videoError: string | null = null
          if (status.dedicatedEncoder !== true || status.dedicatedVideoEncoder !== true) {
            videoError = '専用映像エンコーダーを確認できません'
          } else if (status.sharedPrimaryAudioEncoder !== true || status.audioMixerIndex !== 5) {
            videoError = '配信用A6 STREAM MIXの共有音声エンコーダーを確認できません'
          } else if (width !== managedOutputPreset.width || height !== managedOutputPreset.height) {
            videoError = `映像サイズが${width ?? '?'}x${height ?? '?'}です（必要: ${managedOutputPreset.width}x${managedOutputPreset.height}）`
          } else if (fps === null || Math.abs(fps - expectedFps) > 0.01) {
            videoError = `フレームレートが${fps === null ? '?' : fps.toFixed(2)}fpsです（必要: ${expectedFps}fps）`
          }
          if (videoError) throw new Error(`Twitch副出力の映像設定が不正です: ${videoError}`)

          // "Active" is true during RTMP warm-up and can remain true while the
          // encoder is effectively stalled. A one-frame increase is also not
          // enough: the reported failure produced roughly 1 FPS while staying
          // active. Measure a real window and require near-60 FPS throughput.
          if (deliveredFrames !== null) {
            const sampledAt = Date.now()
            if (!baseline || deliveredFrames < baseline.deliveredFrames) {
              baseline = { deliveredFrames, sampledAt }
            } else if (sampledAt - baseline.sampledAt >= measurementWindowMs) {
              const measuredFrameRate = (deliveredFrames - baseline.deliveredFrames) * 1_000 / (sampledAt - baseline.sampledAt)
              if (measuredFrameRate >= minimumFrameRate) return
              baseline = { deliveredFrames, sampledAt }
            }
          }
        }
        await wait(pollIntervalMs)
      } while (Date.now() < deadline)
      throw new Error('Twitch副出力の映像が安定した60 FPSで進みませんでした')
    } catch (error) {
      // A pre-existing secondary output is still stopped when validation proves
      // it unhealthy; leaving it active would keep the failed encoder load on
      // the primary stream while the orchestrator only reports a warning.
      try {
        await this.callVendor(OBS_OUTPUT_PLUGIN_VENDOR, 'stop_twitch')
      } catch (stopError) {
        const validationDetail = error instanceof Error ? error.message : String(error)
        const stopDetail = stopError instanceof Error ? stopError.message : String(stopError)
        throw new Error(`${validationDetail} / 異常なTwitch副出力の停止にも失敗しました。OBSを再起動して出力を止めてください。詳細: ${stopDetail}`)
      }
      throw error
    }
  }

  private async stopTwitchSecondary(): Promise<void> {
    await this.callVendor(OBS_OUTPUT_PLUGIN_VENDOR, 'stop_twitch')
  }

  private async callVertical(requestType: 'start_recording' | 'stop_recording' | 'stop_backtrack'): Promise<void> {
    try {
      await this.callVendor('aitum-vertical-canvas', requestType)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.toLowerCase().includes('no vendor was found')) throw error
      const hotkeyNames = {
        start_recording: 'VerticalCanvasDockStartRecording',
        stop_recording: 'VerticalCanvasDockStopRecording',
        stop_backtrack: 'VerticalCanvasDockStopBacktrack',
      } as const
      try {
        await this.obs.call('TriggerHotkeyByName', {
          hotkeyName: hotkeyNames[requestType],
        })
      } catch (hotkeyError) {
        const hotkeyMessage = hotkeyError instanceof Error ? hotkeyError.message : String(hotkeyError)
        const missingHotkey = hotkeyMessage.toLowerCase().includes('no hotkeys were found')
        // Stop operations are global, idempotent teardown. A missing Aitum vendor
        // and missing Aitum hotkey means there is simply no vertical output to stop.
        if (requestType !== 'start_recording' && missingHotkey) return
        throw hotkeyError
      }
    }
  }

  private async stopVerticalBacktrackIfActive(): Promise<boolean> {
    try {
      const status = await this.callVendor('aitum-vertical-canvas', 'status')
      if (status.backtrack !== true) return false
      await this.callVertical('stop_backtrack')
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.toLowerCase().includes('no vendor was found')) return false
      throw error
    }
  }

  private async protectSimulcastPerformance(
    protection: { protected: boolean; width: number; height: number },
    warnings: string[],
  ): Promise<void> {
    if (!protection.protected) return
    try {
      if (await this.stopVerticalBacktrackIfActive()) {
        warnings.push('YouTube・Twitch同時配信と通常録画をFHD 60 FPSで維持するため、Aitum Vertical Backtrackを停止しました')
      }
    } catch (error) {
      warnings.push(`Aitum Vertical Backtrackの停止を確認できませんでした: ${error instanceof Error ? error.message : String(error)}。Aitum VerticalでBacktrackを停止してください`)
    }
  }

  private async verticalSceneReady(): Promise<{ ready: boolean; sceneName: string }> {
    let current: Record<string, unknown> = {}
    try {
      current = await this.callVendor('aitum-vertical-canvas', 'current_scene')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.toLowerCase().includes('no vendor was found')) throw error
    }
    const sceneName = typeof current.scene === 'string' ? current.scene.trim() : 'Vertical Scene'
    if (!sceneName) return { ready: false, sceneName: 'Vertical Scene' }
    const scene = await this.obs.call('GetSceneItemList', { sceneName }).catch(() => null)
    if (!scene || !Array.isArray(scene.sceneItems)) return { ready: true, sceneName }
    return {
      sceneName,
      ready: scene.sceneItems.some((item) => item.sceneItemEnabled !== false),
    }
  }

  private async stopSourceRecord(): Promise<void> {
    try {
      await this.callVendor('source-record', 'record_stop')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.toLowerCase().includes('no source found')) return
      throw error
    }
  }

  private async getReplayBufferStatus(): Promise<{ outputActive: boolean }> {
    try {
      return await this.obs.call('GetReplayBufferStatus')
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 604) return { outputActive: false }
      throw error
    }
  }

  private async setCompatibleProfileParameter(
    options: ReadonlyArray<{ parameterCategory: string; parameterName: string }>,
    parameterValue: string,
  ): Promise<boolean> {
    let applied = false
    for (const { parameterCategory, parameterName } of options) {
      try {
        await this.obs.call('SetProfileParameter', { parameterCategory, parameterName, parameterValue })
        applied = true
      } catch { /* OBS output modes expose different parameter categories */ }
    }
    return applied
  }

  private async configureManagedStream(streamServer: string, streamKey: string): Promise<boolean> {
    const current = await this.obs.call('GetStreamServiceSettings')
    const currentSettings = current.streamServiceSettings as Record<string, unknown>
    const alreadyConfigured = current.streamServiceType === 'rtmp_custom'
      && currentSettings.server === streamServer
      && currentSettings.key === streamKey
    const savedPrevious = this.secrets.get('obs-previous-stream-service')
    const savedApplied = this.secrets.get('obs-applied-stream-service')
    let savedPairMatchesCurrent = false
    if (savedPrevious && savedApplied) {
      try {
        const previous = JSON.parse(savedPrevious) as Partial<StreamServiceSettings>
        const applied = JSON.parse(savedApplied) as Partial<AppliedStreamService>
        savedPairMatchesCurrent = typeof previous.streamServiceType === 'string'
          && Boolean(previous.streamServiceSettings && typeof previous.streamServiceSettings === 'object')
          && current.streamServiceType === applied.streamServiceType
          && currentSettings.server === applied.server
          && currentSettings.key === applied.key
      } catch { /* invalid snapshots are replaced with the current OBS service below */ }
    }
    if (alreadyConfigured) {
      this.streamServiceManaged = savedPairMatchesCurrent
      if (!savedPairMatchesCurrent) {
        this.secrets.set('obs-applied-stream-service', '')
        this.secrets.set('obs-previous-stream-service', '')
      }
      return false
    }
    if (!savedPairMatchesCurrent) {
      this.secrets.set('obs-previous-stream-service', JSON.stringify(current))
      this.secrets.set('obs-applied-stream-service', '')
    }
    await this.obs.call('SetStreamServiceSettings', {
      streamServiceType: 'rtmp_custom',
      streamServiceSettings: {
        server: streamServer,
        key: streamKey,
        use_auth: false,
      },
    })
    this.secrets.set('obs-applied-stream-service', JSON.stringify({ streamServiceType: 'rtmp_custom', server: streamServer, key: streamKey } satisfies AppliedStreamService))
    this.streamServiceManaged = true
    return true
  }

  private async configurePrimaryStream(config: AppConfig, profile: GameProfile): Promise<boolean> {
    if (config.features.youtube && profile.youtube.enabled) {
      const streamKey = this.secrets.get('youtube-stream-key')
      if (!streamKey) throw new Error('YouTube 配信キーが未取得です。現在のゲーム設定は保持されます。配信開始をもう一度実行して自動再準備してください')
      const streamServer = this.secrets.get('youtube-stream-server')
      if (!streamServer) throw new Error('YouTube 配信サーバーが未取得です。現在のゲーム設定は保持されます。配信開始をもう一度実行して自動再準備してください')
      return this.configureManagedStream(streamServer, streamKey)
    }
    if (config.features.twitch && profile.twitch.enabled) {
      const streamKey = this.secrets.get('twitch-stream-key')
      if (!streamKey) throw new Error('Twitch 配信キーが未取得です。Twitchを再接続してください')
      const streamServer = this.secrets.get('twitch-stream-server')
      if (!streamServer) throw new Error('Twitch 配信サーバーが未取得です。Twitchを再接続してください')
      return this.configureManagedStream(streamServer, streamKey)
    }
    return false
  }

  async preparePrimaryStream(config: AppConfig, profile: GameProfile): Promise<void> {
    await this.connect(config)
    if (streamOutputRunning(await this.obs.call('GetStreamStatus'))) {
      throw Object.assign(new Error('OBS配信中は配信先を変更できません'), { statusCode: 409 })
    }
    await this.configurePrimaryStream(config, profile)
  }

  async startSecondaryTwitchForObsStream(config: AppConfig, profile: GameProfile): Promise<string[]> {
    const warnings: string[] = []
    if (!(config.features.youtube && profile.youtube.enabled && config.features.twitch && profile.twitch.enabled)) return warnings
    await this.connect(config)
    const protection = await this.simulcastPerformanceProtection(config, profile)
    await this.protectSimulcastPerformance(protection, warnings)
    await this.assertManagedStreamEncoderReady(this.primaryVideoBitrateKbps(config, profile))
    await this.startTwitchSecondary()
    this.started.twitch = true
    return warnings
  }

  async finishObsTriggeredStream(config: AppConfig): Promise<string[]> {
    await this.connect(config)
    // OBS本体の「配信停止」もアプリの「配信終了」と同じ終了操作として扱う。
    // 配信開始時に連動して起動した録画・リプレイバッファーなどを残さない。
    return this.stopOutputs()
  }

  private async restorePreviousStreamService(): Promise<void> {
    const serialized = this.secrets.get('obs-previous-stream-service')
    if (!serialized) {
      this.streamServiceManaged = false
      return
    }
    if (!this.streamServiceManaged) {
      this.secrets.set('obs-applied-stream-service', '')
      this.secrets.set('obs-previous-stream-service', '')
      return
    }
    const appliedSerialized = this.secrets.get('obs-applied-stream-service')
    if (!appliedSerialized) {
      this.streamServiceManaged = false
      this.secrets.set('obs-previous-stream-service', '')
      return
    }
    const parsed = JSON.parse(serialized) as Partial<StreamServiceSettings>
    const applied = JSON.parse(appliedSerialized) as Partial<AppliedStreamService>
    if (typeof parsed.streamServiceType !== 'string' || !parsed.streamServiceSettings || typeof parsed.streamServiceSettings !== 'object') {
      throw new Error('保存したOBS配信サービス設定が壊れています')
    }
    const current = await this.obs.call('GetStreamServiceSettings')
    const currentSettings = current.streamServiceSettings as Record<string, unknown>
    const stillManagerApplied = current.streamServiceType === applied.streamServiceType
      && currentSettings.server === applied.server
      && currentSettings.key === applied.key
    if (!stillManagerApplied) {
      this.streamServiceManaged = false
      this.secrets.set('obs-applied-stream-service', '')
      this.secrets.set('obs-previous-stream-service', '')
      return
    }
    await this.obs.call('SetStreamServiceSettings', parsed as StreamServiceSettings)
    this.streamServiceManaged = false
    this.secrets.set('obs-applied-stream-service', '')
    this.secrets.set('obs-previous-stream-service', '')
  }

  private async waitForStreamActive(): Promise<boolean> {
    const deadline = Date.now() + this.streamStartTimeoutMs
    do {
      const status = await this.obs.call('GetStreamStatus')
      if (status.outputActive) return true
      await wait(250)
    } while (Date.now() < deadline)
    return false
  }

  private async waitForStreamInactive(): Promise<boolean> {
    const deadline = Date.now() + this.streamStopTimeoutMs
    do {
      const status = await this.obs.call('GetStreamStatus')
      if (!streamOutputRunning(status)) return true
      await wait(250)
    } while (Date.now() < deadline)
    return false
  }

  private async waitForRecordInactive(): Promise<boolean> {
    const deadline = Date.now() + this.streamStopTimeoutMs
    do {
      if (!(await this.obs.call('GetRecordStatus')).outputActive) return true
      await wait(250)
    } while (Date.now() < deadline)
    return false
  }

  private async waitForRecordActive(): Promise<boolean> {
    const deadline = Date.now() + this.streamStartTimeoutMs
    do {
      if ((await this.obs.call('GetRecordStatus')).outputActive) return true
      await wait(250)
    } while (Date.now() < deadline)
    return false
  }

  private async waitForOutputFrameProgress(
    readStatus: () => Promise<StreamOutputStatus & { outputTotalFrames?: number; outputSkippedFrames?: number }>,
  ): Promise<boolean> {
    const deadline = Date.now() + this.streamStartTimeoutMs
    const pollIntervalMs = Math.min(250, Math.max(10, Math.floor(this.streamStartTimeoutMs / 4)))
    const measurementWindowMs = Math.min(1_000, Math.max(20, Math.floor(this.streamStartTimeoutMs / 2)))
    const minimumFrameRate = (managedOutputPreset.fpsNumerator / managedOutputPreset.fpsDenominator) * 0.85
    let baseline: { deliveredFrames: number; sampledAt: number } | null = null
    do {
      const status = await readStatus()
      if (status.outputReconnecting) {
        baseline = null
        await wait(pollIntervalMs)
        continue
      }
      if (!status.outputActive) return false
      const totalFrames = typeof status.outputTotalFrames === 'number' && Number.isFinite(status.outputTotalFrames)
        ? status.outputTotalFrames
        : null
      const skippedFrames = typeof status.outputSkippedFrames === 'number' && Number.isFinite(status.outputSkippedFrames)
        ? status.outputSkippedFrames
        : 0
      const deliveredFrames = totalFrames === null ? null : Math.max(0, totalFrames - skippedFrames)
      if (deliveredFrames !== null) {
        const sampledAt = Date.now()
        if (!baseline || deliveredFrames < baseline.deliveredFrames) {
          baseline = { deliveredFrames, sampledAt }
        } else if (sampledAt - baseline.sampledAt >= measurementWindowMs) {
          const measuredFrameRate = (deliveredFrames - baseline.deliveredFrames) * 1_000 / (sampledAt - baseline.sampledAt)
          if (measuredFrameRate >= minimumFrameRate) return true
          baseline = { deliveredFrames, sampledAt }
        }
      }
      await wait(pollIntervalMs)
    } while (Date.now() < deadline)
    return false
  }

  private async waitForStreamFrameProgress(): Promise<boolean> {
    return this.waitForOutputFrameProgress(() => this.obs.call('GetStreamStatus'))
  }

  private async waitForRecordFrameProgress(): Promise<boolean> {
    const deadline = Date.now() + this.streamStartTimeoutMs
    const pollIntervalMs = Math.min(250, Math.max(10, Math.floor(this.streamStartTimeoutMs / 4)))
    const measurementWindowMs = Math.min(1_000, Math.max(20, Math.floor(this.streamStartTimeoutMs / 2)))
    let baseline: { durationMs: number; bytes: number; sampledAt: number } | null = null
    do {
      const status = await this.obs.call('GetRecordStatus')
      if (!status.outputActive) return false
      const durationMs = status.outputDuration
      const bytes = status.outputBytes
      const sampledAt = Date.now()
      if (!baseline || durationMs < baseline.durationMs || bytes < baseline.bytes) {
        baseline = { durationMs, bytes, sampledAt }
      } else if (sampledAt - baseline.sampledAt >= measurementWindowMs) {
        if (durationMs > baseline.durationMs && bytes > baseline.bytes) return true
        baseline = { durationMs, bytes, sampledAt }
      }
      await wait(pollIntervalMs)
    } while (Date.now() < deadline)
    return false
  }

  private async waitForReplayInactive(): Promise<boolean> {
    const deadline = Date.now() + this.streamStopTimeoutMs
    do {
      if (!(await this.getReplayBufferStatus()).outputActive) return true
      await wait(250)
    } while (Date.now() < deadline)
    return false
  }


  private async waitForReplayActive(): Promise<boolean> {
    const deadline = Date.now() + this.streamStartTimeoutMs
    do {
      if ((await this.getReplayBufferStatus()).outputActive) return true
      await wait(250)
    } while (Date.now() < deadline)
    return false
  }

  async testTwitchIngest(
    config: AppConfig,
    durationMs = 15_000,
    options: TwitchIngestTestOptions = {},
    activeGameAudioInput?: string,
  ): Promise<TwitchIngestTestResult> {
    await this.connect(config)
    const [currentStream, currentRecord, currentReplay] = await Promise.all([
      this.obs.call('GetStreamStatus'),
      this.obs.call('GetRecordStatus'),
      this.getReplayBufferStatus(),
    ])
    // Even a primary-only diagnostic must not overlap a secondary output that
    // is already live. includeSecondary controls the test load, not this guard.
    const currentSecondary = await this.getTwitchOutputPluginStatus()
    if (streamOutputRunning(currentStream) || currentRecord.outputActive || currentReplay.outputActive || currentSecondary?.outputActive) {
      throw Object.assign(new Error('出力中はTwitch出力テストを実行できません。配信・録画・リプレイ・Twitch副出力を停止してから再実行してください'), { statusCode: 409 })
    }
    const streamKey = this.secrets.get('twitch-stream-key')
    const streamServer = this.secrets.get('twitch-stream-server')
    if (!streamKey || !streamServer) throw new Error('Twitchへの映像送信準備が未完了です。Twitchを再接続してください')
    const testKey = `${streamKey}${streamKey.includes('?') ? '&' : '?'}bandwidthtest=true`
    const boundedDurationMs = Math.max(1_000, Math.min(30_000, durationMs))
    let started = false
    let secondaryStarted = false
    let recordingStarted = false
    let replayStarted = false
    let changed = false
    let encoderConfigured = false
    let verticalBacktrackStopped = false
    const warnings: string[] = []
    try {
      await this.configureManagedOutput(warnings)
      await this.configureSeparatedAudioTracks(config, warnings, activeGameAudioInput)
      const video = await this.obs.call('GetVideoSettings').catch(() => null)
      // The stress test is meant to reproduce the real two-destination load.
      // Backtrack is another encoder even at FHD, so stop it whenever the
      // dedicated Twitch output participates, matching the production start
      // path rather than accidentally testing an overloaded configuration.
      if (options.includeSecondary !== false) {
        verticalBacktrackStopped = await this.stopVerticalBacktrackIfActive().catch(() => false)
      }
      changed = await this.configureManagedStream(streamServer, testKey)
      const primaryVideoBitrateKbps = managedOutputPreset.twitchVideoBitrateKbps
      await this.assertManagedStreamEncoderReady(primaryVideoBitrateKbps)
      encoderConfigured = true
      await this.obs.call('StartStream')
      started = true
      if (!await this.waitForStreamActive()) throw new Error('OBSからTwitchテスト出力を開始できませんでした')
      if (!await this.waitForStreamFrameProgress()) throw new Error('OBSのTwitchテスト出力は開始状態ですが、映像が安定した60 FPSで進みませんでした')
      if (options.includeSecondary !== false) {
        await this.startTwitchSecondary({ server: streamServer, key: testKey })
        secondaryStarted = true
      }
      if (options.includeRecording) {
        await this.obs.call('StartRecord')
        recordingStarted = true
        if (!await this.waitForRecordActive()) throw new Error('負荷テスト用の通常録画を開始できませんでした')
      }
      if (options.includeReplayBuffer) {
        await this.obs.call('StartReplayBuffer')
        replayStarted = true
        if (!await this.waitForReplayActive()) throw new Error('負荷テスト用のリプレイバッファを開始できませんでした')
      }
      const measurementStartedAt = Date.now()
      const [streamBaseline, secondaryBaseline, recordBaseline, baselineStats] = await Promise.all([
        this.obs.call('GetStreamStatus'),
        secondaryStarted ? this.callVendor(OBS_OUTPUT_PLUGIN_VENDOR, 'twitch_status') : Promise.resolve(null),
        recordingStarted ? this.obs.call('GetRecordStatus') : Promise.resolve(null),
        this.obs.call('GetStats'),
      ])
      await wait(boundedDurationMs)
      const [status, secondaryStatus, recordStatus, replayStatus, stats] = await Promise.all([
        this.obs.call('GetStreamStatus'),
        secondaryStarted ? this.callVendor(OBS_OUTPUT_PLUGIN_VENDOR, 'twitch_status') : Promise.resolve(null),
        recordingStarted ? this.obs.call('GetRecordStatus') : Promise.resolve(null),
        replayStarted ? this.getReplayBufferStatus() : Promise.resolve(null),
        this.obs.call('GetStats'),
      ])
      if (!status.outputActive) throw new Error('Twitchテスト出力が途中で停止しました。OBSログを確認してください')
      if (secondaryStarted && secondaryStatus?.outputActive !== true) throw new Error('Twitch副出力テストが途中で停止しました。OBSログを確認してください')
      if (recordingStarted && recordStatus?.outputActive !== true) throw new Error('負荷テスト用の通常録画が途中で停止しました')
      if (replayStarted && replayStatus?.outputActive !== true) throw new Error('負荷テスト用のリプレイバッファが途中で停止しました')
      const numeric = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0
      const outputMetric = (output: Record<string, unknown>, websocketName: string, vendorName: string) => numeric(output[websocketName] ?? output[vendorName])
      const metrics = (output: Record<string, unknown> | null, baseline: Record<string, unknown> | null, fallbackDurationMs: number) => {
        if (!output) return null
        const durationMs = baseline && typeof output.outputDuration === 'number' && typeof baseline.outputDuration === 'number'
          ? Math.max(0, output.outputDuration - baseline.outputDuration)
          : fallbackDurationMs
        const totalFrames = Math.max(0, outputMetric(output, 'outputTotalFrames', 'totalFrames') - (baseline ? outputMetric(baseline, 'outputTotalFrames', 'totalFrames') : 0))
        const skippedFrames = Math.max(0, outputMetric(output, 'outputSkippedFrames', 'skippedFrames') - (baseline ? outputMetric(baseline, 'outputSkippedFrames', 'skippedFrames') : 0))
        return {
          durationMs,
          bytesSent: Math.max(0, outputMetric(output, 'outputBytes', 'bytesSent') - (baseline ? outputMetric(baseline, 'outputBytes', 'bytesSent') : 0)),
          totalFrames,
          skippedFrames,
          measuredFps: durationMs > 0 ? Math.max(0, totalFrames - skippedFrames) * 1_000 / durationMs : 0,
        }
      }
      const measuredDurationMs = Date.now() - measurementStartedAt
      const primaryMetrics = metrics(status, streamBaseline, measuredDurationMs)
      const primaryMeasuredFps = primaryMetrics?.measuredFps ?? 0
      const secondaryMetrics = metrics(secondaryStatus, secondaryBaseline, measuredDurationMs)
      const recordingMetrics = recordStatus && recordBaseline
        ? {
            durationMs: Math.max(0, numeric(recordStatus.outputDuration) - numeric(recordBaseline.outputDuration)),
            bytesWritten: Math.max(0, numeric(recordStatus.outputBytes) - numeric(recordBaseline.outputBytes)),
          }
        : null
      // obs-websocket exposes only whether the replay buffer is active. Do not
      // publish invented duration, byte, or frame counters for this output.
      const replayMetrics = replayStarted && replayStatus?.outputActive === true ? { active: true as const } : null
      const minimumHealthyFps = (managedOutputPreset.fpsNumerator / managedOutputPreset.fpsDenominator) * 0.85
      if (measuredDurationMs < 1_000) {
        throw new Error(`実運用負荷の計測時間が短すぎます（${measuredDurationMs} ms）。1秒以上の映像進行を確認できませんでした`)
      }
      if (measuredDurationMs >= 1_000) {
        const minimumRecordingProgressMs = measuredDurationMs * 0.5
        const frameRateFailures = [
          primaryMeasuredFps >= minimumHealthyFps ? null : `主配信 ${primaryMeasuredFps.toFixed(2)} FPS`,
          secondaryMetrics && secondaryMetrics.measuredFps < minimumHealthyFps ? `Twitch副出力 ${secondaryMetrics.measuredFps.toFixed(2)} FPS` : null,
          recordingMetrics && (recordingMetrics.durationMs < minimumRecordingProgressMs || recordingMetrics.bytesWritten <= 0)
            ? `通常録画の書き込み停止 (${recordingMetrics.durationMs} ms / ${recordingMetrics.bytesWritten} bytes)`
            : null,
          numeric(stats.activeFps) >= 59 ? null : `OBS描画 ${numeric(stats.activeFps).toFixed(2)} FPS`,
          numeric(stats.outputSkippedFrames) - numeric(baselineStats.outputSkippedFrames) <= 0
            ? null
            : `OBSエンコード欠落 ${numeric(stats.outputSkippedFrames) - numeric(baselineStats.outputSkippedFrames)} フレーム`,
        ].filter((failure): failure is string => failure !== null)
        if (frameRateFailures.length) {
          throw new Error(`実運用負荷で映像が安定した60 FPSに達しませんでした: ${frameRateFailures.join(' / ')}`)
        }
      }
      return {
        ok: true,
        output: {
          width: video?.outputWidth ?? 0,
          height: video?.outputHeight ?? 0,
          fpsNumerator: video?.fpsNumerator ?? 0,
          fpsDenominator: video?.fpsDenominator ?? 0,
          videoBitrateKbps: primaryVideoBitrateKbps,
          audioBitrateKbps: managedOutputPreset.audioBitrateKbps,
          encoderConfigured,
        },
        durationMs: status.outputDuration,
        bytesSent: status.outputBytes,
        totalFrames: status.outputTotalFrames,
        skippedFrames: status.outputSkippedFrames,
        measuredFps: primaryMeasuredFps,
        congestion: status.outputCongestion,
        secondary: secondaryMetrics,
        recording: recordingMetrics,
        replayBuffer: replayMetrics,
        obs: {
          activeFps: numeric(stats.activeFps),
          renderTotalFrames: numeric(stats.renderTotalFrames) - numeric(baselineStats.renderTotalFrames),
          renderSkippedFrames: numeric(stats.renderSkippedFrames) - numeric(baselineStats.renderSkippedFrames),
          outputTotalFrames: numeric(stats.outputTotalFrames) - numeric(baselineStats.outputTotalFrames),
          outputSkippedFrames: numeric(stats.outputSkippedFrames) - numeric(baselineStats.outputSkippedFrames),
        },
        verticalBacktrackStopped,
        warnings,
      }
    } finally {
      let streamInactive = !started
      if (replayStarted) {
        await this.obs.call('StopReplayBuffer').catch(() => undefined)
        await this.waitForReplayInactive().catch(() => false)
      }
      if (recordingStarted) {
        await this.obs.call('StopRecord').catch(() => undefined)
        await this.waitForRecordInactive().catch(() => false)
      }
      if (secondaryStarted) await this.stopTwitchSecondary().catch(() => undefined)
      if (started) {
        await this.obs.call('StopStream').catch(() => undefined)
        streamInactive = await this.waitForStreamInactive().catch(() => false)
      }
      if (changed && streamInactive) {
        await this.restorePreviousStreamService().catch((error) => {
          warnings.push(`Twitchテスト後にOBS配信サービス設定を復元できませんでした: ${error instanceof Error ? error.message : String(error)}`)
        })
      } else if (changed) {
        warnings.push('Twitchテスト出力の停止を確認できなかったため、OBS配信サービス設定を復元していません')
      }
    }
  }

  async applyProfile(
    config: AppConfig,
    profile: GameProfile,
    method: CaptureMethod,
    captureWindowTitle?: string,
    knownCaptureSources: string[] = [],
    preserveMicrophoneMute = false,
    recordingOnly = false,
  ): Promise<ProfileApplyResult> {
    await this.connect(config)
    const warnings: string[] = []
    if (!recordingOnly) await this.configureManagedOutput(warnings)
    if (await this.anyOutputActive()) {
      warnings.push('配信エンコーダー設定は出力中のため変更していません。配信・録画・リプレイ・Twitch副出力を停止してゲームを選び直すと反映されます')
    } else if (!recordingOnly) {
      const primaryVideoBitrateKbps = this.primaryVideoBitrateKbps(config, profile)
      await this.configureStreamEncoder(primaryVideoBitrateKbps).catch((error) => {
        warnings.push(`配信エンコーダーをCBR ${primaryVideoBitrateKbps} kbps・look-ahead無効へ事前設定できませんでした: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    await this.obs.call('SetCurrentProgramScene', { sceneName: profile.obs.sceneName })

    const selectedSource = this.captureSource(profile, method)
    if (method === 'geforce_now' && captureWindowTitle) {
      await this.prepareGeForceNowWindow(selectedSource, captureWindowTitle, warnings)
    }
    const captureSources = new Set([
      ...knownCaptureSources,
      profile.capture.localSourceName,
      profile.capture.geforceNowSourceName,
      profile.capture.windowSourceName,
      profile.capture.displaySourceName,
      'Elgato Game Capture',
    ].filter((name): name is string => Boolean(name)))
    let selectedSourceEnabled = false
    for (const source of captureSources) {
      const changed = await this.setSceneItem(profile.obs.sceneName, source, source === selectedSource)
      if (source === selectedSource) selectedSourceEnabled ||= changed
    }
    if (!selectedSourceEnabled) {
      warnings.push(`OBSシーン「${profile.obs.sceneName}」に映像ソース「${selectedSource}」がないため、プロファイルの映像へ切り替えられませんでした`)
    }
    const sourceActive = await this.obs.call('GetSourceActive', { sourceName: selectedSource }).catch(() => null)
    if (!sourceActive?.videoActive) warnings.push(`映像ソース「${selectedSource}」がアクティブではありません`)
    const activeAudio = await this.prepareGameAudioInput(config, profile, selectedSource, warnings)
    await this.ensureDiscordApplicationAudio(profile.obs.sceneName, config.sources.discord, warnings)

    const microphoneGain = normalizeMicrophoneGain(profile.audio.microphoneDb, profile.audio.microphoneBoostDb)
    if (microphoneGain.appliedDb !== profile.audio.microphoneDb || microphoneGain.appliedBoostDb !== profile.audio.microphoneBoostDb) {
      warnings.push(microphoneGain.constrainedByBoost
        ? 'マイクの合計ゲインが安全上限を超えていたため、リミッターが有効に働く最大値へ制限しました'
        : 'マイクの正のフェーダー値をリミッター前の管理ゲインへ安全に移しました')
    }
    await Promise.all([
      this.setVolume(config.sources.microphone, microphoneGain.appliedDb),
      this.setVolume(config.sources.discord, profile.audio.discordDb),
      this.setVolume(config.sources.bgm, profile.audio.bgmDb),
      this.setVolume(stockBgmInputName, profile.audio.bgmDb),
      this.setVolume(activeAudio, profile.audio.gameDb),
    ])
    if (!preserveMicrophoneMute) await this.setMuted(config.sources.microphone, false)
    let audioApplied = true
    try {
      const managed = await this.audioCalibration.applyManagedMicrophoneFilters(this.obs, config.sources.microphone, microphoneGain.appliedBoostDb)
      warnings.push(...managed.warnings)
    } catch (error) {
      audioApplied = false
      warnings.push(`マイクの自動音量保護を適用できませんでした: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      const managedGame = await this.audioCalibration.applyManagedGameFilters(this.obs, activeAudio, config.sources.microphone, profile.audio.duckingDb)
      warnings.push(...managedGame.warnings)
    } catch (error) {
      audioApplied = false
      warnings.push(`ゲーム音のダッキングとピーク保護を適用できませんでした: ${error instanceof Error ? error.message : String(error)}`)
    }
    await this.reconcileMicrophoneSceneItems(config, profile, warnings)
    await this.configureSeparatedAudioTracks(config, warnings, activeAudio, knownCaptureSources)

    for (const source of new Set([config.sources.pcGame, config.sources.geforceNow, config.sources.switchGame, ...knownCaptureSources, activeAudio])) {
      await this.setMuted(source, source !== activeAudio)
    }
    const { outputActive } = await this.obs.call('GetRecordStatus')
    if (!outputActive && profile.recording.directory) {
      const applied = await this.setCompatibleProfileParameter([
        { parameterCategory: 'AdvOut', parameterName: 'RecFilePath' },
        { parameterCategory: 'SimpleOutput', parameterName: 'FilePath' },
      ], profile.recording.directory)
      if (!applied) warnings.push(`録画保存先「${profile.recording.directory}」をOBSプロファイルへ反映できませんでした`)
    }
    if (!outputActive) {
      const applied = await this.setCompatibleProfileParameter([
        { parameterCategory: 'AdvOut', parameterName: 'RecRBTime' },
        { parameterCategory: 'SimpleOutput', parameterName: 'RecRBTime' },
      ], String(profile.recording.replayBufferSeconds))
      if (!applied) warnings.push(`リプレイバッファ時間 ${profile.recording.replayBufferSeconds} 秒をOBSプロファイルへ反映できませんでした`)
    }
    return { warnings, audioApplied }
  }

  async ensureProfileAudio(
    config: AppConfig,
    profile: GameProfile,
    method: CaptureMethod,
    knownCaptureSources: string[] = [],
  ): Promise<string[]> {
    await this.connect(config)
    const warnings: string[] = []
    const selectedSource = this.captureSource(profile, method)
    const activeGame = await this.prepareGameAudioInput(config, profile, selectedSource, warnings)
    await this.ensureDiscordApplicationAudio(profile.obs.sceneName, config.sources.discord, warnings)
    await this.configureSeparatedAudioTracks(config, warnings, activeGame, knownCaptureSources)
    const microphoneGain = normalizeMicrophoneGain(profile.audio.microphoneDb, profile.audio.microphoneBoostDb)
    if (microphoneGain.appliedDb !== profile.audio.microphoneDb || microphoneGain.appliedBoostDb !== profile.audio.microphoneBoostDb) {
      warnings.push(microphoneGain.constrainedByBoost
        ? 'マイクの合計ゲインが安全上限を超えていたため、リミッターが有効に働く最大値へ制限しました'
        : 'マイクの正のフェーダー値をリミッター前の管理ゲインへ安全に移しました')
    }
    const managed = await this.audioCalibration.applyManagedMicrophoneFilters(this.obs, config.sources.microphone, microphoneGain.appliedBoostDb)
    warnings.push(...managed.warnings)
    const managedGame = await this.audioCalibration.applyManagedGameFilters(this.obs, activeGame, config.sources.microphone, profile.audio.duckingDb)
    warnings.push(...managedGame.warnings)
    const volumes: Array<[string, number]> = [
      [config.sources.microphone, microphoneGain.appliedDb],
      [activeGame, profile.audio.gameDb],
      [config.sources.discord, profile.audio.discordDb],
      [config.sources.bgm, profile.audio.bgmDb],
      [stockBgmInputName, profile.audio.bgmDb],
    ]
    for (const [inputName, inputVolumeDb] of volumes) {
      await this.audioCalibration.assertOutputsInactive(this.obs)
      await this.setVolume(inputName, inputVolumeDb)
    }
    for (const source of new Set([config.sources.pcGame, config.sources.geforceNow, config.sources.switchGame, ...knownCaptureSources, activeGame])) {
      await this.setMuted(source, source !== activeGame)
    }
    return warnings
  }

  async applyCommonTemplate(config: AppConfig, rendered: CommonTemplateRender): Promise<void> {
    await this.connect(config)
    try {
      await this.obs.call('SetInputSettings', {
        inputName: rendered.sourceName,
        inputSettings: { file: rendered.filename },
        overlay: true,
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`共通テンプレート用OBS画像ソース「${rendered.sourceName}」を更新できませんでした: ${detail}`)
    }
  }

  async clearCommonTemplate(config: AppConfig, sourceName: string): Promise<void> {
    await this.connect(config)
    try {
      await this.obs.call('SetInputSettings', {
        inputName: sourceName,
        inputSettings: { file: '' },
        overlay: true,
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`共通テンプレート用OBS画像ソース「${sourceName}」をクリアできませんでした: ${detail}`)
    }
  }

  async start(config: AppConfig, profile: GameProfile, selectedSource: string): Promise<string[]> {
    await this.connect(config)
    await this.restorePreviousRecordingProfile()
    const active = await this.obs.call('GetSourceActive', { sourceName: selectedSource }).catch(() => null)
    if (!active?.videoActive) throw new Error(`キャプチャ映像「${selectedSource}」を確認できないため、配信を開始しません`)

    const [initialStream, initialRecord, initialReplay] = await Promise.all([
      this.obs.call('GetStreamStatus'),
      this.obs.call('GetRecordStatus'),
      this.getReplayBufferStatus(),
    ])
    if (!streamOutputRunning(initialStream) && (initialRecord.outputActive || initialReplay.outputActive)) {
      throw new Error('OBSで録画またはリプレイバッファがすでに動作中です。A1〜A5音声分離とFHD 60 FPS設定を反映するため、OBS側で停止してからもう一度開始してください')
    }

    const previousScene = await this.obs.call('GetCurrentProgramScene')
      .then(({ currentProgramSceneName }) => currentProgramSceneName)
      .catch(() => profile.obs.sceneName)
    await this.obs.call('SetCurrentProgramScene', { sceneName: profile.obs.startingScene })
    const warnings: string[] = []
    const startedNow = { stream: false, twitch: false, record: false, replay: false, sourceRecord: false, vertical: false }
    let restoreManagedStreamServiceOnFailure = false
    try {
      await this.configureManagedOutput(warnings)
      const protection = await this.simulcastPerformanceProtection(config, profile)
      await this.protectSimulcastPerformance(protection, warnings)
      const stream = streamOutputRunning(initialStream) ? initialStream : await this.obs.call('GetStreamStatus')
      if (!streamOutputRunning(stream)) {
        const activeGameAudio = await this.prepareGameAudioInput(config, profile, selectedSource, warnings)
        await this.ensureDiscordApplicationAudio(profile.obs.sceneName, config.sources.discord, warnings)
        await this.configureSeparatedAudioTracks(config, warnings, activeGameAudio)
      }
      if (!streamOutputRunning(stream)) {
        await this.configurePrimaryStream(config, profile)
        restoreManagedStreamServiceOnFailure = this.streamServiceManaged
      }
      // This gate also applies when OBS was started from its own UI.  In that
      // case the existing public stream remains authoritative, but recording,
      // replay and secondary Twitch output must not be added to a stale Simple
      // output handler that cannot provide the managed A1-A5/FHD settings.
      await this.assertManagedStreamEncoderReady(this.primaryVideoBitrateKbps(config, profile))
      if (!streamOutputRunning(stream)) {
        await this.obs.call('StartStream')
        this.started.stream = true
        startedNow.stream = true
        if (!await this.waitForStreamActive()) {
          const guidance = config.features.youtube && profile.youtube.enabled
            ? 'YouTube配信キーとOBS出力設定を確認してください'
            : config.features.twitch && profile.twitch.enabled
              ? 'Twitch配信キーとOBS出力設定を確認してください'
              : 'OBSの配信サービスと出力設定を確認してください'
          throw new Error(`OBS配信出力が開始状態になりませんでした。${guidance}`)
        }
      }
      if (!await this.waitForStreamFrameProgress()) {
        throw new Error('OBS配信出力は開始状態ですが、映像が安定した60 FPSで進んでいません。エンコード遅延とGPU負荷を確認してください')
      }
      if (config.features.youtube && profile.youtube.enabled && config.features.twitch && profile.twitch.enabled) {
        await this.startTwitchSecondary()
        this.started.twitch = true
        startedNow.twitch = true
      }

      // Allocate the primary YouTube encoder and Twitch's dedicated video encoder
      // before recording. Recording reuses the 9 Mbps primary encoder, while the
      // Twitch encoder stays inside Twitch's 6 Mbps ceiling.
      const record = await this.obs.call('GetRecordStatus')
      if (config.features.recording && profile.recording.enabled && !record.outputActive) {
        try {
          await this.obs.call('StartRecord')
          this.started.record = true
          startedNow.record = true
          if (!await this.waitForRecordActive()) throw new Error('OBSが録画開始を確認できませんでした')
          if (!await this.waitForRecordFrameProgress()) throw new Error('録画映像が安定した60 FPSで進みませんでした')
        } catch (error) {
          if (startedNow.record) {
            await this.obs.call('StopRecord').catch(() => undefined)
            await this.waitForRecordInactive().catch(() => false)
            this.started.record = false
            startedNow.record = false
          }
          warnings.push(`通常録画を開始できませんでした: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      const replay = await this.getReplayBufferStatus()
      if (config.features.replayBuffer && !replay.outputActive) {
        try {
          await this.obs.call('StartReplayBuffer')
          this.started.replay = true
          startedNow.replay = true
          if (!await this.waitForReplayActive()) throw new Error('OBSがリプレイバッファ開始を確認できませんでした')
        } catch (error) {
          if (startedNow.replay) {
            await this.obs.call('StopReplayBuffer').catch(() => undefined)
            await this.waitForReplayInactive().catch(() => false)
            this.started.replay = false
            startedNow.replay = false
          }
          warnings.push(`リプレイバッファを開始できませんでした: ${error instanceof Error ? error.message : String(error)}`)
        }
      }

      const sourceRecordRequested = config.features.sourceRecord && profile.recording.sourceRecord
      const verticalRequested = config.features.verticalRecording && profile.recording.verticalRecording
      if (sourceRecordRequested) {
        // Source Record exposes start/stop controls but no per-output frame or
        // encoder-lag counters. A real output dropped 99.7% of its frames while
        // OBS GetStats still showed the public outputs moving, so it cannot be
        // guarded safely during a live stream. Keep legacy settings readable,
        // but never add this unobservable encoder to a live workload.
        warnings.push('Source Recordは個別のフレーム落ちを監視できないため、配信中は開始しません。素材はA1〜A5分離の通常録画へ保存します')
      }
      const baselineSkippedFrames = verticalRequested && !protection.protected
        ? await this.obs.call('GetStats').then(({ outputSkippedFrames }) => outputSkippedFrames).catch(() => null)
        : null
      if (protection.protected && verticalRequested) {
        warnings.push('YouTube・Twitch同時配信と通常録画をFHD 60 FPSで維持するため、Aitum Vertical録画は開始しませんでした')
      } else {
        if (verticalRequested) {
          try {
            const vertical = await this.verticalSceneReady()
            if (!vertical.ready) {
              warnings.push(`Aitum Verticalシーン「${vertical.sceneName}」に表示ソースがないため、黒画面になる縦録画は開始しませんでした`)
            } else {
              await this.callVertical('start_recording')
              this.started.vertical = true; startedNow.vertical = true
            }
          } catch (error) { warnings.push(`Aitum Vertical録画を開始できませんでした: ${error instanceof Error ? error.message : String(error)}`) }
        }
      }

      const optionalStarted = startedNow.sourceRecord || startedNow.vertical
      await wait(Math.max(config.obs.startDelaySeconds * 1000, optionalStarted ? 1_500 : 0))
      if (optionalStarted && baselineSkippedFrames !== null) {
        const skippedFrames = await this.obs.call('GetStats').then(({ outputSkippedFrames }) => outputSkippedFrames).catch(() => baselineSkippedFrames)
        if (skippedFrames - baselineSkippedFrames >= 10) {
          if (startedNow.vertical) await this.callVertical('stop_recording').catch(() => undefined)
          if (startedNow.sourceRecord) await this.callVendor('source-record', 'record_stop', { source: selectedSource, filter: managedSourceRecordFilterName }).catch(() => undefined)
          this.started.vertical = false
          this.started.sourceRecord = false
          this.started.sourceRecordSource = null
          startedNow.vertical = false
          startedNow.sourceRecord = false
          warnings.push('エンコード遅延を検出したため、素材録画と縦録画を自動停止して配信と通常録画を優先しました')
        }
      }
      if (!await this.waitForStreamFrameProgress()) {
        throw new Error('録画・リプレイ開始後にOBS配信映像が安定した60 FPSで進まなくなりました。追加出力を停止してロールバックします')
      }
      if (config.features.youtube && profile.youtube.enabled && config.features.twitch && profile.twitch.enabled) {
        await this.startTwitchSecondary()
      }
      await this.obs.call('SetCurrentProgramScene', { sceneName: profile.obs.sceneName })
      this.rollbackScene = previousScene
      return warnings
    } catch (error) {
      if (startedNow.vertical) await this.callVertical('stop_recording').catch(() => undefined)
      if (startedNow.sourceRecord) await this.callVendor('source-record', 'record_stop', { source: selectedSource, filter: managedSourceRecordFilterName }).catch(() => undefined)
      if (startedNow.replay) await this.obs.call('StopReplayBuffer').catch(() => undefined)
      if (startedNow.record) await this.obs.call('StopRecord').catch(() => undefined)
      if (startedNow.twitch) await this.stopTwitchSecondary().catch(() => undefined)
      let rollbackStreamStopped = true
      if (startedNow.stream) {
        try {
          await this.obs.call('StopStream')
          rollbackStreamStopped = await this.waitForStreamInactive()
        } catch {
          rollbackStreamStopped = await this.waitForStreamInactive().catch(() => false)
        }
      }
      if (restoreManagedStreamServiceOnFailure && rollbackStreamStopped) {
        await this.restorePreviousStreamService().catch((restoreError) => warnings.push(`OBS配信サービス設定を復元できませんでした: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`))
      } else if (restoreManagedStreamServiceOnFailure) {
        warnings.push('OBS配信出力の停止を確認できなかったため、配信サービス設定を復元していません')
      }
      if (startedNow.stream) this.started.stream = false
      if (startedNow.twitch) this.started.twitch = false
      if (startedNow.vertical) this.started.vertical = false
      if (startedNow.sourceRecord) { this.started.sourceRecord = false; this.started.sourceRecordSource = null }
      if (startedNow.replay) this.started.replay = false
      if (startedNow.record) this.started.record = false
      await this.obs.call('SetCurrentProgramScene', { sceneName: previousScene })
        .catch((restoreError) => warnings.push(`開始前のOBSシーンへ復元できませんでした: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`))
      this.rollbackScene = null
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(warnings.length ? `${message} / 先行警告: ${warnings.join(' / ')}` : message, { cause: error })
    }
  }

  async startRecordingOnly(config: AppConfig, profile: GameProfile, selectedSource: string, method: CaptureMethod): Promise<string[]> {
    await this.connect(config)
    const warnings: string[] = []
    const [stream, record, replay, secondary] = await Promise.all([
      this.obs.call('GetStreamStatus'),
      this.obs.call('GetRecordStatus'),
      this.getReplayBufferStatus(),
      this.getTwitchOutputPluginStatus().catch(() => null),
    ])
    if (streamOutputRunning(stream) || record.outputActive || replay.outputActive || secondary?.outputActive) {
      throw new Error('配信・録画・リプレイ・Twitch副出力をすべて停止してから「録画のみ」を開始してください')
    }

    const previousScene = await this.obs.call('GetCurrentProgramScene')
      .then(({ currentProgramSceneName }) => currentProgramSceneName)
      .catch(() => profile.obs.sceneName)
    let recordingStarted = false
    try {
      await this.prepareLocalRecordingCapture(profile, selectedSource, method)
      await this.assertSelectedGameCapture(profile, selectedSource, method)
      await this.configureRecordingOnlyProfile(this.recordingDirectory(profile), recordingFilenameFormat(profile))
      await this.assertSelectedGameCapture(profile, selectedSource, method)
      const activeGameAudio = await this.prepareGameAudioInput(config, profile, selectedSource, warnings)
      await this.ensureDiscordApplicationAudio(profile.obs.sceneName, config.sources.discord, warnings)
      await this.configureSeparatedAudioTracks(config, warnings, activeGameAudio, [], recordingOnlyPreset.encoder)
      await this.reconcileMicrophoneSceneItems(config, profile, warnings)
      await this.obs.call('SetCurrentProgramScene', { sceneName: profile.obs.sceneName })
      const active = await this.obs.call('GetSourceActive', { sourceName: selectedSource }).catch(() => null)
      if (!active?.videoActive) throw new Error(`「${profile.displayName}」の録画ソース「${selectedSource}」に映像が来ていないため録画を開始しません`)

      const recordingGame = { id: profile.id, name: profile.displayName.trim() }
      await this.obs.call('SetProfileParameter', { parameterCategory: 'OBSStreamManager', parameterName: 'RecordingGameId', parameterValue: recordingGame.id })
      await this.obs.call('SetProfileParameter', { parameterCategory: 'OBSStreamManager', parameterName: 'RecordingGameName', parameterValue: recordingGame.name })
      await this.obs.call('StartRecord')
      recordingStarted = true
      this.started.record = true
      this.recordingOnlyActive = true
      this.recordingGame = recordingGame
      if (!await this.waitForRecordActive()) throw new Error('OBSが録画専用モードの開始を確認できませんでした')
      if (!await this.waitForRecordFrameProgress()) throw new Error('録画専用モードのMKV書き込みが進んでいません')
      return warnings
    } catch (error) {
      if (recordingStarted) {
        await this.obs.call('StopRecord').catch(() => undefined)
        await this.waitForRecordInactive().catch(() => false)
      }
      this.started.record = false
      this.recordingOnlyActive = false
      this.recordingGame = null
      await this.restorePreviousRecordingProfile(warnings).catch((restoreError) => {
        warnings.push(`元のOBSプロファイルへ戻せませんでした: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`)
      })
      await this.obs.call('SetCurrentProgramScene', { sceneName: previousScene }).catch(() => undefined)
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(warnings.length ? `${message} / ${warnings.join(' / ')}` : message, { cause: error })
    }
  }

  async stopRecordingOnly(config: AppConfig): Promise<{ warnings: string[]; outputPath: string | null; remuxedPath: string | null }> {
    await this.connect(config)
    const warnings: string[] = []
    const record = await this.obs.call('GetRecordStatus')
    let outputPath: string | null = null
    if (record.outputActive) {
      try {
        const stopped = await this.obs.call('StopRecord')
        outputPath = typeof stopped.outputPath === 'string' && stopped.outputPath.trim() ? stopped.outputPath : null
        if (!await this.waitForRecordInactive()) warnings.push('録画停止の完了を確認できませんでした')
      } catch (error) {
        warnings.push(`録画を停止できませんでした: ${error instanceof Error ? error.message : String(error)}`)
      }
    } else {
      warnings.push('OBS録画はすでに停止しています')
    }
    this.started.record = false
    this.recordingOnlyActive = false
    this.recordingGame = null
    const remuxedPath = outputPath ? await this.waitForRemuxedMp4(outputPath) : null
    if (outputPath?.toLowerCase().endsWith('.mkv') && !remuxedPath) warnings.push('録画MKVは保存されましたが、自動変換したMP4を30秒以内に確認できませんでした')
    await this.restorePreviousRecordingProfile(warnings).catch((error) => {
      warnings.push(`元のOBSプロファイルへ戻せませんでした: ${error instanceof Error ? error.message : String(error)}`)
    })
    return { warnings, outputPath, remuxedPath }
  }

  private async stopOutputs(): Promise<string[]> {
    const warnings: string[] = []
    const [stream, record, replay] = await Promise.all([
      this.obs.call('GetStreamStatus'), this.obs.call('GetRecordStatus'), this.getReplayBufferStatus(),
    ])
    // The Stop action is a global teardown by design. OBS remains authoritative after this
    // process restarts, so do not rely on the controller's transient `started` flags here.
    await this.stopSourceRecord().catch((error) => warnings.push(`Source Recordを停止できませんでした: ${error instanceof Error ? error.message : String(error)}`))
    await this.callVertical('stop_recording').catch((error) => warnings.push(`Aitum Vertical録画を停止できませんでした: ${error instanceof Error ? error.message : String(error)}`))
    await this.callVertical('stop_backtrack').catch((error) => warnings.push(`Aitum Vertical Backtrackを停止できませんでした: ${error instanceof Error ? error.message : String(error)}`))
    await this.stopTwitchSecondary().catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.toLowerCase().includes('no vendor was found')) warnings.push(`Twitch副出力を停止できませんでした: ${message}`)
    })
    const outputStopChecks: Promise<void>[] = []
    if (replay.outputActive) {
      try {
        await this.obs.call('StopReplayBuffer')
        outputStopChecks.push(this.waitForReplayInactive().then((stopped) => {
          if (!stopped) warnings.push('リプレイバッファの停止を確認できませんでした')
        }).catch((error) => {
          warnings.push(`リプレイバッファの停止確認に失敗しました: ${error instanceof Error ? error.message : String(error)}`)
        }))
      } catch (error) {
        warnings.push(`リプレイバッファを停止できませんでした: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (record.outputActive) {
      try {
        await this.obs.call('StopRecord')
        outputStopChecks.push(this.waitForRecordInactive().then((stopped) => {
          if (!stopped) warnings.push('通常録画の停止を確認できませんでした')
        }).catch((error) => {
          warnings.push(`通常録画の停止確認に失敗しました: ${error instanceof Error ? error.message : String(error)}`)
        }))
      } catch (error) {
        warnings.push(`通常録画を停止できませんでした: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    let streamStopped = !streamOutputRunning(stream)
    if (streamOutputRunning(stream)) {
      try {
        await this.obs.call('StopStream')
        outputStopChecks.push(this.waitForStreamInactive().then((stopped) => {
          streamStopped = stopped
          if (!stopped) warnings.push('OBS配信出力の停止を確認できませんでした')
        }).catch((error) => {
          streamStopped = false
          warnings.push(`OBS配信出力の停止確認に失敗しました: ${error instanceof Error ? error.message : String(error)}`)
        }))
      } catch (error) {
        warnings.push(`配信を停止できませんでした: ${error instanceof Error ? error.message : String(error)}`)
        outputStopChecks.push(this.waitForStreamInactive().then((stopped) => { streamStopped = stopped }).catch(() => { streamStopped = false }))
      }
    }
    await Promise.all(outputStopChecks)
    if (streamStopped) {
      await this.restorePreviousStreamService().catch((error) => warnings.push(`OBS配信サービス設定を復元できませんでした: ${error instanceof Error ? error.message : String(error)}`))
    }
    this.started = { stream: false, twitch: false, record: false, replay: false, sourceRecord: false, vertical: false, sourceRecordSource: null }
    return warnings
  }

  private async rollbackStartedOutputs(): Promise<string[]> {
    const warnings: string[] = []
    if (this.started.sourceRecord && this.started.sourceRecordSource) {
      await this.callVendor('source-record', 'record_stop', { source: this.started.sourceRecordSource, filter: managedSourceRecordFilterName })
        .catch((error) => warnings.push(`Source Recordを停止できませんでした: ${error instanceof Error ? error.message : String(error)}`))
    }
    if (this.started.vertical) {
      await this.callVertical('stop_recording')
        .catch((error) => warnings.push(`Aitum Vertical録画を停止できませんでした: ${error instanceof Error ? error.message : String(error)}`))
    }
    if (this.started.twitch) {
      await this.stopTwitchSecondary()
        .catch((error) => warnings.push(`Twitch副出力を停止できませんでした: ${error instanceof Error ? error.message : String(error)}`))
    }
    if (this.started.replay) {
      await this.obs.call('StopReplayBuffer')
        .catch((error) => warnings.push(`リプレイバッファを停止できませんでした: ${error instanceof Error ? error.message : String(error)}`))
    }
    if (this.started.record) {
      await this.obs.call('StopRecord')
        .catch((error) => warnings.push(`通常録画を停止できませんでした: ${error instanceof Error ? error.message : String(error)}`))
    }
    let streamStopped = !this.started.stream
    if (this.started.stream) {
      try {
        await this.obs.call('StopStream')
        streamStopped = await this.waitForStreamInactive()
        if (!streamStopped) warnings.push('OBS配信出力の停止を確認できませんでした')
      } catch (error) {
        warnings.push(`配信を停止できませんでした: ${error instanceof Error ? error.message : String(error)}`)
        streamStopped = await this.waitForStreamInactive().catch(() => false)
      }
    }
    if (streamStopped) {
      await this.restorePreviousStreamService().catch((error) => warnings.push(`OBS配信サービス設定を復元できませんでした: ${error instanceof Error ? error.message : String(error)}`))
    }
    this.started = { stream: false, twitch: false, record: false, replay: false, sourceRecord: false, vertical: false, sourceRecordSource: null }
    return warnings
  }

  async rollbackStart(config: AppConfig, profile: GameProfile): Promise<string[]> {
    await this.connect(config)
    const warnings = await this.rollbackStartedOutputs()
    const sceneName = this.rollbackScene ?? profile.obs.sceneName
    await this.obs.call('SetCurrentProgramScene', { sceneName })
      .catch((error) => warnings.push(`開始前のOBSシーンへ復元できませんでした: ${error instanceof Error ? error.message : String(error)}`))
    this.rollbackScene = null
    return warnings
  }

  async stop(config: AppConfig, profile: GameProfile | null): Promise<string[]> {
    await this.connect(config)
    const warnings: string[] = []
    const endingSceneSelected = await this.obs.call('SetCurrentProgramScene', { sceneName: profile?.obs.endingScene ?? '90_ENDING' })
      .then(() => true)
      .catch((error) => {
        warnings.push(`終了シーンへ切り替えできませんでした: ${error instanceof Error ? error.message : String(error)}`)
        return false
      })
    if (endingSceneSelected) await wait(config.obs.endDelaySeconds * 1000)
    warnings.push(...await this.stopOutputs())
    this.rollbackScene = null
    return warnings
  }

  async isStreaming(config: AppConfig): Promise<boolean> {
    await this.connect(config)
    return streamOutputRunning(await this.obs.call('GetStreamStatus'))
  }

  ownsCurrentStream(): boolean {
    return this.started.stream
  }

  async saveReplay(config: AppConfig): Promise<void> {
    await this.connect(config)
    await this.obs.call('SaveReplayBuffer')
  }

  async switchScene(config: AppConfig, sceneName: string): Promise<void> {
    await this.connect(config)
    await this.obs.call('SetCurrentProgramScene', { sceneName })
  }

  async status(config: AppConfig, selectedGameId: string | null, captureMethod: CaptureMethod | null, busy: boolean, warning: string | null): Promise<ObsRuntimeStatus> {
    try {
      await this.connect(config)
      const [stream, record, replay, scene, twitchOutputPlugin, profiles] = await Promise.all([
        this.obs.call('GetStreamStatus'),
        this.obs.call('GetRecordStatus'),
        this.getReplayBufferStatus(),
        this.obs.call('GetCurrentProgramScene'),
        this.getTwitchOutputPluginStatus(),
        this.obs.call('GetProfileList'),
      ])
      const recordingOnly = record.outputActive && (this.recordingOnlyActive || profiles.currentProfileName === recordingOnlyPreset.profileName)
      if (!record.outputActive) this.recordingGame = null
      if (recordingOnly && !this.recordingGame) {
        const [id, name] = await Promise.all(['RecordingGameId', 'RecordingGameName'].map((parameterName) =>
          this.obs.call('GetProfileParameter', { parameterCategory: 'OBSStreamManager', parameterName })
            .then(({ parameterValue }) => parameterValue?.trim() || null).catch(() => null)))
        if (id && name) this.recordingGame = { id, name }
      }
      return { obsConnected: true, streaming: streamOutputRunning(stream), streamElapsedMs: stream.outputDuration, recording: record.outputActive, recordingOnly, recordingGameId: recordingOnly ? this.recordingGame?.id ?? null : null, recordingGameName: recordingOnly ? this.recordingGame?.name ?? null : null, replayBuffer: replay.outputActive, sourceRecord: this.started.sourceRecord, verticalRecording: this.started.vertical, selectedGameId, captureMethod, currentScene: scene.currentProgramSceneName, warning, busy, twitchOutputPluginReady: twitchOutputPlugin.state === 'ready', twitchOutputPlugin }
    } catch {
      this.connected = false
      this.resetTransientOutputOwnership()
      return { obsConnected: false, streaming: false, recording: false, recordingOnly: false, replayBuffer: false, sourceRecord: false, verticalRecording: false, selectedGameId, captureMethod, currentScene: null, warning, busy, twitchOutputPluginReady: false, twitchOutputPlugin: { state: 'missing', detail: 'OBS未接続のため副出力プラグインを確認できません', outputActive: false } }
    }
  }
}
