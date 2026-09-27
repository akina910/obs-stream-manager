import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeStatus } from '../shared/contracts'
import { RuntimeStatusBar } from './App'
import { I18nProvider } from './i18n'

const liveStatus: RuntimeStatus = {
  obsConnected: true,
  streaming: true,
  streamElapsedMs: 12_000,
  recording: true,
  recordingOnly: false,
  replayBuffer: true,
  sourceRecord: false,
  verticalRecording: false,
  selectedGameId: 'ark_survival_ascended',
  captureMethod: 'local',
  currentScene: '10_GAME_PC',
  warning: null,
  busy: false,
  platforms: {
    youtube: { state: 'live', detail: 'YouTubeで公開配信中', checkedAt: '2026-07-22T06:00:00.000Z', viewerCount: 12, viewerCountState: 'available' },
    twitch: { state: 'live', detail: 'Twitchで公開配信中', checkedAt: '2026-07-22T06:00:00.000Z', viewerCount: 7, viewerCountState: 'available' },
  },
}

describe('RuntimeStatusBar', () => {
  it('shows the selected game name while recording without broadcasting', () => {
    const recordingOnly = {
      ...liveStatus,
      streaming: false,
      recording: true,
      recordingOnly: true,
      replayBuffer: false,
      platforms: {
        youtube: { state: 'ready' as const, detail: 'OBS映像の受信待ち', checkedAt: '2026-07-22T06:00:00.000Z' },
        twitch: { state: 'offline' as const, detail: 'Twitchはオフライン', checkedAt: '2026-07-22T06:00:00.000Z' },
      },
    }
    const html = renderToStaticMarkup(<I18nProvider language="ja"><RuntimeStatusBar status={recordingOnly} selectedGameName="Minecraft" /></I18nProvider>)

    expect(html).toContain('配信停止・Minecraft録画中')
    expect(html).not.toContain('ASA録画中')
  })

  it('does not present deferred snapshots as current connections or audience counts during local recording', () => {
    const status: RuntimeStatus = {
      ...liveStatus, streaming: false, recordingOnly: true, recordingGameName: 'Minecraft',
      platforms: {
        youtube: { ...liveStatus.platforms.youtube, state: 'live', observation: 'deferred', viewerCount: 123, detail: '前回確認時はライブ。現在未確認' },
        twitch: { state: 'unprepared', observation: 'deferred', detail: '録画中は配信状態確認を保留', checkedAt: null },
      },
    }
    const html = renderToStaticMarkup(<I18nProvider language="ja"><RuntimeStatusBar status={status} selectedGameName="ASA" /></I18nProvider>)
    expect(html).toContain('Minecraft録画中・外部配信は現在未確認')
    expect(html).toContain('前回ライブ・現在未確認')
    expect(html).toContain('前回確認時の状態')
    expect(html).not.toContain('合計 123人')
    expect(html).not.toContain('同時視聴 123')
    expect(html).not.toContain('<strong>123</strong>')
    expect(html).not.toContain('1/2 接続中')
    expect(html).not.toContain('runtime-status-warning danger')
  })

  it('offers connection settings for an expired authorization without starting OAuth on render', () => {
    const onOpenConnectionSettings = vi.fn()
    const status: RuntimeStatus = { ...liveStatus, streaming: false, recording: false, recordingOnly: false, platforms: {
      youtube: { state: 'error', connectionIssue: 'reconnect_required', detail: '保存済みのGoogle認証を更新できません。YouTubeを再接続してください', checkedAt: null },
      twitch: { state: 'disabled', detail: '無効', checkedAt: null },
    } }
    const html = renderToStaticMarkup(<I18nProvider language="ja"><RuntimeStatusBar status={status} onOpenConnectionSettings={onOpenConnectionSettings} /></I18nProvider>)
    expect(html).toContain('再接続が必要')
    expect(html).toContain('YouTubeの接続設定を開く')
    expect(html).toContain('配信するには設定画面で再接続してください')
    expect(html).toContain('destination-card pending')
    expect(html).not.toContain('確認失敗')
    expect(html).not.toContain('視聴者数取得待ち')
    expect(onOpenConnectionSettings).not.toHaveBeenCalled()
  })

  it('explains that deferred platform reconnection is not required to continue recording', () => {
    const status: RuntimeStatus = { ...liveStatus, streaming: false, recordingOnly: true, recordingGameName: 'Minecraft', platforms: {
      youtube: { state: 'unprepared', connectionIssue: 'reconnect_required', observation: 'deferred', detail: '録画には接続不要、配信時に再接続してください', checkedAt: null },
      twitch: { state: 'unprepared', observation: 'deferred', detail: '録画中は確認を保留', checkedAt: null },
    } }
    const html = renderToStaticMarkup(<I18nProvider language="ja"><RuntimeStatusBar status={status} onOpenConnectionSettings={() => undefined} /></I18nProvider>)
    expect(html).toContain('Minecraft録画中')
    expect(html).toContain('配信には再接続が必要')
    expect(html).toContain('録画のみでは配信先への接続は不要です')
    expect(html).not.toContain('確認失敗')
    expect(html).not.toContain('destination-card error')
    const english = renderToStaticMarkup(<I18nProvider language="en"><RuntimeStatusBar status={status} onOpenConnectionSettings={() => undefined} /></I18nProvider>)
    expect(english).toContain('Recording only does not require a broadcast connection.')
    expect(english).toContain('Reconnect before broadcasting')
    expect(english).toContain('Open YouTube connection settings')
  })

  it('keeps non-authentication failures visibly erroneous without suggesting reconnect fixes them', () => {
    const status: RuntimeStatus = { ...liveStatus, platforms: { ...liveStatus.platforms, youtube: { state: 'error', detail: 'HTTP 503', checkedAt: null } } }
    const html = renderToStaticMarkup(<I18nProvider language="ja"><RuntimeStatusBar status={status} onOpenConnectionSettings={() => undefined} /></I18nProvider>)
    expect(html).toContain('確認失敗')
    expect(html).toContain('destination-card error')
    expect(html).toContain('HTTP 503')
    expect(html).not.toContain('接続設定を開く')
  })

  it('preserves a confirmed live destination when only management authorization needs reconnecting', () => {
    const status: RuntimeStatus = { ...liveStatus, platforms: { ...liveStatus.platforms, youtube: { ...liveStatus.platforms.youtube, connectionIssue: 'reconnect_required' } } }
    const html = renderToStaticMarkup(<I18nProvider language="ja"><RuntimeStatusBar status={status} onOpenConnectionSettings={() => undefined} /></I18nProvider>)
    expect(html).toContain('2/2 同時接続')
    expect(html).toContain('配信の管理・状態確認には再接続が必要です')
    expect(html).toContain('YouTubeの接続設定を開く')
    expect(html).not.toContain('配信するには設定画面で再接続してください')
  })

  it('makes both destination connections and the combined audience prominent', () => {
    const html = renderToStaticMarkup(<I18nProvider language="ja"><RuntimeStatusBar status={liveStatus} /></I18nProvider>)

    expect(html).toContain('2/2 同時接続')
    expect(html).toContain('合計 19人')
    expect(html).toContain('<strong>12</strong>')
    expect(html).toContain('<strong>7</strong>')
  })

  it('shows a retrying viewer state without hiding a confirmed live destination', () => {
    const status = structuredClone(liveStatus)
    status.platforms.youtube = { state: 'live', detail: 'YouTubeで公開配信中', checkedAt: '2026-07-22T06:00:00.000Z', viewerCount: null, viewerCountState: 'unavailable', viewerCountDetail: '10秒ごとに再取得します' }
    const html = renderToStaticMarkup(<I18nProvider language="ja"><RuntimeStatusBar status={status} /></I18nProvider>)

    expect(html).toContain('YouTube')
    expect(html).toContain('配信中')
    expect(html).toContain('視聴者数取得待ち')
    expect(html).toContain('10秒ごとに再取得します')
  })

  it('does not call an intentionally hidden platform pending forever', () => {
    const status = structuredClone(liveStatus)
    status.platforms.youtube = { state: 'live', detail: 'YouTubeで公開配信中', checkedAt: '2026-07-22T06:00:00.000Z', viewerCount: null, viewerCountState: 'hidden' }
    const html = renderToStaticMarkup(<I18nProvider language="ja"><RuntimeStatusBar status={status} /></I18nProvider>)

    expect(html).toContain('確認済み 7人・一部非表示')
    expect(html).not.toContain('視聴者数取得待ち')
  })

  it('translates the YouTube quota fallback detail and viewer tooltip in English', () => {
    const status = structuredClone(liveStatus)
    status.platforms.youtube = {
      state: 'live',
      detail: 'YouTubeで公開配信中（API上限のため公開ページで確認）',
      checkedAt: '2026-07-22T06:00:00.000Z',
      viewerCount: 12,
      viewerCountState: 'available',
      viewerCountDetail: 'YouTube API上限中のため、公開ページのライブ人数から取得しました',
    }
    const html = renderToStaticMarkup(<I18nProvider language="en"><RuntimeStatusBar status={status} /></I18nProvider>)

    expect(html).toContain('Live on YouTube (confirmed from the public page while the API is limited)')
    expect(html).toContain('Viewer count was read from the public YouTube page while the API is limited.')
    expect(html).not.toContain('API上限')
  })
})
