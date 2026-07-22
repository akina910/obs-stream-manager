import OBSWebSocket, { type OBSRequestTypes } from 'obs-websocket-js'
import type { AppConfig, BgmPlayback, CaptureMethod, GameProfile, RuntimeStatus } from '../shared/contracts.js'
import type { CommonTemplateRender } from './common-template.js'
import type { AudioCalibrationResult } from '../shared/audio-calibration.js'
import { STOCK_BGM_INPUT_NAME } from '../shared/bgm.js'
import { AudioCalibrationService } from './audio-calibration.js'
import { SecretStore } from './secrets.js'

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))
type StreamServiceSettings = OBSRequestTypes['SetStreamServiceSettings']
type AppliedStreamService = { streamServiceType: string; server: string; key: string }
type ObsRuntimeStatus = Omit<RuntimeStatus, 'platforms'>
type TwitchOutputPluginStatus = NonNullable<ObsRuntimeStatus['twitchOutputPlugin']>
const twitchOutputPluginApiVersion = 2
export const managedOutputPreset = {
  width: 1920,
  height: 1080,
  fpsNumerator: 60,
  fpsDenominator: 1,
  videoBitrateKbps: 6_000,
  audioBitrateKbps: 160,
} as const
export const stockBgmInputName = STOCK_BGM_INPUT_NAME
export type BgmControlAction = 'play' | 'pause' | 'stop' | 'restart'
export type ProfileApplyResult = { warnings: string[]; audioApplied: boolean }
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
  congestion: number
  secondary: {
    durationMs: number
    bytesSent: number
    totalFrames: number
    skippedFrames: number
  } | null
  recording: {
    durationMs: number
    bytesSent: number
    totalFrames: number
    skippedFrames: number
  } | null
  replayBuffer: {
    durationMs: number
    bytesSent: number
    totalFrames: number
    skippedFrames: number
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
  private readonly streamStateListeners = new Set<(active: boolean) => void>()
  private started = { stream: false, twitch: false, record: false, replay: false, sourceRecord: false, vertical: false, sourceRecordSource: null as string | null }

  constructor(
    private readonly secrets: SecretStore,
    private readonly streamStartTimeoutMs = 8_000,
    private readonly streamStopTimeoutMs = streamStartTimeoutMs,
    private readonly audioCalibration = new AudioCalibrationService(),
  ) {
    this.obs.on('ConnectionClosed', () => {
      this.connected = false
      this.resetTransientOutputOwnership()
    })
    this.obs.on('StreamStateChanged', ({ outputActive }) => {
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
    return this.audioCalibration.calibrate(
      config,
      this.secrets.get('obs-password') ?? undefined,
      profile,
      method,
      durationMs,
      persistProfile,
    )
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
  }

  private captureSource(profile: GameProfile, method: CaptureMethod): string {
    if (method === 'geforce_now') return profile.capture.geforceNowSourceName
    if (method === 'window') return profile.capture.windowSourceName ?? profile.capture.localSourceName
    if (method === 'display') return profile.capture.displaySourceName
    return profile.capture.localSourceName
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

  private async highResolutionSimulcast(config: AppConfig, profile: GameProfile): Promise<{ protected: boolean; width: number; height: number }> {
    const simulcasting = config.features.youtube && profile.youtube.enabled && config.features.twitch && profile.twitch.enabled
    if (!simulcasting) return { protected: false, width: 0, height: 0 }
    const video = await this.obs.call('GetVideoSettings').catch(() => null)
    const width = video?.outputWidth ?? 0
    const height = video?.outputHeight ?? 0
    return { protected: width * height >= 2560 * 1440, width, height }
  }

  private audioTrackSelection(...enabled: number[]): Record<string, boolean> {
    const selected = new Set(enabled)
    return Object.fromEntries(Array.from({ length: 6 }, (_, index) => [String(index + 1), selected.has(index + 1)]))
  }

  private async configureSeparatedAudioTracks(config: AppConfig, warnings: string[]): Promise<void> {
    const [stream, record, replay] = await Promise.all([
      this.obs.call('GetStreamStatus').catch(() => ({ outputActive: false })),
      this.obs.call('GetRecordStatus').catch(() => ({ outputActive: false })),
      this.getReplayBufferStatus().catch(() => ({ outputActive: false })),
    ])
    if (stream.outputActive || record.outputActive || replay.outputActive) {
      warnings.push('音声トラック分離は出力中のため変更していません。配信・録画・リプレイを停止してゲームを選び直すと反映されます')
      return
    }

    const inputList = await this.obs.call('GetInputList').catch(() => null)
    if (!inputList || !Array.isArray(inputList.inputs)) return
    const inputs = inputList.inputs.flatMap((input) => typeof input.inputName === 'string'
      ? [{ inputName: input.inputName, inputKind: typeof input.inputKind === 'string' ? input.inputKind : '' }]
      : [])
    const existing = new Set(inputs.map(({ inputName }) => inputName))
    const outputMode = await this.obs.call('GetProfileParameter', { parameterCategory: 'Output', parameterName: 'Mode' })
      .then(({ parameterValue }) => parameterValue)
      .catch(() => null)
    const advanced = outputMode === 'Advanced'
    const streamMix = advanced ? 6 : 1
    const routes: Array<{ inputName: string; isolatedTrack: number; includeInStream?: boolean }> = [
      ...[...new Set([config.sources.pcGame, config.sources.geforceNow, config.sources.switchGame])]
        .map((inputName) => ({ inputName, isolatedTrack: advanced ? 1 : 2 })),
      { inputName: config.sources.discord, isolatedTrack: advanced ? 2 : 3 },
      { inputName: config.sources.microphone, isolatedTrack: advanced ? 3 : 4 },
      { inputName: config.sources.bgm, isolatedTrack: advanced ? 4 : 5 },
      { inputName: stockBgmInputName, isolatedTrack: advanced ? 4 : 5 },
    ]
    const managedNames = new Set(routes.map(({ inputName }) => inputName))
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
        isolatedTrack: advanced ? 5 : 6,
        includeInStream: !auxiliaryKinds.has(input.inputKind),
      })
    }
    for (const { inputName, isolatedTrack, includeInStream = true } of routes) {
      if (!existing.has(inputName)) continue
      await this.obs.call('SetInputAudioTracks', {
        inputName,
        inputAudioTracks: this.audioTrackSelection(isolatedTrack, ...(includeInStream ? [streamMix] : [])),
      }).catch(() => warnings.push(`音声ソース「${inputName}」の録画トラックを分離できませんでした`))
    }

    const profileSettings = advanced
      ? [
          { parameterCategory: 'AdvOut', parameterName: 'TrackIndex', parameterValue: '6' },
          { parameterCategory: 'AdvOut', parameterName: 'RecTracks', parameterValue: '31' },
          { parameterCategory: 'AdvOut', parameterName: 'RecEncoder', parameterValue: 'none' },
          { parameterCategory: 'AdvOut', parameterName: 'RecUseRescale', parameterValue: 'false' },
          { parameterCategory: 'AdvOut', parameterName: 'Track1Name', parameterValue: 'GAME' },
          { parameterCategory: 'AdvOut', parameterName: 'Track2Name', parameterValue: 'DISCORD' },
          { parameterCategory: 'AdvOut', parameterName: 'Track3Name', parameterValue: 'MIC' },
          { parameterCategory: 'AdvOut', parameterName: 'Track4Name', parameterValue: 'BGM' },
          { parameterCategory: 'AdvOut', parameterName: 'Track5Name', parameterValue: 'AUX CAPTURE' },
          { parameterCategory: 'AdvOut', parameterName: 'Track6Name', parameterValue: 'STREAM MIX' },
        ]
      : [
          { parameterCategory: 'SimpleOutput', parameterName: 'RecTracks', parameterValue: '62' },
          { parameterCategory: 'SimpleOutput', parameterName: 'RecQuality', parameterValue: 'Stream' },
        ]
    const results = await Promise.all(profileSettings.map((setting) => this.obs.call('SetProfileParameter', setting).then(() => true).catch(() => false)))
    if (results.some((result) => !result)) warnings.push('OBS録画プロファイルの一部で音声トラック名または録音対象を更新できませんでした')
    if (!advanced) warnings.push('OBSが基本出力モードのため、配信用MIXをA1、分離録画をA2以降へ設定しました。詳細出力モードではA1=ゲーム、A2=Discord、A3=マイク、A4=BGM、A5=AUXになります')
  }

  private async configureManagedOutput(warnings: string[]): Promise<void> {
    const [stream, record, replay, secondary] = await Promise.all([
      this.obs.call('GetStreamStatus').catch(() => ({ outputActive: false })),
      this.obs.call('GetRecordStatus').catch(() => ({ outputActive: false })),
      this.getReplayBufferStatus().catch(() => ({ outputActive: false })),
      this.getTwitchOutputPluginStatus().catch(() => null),
    ])
    if (stream.outputActive || record.outputActive || replay.outputActive || secondary?.outputActive) {
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

  private async configureStreamEncoder(): Promise<void> {
    await this.callVendor('obs-stream-manager-output', 'configure_stream', {
      videoBitrateKbps: managedOutputPreset.videoBitrateKbps,
      audioBitrateKbps: managedOutputPreset.audioBitrateKbps,
    })
    await wait(500)
  }

  private async ensureStockBgmInput(filename: string): Promise<void> {
    const sceneList = await this.obs.call('GetSceneList')
    let created = false
    try {
      const input = await this.obs.call('GetInputSettings', { inputName: stockBgmInputName })
      if (input.inputKind !== 'ffmpeg_source') throw new Error(`OBSソース「${stockBgmInputName}」がメディアソースではありません`)
      await this.obs.call('SetInputSettings', {
        inputName: stockBgmInputName,
        inputSettings: { is_local_file: true, local_file: filename, looping: true, restart_on_activate: false, close_when_inactive: false },
        overlay: true,
      })
    } catch (error) {
      if (error instanceof Error && error.message.includes('メディアソースではありません')) throw error
      await this.obs.call('CreateInput', {
        sceneName: sceneList.currentProgramSceneName,
        inputName: stockBgmInputName,
        inputKind: 'ffmpeg_source',
        inputSettings: { is_local_file: true, local_file: filename, looping: true, restart_on_activate: false, close_when_inactive: false },
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

  async playBgm(config: AppConfig, filename: string, volumeDb = -25, restart = true): Promise<void> {
    await this.connect(config)
    await this.ensureStockBgmInput(filename)
    const advanced = await this.obs.call('GetProfileParameter', { parameterCategory: 'Output', parameterName: 'Mode' })
      .then(({ parameterValue }) => parameterValue === 'Advanced')
      .catch(() => false)
    await this.obs.call('SetInputAudioTracks', {
      inputName: stockBgmInputName,
      inputAudioTracks: this.audioTrackSelection(advanced ? 4 : 5, advanced ? 6 : 1),
    }).catch(() => undefined)
    await this.obs.call('SetInputVolume', { inputName: stockBgmInputName, inputVolumeDb: volumeDb })
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
    try {
      const response = await this.callVendor('obs-stream-manager-output', 'twitch_status')
      const version = typeof response.pluginVersion === 'string' ? response.pluginVersion : undefined
      const apiVersion = typeof response.apiVersion === 'number' ? response.apiVersion : undefined
      if (apiVersion !== twitchOutputPluginApiVersion) {
        const restartRequired = installState === 'installed' || installState === 'pending'
        return {
          state: restartRequired ? 'restart_required' : 'incompatible',
          version,
          detail: restartRequired
            ? 'OBS Stream Manager Outputを更新しました。OBSを再起動してください'
            : 'OBS Stream Manager Outputの互換性を確認できません。アプリを再インストールしてOBSを再起動してください',
          outputActive: response.outputActive === true,
        }
      }
      return { state: 'ready', version, detail: `OBS副出力プラグイン ${version ?? '互換版'} は利用可能です`, outputActive: response.outputActive === true }
    } catch {
      if (installState === 'installed' || installState === 'pending') {
        return { state: 'restart_required', detail: 'OBS副出力プラグインを反映するためOBSを再起動してください', outputActive: false }
      }
      if (installState === 'unavailable') {
        return { state: 'install_failed', detail: 'OBS副出力プラグインを配置できませんでした。アプリを再インストールしてください', outputActive: false }
      }
      return { state: 'missing', detail: 'OBS副出力プラグインが読み込まれていません。OBSを再起動してください', outputActive: false }
    }
  }

  private async startTwitchSecondary(credentials?: { server: string; key: string }): Promise<void> {
    const plugin = await this.getTwitchOutputPluginStatus()
    if (plugin.state !== 'ready') throw new Error(plugin.detail)
    if (plugin.outputActive) return
    const key = credentials?.key ?? this.secrets.get('twitch-stream-key')
    const server = credentials?.server ?? this.secrets.get('twitch-stream-server')
    if (!key || !server) throw new Error('Twitchへの映像送信準備が未完了です。Twitchを再接続してください')
    try {
      await this.callVendor('obs-stream-manager-output', 'start_twitch', { server, key })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (detail.toLowerCase().includes('no vendor was found')) {
        throw new Error('OBS Stream Manager OutputプラグインがOBSに読み込まれていません。OBSを再起動してください')
      }
      throw new Error(`Twitch副出力を開始できませんでした: ${detail}`)
    }
    const deadline = Date.now() + this.streamStartTimeoutMs
    do {
      const status = await this.callVendor('obs-stream-manager-output', 'twitch_status')
      const totalFrames = typeof status.totalFrames === 'number' ? status.totalFrames : null
      // OBS marks an RTMP output active before the first encoded frame reaches it.
      // Waiting for the first frame keeps the UI and follow-up recording startup
      // from treating the RTMP handshake/warm-up period as live video time.
      if (status.outputActive === true && (totalFrames === null || totalFrames > 0)) {
        const width = typeof status.videoWidth === 'number' ? status.videoWidth : null
        const height = typeof status.videoHeight === 'number' ? status.videoHeight : null
        const fpsNumerator = typeof status.fpsNumerator === 'number' ? status.fpsNumerator : null
        const fpsDenominator = typeof status.fpsDenominator === 'number' ? status.fpsDenominator : null
        const fps = fpsNumerator !== null && fpsDenominator !== null && fpsDenominator > 0
          ? fpsNumerator / fpsDenominator
          : null
        const expectedFps = managedOutputPreset.fpsNumerator / managedOutputPreset.fpsDenominator
        let videoError: string | null = null
        if (status.dedicatedEncoder !== true) {
          videoError = '専用エンコーダーを確認できません'
        } else if (width !== managedOutputPreset.width || height !== managedOutputPreset.height) {
          videoError = `映像サイズが${width ?? '?'}x${height ?? '?'}です（必要: ${managedOutputPreset.width}x${managedOutputPreset.height}）`
        } else if (fps === null || Math.abs(fps - expectedFps) > 0.01) {
          videoError = `フレームレートが${fps === null ? '?' : fps.toFixed(2)}fpsです（必要: ${expectedFps}fps）`
        }
        if (videoError) {
          await this.callVendor('obs-stream-manager-output', 'stop_twitch').catch(() => undefined)
          throw new Error(`Twitch副出力の映像設定が不正です: ${videoError}`)
        }
        return
      }
      await wait(250)
    } while (Date.now() < deadline)
    throw new Error('Twitch副出力から映像フレームが送信されませんでした')
  }

  private async stopTwitchSecondary(): Promise<void> {
    await this.callVendor('obs-stream-manager-output', 'stop_twitch')
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

  private async protectHighResolutionSimulcast(
    protection: { protected: boolean; width: number; height: number },
    warnings: string[],
  ): Promise<void> {
    if (!protection.protected) return
    try {
      if (await this.stopVerticalBacktrackIfActive()) {
        warnings.push(`${protection.width}×${protection.height}の同時配信を60 FPSで維持するため、Aitum Vertical Backtrackを停止しました`)
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
      if (!streamKey) throw new Error('YouTube 配信キーが未取得です。ゲームを選び直して配信準備を完了してください')
      const streamServer = this.secrets.get('youtube-stream-server')
      if (!streamServer) throw new Error('YouTube 配信サーバーが未取得です。ゲームを選び直して配信準備を完了してください')
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
    if ((await this.obs.call('GetStreamStatus')).outputActive) {
      throw Object.assign(new Error('OBS配信中は配信先を変更できません'), { statusCode: 409 })
    }
    await this.configurePrimaryStream(config, profile)
  }

  async startSecondaryTwitchForObsStream(config: AppConfig, profile: GameProfile): Promise<string[]> {
    const warnings: string[] = []
    if (!(config.features.youtube && profile.youtube.enabled && config.features.twitch && profile.twitch.enabled)) return warnings
    await this.connect(config)
    await this.configureStreamEncoder().catch((error) => {
      warnings.push(`配信ビットレートをCBR ${managedOutputPreset.videoBitrateKbps} kbpsへ固定できませんでした: ${error instanceof Error ? error.message : String(error)}`)
    })
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
      if (!status.outputActive) return true
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
  ): Promise<TwitchIngestTestResult> {
    await this.connect(config)
    const [currentStream, currentRecord, currentReplay] = await Promise.all([
      this.obs.call('GetStreamStatus'),
      this.obs.call('GetRecordStatus'),
      this.getReplayBufferStatus(),
    ])
    const currentSecondary = options.includeSecondary === false ? null : await this.getTwitchOutputPluginStatus()
    if (currentStream.outputActive || currentRecord.outputActive || currentReplay.outputActive || currentSecondary?.outputActive) {
      throw Object.assign(new Error('出力中はTwitch出力テストを実行できません。配信・録画・リプレイを停止してから再実行してください'), { statusCode: 409 })
    }
    const streamKey = this.secrets.get('twitch-stream-key')
    const streamServer = this.secrets.get('twitch-stream-server')
    if (!streamKey || !streamServer) throw new Error('Twitchへの映像送信準備が未完了です。Twitchを再接続してください')
    const testKey = `${streamKey}${streamKey.includes('?') ? '&' : '?'}bandwidthtest=true`
    const boundedDurationMs = Math.max(0, Math.min(30_000, durationMs))
    let started = false
    let secondaryStarted = false
    let recordingStarted = false
    let replayStarted = false
    let changed = false
    let encoderConfigured = false
    let secondaryStartedAt = 0
    let verticalBacktrackStopped = false
    const warnings: string[] = []
    try {
      await this.configureManagedOutput(warnings)
      await this.configureSeparatedAudioTracks(config, warnings)
      const video = await this.obs.call('GetVideoSettings').catch(() => null)
      if ((video?.outputWidth ?? 0) * (video?.outputHeight ?? 0) >= 2560 * 1440) {
        verticalBacktrackStopped = await this.stopVerticalBacktrackIfActive().catch(() => false)
      }
      changed = await this.configureManagedStream(streamServer, testKey)
      try { await this.configureStreamEncoder() } catch { /* retry after OBS creates the encoder */ }
      await this.obs.call('StartStream')
      started = true
      if (!await this.waitForStreamActive()) throw new Error('OBSからTwitchテスト出力を開始できませんでした')
      await this.configureStreamEncoder()
        .then(() => { encoderConfigured = true })
        .catch((error) => warnings.push(`配信ビットレートをCBR ${managedOutputPreset.videoBitrateKbps} kbpsへ固定できませんでした: ${error instanceof Error ? error.message : String(error)}`))
      if (options.includeSecondary !== false) {
        await this.startTwitchSecondary({ server: streamServer, key: testKey })
        secondaryStarted = true
        secondaryStartedAt = Date.now()
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
      const [secondaryBaseline, recordBaseline, replayBaseline, baselineStats] = await Promise.all([
        secondaryStarted ? this.callVendor('obs-stream-manager-output', 'twitch_status') : Promise.resolve(null),
        recordingStarted ? this.obs.call('GetRecordStatus') : Promise.resolve(null),
        replayStarted ? this.getReplayBufferStatus() : Promise.resolve(null),
        this.obs.call('GetStats'),
      ])
      await wait(boundedDurationMs)
      const [status, secondaryStatus, recordStatus, replayStatus, stats] = await Promise.all([
        this.obs.call('GetStreamStatus'),
        secondaryStarted ? this.callVendor('obs-stream-manager-output', 'twitch_status') : Promise.resolve(null),
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
      const metrics = (output: Record<string, unknown> | null, baseline: Record<string, unknown> | null, fallbackDurationMs: number) => output ? {
        durationMs: baseline && typeof output.outputDuration === 'number' && typeof baseline.outputDuration === 'number'
          ? Math.max(0, output.outputDuration - baseline.outputDuration)
          : fallbackDurationMs,
        bytesSent: Math.max(0, outputMetric(output, 'outputBytes', 'bytesSent') - (baseline ? outputMetric(baseline, 'outputBytes', 'bytesSent') : 0)),
        totalFrames: Math.max(0, outputMetric(output, 'outputTotalFrames', 'totalFrames') - (baseline ? outputMetric(baseline, 'outputTotalFrames', 'totalFrames') : 0)),
        skippedFrames: Math.max(0, outputMetric(output, 'outputSkippedFrames', 'skippedFrames') - (baseline ? outputMetric(baseline, 'outputSkippedFrames', 'skippedFrames') : 0)),
      } : null
      const measuredDurationMs = Date.now() - measurementStartedAt
      return {
        ok: true,
        output: {
          width: video?.outputWidth ?? 0,
          height: video?.outputHeight ?? 0,
          fpsNumerator: video?.fpsNumerator ?? 0,
          fpsDenominator: video?.fpsDenominator ?? 0,
          videoBitrateKbps: managedOutputPreset.videoBitrateKbps,
          audioBitrateKbps: managedOutputPreset.audioBitrateKbps,
          encoderConfigured,
        },
        durationMs: status.outputDuration,
        bytesSent: status.outputBytes,
        totalFrames: status.outputTotalFrames,
        skippedFrames: status.outputSkippedFrames,
        congestion: status.outputCongestion,
        secondary: metrics(secondaryStatus, secondaryBaseline, secondaryStarted ? measuredDurationMs : Date.now() - secondaryStartedAt),
        recording: metrics(recordStatus, recordBaseline, measuredDurationMs),
        replayBuffer: metrics(replayStatus, replayBaseline, measuredDurationMs),
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
        await this.waitForStreamInactive().catch(() => false)
      }
      if (changed) await this.restorePreviousStreamService()
    }
  }

  async applyProfile(config: AppConfig, profile: GameProfile, method: CaptureMethod): Promise<ProfileApplyResult> {
    await this.connect(config)
    const warnings: string[] = []
    await this.configureManagedOutput(warnings)
    await this.obs.call('SetCurrentProgramScene', { sceneName: profile.obs.sceneName })

    const selectedSource = this.captureSource(profile, method)
    const captureSources = new Set([
      profile.capture.localSourceName,
      profile.capture.geforceNowSourceName,
      profile.capture.windowSourceName,
      profile.capture.displaySourceName,
      'Elgato Game Capture',
    ].filter((name): name is string => Boolean(name)))
    for (const source of captureSources) await this.setSceneItem(profile.obs.sceneName, source, source === selectedSource)
    const sourceActive = await this.obs.call('GetSourceActive', { sourceName: selectedSource }).catch(() => null)
    if (!sourceActive?.videoActive) warnings.push(`映像ソース「${selectedSource}」がアクティブではありません`)

    await Promise.all([
      this.setVolume(config.sources.microphone, profile.audio.microphoneDb),
      this.setVolume(config.sources.discord, profile.audio.discordDb),
      this.setVolume(config.sources.bgm, profile.audio.bgmDb),
      this.setVolume(stockBgmInputName, profile.audio.bgmDb),
      this.setVolume(method === 'geforce_now' ? config.sources.geforceNow : method === 'elgato' ? config.sources.switchGame : config.sources.pcGame, profile.audio.gameDb),
    ])
    await this.setMuted(config.sources.microphone, false)
    let audioApplied = true
    try {
      const managed = await this.audioCalibration.applyManagedMicrophoneFilters(this.obs, config.sources.microphone, profile.audio.microphoneBoostDb)
      warnings.push(...managed.warnings)
    } catch (error) {
      audioApplied = false
      warnings.push(`マイクの自動音量保護を適用できませんでした: ${error instanceof Error ? error.message : String(error)}`)
    }
    await this.reconcileMicrophoneSceneItems(config, profile, warnings)
    await this.configureSeparatedAudioTracks(config, warnings)

    const activeAudio = method === 'geforce_now' ? config.sources.geforceNow : method === 'elgato' ? config.sources.switchGame : config.sources.pcGame
    for (const source of [config.sources.pcGame, config.sources.geforceNow, config.sources.switchGame]) await this.setMuted(source, source !== activeAudio)
    const filters = await this.obs.call('GetSourceFilterList', { sourceName: activeAudio }).catch(() => null)
    const compressor = filters?.filters.find((filter) => {
      const kind = typeof filter.filterKind === 'string' ? filter.filterKind : ''
      const name = typeof filter.filterName === 'string' ? filter.filterName : ''
      return kind.includes('compressor') || name.toLowerCase().includes('duck')
    })
    const compressorName = typeof compressor?.filterName === 'string' ? compressor.filterName : null
    const duckingEnabled = profile.audio.duckingDb < 0
    if (compressorName) {
      await this.obs.call('SetSourceFilterEnabled', { sourceName: activeAudio, filterName: compressorName, filterEnabled: duckingEnabled })
        .catch(() => warnings.push(`ゲーム音ダッキングフィルター「${compressorName}」を${duckingEnabled ? '有効化' : '無効化'}できませんでした`))
    } else if (duckingEnabled) {
      warnings.push(`ゲーム音のダッキング目標 ${profile.audio.duckingDb} dB に対応するコンプレッサーフィルターが「${activeAudio}」にありません`)
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

  async ensureProfileAudio(config: AppConfig, profile: GameProfile, method: CaptureMethod): Promise<string[]> {
    await this.connect(config)
    const warnings: string[] = []
    const activeGame = method === 'geforce_now' ? config.sources.geforceNow : method === 'elgato' ? config.sources.switchGame : config.sources.pcGame
    const managed = await this.audioCalibration.applyManagedMicrophoneFilters(this.obs, config.sources.microphone, profile.audio.microphoneBoostDb)
    warnings.push(...managed.warnings)
    const volumes: Array<[string, number]> = [
      [config.sources.microphone, profile.audio.microphoneDb],
      [activeGame, profile.audio.gameDb],
      [config.sources.discord, profile.audio.discordDb],
      [config.sources.bgm, profile.audio.bgmDb],
      [stockBgmInputName, profile.audio.bgmDb],
    ]
    for (const [inputName, inputVolumeDb] of volumes) {
      await this.audioCalibration.assertOutputsInactive(this.obs)
      await this.setVolume(inputName, inputVolumeDb)
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
    const active = await this.obs.call('GetSourceActive', { sourceName: selectedSource }).catch(() => null)
    if (!active?.videoActive) throw new Error(`キャプチャ映像「${selectedSource}」を確認できないため、配信を開始しません`)

    const previousScene = await this.obs.call('GetCurrentProgramScene')
      .then(({ currentProgramSceneName }) => currentProgramSceneName)
      .catch(() => profile.obs.sceneName)
    await this.obs.call('SetCurrentProgramScene', { sceneName: profile.obs.startingScene })
    const warnings: string[] = []
    const startedNow = { stream: false, twitch: false, record: false, replay: false, sourceRecord: false, vertical: false }
    let restoreManagedStreamServiceOnFailure = false
    try {
      await this.configureManagedOutput(warnings)
      const protection = await this.highResolutionSimulcast(config, profile)
      await this.protectHighResolutionSimulcast(protection, warnings)
      const stream = await this.obs.call('GetStreamStatus')
      if (!stream.outputActive) await this.configureSeparatedAudioTracks(config, warnings)
      if (!stream.outputActive) {
        await this.configurePrimaryStream(config, profile)
        restoreManagedStreamServiceOnFailure = this.streamServiceManaged
        try { await this.configureStreamEncoder() } catch { /* retry after OBS creates the encoder */ }
      }
      if (!stream.outputActive) {
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
      await this.configureStreamEncoder().catch((error) => warnings.push(`配信ビットレートをCBR ${managedOutputPreset.videoBitrateKbps} kbpsへ固定できませんでした: ${error instanceof Error ? error.message : String(error)}`))
      if (config.features.youtube && profile.youtube.enabled && config.features.twitch && profile.twitch.enabled) {
        await this.startTwitchSecondary()
        this.started.twitch = true
        startedNow.twitch = true
      }

      // Allocate the primary simulcast encoder before optional recording encoders.
      // The managed 1080p60 preset keeps the shared YouTube/Twitch encoder within
      // Twitch's 6000 kbps ceiling while recording reuses the same encoder.
      const record = await this.obs.call('GetRecordStatus')
      if (config.features.recording && profile.recording.enabled && !record.outputActive) {
        try { await this.obs.call('StartRecord'); this.started.record = true; startedNow.record = true }
        catch (error) { warnings.push(`通常録画を開始できませんでした: ${error instanceof Error ? error.message : String(error)}`) }
      }
      const replay = await this.getReplayBufferStatus()
      if (config.features.replayBuffer && !replay.outputActive) {
        try { await this.obs.call('StartReplayBuffer'); this.started.replay = true; startedNow.replay = true }
        catch (error) { warnings.push(`リプレイバッファを開始できませんでした: ${error instanceof Error ? error.message : String(error)}`) }
      }

      const optionalRequested = (config.features.sourceRecord && profile.recording.sourceRecord)
        || (config.features.verticalRecording && profile.recording.verticalRecording)
      const baselineSkippedFrames = optionalRequested && !protection.protected
        ? await this.obs.call('GetStats').then(({ outputSkippedFrames }) => outputSkippedFrames).catch(() => null)
        : null
      if (protection.protected && optionalRequested) {
        warnings.push(`${protection.width}×${protection.height}の同時配信を60 FPSで維持するため、Source RecordとAitum Vertical録画は開始しませんでした`)
      } else {
        if (config.features.sourceRecord && profile.recording.sourceRecord) {
          try {
            await this.callVendor('source-record', 'record_start', { source: selectedSource })
            this.started.sourceRecord = true; this.started.sourceRecordSource = selectedSource; startedNow.sourceRecord = true
          } catch (error) { warnings.push(`Source Recordを開始できませんでした: ${error instanceof Error ? error.message : String(error)}`) }
        }
        if (config.features.verticalRecording && profile.recording.verticalRecording) {
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
          if (startedNow.sourceRecord) await this.callVendor('source-record', 'record_stop', { source: selectedSource }).catch(() => undefined)
          this.started.vertical = false
          this.started.sourceRecord = false
          this.started.sourceRecordSource = null
          startedNow.vertical = false
          startedNow.sourceRecord = false
          warnings.push('エンコード遅延を検出したため、素材録画と縦録画を自動停止してYouTube・Twitch配信を優先しました')
        }
      }
      if (!(await this.obs.call('GetStreamStatus')).outputActive) throw new Error('OBS配信出力が開始直後に停止しました。OBSログを確認してください')
      await this.obs.call('SetCurrentProgramScene', { sceneName: profile.obs.sceneName })
      this.rollbackScene = previousScene
      return warnings
    } catch (error) {
      if (startedNow.vertical) await this.callVertical('stop_recording').catch(() => undefined)
      if (startedNow.sourceRecord) await this.callVendor('source-record', 'record_stop', { source: selectedSource }).catch(() => undefined)
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
        }))
      } catch (error) {
        warnings.push(`通常録画を停止できませんでした: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    let streamStopped = !stream.outputActive
    if (stream.outputActive) {
      try {
        await this.obs.call('StopStream')
        outputStopChecks.push(this.waitForStreamInactive().then((stopped) => {
          streamStopped = stopped
          if (!stopped) warnings.push('OBS配信出力の停止を確認できませんでした')
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
      await this.callVendor('source-record', 'record_stop', { source: this.started.sourceRecordSource })
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
    await this.obs.call('SetCurrentProgramScene', { sceneName: profile?.obs.endingScene ?? '90_ENDING' })
    await wait(config.obs.endDelaySeconds * 1000)
    const warnings = await this.stopOutputs()
    this.rollbackScene = null
    return warnings
  }

  async isStreaming(config: AppConfig): Promise<boolean> {
    await this.connect(config)
    return (await this.obs.call('GetStreamStatus')).outputActive
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
      const [stream, record, replay, scene, twitchOutputPlugin] = await Promise.all([
        this.obs.call('GetStreamStatus'),
        this.obs.call('GetRecordStatus'),
        this.getReplayBufferStatus(),
        this.obs.call('GetCurrentProgramScene'),
        this.getTwitchOutputPluginStatus(),
      ])
      return { obsConnected: true, streaming: stream.outputActive, streamElapsedMs: stream.outputDuration, recording: record.outputActive, replayBuffer: replay.outputActive, sourceRecord: this.started.sourceRecord, verticalRecording: this.started.vertical, selectedGameId, captureMethod, currentScene: scene.currentProgramSceneName, warning, busy, twitchOutputPluginReady: twitchOutputPlugin.state === 'ready', twitchOutputPlugin }
    } catch {
      this.connected = false
      this.resetTransientOutputOwnership()
      return { obsConnected: false, streaming: false, recording: false, replayBuffer: false, sourceRecord: false, verticalRecording: false, selectedGameId, captureMethod, currentScene: null, warning, busy, twitchOutputPluginReady: false, twitchOutputPlugin: { state: 'missing', detail: 'OBS未接続のため副出力プラグインを確認できません', outputActive: false } }
    }
  }
}
