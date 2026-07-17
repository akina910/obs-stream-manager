import { describe, expect, it } from 'vitest'
import type { RuntimeStatus } from '../shared/contracts'
import type { DesktopUpdateState } from '../shared/update-contracts'
import { getDesktopUpdateAction } from './update-ui'

const stoppedStatus: RuntimeStatus = {
  obsConnected: true,
  streaming: false,
  recording: false,
  replayBuffer: false,
  sourceRecord: false,
  verticalRecording: false,
  selectedGameId: null,
  captureMethod: null,
  currentScene: null,
  warning: null,
  busy: false,
  platforms: {
    youtube: { state: 'ready', detail: '', checkedAt: null },
    twitch: { state: 'offline', detail: '', checkedAt: null },
  },
}

const state = (phase: DesktopUpdateState['phase'], extra: Partial<DesktopUpdateState> = {}): DesktopUpdateState => ({
  phase,
  currentVersion: '0.2.3',
  portable: false,
  installSupported: true,
  ...extra,
})

describe('desktop update UI actions', () => {
  it('offers exactly one useful primary action for each stable phase', () => {
    expect(getDesktopUpdateAction(state('idle'), stoppedStatus)).toEqual({ action: 'check', disabled: false })
    expect(getDesktopUpdateAction(state('up-to-date'), stoppedStatus)).toEqual({ action: 'check', disabled: false })
    expect(getDesktopUpdateAction(state('error'), stoppedStatus)).toEqual({ action: 'check', disabled: false })
    expect(getDesktopUpdateAction(state('available'), stoppedStatus)).toEqual({ action: 'download', disabled: false })
    expect(getDesktopUpdateAction(state('downloaded'), stoppedStatus)).toEqual({ action: 'install', disabled: false })
  })

  it('does not offer duplicate actions while an operation is running', () => {
    for (const phase of ['checking', 'downloading', 'installing', 'unsupported'] as const) {
      expect(getDesktopUpdateAction(state(phase), stoppedStatus)).toEqual({ action: 'none', disabled: true })
    }
  })

  it('sends non-installed distributions to the fixed release page', () => {
    expect(getDesktopUpdateAction(state('available', { portable: true, installSupported: false }), stoppedStatus))
      .toEqual({ action: 'open-releases', disabled: false })
  })

  it('keeps restart-and-update visible but explains why it is temporarily blocked', () => {
    expect(getDesktopUpdateAction(state('downloaded'), { ...stoppedStatus, streaming: true }))
      .toEqual({ action: 'install', disabled: true, blockReason: 'streaming' })
    expect(getDesktopUpdateAction(state('downloaded'), { ...stoppedStatus, recording: true }))
      .toEqual({ action: 'install', disabled: true, blockReason: 'recording' })
    expect(getDesktopUpdateAction(state('downloaded'), { ...stoppedStatus, replayBuffer: true }))
      .toEqual({ action: 'install', disabled: true, blockReason: 'replay-buffer' })
    expect(getDesktopUpdateAction(state('downloaded'), { ...stoppedStatus, busy: true }))
      .toEqual({ action: 'install', disabled: true, blockReason: 'busy' })
    expect(getDesktopUpdateAction(state('downloaded'), {
      ...stoppedStatus,
      platforms: { ...stoppedStatus.platforms, youtube: { ...stoppedStatus.platforms.youtube, state: 'live' } },
    })).toEqual({ action: 'install', disabled: true, blockReason: 'external-live' })
  })
})
