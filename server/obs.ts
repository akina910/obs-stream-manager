import OBSWebSocket from 'obs-websocket-js'
import type { AppConfig, CaptureMethod, GameProfile, RuntimeStatus } from '../shared/contracts.js'
import { SecretStore } from './secrets.js'

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

export class ObsController {
  private readonly obs = new OBSWebSocket()
  private connected = false
  private started = { stream: false, record: false, replay: false, sourceRecord: false, vertical: false, sourceRecordSource: null as string | null }

  constructor(private readonly secrets: SecretStore) {
    this.obs.on('ConnectionClosed', () => { this.connected = false })
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
    if (profile.audio.duckingDb < 0) {
      const filters = await this.obs.call('GetSourceFilterList', { sourceName: activeAudio }).catch(() => null)
      const compressor = filters?.filters.find((filter) => {
        const kind = typeof filter.filterKind === 'string' ? filter.filterKind : ''
        const name = typeof filter.filterName === 'string' ? filter.filterName : ''
        return kind.includes('compressor') || name.toLowerCase().includes('duck')
      })
      const compressorName = typeof compressor?.filterName === 'string' ? compressor.filterName : null
      if (compressorName) await this.obs.call('SetSourceFilterEnabled', { sourceName: activeAudio, filterName: compressorName, filterEnabled: true }).catch(() => warnings.push(`ゲーム音ダッキングフィルター「${compressorName}」を有効化できませんでした`))
      else warnings.push(`ゲーム音のダッキング目標 ${profile.audio.duckingDb} dB に対応するコンプレッサーフィルターが「${activeAudio}」にありません`)
    }

    const { outputActive } = await this.obs.call('GetRecordStatus')
    if (!outputActive && profile.recording.directory) {
      for (const [parameterCategory, parameterName] of [['AdvOut', 'RecFilePath'], ['SimpleOutput', 'FilePath']] as const) {
        await this.obs.call('SetProfileParameter', { parameterCategory, parameterName, parameterValue: profile.recording.directory }).catch(() => undefined)
      }
    }
    if (!outputActive) {
      for (const category of ['AdvOut', 'SimpleOutput']) {
        await this.obs.call('SetProfileParameter', { parameterCategory: category, parameterName: 'RecRBTime', parameterValue: String(profile.recording.replayBufferSeconds) }).catch(() => undefined)
      }
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
    try {
      const record = await this.obs.call('GetRecordStatus')
      if (config.features.recording && profile.recording.enabled && !record.outputActive) {
        try { await this.obs.call('StartRecord'); this.started.record = true; startedNow.record = true }
        catch (error) { warnings.push(`通常録画を開始できませんでした: ${error instanceof Error ? error.message : String(error)}`) }
      }
      const replay = await this.obs.call('GetReplayBufferStatus')
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
          await this.callVendor('aitum-vertical-canvas', 'start_recording')
          this.started.vertical = true; startedNow.vertical = true
        } catch (error) { warnings.push(`Aitum Vertical録画を開始できませんでした: ${error instanceof Error ? error.message : String(error)}`) }
      }
      const stream = await this.obs.call('GetStreamStatus')
      if (!stream.outputActive) { await this.obs.call('StartStream'); this.started.stream = true; startedNow.stream = true }
      await wait(config.obs.startDelaySeconds * 1000)
      await this.obs.call('SetCurrentProgramScene', { sceneName: profile.obs.sceneName })
      return warnings
    } catch (error) {
      if (startedNow.stream) await this.obs.call('StopStream').catch(() => undefined)
      if (startedNow.vertical) await this.callVendor('aitum-vertical-canvas', 'stop_recording').catch(() => undefined)
      if (startedNow.sourceRecord) await this.callVendor('source-record', 'record_stop', { source: selectedSource }).catch(() => undefined)
      if (startedNow.replay) await this.obs.call('StopReplayBuffer').catch(() => undefined)
      if (startedNow.record) await this.obs.call('StopRecord').catch(() => undefined)
      if (startedNow.stream) this.started.stream = false
      if (startedNow.vertical) this.started.vertical = false
      if (startedNow.sourceRecord) { this.started.sourceRecord = false; this.started.sourceRecordSource = null }
      if (startedNow.replay) this.started.replay = false
      if (startedNow.record) this.started.record = false
      throw error
    }
  }

  async stop(config: AppConfig, profile: GameProfile | null): Promise<string[]> {
    await this.connect(config)
    const warnings: string[] = []
    await this.obs.call('SetCurrentProgramScene', { sceneName: profile?.obs.endingScene ?? '90_ENDING' })
    await wait(config.obs.endDelaySeconds * 1000)
    const [stream, record, replay] = await Promise.all([
      this.obs.call('GetStreamStatus'), this.obs.call('GetRecordStatus'), this.obs.call('GetReplayBufferStatus'),
    ])
    if (this.started.sourceRecord && this.started.sourceRecordSource) await this.callVendor('source-record', 'record_stop', { source: this.started.sourceRecordSource }).catch((error) => warnings.push(`Source Recordを停止できませんでした: ${error instanceof Error ? error.message : String(error)}`))
    if (this.started.vertical) await this.callVendor('aitum-vertical-canvas', 'stop_recording').catch((error) => warnings.push(`Aitum Vertical録画を停止できませんでした: ${error instanceof Error ? error.message : String(error)}`))
    if (replay.outputActive && this.started.replay) await this.obs.call('StopReplayBuffer').catch((error) => warnings.push(`リプレイバッファを停止できませんでした: ${error instanceof Error ? error.message : String(error)}`))
    if (record.outputActive && this.started.record) await this.obs.call('StopRecord').catch((error) => warnings.push(`通常録画を停止できませんでした: ${error instanceof Error ? error.message : String(error)}`))
    if (stream.outputActive) await this.obs.call('StopStream').catch((error) => warnings.push(`配信を停止できませんでした: ${error instanceof Error ? error.message : String(error)}`))
    this.started = { stream: false, record: false, replay: false, sourceRecord: false, vertical: false, sourceRecordSource: null }
    return warnings
  }

  async saveReplay(config: AppConfig): Promise<void> {
    await this.connect(config)
    await this.obs.call('SaveReplayBuffer')
  }

  async switchScene(config: AppConfig, sceneName: string): Promise<void> {
    await this.connect(config)
    await this.obs.call('SetCurrentProgramScene', { sceneName })
  }

  async status(config: AppConfig, selectedGameId: string | null, captureMethod: CaptureMethod | null, busy: boolean, warning: string | null): Promise<RuntimeStatus> {
    try {
      await this.connect(config)
      const [stream, record, replay, scene] = await Promise.all([
        this.obs.call('GetStreamStatus'), this.obs.call('GetRecordStatus'), this.obs.call('GetReplayBufferStatus'), this.obs.call('GetCurrentProgramScene'),
      ])
      return { obsConnected: true, streaming: stream.outputActive, recording: record.outputActive, replayBuffer: replay.outputActive, sourceRecord: this.started.sourceRecord, verticalRecording: this.started.vertical, selectedGameId, captureMethod, currentScene: scene.currentProgramSceneName, warning, busy }
    } catch {
      this.connected = false
      return { obsConnected: false, streaming: false, recording: false, replayBuffer: false, sourceRecord: this.started.sourceRecord, verticalRecording: this.started.vertical, selectedGameId, captureMethod, currentScene: null, warning, busy }
    }
  }
}
