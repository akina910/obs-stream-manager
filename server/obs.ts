import OBSWebSocket, { type OBSRequestTypes } from 'obs-websocket-js'
import type { AppConfig, CaptureMethod, GameProfile, RuntimeStatus } from '../shared/contracts.js'
import { SecretStore } from './secrets.js'

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))
type StreamServiceSettings = OBSRequestTypes['SetStreamServiceSettings']
type AppliedStreamService = { streamServiceType: string; server: string; key: string }
type ObsRuntimeStatus = Omit<RuntimeStatus, 'platforms'>

export class ObsController {
  private readonly obs = new OBSWebSocket()
  private connected = false
  private streamServiceManaged = false
  private readonly streamStateListeners = new Set<(active: boolean) => void>()
  private started = { stream: false, record: false, replay: false, sourceRecord: false, vertical: false, sourceRecordSource: null as string | null }

  constructor(private readonly secrets: SecretStore, private readonly streamStartTimeoutMs = 8_000) {
    this.obs.on('ConnectionClosed', () => { this.connected = false })
    this.obs.on('StreamStateChanged', ({ outputActive }) => {
      for (const listener of this.streamStateListeners) listener(outputActive)
    })
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
    if (this.connected) await this.obs.disconnect()
    this.connected = false
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

  private async callVendor(vendorName: string, requestType: string, requestData: Record<string, string | number | boolean | null> = {}): Promise<void> {
    const response = await this.obs.call('CallVendorRequest', { vendorName, requestType, requestData })
    if (response.responseData.success === false) {
      const error = typeof response.responseData.error === 'string' ? response.responseData.error : 'vendor request failed'
      throw new Error(error)
    }
  }

  private async callVertical(requestType: 'start_recording' | 'stop_recording'): Promise<void> {
    try {
      await this.callVendor('aitum-vertical-canvas', requestType)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.toLowerCase().includes('no vendor was found')) throw error
      await this.obs.call('TriggerHotkeyByName', {
        hotkeyName: requestType === 'start_recording' ? 'VerticalCanvasDockStartRecording' : 'VerticalCanvasDockStopRecording',
      })
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

  private async configureYouTubeStream(config: AppConfig, profile: GameProfile): Promise<boolean> {
    if (!config.features.youtube || !profile.youtube.enabled) return false
    const streamKey = this.secrets.get('youtube-stream-key')
    if (!streamKey) throw new Error('YouTube 配信キーが未取得です。ゲームを選び直して配信準備を完了してください')
    const streamServer = this.secrets.get('youtube-stream-server')
    if (!streamServer) throw new Error('YouTube 配信サーバーが未取得です。ゲームを選び直して配信準備を完了してください')
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
      this.streamServiceManaged = false
      this.secrets.set('obs-applied-stream-service', '')
      this.secrets.set('obs-previous-stream-service', '')
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
    const deadline = Date.now() + this.streamStartTimeoutMs
    do {
      const status = await this.obs.call('GetStreamStatus')
      if (!status.outputActive) return true
      await wait(250)
    } while (Date.now() < deadline)
    return false
  }

  async applyProfile(config: AppConfig, profile: GameProfile, method: CaptureMethod): Promise<string[]> {
    await this.connect(config)
    const warnings: string[] = []
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
      this.setVolume(method === 'geforce_now' ? config.sources.geforceNow : method === 'elgato' ? config.sources.switchGame : config.sources.pcGame, profile.audio.gameDb),
    ])

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
    return warnings
  }

  async start(config: AppConfig, profile: GameProfile, selectedSource: string): Promise<string[]> {
    await this.connect(config)
    const active = await this.obs.call('GetSourceActive', { sourceName: selectedSource }).catch(() => null)
    if (!active?.videoActive) throw new Error(`キャプチャ映像「${selectedSource}」を確認できないため、配信を開始しません`)

    await this.obs.call('SetCurrentProgramScene', { sceneName: profile.obs.startingScene })
    const warnings: string[] = []
    const startedNow = { stream: false, record: false, replay: false, sourceRecord: false, vertical: false }
    let restoreStreamService: (() => Promise<void>) | null = null
    try {
      const stream = await this.obs.call('GetStreamStatus')
      if (!stream.outputActive) {
        const streamServiceChanged = await this.configureYouTubeStream(config, profile)
        if (streamServiceChanged) restoreStreamService = () => this.restorePreviousStreamService()
      }
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
      if (config.features.sourceRecord && profile.recording.sourceRecord) {
        try {
          await this.callVendor('source-record', 'record_start', { source: selectedSource })
          this.started.sourceRecord = true; this.started.sourceRecordSource = selectedSource; startedNow.sourceRecord = true
        } catch (error) { warnings.push(`Source Recordを開始できませんでした: ${error instanceof Error ? error.message : String(error)}`) }
      }
      if (config.features.verticalRecording && profile.recording.verticalRecording) {
        try {
          await this.callVertical('start_recording')
          this.started.vertical = true; startedNow.vertical = true
        } catch (error) { warnings.push(`Aitum Vertical録画を開始できませんでした: ${error instanceof Error ? error.message : String(error)}`) }
      }
      if (!stream.outputActive) {
        await this.obs.call('StartStream')
        this.started.stream = true
        startedNow.stream = true
        if (!await this.waitForStreamActive()) {
          const guidance = config.features.youtube && profile.youtube.enabled
            ? 'YouTube配信キーとOBS出力設定を確認してください'
            : 'OBSの配信サービスと出力設定を確認してください'
          throw new Error(`OBS配信出力が開始状態になりませんでした。${guidance}`)
        }
      }
      await wait(config.obs.startDelaySeconds * 1000)
      if (!(await this.obs.call('GetStreamStatus')).outputActive) throw new Error('OBS配信出力が開始直後に停止しました。OBSログを確認してください')
      await this.obs.call('SetCurrentProgramScene', { sceneName: profile.obs.sceneName })
      return warnings
    } catch (error) {
      let rollbackStreamStopped = true
      if (startedNow.stream) {
        try {
          await this.obs.call('StopStream')
          rollbackStreamStopped = await this.waitForStreamInactive()
        } catch {
          rollbackStreamStopped = await this.waitForStreamInactive().catch(() => false)
        }
      }
      if (restoreStreamService && rollbackStreamStopped) {
        await restoreStreamService().catch((restoreError) => warnings.push(`OBS配信サービス設定を復元できませんでした: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`))
      } else if (restoreStreamService) {
        warnings.push('OBS配信出力の停止を確認できなかったため、配信サービス設定を復元していません')
      }
      if (startedNow.vertical) await this.callVertical('stop_recording').catch(() => undefined)
      if (startedNow.sourceRecord) await this.callVendor('source-record', 'record_stop', { source: selectedSource }).catch(() => undefined)
      if (startedNow.replay) await this.obs.call('StopReplayBuffer').catch(() => undefined)
      if (startedNow.record) await this.obs.call('StopRecord').catch(() => undefined)
      if (startedNow.stream) this.started.stream = false
      if (startedNow.vertical) this.started.vertical = false
      if (startedNow.sourceRecord) { this.started.sourceRecord = false; this.started.sourceRecordSource = null }
      if (startedNow.replay) this.started.replay = false
      if (startedNow.record) this.started.record = false
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(warnings.length ? `${message} / 先行警告: ${warnings.join(' / ')}` : message, { cause: error })
    }
  }

  async stop(config: AppConfig, profile: GameProfile | null): Promise<string[]> {
    await this.connect(config)
    const warnings: string[] = []
    await this.obs.call('SetCurrentProgramScene', { sceneName: profile?.obs.endingScene ?? '90_ENDING' })
    await wait(config.obs.endDelaySeconds * 1000)
    const [stream, record, replay] = await Promise.all([
      this.obs.call('GetStreamStatus'), this.obs.call('GetRecordStatus'), this.getReplayBufferStatus(),
    ])
    // The Stop action is a global teardown by design. OBS remains authoritative after this
    // process restarts, so do not rely on the controller's transient `started` flags here.
    await this.stopSourceRecord().catch((error) => warnings.push(`Source Recordを停止できませんでした: ${error instanceof Error ? error.message : String(error)}`))
    await this.callVertical('stop_recording').catch((error) => warnings.push(`Aitum Vertical録画を停止できませんでした: ${error instanceof Error ? error.message : String(error)}`))
    if (replay.outputActive) await this.obs.call('StopReplayBuffer').catch((error) => warnings.push(`リプレイバッファを停止できませんでした: ${error instanceof Error ? error.message : String(error)}`))
    if (record.outputActive) await this.obs.call('StopRecord').catch((error) => warnings.push(`通常録画を停止できませんでした: ${error instanceof Error ? error.message : String(error)}`))
    let streamStopped = !stream.outputActive
    if (stream.outputActive) {
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
    this.started = { stream: false, record: false, replay: false, sourceRecord: false, vertical: false, sourceRecordSource: null }
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
      const [stream, record, replay, scene] = await Promise.all([
        this.obs.call('GetStreamStatus'),
        this.obs.call('GetRecordStatus'),
        this.getReplayBufferStatus(),
        this.obs.call('GetCurrentProgramScene'),
      ])
      return { obsConnected: true, streaming: stream.outputActive, recording: record.outputActive, replayBuffer: replay.outputActive, sourceRecord: this.started.sourceRecord, verticalRecording: this.started.vertical, selectedGameId, captureMethod, currentScene: scene.currentProgramSceneName, warning, busy }
    } catch {
      this.connected = false
      return { obsConnected: false, streaming: false, recording: false, replayBuffer: false, sourceRecord: this.started.sourceRecord, verticalRecording: this.started.vertical, selectedGameId, captureMethod, currentScene: null, warning, busy }
    }
  }
}
