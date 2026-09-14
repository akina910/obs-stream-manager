import { ChevronRight, MessageSquareText } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ChatMessage } from '../shared/contracts'
import type { Translator, UiLanguage } from './i18n'
import { ServiceIcon } from './ServiceIcon'

const commentsOpenStorageKey = 'obs-stream-manager.comments-open'

function readStoredOpen(fallback: boolean): boolean {
  if (typeof window === 'undefined') return fallback
  try { return window.localStorage.getItem(commentsOpenStorageKey) === 'true' }
  catch { return fallback }
}

export function CommentsSection({ comments, language, streaming, t, initiallyOpen = false }: {
  comments: ChatMessage[]
  language: UiLanguage
  streaming: boolean
  t: Translator
  initiallyOpen?: boolean
}) {
  const [open, setOpen] = useState(() => readStoredOpen(initiallyOpen))
  const visibleComments = comments.slice(-30).reverse()
  const latest = visibleComments[0]
  const meta = streaming ? t('更新中') : t('配信開始後に更新')
  const latestSummary = streaming && latest ? `${latest.author}: ${latest.body}` : t(streaming ? 'コメント待機中' : '配信開始後に表示されます')

  useEffect(() => {
    try { window.localStorage.setItem(commentsOpenStorageKey, String(open)) }
    catch { /* Storage can be disabled inside an OBS browser dock. */ }
  }, [open])

  return <section className={`comments-strip ${streaming ? 'is-live' : 'is-idle'} ${open ? 'is-open' : ''}`} aria-label={t('ライブコメント')}>
    <button className="comments-strip-toggle" type="button" aria-expanded={open} aria-controls="stream-comments" onClick={() => setOpen((current) => !current)}>
      <MessageSquareText size={12} />
      <strong>{t('コメント')}</strong>
      <span className="comments-strip-meta"><span className="status-dot" />{meta}</span>
      {!open && <span className="comments-strip-latest">{latestSummary}</span>}
      {open && <span className="comments-strip-spacer" />}
      <ChevronRight size={11} />
    </button>
    {open && <div id="stream-comments" className="comments-strip-list">
      {streaming && visibleComments.length > 0 ? visibleComments.map((comment) => <div className={`comment-row ${comment.mention ? 'mention' : ''}`} key={comment.id} data-service={comment.service}>
        <ServiceIcon service={comment.service} />
        <div>
          <div className="comment-meta"><strong>{comment.author}</strong>{comment.moderator && <b>MOD</b>}<time>{new Date(comment.publishedAt).toLocaleTimeString(language === 'en' ? 'en-US' : 'ja-JP', { hour: '2-digit', minute: '2-digit' })}</time></div>
          <p>{comment.body}</p>
        </div>
      </div>) : <div className="comments-strip-empty"><MessageSquareText size={17} /><span>{t(streaming ? 'コメント待機中' : 'ライブコメントは配信中に表示します')}</span></div>}
    </div>}
  </section>
}
