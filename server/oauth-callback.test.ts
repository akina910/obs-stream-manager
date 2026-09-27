import { describe, expect, it } from 'vitest'
import { youtubeOAuthCallbackHtml } from './oauth-callback.js'

describe('youtubeOAuthCallbackHtml', () => {
  it('tells external-browser users to close the tab manually', () => {
    const html = youtubeOAuthCallbackHtml('http://127.0.0.1:4317')

    expect(html).toContain('YouTube 接続が完了しました')
    expect(html).toContain('このタブを閉じて OBS Stream Manager に戻ってください。')
  })

  it('only promises and attempts automatic closing for a script-opened popup', () => {
    const html = youtubeOAuthCallbackHtml('http://127.0.0.1:4317')
    const openerGuard = html.indexOf('if (window.opener && !window.opener.closed)')
    const automaticMessage = html.indexOf('このウィンドウは自動で閉じます。', openerGuard)
    const closeAttempt = html.indexOf('window.close()', openerGuard)

    expect(openerGuard).toBeGreaterThan(-1)
    expect(automaticMessage).toBeGreaterThan(openerGuard)
    expect(closeAttempt).toBeGreaterThan(openerGuard)
  })

  it('serializes the validated opener origin safely in the inline script', () => {
    const html = youtubeOAuthCallbackHtml('http://localhost:4318/<script>')

    expect(html).not.toContain('http://localhost:4318/<script>')
    expect(html).toContain('http://localhost:4318/\\u003cscript>')
  })
})
