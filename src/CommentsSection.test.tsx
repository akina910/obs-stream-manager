import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../shared/contracts'
import type { Translator } from './i18n'
import { CommentsSection } from './CommentsSection'

const translate: Translator = (source, values = {}) => Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), source)

const comments: ChatMessage[] = [
  {
    id: 'youtube:one',
    service: 'youtube',
    author: 'YouTube視聴者',
    body: 'YouTubeからのコメント',
    publishedAt: '2026-07-17T01:00:00.000Z',
    moderator: false,
    mention: false,
  },
  {
    id: 'twitch:two',
    service: 'twitch',
    author: 'Twitchモデレーター',
    body: '@配信者 Twitchからのコメント',
    publishedAt: '2026-07-17T01:01:00.000Z',
    moderator: true,
    mention: true,
  },
]

describe('CommentsSection', () => {
  it('renders YouTube and Twitch comments with service, author, moderator, mention and body state', () => {
    const html = renderToStaticMarkup(<CommentsSection comments={comments} language="ja" streaming t={translate} />)

    expect(html).toContain('data-service="youtube"')
    expect(html).toContain('data-service="twitch"')
    expect(html).toContain('ライブコメント')
    expect(html).toContain('2件')
    expect(html).toContain('comment-service youtube')
    expect(html).toContain('comment-service twitch')
    expect(html).toContain('YouTube視聴者')
    expect(html).toContain('YouTubeからのコメント')
    expect(html).toContain('Twitchモデレーター')
    expect(html).toContain('@配信者 Twitchからのコメント')
    expect(html).toContain('comment-row mention')
    expect(html).toContain('MOD')
    expect(html.indexOf('Twitchモデレーター')).toBeLessThan(html.indexOf('YouTube視聴者'))
  })

  it('does not show retained comments while streaming is stopped', () => {
    const html = renderToStaticMarkup(<CommentsSection comments={comments} language="ja" streaming={false} t={translate} />)

    expect(html).toContain('配信開始後に表示されます')
    expect(html).not.toContain('YouTube視聴者')
    expect(html).not.toContain('Twitchモデレーター')
  })
})
