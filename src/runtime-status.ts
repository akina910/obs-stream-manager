import type { RuntimeStatus } from '../shared/contracts'

export type BroadcastStatus = {
  label: string
  detail: string
  tone: 'live' | 'sending' | 'stopped' | 'unknown'
}

export type RuntimeOutputStatus = {
  key: 'obs' | 'youtube' | 'twitch' | 'recording' | 'replay' | 'source' | 'vertical'
  label: string
  state: string
  active: boolean
  tone: 'active' | 'pending' | 'inactive' | 'error'
  detail?: string
}

export function getBroadcastStatus(status: RuntimeStatus): BroadcastStatus {
  const livePlatforms = ([['YouTube', status.platforms.youtube], ['Twitch', status.platforms.twitch]] as const)
    .filter(([, platform]) => platform.state === 'live')
    .map(([name]) => name)
  if (livePlatforms.length) return { label: '外部配信中', detail: livePlatforms.join(' + '), tone: 'live' }
  if (!status.obsConnected) return { label: '配信状態不明', detail: 'OBS未接続', tone: 'unknown' }
  if (status.streaming) {
    const checking = [status.platforms.youtube.state, status.platforms.twitch.state].some((state) => state === 'starting')
    return checking
      ? { label: '外部配信を確認中', detail: status.busy ? '同期処理中' : 'OBS送信中', tone: 'sending' }
      : { label: 'OBSのみ送信中', detail: '外部ライブ未確認', tone: 'sending' }
  }
  if ([status.platforms.youtube.state, status.platforms.twitch.state].some((state) => state === 'stopping')) {
    return { label: '外部配信終了中', detail: '終了確認中', tone: 'sending' }
  }
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

export function getRuntimeOutputs(status: RuntimeStatus): RuntimeOutputStatus[] {
  return [
    { key: 'obs', label: 'OBS送信', state: !status.obsConnected ? '未接続' : status.streaming ? '送信中' : '停止', active: status.streaming, tone: status.streaming ? 'active' : status.obsConnected ? 'inactive' : 'error' },
    { key: 'youtube', label: 'YouTube', state: platformStateLabel(status.platforms.youtube.state), active: status.platforms.youtube.state === 'live', tone: platformTone(status.platforms.youtube.state), detail: status.platforms.youtube.detail },
    { key: 'twitch', label: 'Twitch', state: platformStateLabel(status.platforms.twitch.state), active: status.platforms.twitch.state === 'live', tone: platformTone(status.platforms.twitch.state), detail: status.platforms.twitch.detail },
    { key: 'recording', label: '録画', state: status.recording ? '録画中' : '停止', active: status.recording, tone: status.recording ? 'active' : 'inactive' },
    { key: 'replay', label: 'リプレイ', state: status.replayBuffer ? '動作中' : '停止', active: status.replayBuffer, tone: status.replayBuffer ? 'active' : 'inactive' },
    { key: 'source', label: '素材', state: status.sourceRecord ? '録画中' : '停止', active: status.sourceRecord, tone: status.sourceRecord ? 'active' : 'inactive' },
    { key: 'vertical', label: '縦録画', state: status.verticalRecording ? '録画中' : '停止', active: status.verticalRecording, tone: status.verticalRecording ? 'active' : 'inactive' },
  ]
}

export function getExternalDeliveryWarning(status: RuntimeStatus): string | null {
  const states = [status.platforms.youtube.state, status.platforms.twitch.state]
  if (status.streaming && !states.includes('live')) {
    if (states.some((state) => state === 'starting')) return 'OBSは送信中です。YouTube / Twitch の公開開始を確認しています。'
    return 'OBSは送信中ですが、YouTube / Twitch で公開配信中とは確認できていません。'
  }
  if (!status.streaming && states.includes('live')) return 'OBSは停止していますが、外部サービスではまだライブ状態です。終了処理を確認してください。'
  if (!status.streaming && states.includes('stopping')) return 'OBSは停止しました。YouTube / Twitch の終了完了を確認しています。'
  return null
}
