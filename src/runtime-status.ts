import type { RuntimeStatus } from '../shared/contracts'

export type BroadcastStatus = {
  label: string
  detail: string
  detailValues?: Record<string, string | number>
  tone: 'live' | 'sending' | 'stopped' | 'unknown'
}

export type RuntimeOutputStatus = {
  key: 'obs' | 'youtube' | 'twitch' | 'recording' | 'replay' | 'vertical'
  label: string
  state: string
  active: boolean
  tone: 'active' | 'pending' | 'inactive' | 'error'
  detail?: string
  observation?: 'deferred'
  connectionIssue?: 'reconnect_required'
}

export function getBroadcastStatus(status: RuntimeStatus, selectedGameName?: string | null): BroadcastStatus {
  const platforms = [['YouTube', status.platforms.youtube], ['Twitch', status.platforms.twitch]] as const
  const livePlatforms = platforms
    .filter(([, platform]) => platform.state === 'live' && platform.observation !== 'deferred')
    .map(([name]) => name)
  const deferredActive = platforms.filter(([, platform]) => platform.observation === 'deferred' && ['starting', 'live', 'stopping'].includes(platform.state))
  const reconnectRequired = platforms.some(([, platform]) => platform.connectionIssue === 'reconnect_required')
  if (livePlatforms.length) return { label: '外部配信中', detail: livePlatforms.join(' + '), tone: 'live' }
  if (!status.obsConnected) return { label: '配信状態不明', detail: 'OBS未接続', tone: 'unknown' }
  if (status.streaming) {
    if (deferredActive.length) return { label: 'OBS送信中・外部配信は現在未確認', detail: '前回確認した配信先: {services}', detailValues: { services: deferredActive.map(([name]) => name).join(' + ') }, tone: 'sending' }
    const checking = platforms.some(([, platform]) => platform.state === 'starting' && platform.observation !== 'deferred')
    return checking
      ? { label: '外部配信を確認中', detail: status.busy ? '同期処理中' : 'OBS送信中', tone: 'sending' }
      : { label: 'OBSのみ送信中', detail: '外部ライブ未確認', tone: 'sending' }
  }
  if (platforms.some(([, platform]) => platform.state === 'stopping' && platform.observation !== 'deferred')) {
    return { label: '外部配信終了中', detail: '終了確認中', tone: 'sending' }
  }
  if (status.recordingOnly && status.recording) {
    const gameName = status.recordingGameName === undefined ? selectedGameName : status.recordingGameName
    if (deferredActive.length || reconnectRequired) return gameName?.trim()
      ? { label: '録画専用モード', detail: '{game}録画中・外部配信は現在未確認', detailValues: { game: gameName.trim() }, tone: 'sending' }
      : { label: '録画専用モード', detail: '録画中・外部配信は現在未確認', tone: 'sending' }
    return gameName?.trim()
      ? { label: '録画専用モード', detail: '配信停止・{game}録画中', detailValues: { game: gameName.trim() }, tone: 'sending' }
      : { label: '録画専用モード', detail: '配信停止・選択中ゲーム録画中', tone: 'sending' }
  }
  if (deferredActive.length) return { label: '外部配信は現在未確認', detail: '前回確認した配信先: {services}', detailValues: { services: deferredActive.map(([name]) => name).join(' + ') }, tone: 'unknown' }
  if (reconnectRequired) return { label: '配信先の再接続が必要', detail: '外部配信は現在未確認', tone: 'sending' }
  if (platforms.some(([, platform]) => platform.observation === 'deferred')) return { label: '外部配信は現在未確認', detail: '状態確認を保留中', tone: 'unknown' }
  return { label: '配信停止中', detail: status.busy ? '切替処理中' : 'OFFLINE', tone: 'stopped' }
}

function platformStateLabel(state: RuntimeStatus['platforms']['youtube']['state']): string {
  if (state === 'live') return 'ライブ'
  if (state === 'starting') return '開始確認中'
  if (state === 'stopping') return '終了確認中'
  if (state === 'ready') return '待機中'
  if (state === 'offline') return 'オフライン'
  if (state === 'unprepared') return '未準備'
  if (state === 'disabled') return '無効'
  return '確認失敗'
}

function platformTone(state: RuntimeStatus['platforms']['youtube']['state']): RuntimeOutputStatus['tone'] {
  if (state === 'live') return 'active'
  if (state === 'starting' || state === 'stopping' || state === 'ready') return 'pending'
  if (state === 'error') return 'error'
  return 'inactive'
}

function platformOutput(key: 'youtube' | 'twitch', label: string, platform: RuntimeStatus['platforms']['youtube']): RuntimeOutputStatus {
  const deferred = platform.observation === 'deferred'
  const reconnectRequired = platform.connectionIssue === 'reconnect_required'
  const activeOrTransitioning = ['live', 'starting', 'stopping'].includes(platform.state)
  const previousState = platform.state === 'live' ? '前回ライブ・現在未確認'
    : platform.state === 'starting' ? '前回開始確認中・現在未確認'
      : platform.state === 'stopping' ? '前回終了確認中・現在未確認' : '現在未確認'
  return {
    key, label,
    state: reconnectRequired && !activeOrTransitioning
      ? deferred ? '配信には再接続が必要' : '再接続が必要'
      : deferred ? previousState : platformStateLabel(platform.state),
    // Raw active state remains conservative for consumers guarding operations.
    active: platform.state === 'live',
    tone: deferred || reconnectRequired && !activeOrTransitioning ? 'pending' : platformTone(platform.state),
    detail: platform.detail,
    ...(deferred ? { observation: 'deferred' as const } : {}),
    ...(reconnectRequired ? { connectionIssue: 'reconnect_required' as const } : {}),
  }
}

export function getRuntimeOutputs(status: RuntimeStatus): RuntimeOutputStatus[] {
  return [
    { key: 'obs', label: 'OBS送信', state: !status.obsConnected ? '未接続' : status.streaming ? '送信中' : '停止', active: status.streaming, tone: status.streaming ? 'active' : status.obsConnected ? 'inactive' : 'error' },
    platformOutput('youtube', 'YouTube', status.platforms.youtube),
    platformOutput('twitch', 'Twitch', status.platforms.twitch),
    { key: 'recording', label: status.recordingOnly ? '録画のみ' : '録画', state: status.recording ? '録画中' : '停止', active: status.recording, tone: status.recording ? 'active' : 'inactive' },
    { key: 'replay', label: 'リプレイ', state: status.replayBuffer ? '動作中' : '停止', active: status.replayBuffer, tone: status.replayBuffer ? 'active' : 'inactive' },
    { key: 'vertical', label: '縦録画', state: status.verticalRecording ? '録画中' : '停止', active: status.verticalRecording, tone: status.verticalRecording ? 'active' : 'inactive' },
  ]
}

export function getExternalDeliveryWarning(status: RuntimeStatus): string | null {
  const platforms = [status.platforms.youtube, status.platforms.twitch]
  const states = platforms.filter((platform) => platform.observation !== 'deferred').map(({ state }) => state)
  if (!status.streaming && states.includes('live')) return 'OBSは停止していますが、外部サービスではまだライブ状態です。終了処理を確認してください。'
  if (platforms.some((platform) => platform.observation === 'deferred' && ['starting', 'live', 'stopping'].includes(platform.state))) {
    return '外部配信には前回確認時の状態を表示しています。現在のライブ・終了状態は未確認です。'
  }
  if (status.streaming && !states.includes('live')) {
    if (states.some((state) => state === 'starting')) return 'OBSは送信中です。YouTube / Twitch の公開開始を確認しています。'
    return 'OBSは送信中ですが、YouTube / Twitch で公開配信中とは確認できていません。'
  }
  if (!status.streaming && states.includes('stopping')) return 'OBSは停止しました。YouTube / Twitch の終了完了を確認しています。'
  return null
}
