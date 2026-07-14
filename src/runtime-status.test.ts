import { describe, expect, it } from 'vitest'
import type { RuntimeStatus } from '../shared/contracts'
import { getBroadcastStatus, getRuntimeOutputs } from './runtime-status'

const stoppedStatus: RuntimeStatus = {
  obsConnected: true,
  streaming: false,
  recording: false,
  replayBuffer: false,
  sourceRecord: false,
  verticalRecording: false,
  selectedGameId: null,
  captureMethod: null,
  currentScene: '90_ENDING',
  warning: null,
  busy: false,
}

describe('runtime status labels', () => {
  it('shows an explicit stopped state when OBS is connected', () => {
    expect(getBroadcastStatus(stoppedStatus)).toEqual({ label: '配信停止中', detail: 'OFFLINE', tone: 'stopped' })
    expect(getRuntimeOutputs(stoppedStatus).map(({ label, state }) => [label, state])).toEqual([
      ['OBS', '接続中'],
      ['録画', '停止'],
      ['リプレイ', '停止'],
      ['素材', '停止'],
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
    expect(getBroadcastStatus(active)).toEqual({ label: '配信中', detail: '切替処理中', tone: 'live' })
    expect(getRuntimeOutputs(active).find(({ key }) => key === 'recording')?.state).toBe('録画中')
    expect(getRuntimeOutputs(active).find(({ key }) => key === 'replay')?.state).toBe('動作中')
    expect(getRuntimeOutputs(active).find(({ key }) => key === 'source')?.state).toBe('録画中')
    expect(getRuntimeOutputs(active).find(({ key }) => key === 'vertical')?.state).toBe('録画中')
    expect(getBroadcastStatus({ ...stoppedStatus, busy: true })).toEqual({ label: '配信停止中', detail: '切替処理中', tone: 'stopped' })
  })
})
