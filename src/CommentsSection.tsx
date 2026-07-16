import { MessageSquareText } from 'lucide-react'
import type { ChatMessage } from '../shared/contracts'
import type { Translator, UiLanguage } from './i18n'
import { ServiceIcon } from './ServiceIcon'

export function CommentsSection({ comments, language, streaming, t }: {
  comments: ChatMessage[]
  language: UiLanguage
  streaming: boolean
  t: Translator
}) {
  const visibleComments = comments.slice(-30).reverse()
  return <section className={`comments-section ${streaming ? 'is-live' : 'is-idle'}`} aria-label={t('ライブコメント')}>
    <div className="comments-header">
      <div className="comments-heading"><span className="comments-icon"><MessageSquareText size={17} /></span><div><h2>{t('ライブコメント')}</h2><span>YouTube + Twitch</span></div></div>
      <div className="comments-summary">
        {streaming && <b>{t('{count}件', { count: comments.length })}</b>}
        <span className={streaming ? 'active-text' : ''}>{t(streaming ? '配信中・自動更新' : '配信開始後に表示されます')}</span>
      </div>
    </div>
    {streaming && visibleComments.length ? <div className="comment-list">{visibleComments.map((comment) => <div className={`comment-row ${comment.mention ? 'mention' : ''}`} key={comment.id} data-service={comment.service}>
      <ServiceIcon service={comment.service} />
      <div>
        <div><span className={`comment-service ${comment.service}`}>{comment.service === 'youtube' ? 'YouTube' : 'Twitch'}</span><strong>{comment.author}</strong>{comment.moderator && <b>MOD</b>}<time>{new Date(comment.publishedAt).toLocaleTimeString(language === 'en' ? 'en-US' : 'ja-JP', { hour: '2-digit', minute: '2-digit' })}</time></div>
        <p>{comment.body}</p>
      </div>
    </div>)}</div> : <div className="comment-empty"><MessageSquareText size={20} /><div><strong>{t(streaming ? 'コメント待機中' : 'ライブコメントは配信中に表示します')}</strong><span>{t('YouTube / Twitch の実際のコメントをここに表示します')}</span></div></div>}
  </section>
}
