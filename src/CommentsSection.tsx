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
  return <section className="comments-section">
    <div className="section-title">
      <h2>{t('統合コメント')}</h2>
      <span className={streaming ? 'active-text' : ''}>{t(streaming ? '配信中・自動更新' : '配信開始後に表示されます')}</span>
    </div>
    {streaming && comments.length ? <div className="comment-list">{comments.slice(-30).map((comment) => <div className={`comment-row ${comment.mention ? 'mention' : ''}`} key={comment.id} data-service={comment.service}>
      <ServiceIcon service={comment.service} />
      <div>
        <div><strong>{comment.author}</strong>{comment.moderator && <b>MOD</b>}<time>{new Date(comment.publishedAt).toLocaleTimeString(language === 'en' ? 'en-US' : 'ja-JP', { hour: '2-digit', minute: '2-digit' })}</time></div>
        <p>{comment.body}</p>
      </div>
    </div>)}</div> : <div className="comment-empty"><MessageSquareText size={20} /><span>{t('YouTube / Twitch の実際のコメントをここに表示します')}</span></div>}
  </section>
}
