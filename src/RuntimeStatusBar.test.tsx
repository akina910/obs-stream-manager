import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { RuntimeStatus } from '../shared/contracts'
import { RuntimeStatusBar } from './App'
import { I18nProvider } from './i18n'

const liveStatus: RuntimeStatus = {
  obsConnected: true,
  streaming: true,
  streamElapsedMs: 12_000,
  recording: true,
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
})
