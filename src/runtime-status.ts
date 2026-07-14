import type { RuntimeStatus } from '../shared/contracts'

export type BroadcastStatus = {
  label: string
  detail: string
  tone: 'live' | 'stopped' | 'unknown'
}

export type RuntimeOutputStatus = {
  key: 'obs' | 'recording' | 'replay' | 'source' | 'vertical'
  label: string
  state: string
  active: boolean
}

export function getBroadcastStatus(status: RuntimeStatus): BroadcastStatus {
  if (!status.obsConnected) return { label: '配信状態不明', detail: 'OBS未接続', tone: 'unknown' }
  if (status.streaming) return { label: '配信中', detail: status.busy ? '切替処理中' : 'LIVE', tone: 'live' }
  return { label: '配信停止中', detail: status.busy ? '切替処理中' : 'OFFLINE', tone: 'stopped' }
}

export function getRuntimeOutputs(status: RuntimeStatus): RuntimeOutputStatus[] {
  return [
    { key: 'obs', label: 'OBS', state: status.obsConnected ? '接続中' : '未接続', active: status.obsConnected },
    { key: 'recording', label: '録画', state: status.recording ? '録画中' : '停止', active: status.recording },
    { key: 'replay', label: 'リプレイ', state: status.replayBuffer ? '動作中' : '停止', active: status.replayBuffer },
    { key: 'source', label: '素材', state: status.sourceRecord ? '録画中' : '停止', active: status.sourceRecord },
    { key: 'vertical', label: '縦録画', state: status.verticalRecording ? '録画中' : '停止', active: status.verticalRecording },
  ]
}
