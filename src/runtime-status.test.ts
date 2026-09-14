import { describe, expect, it } from 'vitest'
import type { RuntimeStatus } from '../shared/contracts'
import { getBroadcastStatus, getExternalDeliveryWarning, getRuntimeOutputs } from './runtime-status'

const stoppedStatus: RuntimeStatus = {
  obsConnected: true,
  streaming: false,
  recording: false,
  recordingOnly: false,
  replayBuffer: false,
  sourceRecord: false,
  verticalRecording: false,
  selectedGameId: null,
  captureMethod: null,
  currentScene: '90_ENDING',
  warning: null,
  busy: false,
  platforms: {
    youtube: { state: 'ready', detail: 'OBS映像の受信待ち', checkedAt: '2026-07-14T00:00:00.000Z' },
    twitch: { state: 'offline', detail: 'Twitchはオフライン', checkedAt: '2026-07-14T00:00:00.000Z' },
  },
}

describe('runtime status labels', () => {
  it('shows an explicit stopped state when OBS is connected', () => {
    expect(getBroadcastStatus(stoppedStatus)).toEqual({ label: '配信停止中', detail: 'OFFLINE', tone: 'stopped' })
    expect(getRuntimeOutputs(stoppedStatus).map(({ label, state }) => [label, state])).toEqual([
      ['OBS送信', '停止'],
      ['YouTube', '待機中'],
      ['Twitch', 'オフライン'],
      ['録画', '停止'],
      ['リプレイ', '停止'],
      ['縦録画', '停止'],
    ])
  })

  it('does not misreport a disconnected OBS instance as stopped', () => {
    expect(getBroadcastStatus({ ...stoppedStatus, obsConnected: false })).toEqual({
      label: '配信状態不明',
      detail: 'OBS未接続',
      tone: 'unknown',
    })
  })

  it('shows active output states and a busy transition', () => {
    const active = { ...stoppedStatus, streaming: true, recording: true, replayBuffer: true, sourceRecord: true, verticalRecording: true, busy: true }
    expect(getBroadcastStatus(active)).toEqual({ label: 'OBSのみ送信中', detail: '外部ライブ未確認', tone: 'sending' })
    expect(getExternalDeliveryWarning(active)).toContain('公開配信中とは確認できていません')
    expect(getRuntimeOutputs(active).find(({ key }) => key === 'recording')?.state).toBe('録画中')
    expect(getRuntimeOutputs(active).find(({ key }) => key === 'replay')?.state).toBe('動作中')
    expect(getRuntimeOutputs(active).find(({ key }) => key === 'vertical')?.state).toBe('録画中')
    expect(getBroadcastStatus({ ...stoppedStatus, busy: true })).toEqual({ label: '配信停止中', detail: '切替処理中', tone: 'stopped' })
  })

  it('labels recording-only separately while keeping broadcast delivery stopped', () => {
    const recordingOnly = { ...stoppedStatus, recording: true, recordingOnly: true }
    expect(getBroadcastStatus(recordingOnly, 'Minecraft')).toEqual({
      label: '録画専用モード',
      detail: '配信停止・{game}録画中',
      detailValues: { game: 'Minecraft' },
      tone: 'sending',
    })
    expect(getBroadcastStatus(recordingOnly)).toEqual({ label: '録画専用モード', detail: '配信停止・選択中ゲーム録画中', tone: 'sending' })
    expect(getRuntimeOutputs(recordingOnly).find(({ key }) => key === 'recording')).toMatchObject({ label: '録画のみ', active: true })
    expect(getRuntimeOutputs(recordingOnly).find(({ key }) => key === 'obs')).toMatchObject({ state: '停止', active: false })
  })

  it('uses the actual recording identity even when the old profile list still says ASA', () => {
    const status = { ...stoppedStatus, recording: true, recordingOnly: true, recordingGameId: 'minecraft', recordingGameName: 'Minecraft' }
    expect(getBroadcastStatus(status, 'ASA').detailValues).toEqual({ game: 'Minecraft' })
    expect(getBroadcastStatus({ ...status, recordingGameName: null }, 'ASA').detail).toBe('配信停止・選択中ゲーム録画中')
    expect(getBroadcastStatus({ ...status, recording: false }, 'ASA').label).toBe('配信停止中')
  })

  it('reports external streaming only after a platform confirms live', () => {
    const youtubeLive = {
      ...stoppedStatus,
      streaming: true,
      platforms: { ...stoppedStatus.platforms, youtube: { ...stoppedStatus.platforms.youtube, state: 'live' as const, detail: 'YouTubeで公開配信中' } },
    }
    expect(getBroadcastStatus(youtubeLive)).toEqual({ label: '外部配信中', detail: 'YouTube', tone: 'live' })
    expect(getRuntimeOutputs(youtubeLive).find(({ key }) => key === 'youtube')).toMatchObject({ state: 'ライブ', active: true, tone: 'active' })
    expect(getExternalDeliveryWarning(youtubeLive)).toBeNull()
  })

  it('shows that external delivery is still finishing after OBS stops', () => {
    const stopping = {
      ...stoppedStatus,
      platforms: { ...stoppedStatus.platforms, youtube: { ...stoppedStatus.platforms.youtube, state: 'stopping' as const, detail: 'YouTube終了確認中' } },
    }
    expect(getBroadcastStatus(stopping)).toEqual({ label: '外部配信終了中', detail: '終了確認中', tone: 'sending' })
    expect(getExternalDeliveryWarning(stopping)).toContain('終了完了を確認しています')
  })
})
