import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import {
  AlertTriangle, ArrowDownToLine, Check, ChevronRight, CircleHelp, CircleStop, Cloud, Copy, Gamepad2,
  Image as ImageIcon, LoaderCircle, LockKeyhole, Play, Plus, RefreshCw,
  Search, Settings, Star, Trash2, Upload, Users, X,
} from 'lucide-react'
import type { AppConfig, CaptureMethod, ChatMessage, GameProfile, PlatformGroup, RuntimeStatus } from '../shared/contracts'
import { createGameProfile } from '../shared/profile-factory'
import { renderTitleTemplate, TITLE_TEMPLATE_VARIABLES } from '../shared/title-template'
import { api, type OAuthConnectionStatus, type OAuthConnectionStatuses, type OAuthProvider, type SteamSyncResult } from './api'
import { createTranslator, I18nProvider, useI18n, type TranslationValues, type Translator, type UiLanguage } from './i18n'
import { completedOAuthProviders, oauthRefreshInterval } from './oauth-refresh'
import { getBroadcastStatus, getExternalDeliveryWarning, getRuntimeOutputs, type RuntimeOutputStatus } from './runtime-status'
import { CommentsSection } from './CommentsSection'
import { BgmLibrarySection } from './BgmLibrarySection'
import { CommonTemplateEditor } from './CommonTemplateEditor'
import { DesktopUpdateControl } from './DesktopUpdateControl'
import { ServiceIcon } from './ServiceIcon'

type Tab = PlatformGroup | 'bgm' | 'settings'
type Toast = { kind: 'success' | 'error' | 'warning'; text: string; values?: TranslationValues }
type OAuthProgress = Partial<Record<OAuthProvider, string>>
type AddGameDraft = { name: string; platformGroup: PlatformGroup; captureMethod: CaptureMethod; steamAppId: string }

const groups: Array<{ id: Tab; label: string }> = [
  { id: 'pc', label: 'PC' },
  { id: 'switch', label: 'Switch' },
  { id: 'exception', label: '例外' },
  { id: 'bgm', label: 'BGM' },
  { id: 'settings', label: '設定' },
]

const captureLabels: Record<CaptureMethod, string> = {
  auto: '自動判定',
  local: 'ローカルキャプチャ',
  geforce_now: 'GeForce NOW',
  window: 'ウィンドウキャプチャ',
  display: '画面キャプチャ',
  elgato: 'HDMIキャプチャ',
}

const platformTitles: Record<PlatformGroup, string> = { pc: 'PCゲーム', switch: 'Switchゲーム', exception: '例外ゲーム' }

function profileInitial(profile: GameProfile): string {
  return profile.displayName.replace(/[^A-Za-z0-9\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu, '').slice(0, 1).toUpperCase() || 'G'
}

function profileHue(profile: GameProfile): number {
  return [...profile.id].reduce((total, character) => total + character.charCodeAt(0), 0) % 320
}

function tileStyle(profile: GameProfile): CSSProperties {
  const hue = profileHue(profile)
  return { '--tile-hue': hue, '--tile-hue-end': (hue + 25) % 360 } as CSSProperties
}

function BrandGlyph() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" /><circle cx="12" cy="12" r="3" /></svg>
}

function DesktopLaunchNotice() {
  const { t } = useI18n()
  const desktop = window.obsStreamManagerDesktop
  const [copied, setCopied] = useState(false)
  if (!desktop) return null
  return <aside className="desktop-launch-notice">
    <div><strong>{t('OBSブラウザドック URL')}</strong><code>{desktop.dockUrl}</code><span>{t('×で閉じてもOBSドック用サーバーは停止せず、通知領域で動作を続けます。')}</span></div>
    <button onClick={() => void desktop.copyDockUrl().then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 2_000) })}><Copy size={14} />{t(copied ? 'コピー済み' : 'コピー')}</button>
  </aside>
}

function DesktopIntegrationControl({ setup = false }: { setup?: boolean }) {
  const { t } = useI18n()
  const desktop = window.obsStreamManagerDesktop
  const [settings, setSettings] = useState<{ startWithWindows: boolean; supported: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!desktop) return
    let cancelled = false
    void desktop.getIntegrationSettings()
      .then((value) => { if (!cancelled) setSettings(value) })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { cancelled = true }
  }, [desktop])
  if (!desktop) return null
  const supported = settings?.supported ?? false
  const note = supported
    ? t('Windowsログイン時に画面を出さず準備し、OBSドックをすぐ読み込める状態にします。')
    : t('Portable版と開発版は自動起動へ登録しません。OBSより先にEXEを起動してください。')
  const rowClass = setup ? 'setup-status-row desktop-integration-row' : 'feature-row desktop-integration-row'
  return <div className={rowClass}>
    <div><strong>{t('OBSドックをバックグラウンドで準備')}</strong><span>{error || note}</span></div>
    <Toggle
      disabled={busy || !supported || !settings}
      checked={settings?.startWithWindows ?? false}
      label={t(settings?.startWithWindows ? '自動起動ON' : '自動起動OFF')}
      onChange={(value) => {
        setBusy(true)
        setError(null)
        void desktop.setStartWithWindows(value)
          .then(setSettings)
          .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
          .finally(() => setBusy(false))
      }}
    />
  </div>
}

function StatusDot({ tone = 'inactive', pulse = false }: { tone?: RuntimeOutputStatus['tone'] | 'live' | 'danger'; pulse?: boolean }) {
  return <span className={`status-dot tone-${tone}${pulse ? ' pulse' : ''}`} />
}

function LiveElapsed({ milliseconds }: { milliseconds: number }) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainder = seconds % 60
  return <>{[hours, minutes, remainder].map((value) => String(value).padStart(2, '0')).join(':')}</>
}

function RuntimeStatusBar({ status }: { status: RuntimeStatus }) {
  const { t } = useI18n()
  const [recordingsOpen, setRecordingsOpen] = useState(false)
  const broadcast = getBroadcastStatus(status)
  const outputs = getRuntimeOutputs(status)
  const platformOutputs = outputs.slice(0, 3)
  const recordingOutputs = outputs.slice(3)
  const activeRecordings = recordingOutputs.filter((output) => output.active).length
  const deliveryWarning = getExternalDeliveryWarning(status)
  const live = broadcast.tone === 'live'

  return (
    <section className={`runtime-status tone-${broadcast.tone}`} aria-label={t('現在の配信状態')}>
      <div className="runtime-overall-row">
        <div className="runtime-overall" role="status" aria-live="polite" aria-atomic="true">
          <StatusDot tone={broadcast.tone === 'live' ? 'live' : broadcast.tone === 'sending' ? 'pending' : broadcast.tone === 'unknown' ? 'error' : 'inactive'} pulse={broadcast.tone === 'live'} />
          <strong>{t(broadcast.label)}</strong>
          <span className="overall-detail">{t(broadcast.detail)}</span>
        </div>
        <span className="scene-label">SCENE: {status.currentScene ?? t('不明')}{live && <> · LIVE{status.streaming && status.streamElapsedMs !== undefined ? <> <LiveElapsed milliseconds={status.streamElapsedMs} /></> : null}</>}</span>
      </div>
      {deliveryWarning && <div className={`runtime-status-warning ${!status.streaming && status.platforms.youtube.state === 'live' || !status.streaming && status.platforms.twitch.state === 'live' ? 'danger' : ''}`} role="alert"><AlertTriangle size={14} /><span>{t(deliveryWarning)}</span></div>}
      <div className="platform-grid">
        {platformOutputs.map((output) => {
          const viewerCount = output.key === 'youtube' || output.key === 'twitch' ? status.platforms[output.key].viewerCount : undefined
          return <div className={`platform-card ${output.tone}`} key={output.key} aria-label={`${t(output.label)}: ${t(output.state)}`} title={output.detail ? t(output.detail) : undefined}>
            <div><ServiceIcon service={output.key === 'youtube' ? 'youtube' : output.key === 'twitch' ? 'twitch' : 'obs'} /><span>{t(output.label)}</span></div>
            <strong><StatusDot tone={output.tone} pulse={output.active} />{t(output.state)}</strong>
            {(output.key === 'youtube' || output.key === 'twitch') && output.active && <span className={`viewer-count ${viewerCount == null ? 'unknown' : ''}`}><Users size={11} />{viewerCount == null ? t('視聴者数取得待ち') : t('同時視聴 {count}', { count: viewerCount })}</span>}
          </div>
        })}
      </div>
      <div className="recording-status">
        <button className="recording-toggle" aria-expanded={recordingsOpen} onClick={() => setRecordingsOpen((current) => !current)}><ChevronRight size={12} /><span>{t('録画系ステータス')}</span><b>{activeRecordings}/{recordingOutputs.length} {t('稼働')}</b></button>
        {recordingsOpen && <div className="recording-grid">{recordingOutputs.map((output) => <div className="recording-item" key={output.key}><StatusDot tone={output.tone} /><span>{t(output.label)}</span><strong>{t(output.active ? '稼働中' : '停止')}</strong></div>)}</div>}
      </div>
    </section>
  )
}

const oauthStageLabels: Record<OAuthConnectionStatus['stage'], string> = {
  setup_required: '配布設定エラー', ready: '認証開始できます', authorizing: '認証待ち', partial: '一部のみ完了', connected: '認証保存済み',
}

function OAuthServiceCard({ status, progress, saving, onConnect, onTestOutput, outputReady }: { status: OAuthConnectionStatus; progress?: string; saving: boolean; onConnect: () => void; onTestOutput?: () => void; outputReady?: boolean }) {
  const { t } = useI18n()
  const isYoutube = status.provider === 'youtube'
  const serviceName = isYoutube ? 'YouTube' : 'Twitch'
  const steps = isYoutube
    ? [
        { label: t('アプリ内OAuth'), complete: status.appConfigured },
        { label: t('Googleアカウント認証'), complete: status.refreshTokenStored },
        { label: t('更新トークン保存'), complete: status.refreshTokenStored },
      ]
    : [
        { label: t('アプリ内OAuth'), complete: status.appConfigured },
        { label: t('Twitchアカウント認証'), complete: status.accessTokenStored && status.refreshTokenStored },
        { label: t('配信キー取得'), complete: status.accountLinked },
        { label: t('OBS副出力プラグイン'), complete: outputReady === true },
      ]
  const buttonLabel = !status.appConfigured ? t('接続機能を準備中') : status.stage === 'connected' ? t('今すぐ再取得') : t('{service}で接続', { service: serviceName })
  return (
    <section className={`settings-card oauth-service oauth-${status.stage}`} data-testid={`oauth-${status.provider}`}>
      <div className="card-title-row">
        <ServiceIcon service={status.provider} />
        <h2>{t('{service} 接続', { service: serviceName })}</h2>
        <span className={`oauth-stage oauth-stage-${status.stage}`}><StatusDot tone={status.stage === 'connected' ? 'live' : status.stage === 'setup_required' ? 'error' : 'pending'} pulse={status.stage === 'authorizing'} />{t(oauthStageLabels[status.stage])}</span>
      </div>
      <ol className="oauth-steps" aria-label={t('{service} 接続状況', { service: serviceName })}>
        {steps.map((step, index) => {
          const current = status.authorizationInProgress && index === 1
          return <li key={step.label} className={step.complete ? 'complete' : current ? 'current' : 'pending'} aria-current={current ? 'step' : undefined}><span className="oauth-step-marker">{step.complete ? <Check size={11} /> : current ? <LoaderCircle className="spin" size={11} /> : index + 1}</span><span>{step.label}</span></li>
        })}
      </ol>
      {(status.stage === 'setup_required' || status.stage === 'partial') && <div className="oauth-error" role="alert">{t(progress ?? status.detail)}</div>}
      <div className="oauth-footer">
        {status.stage === 'connected' && <span>{t(status.detail)} · {t('再起動後も保持（実通信は上部の配信状態で確認）')}</span>}
        {status.stage !== 'connected' && status.stage !== 'setup_required' && <span>{t(progress ?? status.detail)}</span>}
        {onTestOutput && status.stage === 'connected' && <button className="secondary-button" disabled={saving} onClick={onTestOutput}>{t('Twitch映像送信をテスト')}</button>}
        <button className={status.stage === 'connected' ? 'ghost-button' : 'primary-button'} disabled={saving || !status.appConfigured} onClick={onConnect}>{buttonLabel}</button>
      </div>
    </section>
  )
}

type NumericInputProps = { value: number | undefined; allowEmpty?: boolean; disabled?: boolean; onValueChange: (value: number | undefined) => void }

function NumericInput(props: NumericInputProps) {
  return <NumericInputEditor key={props.value === undefined ? 'empty' : String(props.value)} {...props} />
}

function NumericInputEditor({ value, allowEmpty = false, disabled = false, onValueChange }: NumericInputProps) {
  const [text, setText] = useState(value === undefined ? '' : String(value))
  const commit = () => {
    if (allowEmpty && text.trim() === '') { onValueChange(undefined); return }
    const parsed = Number(text)
    if (Number.isFinite(parsed)) onValueChange(parsed)
    else setText(value === undefined ? '' : String(value))
  }
  return <input disabled={disabled} type="number" step="any" value={text} onChange={(event) => setText(event.target.value)} onBlur={commit} />
}

function thumbnailStatusLabel(profile: GameProfile, t: Translator): string {
  if (!profile.state.thumbnailFilename) return t('サムネ未登録')
  if (!profile.state.thumbnailAutoApply) return t('サムネ自動適用OFF')
  if (profile.state.thumbnailApplyStatus === 'applied') return t('サムネ自動適用済み')
  if (profile.state.thumbnailApplyStatus === 'failed') return t('サムネ適用失敗')
  return t('サムネ登録済み')
}

function thumbnailTone(profile: GameProfile): 'live' | 'pending' | 'error' | 'inactive' {
  if (!profile.state.thumbnailFilename || !profile.state.thumbnailAutoApply) return 'inactive'
  if (profile.state.thumbnailApplyStatus === 'failed') return 'error'
  if (profile.state.thumbnailApplyStatus === 'pending') return 'pending'
  return 'live'
}

function thumbnailUrl(profile: GameProfile): string {
  const version = profile.state.thumbnailUpdatedAt ?? profile.state.thumbnailFilename ?? ''
  return `/api/profiles/${encodeURIComponent(profile.id)}/thumbnail?v=${encodeURIComponent(version)}`
}

function httpArtworkUrl(value?: string): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

function ProfileArtwork({ profile, size = 'default' }: { profile: GameProfile; size?: 'default' | 'small' | 'favorite' }) {
  const className = size === 'favorite' ? 'favorite-tile' : `game-tile${size === 'small' ? ' small' : ''}`
  const imageUrl = profile.state.thumbnailFilename ? thumbnailUrl(profile) : httpArtworkUrl(profile.coverUrl)
  return (
    <span className={`${className} profile-artwork`} style={tileStyle(profile)} aria-hidden="true">
      <span className="profile-artwork-fallback">{profileInitial(profile)}</span>
      {imageUrl && <img key={imageUrl} src={imageUrl} alt="" onError={(event) => { event.currentTarget.hidden = true }} />}
    </span>
  )
}

function ThumbnailPreview({ profile }: { profile: GameProfile }) {
  const { t } = useI18n()
  const [failed, setFailed] = useState(false)
  const registered = Boolean(profile.state.thumbnailFilename)
  return (
    <div className="thumbnail-preview-frame">
      {registered && !failed
        ? <img src={thumbnailUrl(profile)} alt={t('{game}の登録済みサムネイル', { game: profile.displayName })} onError={() => setFailed(true)} />
        : <div role={failed ? 'alert' : undefined}><ImageIcon size={21} /><span>{t(failed ? '画像を読み込めません' : '未登録')}</span></div>}
    </div>
  )
}

function GameCard({ profile, selected, busy, onSelect, onEdit, onFavorite }: { profile: GameProfile; selected: boolean; busy: boolean; onSelect: () => void; onEdit: () => void; onFavorite: () => void }) {
  const { t } = useI18n()
  const activate = () => { if (!busy) onSelect() }
  return (
    <article className={`game-card ${selected ? 'selected' : ''}`} role="button" tabIndex={busy ? -1 : 0} aria-disabled={busy} aria-current={selected ? 'true' : undefined} onClick={activate} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate() } }}>
      <ProfileArtwork profile={profile} />
      <div className="game-copy">
        <div className="game-name-row"><strong>{profile.displayName}</strong>{selected && <span className="selected-badge"><Check size={11} strokeWidth={3} />{t('選択中')}</span>}</div>
        <div className="game-meta"><span>{t(captureLabels[profile.capture.preferred])}</span>{profile.library.steamAppId !== undefined && <span className={profile.library.installed ? 'tone-live' : 'tone-cloud'}><Cloud size={11} />{t(profile.library.installed ? 'Steam・ローカル導入済み' : 'Steam・クラウド利用')}</span>}<span className={`thumb-meta tone-${thumbnailTone(profile)}`}><ImageIcon size={11} />{thumbnailStatusLabel(profile, t)}</span></div>
      </div>
      <div className="game-actions">
        <button className="square-button favorite-button" aria-label={t(profile.favorite ? '{game}をお気に入りから外す' : '{game}をお気に入りに追加', { game: profile.displayName })} disabled={busy} onClick={(event) => { event.stopPropagation(); onFavorite() }}><Star size={14} fill={profile.favorite ? 'currentColor' : 'none'} /></button>
        <button className="square-button" aria-label={t('{game}の設定', { game: profile.displayName })} onClick={(event) => { event.stopPropagation(); onEdit() }}><Settings size={14} /></button>
      </div>
    </article>
  )
}

function SelectedGameBanner({ profile, status }: { profile: GameProfile; status: RuntimeStatus }) {
  const { t } = useI18n()
  const captureMethod = status.captureMethod ?? profile.capture.preferred
  return <div className="selected-game-banner">
    <div className="selected-game-check" aria-hidden="true"><Check size={17} strokeWidth={3} /></div>
    <ProfileArtwork profile={profile} size="small" />
    <div className="selected-game-copy"><span>{t('現在選択中のゲーム')}</span><strong>{profile.displayName}</strong><small>{t(captureLabels[captureMethod])} · {t('このゲームが配信対象です')}</small></div>
  </div>
}

function AccordionSection({ title, summary, open, onToggle, children }: { title: string; summary: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  return <section className="editor-section"><button type="button" className="editor-section-toggle" aria-expanded={open} onClick={onToggle}><ChevronRight size={13} /><strong>{title}</strong><span>{summary}</span></button>{open && <div className="editor-section-body">{children}</div>}</section>
}

function TitleTemplateField({ value, game, part, onChange }: { value: string; game: string; part: number; onChange: (value: string) => void }) {
  const { t } = useI18n()
  const inputId = useId()
  const renderedTitle = renderTitleTemplate(value, { game, part }) || t('（空のタイトル）')
  const descriptions: Record<(typeof TITLE_TEMPLATE_VARIABLES)[number], string> = {
    '{game}': t('選択中のゲーム名'),
    '{part}': t('次回の配信回番号。配信開始に成功すると自動で1増えます'),
    '{date}': t('ゲーム適用時の日付（YYYY-MM-DD）'),
    '{time}': t('ゲーム適用時の時刻（HH:mm）'),
    '{datetime}': t('ゲーム適用時の日付と時刻'),
  }
  return <div className="template-field">
    <div className="field-label-with-help">
      <label htmlFor={inputId}>{t('タイトルテンプレート')}</label>
      <details className="template-help">
        <summary aria-label={t('タイトルテンプレートの変数ヘルプ')}><CircleHelp size={14} /></summary>
        <div className="template-help-popover">
          <strong>{t('使用できる変数')}</strong>
          {TITLE_TEMPLATE_VARIABLES.map((variable) => <div key={variable}><code>{variable}</code><span>{descriptions[variable]}</span></div>)}
          <p>{t('「|」など、変数以外の文字はそのままタイトルに残ります。')}</p>
          <p>{t('例: {game} | Part {part} | {date}')}</p>
        </div>
      </details>
    </div>
    <input id={inputId} value={value} onChange={(event) => onChange(event.target.value)} />
    <span className="template-preview">{t('実際の配信タイトル: {title}', { title: renderedTitle })}</span>
  </div>
}

function RangeField({ label, value, disabled, onChange }: { label: string; value: number; disabled: boolean; onChange: (value: number) => void }) {
  return <label>{label}<div className="range-control"><input type="range" min="-30" max="6" step="1" value={value} disabled={disabled} onChange={(event) => onChange(Number(event.target.value))} /><span>{value > 0 ? '+' : ''}{value} dB</span></div></label>
}

function Toggle({ checked, disabled = false, label, onChange }: { checked: boolean; disabled?: boolean; label: string; onChange: (checked: boolean) => void }) {
  return <label className="toggle-row"><button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}><span /></button><span>{label}</span></label>
}

function ProfileEditor({ profile, readOnly, onClose, onSave, onDelete, onThumbnail, onDeleteThumbnail }: { profile: GameProfile; readOnly: boolean; onClose: () => void; onSave: (profile: GameProfile) => Promise<void>; onDelete: () => Promise<void>; onThumbnail: (file: File, draft: GameProfile) => Promise<void>; onDeleteThumbnail: (draft: GameProfile) => Promise<void> }) {
  const { t } = useI18n()
  const [draft, setDraft] = useState(profile)
  const [openSections, setOpenSections] = useState(() => new Set(['recording']))
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const savingRef = useRef(false)
  const modalRef = useRef<HTMLElement>(null)
  const locked = readOnly || saving
  useEffect(() => { modalRef.current?.focus() }, [])
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !savingRef.current) onClose() }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])
  const patch = <K extends keyof GameProfile>(key: K, value: GameProfile[K]) => setDraft((current) => ({ ...current, [key]: value }))
  const execute = async (operation: () => Promise<void>) => {
    if (savingRef.current || readOnly) return
    savingRef.current = true; setSaving(true); setSaveError(null)
    try { await operation() }
    catch (error) { setSaveError(error instanceof Error ? error.message : String(error)) }
    finally { savingRef.current = false; setSaving(false) }
  }
  const toggleSection = (section: string) => setOpenSections((current) => { const next = new Set(current); if (next.has(section)) next.delete(section); else next.add(section); return next })
  const save = () => execute(async () => { await onSave(draft); onClose() })
  const upload = (file: File) => execute(() => onThumbnail(file, draft))
  const removeThumbnail = () => execute(() => onDeleteThumbnail(draft))
  const browseFolder = () => execute(async () => {
    const result = await api.selectFolder(draft.recording.directory)
    if (result.path) patch('recording', { ...draft.recording, directory: result.path })
  })
  return (
    <div className="modal-backdrop" onMouseDown={(event) => !savingRef.current && event.target === event.currentTarget && onClose()}>
      <section ref={modalRef} className="modal profile-modal" role="dialog" aria-modal="true" aria-labelledby="profile-editor-title" aria-busy={saving} tabIndex={-1}>
        <header className="modal-header"><ProfileArtwork profile={profile} size="small" /><div><h2 id="profile-editor-title">{profile.displayName}</h2><span>{t('ゲーム設定')}</span></div><button className="square-button" aria-label={t('ゲーム設定を閉じる')} disabled={saving} onClick={onClose}><X size={15} /></button></header>
        {readOnly && <div className="readonly-banner"><LockKeyhole size={14} /><span>{t('配信中のため読み取り専用です。変更は配信終了後に行えます。')}</span></div>}
        <div className="modal-scroll">
          {saveError && <div className="inline-warning error" role="alert"><AlertTriangle size={14} /><span>{saveError}</span></div>}
          <AccordionSection title={t('基本')} summary={`${draft.platformGroup === 'pc' ? 'PC' : draft.platformGroup === 'switch' ? 'Switch' : t('例外')} · ${draft.displayName}`} open={openSections.has('basic')} onToggle={() => toggleSection('basic')}>
            <fieldset disabled={locked}>
              <label>{t('表示名')}<input value={draft.displayName} onChange={(event) => patch('displayName', event.target.value)} /></label>
              <label>{t('テンプレート表示名')}<input value={draft.presentation.templateLabel} onChange={(event) => patch('presentation', { ...draft.presentation, templateLabel: event.target.value })} placeholder={draft.displayName} /><span className="field-hint">{t('空欄なら表示名を使います。例: ARK: Survival Ascended を ARK と表示')}</span></label>
              <div className="field-grid"><label>{t('分類')}<select value={draft.platformGroup} onChange={(event) => patch('platformGroup', event.target.value as PlatformGroup)}><option value="pc">PC</option><option value="switch">Switch</option><option value="exception">{t('例外')}</option></select></label><label>Steam App ID<NumericInput disabled={locked} allowEmpty value={draft.library.steamAppId} onValueChange={(value) => patch('library', { ...draft.library, steamAppId: value })} /></label></div>
              <label>{t('インストール先')}<input value={draft.library.installDirectory ?? ''} onChange={(event) => patch('library', { ...draft.library, installDirectory: event.target.value || undefined, installed: Boolean(event.target.value) })} /></label>
              <label>{t('次回のPart番号')}<NumericInput disabled={locked} value={draft.state.nextPartNumber} onValueChange={(value) => value !== undefined && patch('state', { ...draft.state, nextPartNumber: Math.max(1, Math.min(9999, Math.trunc(value))) })} /><span className="field-hint">{t('配信開始に成功したときだけ自動で1増えます')}</span></label>
              <div className="toggle-grid"><Toggle disabled={locked} checked={draft.favorite} label={t('お気に入り')} onChange={(value) => patch('favorite', value)} /><Toggle disabled={locked} checked={draft.library.gamePass} label="Game Pass / Xbox" onChange={(value) => patch('library', { ...draft.library, gamePass: value })} /><Toggle disabled={locked} checked={draft.library.installed} label={t('ローカル導入済み')} onChange={(value) => patch('library', { ...draft.library, installed: value })} /><Toggle disabled={locked} checked={draft.hidden} label={t('一覧から非表示')} onChange={(value) => patch('hidden', value)} /></div>
            </fieldset>
          </AccordionSection>
          <AccordionSection title={t('キャプチャ')} summary={t(captureLabels[draft.capture.preferred])} open={openSections.has('capture')} onToggle={() => toggleSection('capture')}>
            <fieldset disabled={locked}>
              <div className="field-grid"><label>{t('優先キャプチャ')}<select value={draft.capture.preferred} onChange={(event) => patch('capture', { ...draft.capture, preferred: event.target.value as CaptureMethod })}>{Object.entries(captureLabels).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</select></label><label>{t('OBSシーン')}<input value={draft.obs.sceneName} onChange={(event) => patch('obs', { ...draft.obs, sceneName: event.target.value })} /></label></div>
              <label>{t('実行ファイル名（カンマ区切り）')}<input value={draft.capture.executableNames.join(', ')} onChange={(event) => patch('capture', { ...draft.capture, executableNames: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) })} /></label>
              <div className="field-grid"><label>{t('ローカル映像ソース')}<input value={draft.capture.localSourceName} onChange={(event) => patch('capture', { ...draft.capture, localSourceName: event.target.value })} /></label><label>{t('GFN映像ソース')}<input value={draft.capture.geforceNowSourceName} onChange={(event) => patch('capture', { ...draft.capture, geforceNowSourceName: event.target.value })} /></label></div>
              <label>{t('ウィンドウ映像ソース')}<input value={draft.capture.windowSourceName ?? ''} onChange={(event) => patch('capture', { ...draft.capture, windowSourceName: event.target.value || undefined })} /></label>
              <div className="toggle-grid"><Toggle disabled={locked} checked={draft.capture.geforceNowEnabled} label={t('GeForce NOW対応')} onChange={(value) => patch('capture', { ...draft.capture, geforceNowEnabled: value })} /><Toggle disabled={locked} checked={draft.capture.allowDisplayFallback} label={t('画面キャプチャへフォールバック')} onChange={(value) => patch('capture', { ...draft.capture, allowDisplayFallback: value })} /></div>
            </fieldset>
          </AccordionSection>
          <AccordionSection title="YouTube" summary={`${t(draft.youtube.enabled ? '有効' : '無効')} · ${t(draft.youtube.privacy === 'public' ? '公開' : draft.youtube.privacy === 'unlisted' ? '限定公開' : '非公開')}`} open={openSections.has('youtube')} onToggle={() => toggleSection('youtube')}>
            <fieldset disabled={locked}><Toggle disabled={locked} checked={draft.youtube.enabled} label={t('このゲームで有効')} onChange={(value) => patch('youtube', { ...draft.youtube, enabled: value })} /><TitleTemplateField value={draft.youtube.titleTemplate} game={draft.displayName} part={draft.state.nextPartNumber} onChange={(value) => patch('youtube', { ...draft.youtube, titleTemplate: value })} /><label>{t('説明文')}<textarea rows={3} value={draft.youtube.description} onChange={(event) => patch('youtube', { ...draft.youtube, description: event.target.value })} /></label><div className="field-grid"><label>{t('公開範囲')}<select value={draft.youtube.privacy} onChange={(event) => patch('youtube', { ...draft.youtube, privacy: event.target.value as GameProfile['youtube']['privacy'] })}><option value="public">{t('公開')}</option><option value="unlisted">{t('限定公開')}</option><option value="private">{t('非公開')}</option></select></label><label>{t('カテゴリID')}<input value={draft.youtube.categoryId} onChange={(event) => patch('youtube', { ...draft.youtube, categoryId: event.target.value })} /></label></div></fieldset>
          </AccordionSection>
          <AccordionSection title="Twitch" summary={`${t(draft.twitch.enabled ? '有効' : '無効')} · ${draft.twitch.categoryName || t('カテゴリ未設定')}`} open={openSections.has('twitch')} onToggle={() => toggleSection('twitch')}>
            <fieldset disabled={locked}><Toggle disabled={locked} checked={draft.twitch.enabled} label={t('このゲームで有効')} onChange={(value) => patch('twitch', { ...draft.twitch, enabled: value })} /><TitleTemplateField value={draft.twitch.titleTemplate} game={draft.displayName} part={draft.state.nextPartNumber} onChange={(value) => patch('twitch', { ...draft.twitch, titleTemplate: value })} /><div className="field-grid"><label>{t('カテゴリ')}<input value={draft.twitch.categoryName} onChange={(event) => patch('twitch', { ...draft.twitch, categoryName: event.target.value })} /></label><label>{t('タグ（カンマ区切り）')}<input value={draft.twitch.tags.join(', ')} onChange={(event) => patch('twitch', { ...draft.twitch, tags: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) })} /></label></div></fieldset>
          </AccordionSection>
          <AccordionSection title={t('音声')} summary={`${t('ゲーム')} ${draft.audio.gameDb > 0 ? '+' : ''}${draft.audio.gameDb} dB`} open={openSections.has('audio')} onToggle={() => toggleSection('audio')}>
            <fieldset disabled={locked} className="field-grid"><RangeField disabled={locked} label={t('マイク')} value={draft.audio.microphoneDb} onChange={(value) => patch('audio', { ...draft.audio, microphoneDb: value })} /><RangeField disabled={locked} label={t('ゲーム')} value={draft.audio.gameDb} onChange={(value) => patch('audio', { ...draft.audio, gameDb: value })} /><RangeField disabled={locked} label="Discord" value={draft.audio.discordDb} onChange={(value) => patch('audio', { ...draft.audio, discordDb: value })} /><RangeField disabled={locked} label="BGM" value={draft.audio.bgmDb} onChange={(value) => patch('audio', { ...draft.audio, bgmDb: value })} /></fieldset>
          </AccordionSection>
          <AccordionSection title={t('録画')} summary={t('リプレイ {seconds}秒', { seconds: draft.recording.replayBufferSeconds })} open={openSections.has('recording')} onToggle={() => toggleSection('recording')}>
            <fieldset disabled={locked}><label>{t('録画先')}<div className="folder-control"><span title={draft.recording.directory}>{draft.recording.directory || t('未設定')}</span><button type="button" disabled={locked} onClick={() => void browseFolder()}>{t('参照')}</button></div></label><label>{t('リプレイ秒数')}<NumericInput disabled={locked} value={draft.recording.replayBufferSeconds} onValueChange={(value) => value !== undefined && patch('recording', { ...draft.recording, replayBufferSeconds: value })} /></label><div className="toggle-grid"><Toggle disabled={locked} checked={draft.recording.enabled} label={t('通常録画')} onChange={(value) => patch('recording', { ...draft.recording, enabled: value })} /><Toggle disabled={locked} checked={draft.recording.sourceRecord} label="Source Record" onChange={(value) => patch('recording', { ...draft.recording, sourceRecord: value })} /><Toggle disabled={locked} checked={draft.recording.verticalRecording} label="Aitum Vertical" onChange={(value) => patch('recording', { ...draft.recording, verticalRecording: value })} /></div></fieldset>
          </AccordionSection>
          <section className="thumbnail-section">
            <div className="thumbnail-heading"><strong>{t('YouTube用サムネイル')}</strong><span className={`thumbnail-status tone-${thumbnailTone(draft)}`}><StatusDot tone={thumbnailTone(draft)} />{thumbnailStatusLabel(draft, t)}</span></div>
            <div className="thumbnail-content">
              <ThumbnailPreview profile={draft} />
              <div className="thumbnail-options">
                {draft.state.thumbnailLastError && <div className="oauth-error">{draft.state.thumbnailLastError}</div>}
                <div className="button-row"><button className="secondary-button" disabled={locked} onClick={() => fileRef.current?.click()}>{t(draft.state.thumbnailFilename ? '差し替え' : '画像を登録')}</button>{draft.state.thumbnailFilename && <button className="ghost-button" disabled={locked} onClick={() => void removeThumbnail()}>{t('削除')}</button>}</div>
                <input ref={fileRef} hidden disabled={locked} type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); event.currentTarget.value = '' }} />
                <Toggle disabled={locked} checked={draft.state.thumbnailAutoApply} label={t('ゲーム選択時に自動適用')} onChange={(value) => patch('state', { ...draft.state, thumbnailAutoApply: value })} />
                <p>{t('PNG / JPG / WEBP・最大4MB。初回登録後は毎回の選択は不要です。未登録でも配信は開始できます。')}</p>
              </div>
            </div>
          </section>
        </div>
        <footer className="modal-footer"><button className="primary-button" disabled={locked} onClick={() => void save()}>{saving ? <LoaderCircle className="spin" size={15} /> : null}{t('保存')}</button><button className="danger-outline" disabled={locked} onClick={() => void execute(onDelete)}><Trash2 size={14} />{t('削除')}</button><button className="ghost-button close-button" disabled={saving} onClick={onClose}>{t('閉じる')}</button></footer>
      </section>
    </div>
  )
}

function AddGameModal({ initialGroup, onClose, onCreate }: { initialGroup: PlatformGroup; onClose: () => void; onCreate: (profile: GameProfile) => void }) {
  const { t } = useI18n()
  const initialCapture = initialGroup === 'switch' ? 'elgato' : initialGroup === 'exception' ? 'window' : 'auto'
  const [draft, setDraft] = useState<AddGameDraft>({ name: '', platformGroup: initialGroup, captureMethod: initialCapture, steamAppId: '' })
  const modalRef = useRef<HTMLElement>(null)
  useEffect(() => { modalRef.current?.focus() }, [])
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey) }, [onClose])
  const create = () => {
    const name = draft.name.trim()
    if (!name) return
    const steamAppId = Number(draft.steamAppId)
    const template = createGameProfile(`new_game_${crypto.randomUUID()}`, name, draft.platformGroup)
    onCreate({
      ...template,
      library: { gamePass: false, exception: draft.platformGroup === 'exception', installed: false, ...(Number.isInteger(steamAppId) && steamAppId > 0 ? { steamAppId } : {}) },
      capture: { ...template.capture, preferred: draft.captureMethod },
    })
  }
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section ref={modalRef} className="modal add-game-modal" role="dialog" aria-modal="true" aria-labelledby="add-game-title" tabIndex={-1}><header className="modal-header"><div className="empty-tile"><Plus size={15} /></div><h2 id="add-game-title">{t('ゲームを追加')}</h2><button className="square-button" aria-label={t('閉じる')} onClick={onClose}><X size={15} /></button></header><div className="add-game-body"><label>{t('ゲーム名')}<input autoFocus value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder={t('例: Elden Ring')} /></label><div className="field-grid"><label>{t('分類')}<select value={draft.platformGroup} onChange={(event) => setDraft({ ...draft, platformGroup: event.target.value as PlatformGroup })}><option value="pc">PC</option><option value="switch">Switch</option><option value="exception">{t('例外')}</option></select></label><label>{t('ソース')}<select value={draft.captureMethod} onChange={(event) => setDraft({ ...draft, captureMethod: event.target.value as CaptureMethod })}>{Object.entries(captureLabels).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</select></label></div><label>{t('Steam App ID（任意）')}<input inputMode="numeric" value={draft.steamAppId} onChange={(event) => setDraft({ ...draft, steamAppId: event.target.value })} placeholder={t('Steamのゲームのみ')} /></label><p>{t('追加後にゲーム設定が開き、キャプチャ方式・タイトル・サムネイルなどを編集できます。')}</p></div><footer className="modal-footer"><button className="primary-button" disabled={!draft.name.trim()} onClick={create}>{t('追加して設定を開く')}</button><button className="ghost-button close-button" onClick={onClose}>{t('キャンセル')}</button></footer></section></div>
}

function SettingsView({ config, profiles, status, oauthStatus, oauthProgress, steamScan, onSave, onBackup, onRestore, onSteamScan, onOAuthConnect, onTwitchOutputTest, onReconnect, onOpenSetup, onTemplateChanged }: { config: AppConfig; profiles: GameProfile[]; status: RuntimeStatus; oauthStatus: OAuthConnectionStatuses; oauthProgress: OAuthProgress; steamScan: SteamSyncResult | null; onSave: (config: AppConfig, secrets: Record<string, string>) => Promise<void>; onBackup: () => Promise<void>; onRestore: (file: File) => Promise<void>; onSteamScan: () => Promise<void>; onOAuthConnect: (provider: OAuthProvider) => Promise<void>; onTwitchOutputTest: () => Promise<void>; onReconnect: () => Promise<void>; onOpenSetup: () => void; onTemplateChanged: (template: AppConfig['commonTemplate']) => void }) {
  const { t } = useI18n()
  const [draft, setDraft] = useState(config)
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const secret = (name: string, value: string) => setSecrets((current) => ({ ...current, [name]: value }))
  const attempt = async (operation: () => Promise<void>) => { setSaving(true); setSettingsError(null); try { await operation() } catch (error) { setSettingsError(error instanceof Error ? error.message : String(error)) } finally { setSaving(false) } }
  const save = () => attempt(async () => { await onSave(draft, secrets); setSecrets({}) })
  const updateFeature = (key: keyof AppConfig['features'], value: boolean) => {
    const next = { ...draft, features: { ...draft.features, [key]: value } }
    setDraft(next)
    void attempt(() => onSave(next, {}))
  }
  const featureRows: Array<{ key: keyof AppConfig['features']; label: string; note: string }> = [
    { key: 'youtube', label: 'YouTube', note: t('YouTubeへの外部配信を管理') }, { key: 'twitch', label: 'Twitch', note: t('Twitchへの外部配信を管理') },
    { key: 'recording', label: t('通常録画'), note: t('OBSの通常録画を連動') }, { key: 'replayBuffer', label: t('リプレイバッファ'), note: t('クリップ保存を有効化') },
    { key: 'sourceRecord', label: 'Source Record', note: t('素材録画を連動') }, { key: 'verticalRecording', label: 'Aitum Vertical', note: t('縦型録画を連動') },
  ]
  return <main className="settings-view">
    {settingsError && <div className="inline-warning error" role="alert"><AlertTriangle size={14} /><span>{settingsError}</span></div>}
    <section className="settings-card obs-settings-card"><div className="card-title-row"><h2>OBS WebSocket</h2><span className={`connection-label ${status.obsConnected ? 'connected' : 'error'}`}><StatusDot tone={status.obsConnected ? 'live' : 'error'} />OBS {t(status.obsConnected ? '接続中' : '未接続')}</span></div><div className="connection-actions"><code>{draft.obs.url}</code><button className="secondary-button" disabled={saving} onClick={() => void attempt(onReconnect)}>{t('再接続')}</button></div><details className="settings-details"><summary>{t('接続詳細を編集')}</summary><div className="settings-details-body"><label>{t('接続URL')}<input value={draft.obs.url} onChange={(event) => setDraft({ ...draft, obs: { ...draft.obs, url: event.target.value } })} /></label><label>{t('パスワード')}<input type="password" autoComplete="off" placeholder={t(draft.obs.passwordStored ? '保存済み（変更時のみ入力）' : 'Windows資格情報へ保存')} value={secrets['obs-password'] ?? ''} onChange={(event) => secret('obs-password', event.target.value)} /></label><div className="field-grid"><label>{t('開始待機（秒）')}<input type="number" value={draft.obs.startDelaySeconds} onChange={(event) => setDraft({ ...draft, obs: { ...draft.obs, startDelaySeconds: Number(event.target.value) } })} /></label><label>{t('終了待機（秒）')}<input type="number" value={draft.obs.endDelaySeconds} onChange={(event) => setDraft({ ...draft, obs: { ...draft.obs, endDelaySeconds: Number(event.target.value) } })} /></label></div><button className="primary-button" disabled={saving} onClick={() => void save()}>{t('接続設定を保存')}</button></div></details></section>
    <OAuthServiceCard status={oauthStatus.youtube} progress={oauthProgress.youtube} saving={saving} onConnect={() => void attempt(() => onOAuthConnect('youtube'))} />
    <OAuthServiceCard status={oauthStatus.twitch} progress={oauthProgress.twitch} saving={saving} onConnect={() => void attempt(() => onOAuthConnect('twitch'))} onTestOutput={() => void attempt(onTwitchOutputTest)} outputReady={status.twitchOutputPluginReady} />
    {config.features.twitch && !status.twitchOutputPluginReady && <div className="inline-warning"><AlertTriangle size={14} /><span>{t(status.twitchOutputPlugin?.detail ?? '同時配信用プラグインを反映するためOBSを再起動してください')}</span></div>}
    {window.obsStreamManagerDesktop && <section className="settings-card"><h2>{t('OBS連携と終了動作')}</h2><p>{t('EXEが同梱ローカルサーバーを自動起動します。利用者がNode.jsやサーバーを準備する必要はありません。画面の×は通知領域へ格納し、OBSドックを維持します。')}</p><div className="feature-list"><DesktopIntegrationControl /></div><button className="danger-outline" disabled={saving || status.streaming} onClick={() => { if (window.confirm(t('完全に終了するとOBSドックも停止します。終了しますか？'))) void window.obsStreamManagerDesktop?.quit() }}>{t('ドックも停止して完全に終了')}</button></section>}
    <DesktopUpdateControl status={status} />
    <section className="settings-card"><h2>{t('機能')}</h2><div className="feature-list">{featureRows.map((feature) => <div className="feature-row" key={feature.key}><div><strong>{feature.label}</strong><span>{feature.note}</span></div><Toggle disabled={saving || status.streaming} checked={draft.features[feature.key]} label={t(draft.features[feature.key] ? '有効' : '無効')} onChange={(value) => updateFeature(feature.key, value)} /></div>)}</div></section>
    <section className="settings-card"><h2>{t('OBS音声ソース名')}</h2><div className="source-chips">{Object.values(draft.sources).map((source) => <code key={source}>{source}</code>)}</div><details className="settings-details"><summary>{t('ソース名を編集')}</summary><div className="settings-details-body field-grid">{Object.entries(draft.sources).map(([key, value]) => <label key={key}>{key}<input value={value} onChange={(event) => setDraft({ ...draft, sources: { ...draft.sources, [key]: event.target.value } })} /></label>)}<button className="primary-button" disabled={saving} onClick={() => void save()}>{t('ソース名を保存')}</button></div></details></section>
    <CommonTemplateEditor config={config.commonTemplate} profiles={profiles} disabled={saving || status.streaming} onChanged={onTemplateChanged} />
    <section className="settings-card"><div className="card-title-row"><h2>{t('Steam ライブラリ同期')}</h2><span className={`connection-label ${steamScan?.libraries.length ? 'connected' : 'optional'}`}><StatusDot tone={steamScan?.libraries.length ? 'live' : steamScan ? 'inactive' : 'pending'} />{t(steamScan ? steamScan.libraries.length ? '検出済み' : 'Steam未使用' : status.streaming ? '配信後に確認' : 'スキャン中')}</span></div><p>{t('Steamクライアントにログイン済みのライブラリから、未インストールを含むゲームを自動追加します。SteamIDやAPIキーの入力は不要です。')}</p><div className="feature-list"><div className="feature-row"><div><strong>{steamScan ? steamScan.libraries.length ? t('所有{owned}本・ローカル{installed}本', { owned: steamScan.owned, installed: steamScan.installed }) : t('Steamなしで利用可能') : t(status.streaming ? '配信中は自動追加を停止' : 'Steamを確認しています')}</strong><span>{steamScan ? steamScan.libraries.length ? t('未インストールのゲームはGeForce NOW用として追加されます') : t('ゲーム一覧の追加ボタンから手動登録できます') : t(status.streaming ? '配信終了後の再読込または再スキャンで反映します' : 'Steamの所有ゲームキャッシュを確認します')}</span></div></div></div>{steamScan?.libraries.length ? <div className="source-chips">{steamScan.libraries.map((library) => <code key={library}>{library}</code>)}</div> : null}<button className="secondary-button" disabled={saving || status.streaming} onClick={() => void attempt(onSteamScan)}><RefreshCw size={14} />{t('Steamライブラリを同期')}</button></section>
    <section className="settings-card"><h2>{t('初期セットアップ')}</h2><p>{t('OBS、配信サービス、ゲーム検出の案内をもう一度開きます。Steamを利用しない設定にも対応しています。')}</p><button className="secondary-button" disabled={saving || status.streaming} onClick={onOpenSetup}><Settings size={14} />{t('セットアップを開く')}</button></section>
    <section className="settings-card"><h2>{t('バックアップ / 復元')}</h2><p>{t('アプリ設定・ゲームプロファイル・サムネイルを書き出します。OBS本体の設定と、OAuthトークンなどの秘密情報は含まれません。')}</p><div className="button-row"><button className="secondary-button" disabled={saving} onClick={() => void attempt(onBackup)}><ArrowDownToLine size={14} />{t('書き出し')}</button><label className="ghost-button file-button"><Upload size={14} />{t('復元')}<input hidden type="file" accept="application/json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void attempt(() => onRestore(file)); event.currentTarget.value = '' }} /></label></div></section>
  </main>
}

type FirstRunSetupProps = {
  config: AppConfig
  status: RuntimeStatus
  oauthStatus: OAuthConnectionStatuses | null
  steamScan: SteamSyncResult | null
  onSaveObs: (url: string, password: string) => Promise<void>
  onConnect: (provider: OAuthProvider) => Promise<void>
  onSteamScan: () => Promise<void>
  onFinish: (openManualGame: boolean) => Promise<void>
  onLanguageChange: (language: UiLanguage) => Promise<void>
  onDismiss: () => void
}

function FirstRunSetup({ config, status, oauthStatus, steamScan, onSaveObs, onConnect, onSteamScan, onFinish, onLanguageChange, onDismiss }: FirstRunSetupProps) {
  const { t, language } = useI18n()
  const [step, setStep] = useState(0)
  const [obsUrl, setObsUrl] = useState(config.obs.url)
  const [obsPassword, setObsPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const dockUrl = window.obsStreamManagerDesktop?.dockUrl ?? 'http://127.0.0.1:4317'
  const steps = [t('ようこそ'), 'OBS', t('配信サービス'), t('ゲーム')]
  const attempt = async (operation: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try { await operation() } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) } finally { setBusy(false) }
  }
  const copyDockUrl = async () => {
    if (window.obsStreamManagerDesktop) await window.obsStreamManagerDesktop.copyDockUrl()
    else await navigator.clipboard.writeText(dockUrl)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2_000)
  }
  const saveObs = () => attempt(async () => { await onSaveObs(obsUrl, obsPassword); setObsPassword(''); setStep(2) })
  const finish = (openManualGame: boolean) => attempt(() => onFinish(openManualGame))
  const steamChecked = steamScan !== null
  const steamDetected = Boolean(steamScan?.libraries.length)

  return <div className="modal-backdrop setup-backdrop">
    <section className="modal setup-modal" role="dialog" aria-modal="true" aria-labelledby="first-run-title">
      <header className="setup-header">
        <div className="brand-mark"><BrandGlyph /></div>
        <div><span>{t('初期セットアップ')}</span><h2 id="first-run-title">{steps[step]}</h2></div>
        <label className="language-picker setup-language-picker"><span>{t('言語')}</span><select aria-label={t('言語を変更')} value={language} disabled={busy} onChange={(event) => void attempt(() => onLanguageChange(event.target.value as UiLanguage))}><option value="ja">日本語</option><option value="en">English</option></select></label>
      </header>
      <ol className="setup-progress" aria-label={t('セットアップ進行状況')}>
        {steps.map((label, index) => <li key={label} className={index < step ? 'complete' : index === step ? 'current' : ''}><span>{index < step ? <Check size={11} /> : index + 1}</span><b>{label}</b></li>)}
      </ol>
      <div className="setup-body">
        {error && <div className="inline-warning error" role="alert"><AlertTriangle size={14} /><span>{error}</span></div>}
        {step === 0 && <div className="setup-step">
          <div className="setup-lead"><Gamepad2 size={28} /><div><h3>{t('配信準備を順番に確認します')}</h3><p>{t('Steamにログイン済みなら、未インストールを含む所有ゲームを自動追加します。Steamがなくても手動登録できます。')}</p></div></div>
          <div className="setup-dock"><div><strong>{t('OBSブラウザドック URL')}</strong><code>{dockUrl}</code></div><button className="secondary-button" onClick={() => void attempt(copyDockUrl)}><Copy size={14} />{t(copied ? 'コピー済み' : 'コピー')}</button></div>
          <p className="setup-note">{t('OBSの「ドック」→「カスタムブラウザドック」へ、このURLを登録してください。')}</p>
          <DesktopIntegrationControl setup />
        </div>}
        {step === 1 && <div className="setup-step">
          <div className="setup-status-row"><div><strong>OBS WebSocket</strong><span>{t('OBS 30以降の「ツール」→「WebSocketサーバー設定」で有効化します。')}</span></div><span className={`connection-label ${status.obsConnected ? 'connected' : 'error'}`}><StatusDot tone={status.obsConnected ? 'live' : 'error'} />{t(status.obsConnected ? '接続中' : '未接続')}</span></div>
          <label>{t('接続URL')}<input value={obsUrl} onChange={(event) => setObsUrl(event.target.value)} /></label>
          <label>{t('パスワード')}<input type="password" autoComplete="off" value={obsPassword} onChange={(event) => setObsPassword(event.target.value)} placeholder={t(config.obs.passwordStored ? '保存済み（変更しない場合は空欄）' : 'Windows資格情報へ保存')} /></label>
          <p className="setup-note">{t('OBSをまだ起動していなくても保存して先へ進めます。')}</p>
        </div>}
        {step === 2 && <div className="setup-step">
          <p className="setup-note">{t('利用するサービスだけ接続できます。認証は後から設定画面でも行えます。')}</p>
          {(['youtube', 'twitch'] as const).map((provider) => {
            const connection = oauthStatus?.[provider]
            const label = provider === 'youtube' ? 'YouTube' : 'Twitch'
            const connected = connection?.stage === 'connected'
            return <div className="setup-service" key={provider}><ServiceIcon service={provider} /><div><strong>{label}</strong><span>{t(connected ? '認証情報を保存済み' : connection?.appConfigured ? 'ブラウザで認証できます' : '配布パッケージ側の設定が必要です')}</span></div><button className={connected ? 'ghost-button' : 'primary-button'} disabled={busy || !connection?.appConfigured} onClick={() => void attempt(() => onConnect(provider))}>{t(connected ? '再認証' : '接続')}</button></div>
          })}
        </div>}
        {step === 3 && <div className="setup-step">
          <div className={`setup-steam-result ${steamDetected ? 'detected' : ''}`}><Gamepad2 size={24} /><div><strong>{steamDetected ? t('Steamの所有ゲームを{count}本検出', { count: steamScan?.owned ?? 0 }) : t(steamChecked ? 'Steamなしでも利用できます' : 'Steamをまだ確認していません')}</strong><span>{steamDetected ? t('ローカル{installed}本・クラウド利用{cloud}本を一覧へ反映しました', { installed: steamScan?.installed ?? 0, cloud: Math.max(0, (steamScan?.owned ?? 0) - (steamScan?.installed ?? 0)) }) : t(steamChecked ? 'Game Pass、GeForce NOW、Switch、単体EXEはセットアップ後に手動追加してください。' : '再スキャンするとSteamの有無を確認できます。Steamを使わず手動追加へ進むこともできます。')}</span></div></div>
          {steamScan?.warnings[0] && !steamDetected && <p className="setup-note">{t('Steam検出結果: {warning}', { warning: steamScan.warnings[0] })}</p>}
          <button className="secondary-button setup-rescan" disabled={busy} onClick={() => void attempt(onSteamScan)}><RefreshCw size={14} />{t('Steamを再スキャン')}</button>
          <div className="setup-finish-actions"><button className="primary-button" disabled={busy} onClick={() => void finish(false)}>{t('セットアップを完了')}</button><button className="secondary-button" disabled={busy} onClick={() => void finish(true)}>{t('Steamを使わずゲームを手動追加')}</button></div>
        </div>}
      </div>
      <footer className="modal-footer setup-footer">
        {step > 0 && <button className="ghost-button" disabled={busy} onClick={() => setStep((current) => current - 1)}>{t('戻る')}</button>}
        <button className="ghost-button close-button" disabled={busy} onClick={onDismiss}>{t('後で設定')}</button>
        {step === 0 && <button className="primary-button" disabled={busy} onClick={() => setStep(1)}>{t('はじめる')}</button>}
        {step === 1 && <button className="primary-button" disabled={busy || !obsUrl.trim()} onClick={saveObs}>{busy ? <LoaderCircle className="spin" size={14} /> : null}{t('保存して次へ')}</button>}
        {step === 2 && <button className="primary-button" disabled={busy} onClick={() => setStep(3)}>{t('次へ')}</button>}
      </footer>
    </section>
  </div>
}

function ControlPanel({ status, selected, busy, onChooseGame, onStart, onStop, onReplay, onEdit }: { status: RuntimeStatus; selected: GameProfile | null; busy: boolean; onChooseGame: () => void; onStart: () => void; onStop: () => void; onReplay: () => void; onEdit: () => void }) {
  const { t } = useI18n()
  const externalActive = status.platforms.youtube.state === 'live' || status.platforms.twitch.state === 'live' || status.platforms.youtube.state === 'stopping' || status.platforms.twitch.state === 'stopping'
  const showStop = status.streaming || externalActive
  const restartDetected = status.streaming && !selected
  const disabled = busy || status.busy || !status.obsConnected || !selected
  const reason = !status.obsConnected ? t('OBSへ接続すると配信を開始できます') : !selected ? t('配信前にゲームを選択してください') : status.busy || busy ? t('処理が完了するまでお待ちください') : null
  return <aside className="control-panel" aria-label={t('配信操作')}>
    {restartDetected && <div className="control-warning"><AlertTriangle size={14} /><span>{t('アプリ再起動後の配信を検出しました。現在の配信を安全に終了できます。')}</span></div>}
    {selected ? <div className="selection-summary has-selection"><ProfileArtwork profile={selected} size="small" /><div className="selection-summary-copy"><span className="selection-label"><Check size={11} strokeWidth={3} />{t('現在選択中')}</span><strong>{selected.displayName}</strong><span>{status.captureMethod ? t(captureLabels[status.captureMethod]) : t('未判定')} · {thumbnailStatusLabel(selected, t)}</span></div><b><Check size={12} strokeWidth={3} />{t('配信対象')}</b></div> : <button type="button" className="selection-summary empty-selection-action" onClick={onChooseGame}><div className="empty-tile"><Plus size={15} /></div><div className="selection-summary-copy"><strong>{t('配信するゲームを選んでください')}</strong><span>{t('ゲーム一覧でカードを押すと配信設定が適用されます')}</span></div><b>{t('ゲーム一覧へ')}<ChevronRight size={12} /></b></button>}
    {!restartDetected && selected && !selected.state.thumbnailFilename && !showStop && <button className="thumbnail-register-link" onClick={onEdit}><ImageIcon size={14} />{t('初回サムネイルを登録')}</button>}
    {status.warning && <div className="control-warning"><AlertTriangle size={14} /><span>{t(status.warning)}</span></div>}
    <div className="control-actions">{showStop ? <button className="stop-button" disabled={busy || status.busy} onClick={onStop}>{busy ? <LoaderCircle className="spin" size={15} /> : <CircleStop size={15} />}{t('配信終了')}</button> : <button className="start-button" disabled={disabled} onClick={onStart}>{busy ? <LoaderCircle className="spin" size={15} /> : <Play size={15} fill="currentColor" />}{t('配信開始')}</button>}<button className="clip-button" disabled={!status.replayBuffer || busy} onClick={onReplay}><ArrowDownToLine size={14} />{t('クリップ保存')}</button></div>
    {!showStop && reason && <div className="control-reason">{reason}</div>}
  </aside>
}

export default function App() {
  const [tab, setTab] = useState<Tab>('pc')
  const [profiles, setProfiles] = useState<GameProfile[]>([])
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [status, setStatus] = useState<RuntimeStatus | null>(null)
  const [oauthStatus, setOAuthStatus] = useState<OAuthConnectionStatuses | null>(null)
  const [oauthProgress, setOAuthProgress] = useState<OAuthProgress>({})
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<GameProfile | null>(null)
  const [adding, setAdding] = useState(false)
  const [setupOpen, setSetupOpen] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)
  const [loading, setLoading] = useState(true)
  const wasStreaming = useRef(false)
  const [actionBusy, setActionBusy] = useState(false)
  const [comments, setComments] = useState<ChatMessage[]>([])
  const [steamScan, setSteamScan] = useState<SteamSyncResult | null>(null)
  const actionLock = useRef(false)
  const oauthPopup = useRef<Window | null>(null)
  const oauthStatusRequest = useRef(0)
  const previousOAuthStatus = useRef<OAuthConnectionStatuses | null>(null)
  const selectedServiceResults = useRef<Array<{ service: OAuthProvider; ok: boolean; message: string }>>([])
  const language = config?.ui.language ?? 'ja'
  const t = useMemo(() => createTranslator(language), [language])

  const loadOAuthStatus = useCallback(async (): Promise<OAuthConnectionStatuses | null> => {
    const requestId = ++oauthStatusRequest.current
    const connections = await api.oauthStatus()
    if (requestId !== oauthStatusRequest.current) return null
    const completedProviders = completedOAuthProviders(previousOAuthStatus.current, connections)
    previousOAuthStatus.current = connections
    setOAuthStatus(connections)
    if (completedProviders.length) {
      setOAuthProgress((current) => Object.fromEntries([...Object.entries(current), ...completedProviders.map((provider) => [provider, connections[provider].detail])]))
      setToast({ kind: 'success', text: '{providers} 接続が完了しました', values: { providers: completedProviders.map((provider) => provider === 'youtube' ? 'YouTube' : 'Twitch').join(' + ') } })
    }
    return connections
  }, [])

  const refresh = async () => { const [data] = await Promise.all([api.bootstrap(), loadOAuthStatus()]); setProfiles(data.profiles); setConfig(data.config); setStatus(data.status); setLoading(false) }
  const refreshOAuth = async () => { const connections = await loadOAuthStatus(); if (!connections) return; setOAuthProgress((current) => ({ youtube: connections.youtube.authorizationInProgress ? current.youtube : undefined, twitch: connections.twitch.authorizationInProgress ? current.twitch : undefined })) }
  const oauthPollingInterval = oauthRefreshInterval(oauthStatus)
  useEffect(() => {
    let active = true
    const initialize = async () => {
      try {
        const data = await api.bootstrap()
        let initialProfiles = data.profiles
        try {
          const result = await api.steamScan()
          if (!active) return
          if (!result.skipped) {
            initialProfiles = result.profiles
            setSteamScan(result)
            if (result.created) setToast({ kind: 'success', text: 'Steamから{count}本を自動追加しました', values: { count: result.created } })
            else if (result.warnings[0] && result.libraries.length) setToast({ kind: 'warning', text: 'Steam自動検出: {warning}', values: { warning: result.warnings[0] } })
          }
        } catch (error) {
          if (active) setToast({ kind: 'warning', text: 'Steam自動検出に失敗しました: {error}', values: { error: error instanceof Error ? error.message : String(error) } })
        }
        if (!active) return
        setProfiles(initialProfiles)
        setConfig(data.config)
        setStatus(data.status)
        setSetupOpen(!data.config.setup.completed)
        setLoading(false)
        void loadOAuthStatus().catch((error: Error) => setToast({ kind: 'error', text: 'OAuth接続状態を取得できません: {error}', values: { error: error.message } }))
      } catch (error) {
        if (!active) return
        setToast({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
        setLoading(false)
      }
    }
    void initialize()
    return () => { active = false }
  }, [loadOAuthStatus])
  useEffect(() => { const timer = window.setInterval(() => void api.status().then(setStatus).catch(() => undefined), 2_000); return () => window.clearInterval(timer) }, [])
  useEffect(() => {
    const streaming = Boolean(status?.streaming)
    if (wasStreaming.current && !streaming) void api.profiles().then(setProfiles).catch(() => undefined)
    wasStreaming.current = streaming
  }, [status?.streaming])
  useEffect(() => { if (!status?.selectedGameId) selectedServiceResults.current = [] }, [status?.selectedGameId])
  useEffect(() => { const load = () => void loadOAuthStatus().catch(() => undefined); const visible = () => { if (document.visibilityState === 'visible') load() }; window.addEventListener('focus', load); document.addEventListener('visibilitychange', visible); return () => { window.removeEventListener('focus', load); document.removeEventListener('visibilitychange', visible) } }, [loadOAuthStatus])
  useEffect(() => { const timer = window.setInterval(() => void loadOAuthStatus().catch(() => undefined), oauthPollingInterval); return () => window.clearInterval(timer) }, [loadOAuthStatus, oauthPollingInterval])
  useEffect(() => {
    if (!status?.streaming) {
      const clearTimer = window.setTimeout(() => setComments([]), 0)
      return () => window.clearTimeout(clearTimer)
    }
    let active = true
    const load = () => void api.comments().then((next) => { if (active) setComments(next) }).catch(() => undefined)
    load()
    const timer = window.setInterval(load, 3_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [status?.streaming])
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(null), 5_000); return () => window.clearTimeout(timer) }, [toast])
  useEffect(() => {
    const authenticated = (event: MessageEvent) => {
      let origin: URL
      try { origin = new URL(event.origin) } catch { return }
      const trustedLoopback = origin.protocol === 'http:' && (origin.hostname === '127.0.0.1' || origin.hostname === 'localhost')
      if (event.source === oauthPopup.current && trustedLoopback && event.data?.type === 'oauth-complete') { oauthPopup.current = null; void Promise.all([api.bootstrap(), loadOAuthStatus()]).then(([data]) => { setConfig(data.config); setStatus(data.status) }) }
    }
    window.addEventListener('message', authenticated)
    return () => window.removeEventListener('message', authenticated)
  }, [loadOAuthStatus])

  const filtered = useMemo(() => profiles.filter((profile) => profile.platformGroup === tab && !profile.hidden && profile.displayName.toLocaleLowerCase().includes(search.toLocaleLowerCase())), [profiles, search, tab])
  const selected = profiles.find((profile) => profile.id === status?.selectedGameId) ?? null
  const activeOperation = Boolean(status && (status.streaming || ['starting', 'live', 'stopping'].includes(status.platforms.youtube.state) || ['starting', 'live', 'stopping'].includes(status.platforms.twitch.state)))

  const run = async (operation: () => Promise<void>) => { if (actionLock.current) return; actionLock.current = true; setActionBusy(true); try { await operation() } catch (error) { setToast({ kind: 'error', text: error instanceof Error ? error.message : String(error) }) } finally { const latest = await api.status().catch(() => null); if (latest) setStatus(latest); actionLock.current = false; setActionBusy(false) } }
  const selectGame = (profile: GameProfile, method?: CaptureMethod) => {
    if (activeOperation) { setToast({ kind: 'warning', text: '配信中はゲームを切り替えられません' }); return }
    void run(async () => { const result = await api.select(profile.id, method); selectedServiceResults.current = result.services; setProfiles((current) => current.map((item) => item.id === profile.id ? result.profile : item)); setToast(result.warnings[0] ? { kind: 'warning', text: result.warnings[0] } : { kind: 'success', text: '{game}を適用しました', values: { game: profile.displayName } }) })
  }
  const toggleFavorite = (profile: GameProfile) => {
    if (activeOperation) { setToast({ kind: 'warning', text: '配信中はゲーム設定を変更できません' }); return }
    void run(async () => { const saved = await api.saveProfile({ ...profile, favorite: !profile.favorite }); setProfiles((current) => current.map((item) => item.id === saved.id ? saved : item)); setToast({ kind: 'success', text: saved.favorite ? 'お気に入りに追加しました' : 'お気に入りから外しました' }) })
  }
  const start = () => void run(async () => {
    const failures = selectedServiceResults.current.filter((service) => !service.ok)
    const twitchFailure = failures.find((service) => service.service === 'twitch')
    const canContinueYouTubeOnly = Boolean(twitchFailure) && failures.every((service) => service.service === 'twitch')
    if (canContinueYouTubeOnly && !window.confirm(`${t('Twitchの配信準備に失敗しています: {error}', { error: twitchFailure?.message ?? '' })}\n\n${t('YouTubeだけで続行しますか？')}`)) return
    const result = await api.start(canContinueYouTubeOnly)
    setToast({ kind: result.warnings.length ? 'warning' : 'success', text: result.warnings[0] ?? '配信と録画を開始しました' })
  })
  const stop = () => void run(async () => { const result = await api.stop(); setToast({ kind: result.warnings.length ? 'warning' : 'success', text: result.warnings[0] ?? '配信を終了しました' }) })
  const replay = () => void run(async () => { await api.replay(); setToast({ kind: 'success', text: 'クリップを保存しました' }) })
  const chooseGame = () => {
    const visibleProfiles = profiles.filter((profile) => !profile.hidden)
    const currentGroup = tab === 'settings' ? 'pc' : tab
    const targetGroup = visibleProfiles.some((profile) => profile.platformGroup === currentGroup) ? currentGroup : visibleProfiles[0]?.platformGroup ?? currentGroup
    setTab(targetGroup)
    setSearch('')
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      const firstCard = document.querySelector<HTMLElement>('.game-card')
      if (!firstCard) { setAdding(true); return }
      firstCard.scrollIntoView({ behavior: 'smooth', block: 'center' })
      firstCard.focus({ preventScroll: true })
    }))
  }

  const connectOAuth = async (provider: OAuthProvider) => {
    const configured = Boolean(oauthStatus?.[provider].appConfigured)
    if (!configured) throw new Error(t('{service}接続機能が配布パッケージに含まれていません。利用者による開発者登録は不要です', { service: provider === 'youtube' ? 'YouTube' : 'Twitch' }))
    const desktop = window.obsStreamManagerDesktop
    if (desktop) {
      setOAuthProgress((current) => ({ ...current, [provider]: t('{service}認証を開始しています', { service: provider === 'youtube' ? 'Google' : 'Twitch' }) }))
      try {
        const started = await api.oauthStart(provider, window.location.origin)
        await loadOAuthStatus()
        await desktop.openExternal(started.url)
        if (started.mode === 'redirect') {
          setOAuthProgress((current) => ({ ...current, [provider]: t('ブラウザでGoogleのアカウント選択と権限承認を完了してください') }))
          return
        }
        setOAuthProgress((current) => ({ ...current, [provider]: t('ブラウザでTwitchを承認してください。確認コード: {code}', { code: started.userCode }) }))
        setToast({ kind: 'warning', text: 'Twitch 認証コード: {code}（画面で求められた場合）', values: { code: started.userCode } })
        while (Date.now() < started.expiresAt) {
          await new Promise((resolve) => window.setTimeout(resolve, started.intervalMs))
          const result = await api.oauthPollTwitch(started.requestId)
          if (result.status === 'complete') {
            await refresh()
            setOAuthProgress((current) => ({ ...current, [provider]: t('Twitch認証と配信キーの取得が完了しました') }))
            return
          }
        }
        throw new Error(t('Twitch 認証の有効期限が切れました'))
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        setOAuthProgress((current) => ({ ...current, [provider]: t('接続に失敗しました: {error}', { error: reason }) }))
        await loadOAuthStatus().catch(() => undefined)
        throw error
      }
    }
    if (oauthPopup.current && !oauthPopup.current.closed) { oauthPopup.current.focus(); throw new Error(t('認証ウィンドウで接続を完了してください')) }
    const popup = window.open('about:blank', `${provider}-oauth`, 'width=560,height=720')
    if (!popup) throw new Error(t('認証ウィンドウを開けませんでした。ポップアップを許可してください'))
    oauthPopup.current = popup; setOAuthProgress((current) => ({ ...current, [provider]: t('{service}認証を開始しています', { service: provider === 'youtube' ? 'Google' : 'Twitch' }) }))
    try {
      const started = await api.oauthStart(provider, window.location.origin); await loadOAuthStatus(); popup.location.href = started.url
      if (started.mode === 'redirect') { setOAuthProgress((current) => ({ ...current, [provider]: t('Googleのアカウント選択と権限承認を待っています') })); return }
      setOAuthProgress((current) => ({ ...current, [provider]: t('Twitchの承認待ちです。確認コード: {code}', { code: started.userCode }) })); setToast({ kind: 'warning', text: 'Twitch 認証コード: {code}（画面で求められた場合）', values: { code: started.userCode } })
      while (Date.now() < started.expiresAt) { await new Promise((resolve) => window.setTimeout(resolve, started.intervalMs)); if (popup.closed) throw new Error(t('認証ウィンドウが閉じられました')); const result = await api.oauthPollTwitch(started.requestId); if (result.status === 'complete') { popup.close(); oauthPopup.current = null; await refresh(); setOAuthProgress((current) => ({ ...current, [provider]: t('Twitch認証と配信キーの取得が完了しました') })); return } }
      throw new Error(t('Twitch 認証の有効期限が切れました'))
    } catch (error) { if (!popup.closed) popup.close(); if (oauthPopup.current === popup) oauthPopup.current = null; const reason = error instanceof Error ? error.message : String(error); setOAuthProgress((current) => ({ ...current, [provider]: t('接続に失敗しました: {error}', { error: reason }) })); await loadOAuthStatus().catch(() => undefined); throw error }
  }

  const saveAppConfig = async (next: AppConfig, secrets: Record<string, string>) => {
    const saved = await api.saveConfig(next, secrets)
    setConfig(saved)
    await loadOAuthStatus()
    return saved
  }
  const changeLanguage = async (nextLanguage: UiLanguage) => {
    if (!config || config.ui.language === nextLanguage) return
    const previous = config
    const optimistic = { ...config, ui: { ...config.ui, language: nextLanguage } }
    try {
      const saved = await api.saveConfig(optimistic, {})
      setConfig(saved)
    } catch (error) {
      setConfig(previous)
      throw error
    }
  }
  const scanSteam = async () => {
    const result = await api.steamScan()
    if (result.skipped) return
    setProfiles(result.profiles)
    setSteamScan(result)
    setToast({
      kind: result.warnings.length && result.libraries.length ? 'warning' : 'success',
      text: result.libraries.length
        ? 'Steam同期: 所有{owned}本・ローカル{installed}本・新規{created}件{warning}'
        : 'Steamは見つかりませんでした。手動追加でそのまま利用できます',
      values: result.libraries.length ? { owned: result.owned, installed: result.installed, created: result.created, warning: result.warnings[0] ? ` / ${result.warnings[0]}` : '' } : undefined,
    })
  }
  const saveSetupObs = async (url: string, password: string) => {
    if (!config) return
    await saveAppConfig({ ...config, obs: { ...config.obs, url: url.trim() } }, password ? { 'obs-password': password } : {})
    setStatus(await api.status())
  }
  const finishSetup = async (openManualGame: boolean) => {
    if (!config) return
    const saved = await saveAppConfig({ ...config, setup: { completed: true } }, {})
    setConfig(saved)
    setSetupOpen(false)
    if (openManualGame) {
      setTab('pc')
      setAdding(true)
    }
    setToast({ kind: 'success', text: openManualGame ? 'セットアップを保存しました。最初のゲームを追加してください' : '初期セットアップを保存しました' })
  }

  const uploadThumbnail = async (profile: GameProfile, file: File) => {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error(t('PNG、JPG、WEBPを選択してください'))
    if (file.size > 4 * 1024 * 1024) throw new Error(t('サムネイルは4MB以下にしてください'))
    const persisted = await api.saveProfile(profile); setProfiles((current) => [...current.filter((item) => item.id !== persisted.id), persisted])
    let saved: GameProfile
    try { const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => { const encoded = String(reader.result).split(',')[1]; if (encoded) resolve(encoded); else reject(new Error(t('サムネイルの読み込みに失敗しました'))) }; reader.onerror = () => reject(new Error(t('サムネイルの読み込みに失敗しました'))); reader.readAsDataURL(file) }); saved = await api.uploadThumbnail(persisted.id, file.type, data, file.name) } catch (error) { throw new Error(t('設定は保存されましたが、サムネイルの更新に失敗しました: {error}', { error: error instanceof Error ? error.message : String(error) })) }
    setProfiles((current) => [...current.filter((item) => item.id !== saved.id), saved]); setEditing(saved); const latest = await api.status().catch(() => null); if (latest) setStatus(latest); setToast({ kind: 'success', text: '設定とサムネイルを保存しました。以後は自動で使い回します' })
  }
  const deleteThumbnail = async (draft: GameProfile) => { if (!window.confirm(t('登録済みサムネイルを削除しますか？'))) return; const persisted = await api.saveProfile(draft); let saved: GameProfile; try { saved = await api.deleteThumbnail(persisted.id) } catch (error) { throw new Error(t('設定は保存されましたが、サムネイルの削除に失敗しました: {error}', { error: error instanceof Error ? error.message : String(error) })) }; setProfiles((current) => [...current.filter((item) => item.id !== saved.id), saved]); setEditing(saved); const latest = await api.status().catch(() => null); if (latest) setStatus(latest); setToast({ kind: 'success', text: '設定を維持したままサムネイルを削除しました' }) }

  if (loading || !config || !status) return <div className="loading-screen"><LoaderCircle className="spin" /><span>{t('ストリーム環境を読み込み中')}</span></div>

  return <I18nProvider language={language}><div className="app-frame"><div className="app-shell">
    <header className="app-header"><div className="brand"><div className="brand-mark"><BrandGlyph /></div><strong>STREAM MANAGER</strong></div><div className="header-actions"><label className="language-picker"><span>{t('言語')}</span><select aria-label={t('言語を変更')} value={language} onChange={(event) => void run(() => changeLanguage(event.target.value as UiLanguage))}><option value="ja">日本語</option><option value="en">English</option></select></label><div className={`header-status ${status.obsConnected ? 'connected' : 'error'}`}><StatusDot tone={status.obsConnected ? 'live' : 'error'} /><span>OBS {t(status.obsConnected ? '接続中' : '未接続')}</span></div></div></header>
    <DesktopLaunchNotice />
    <nav className="tabs">{groups.map(({ id, label }) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{t(label)}</button>)}</nav>
    <RuntimeStatusBar status={status} />
    <CommentsSection comments={comments} language={language} streaming={status.streaming} t={t} />
    {tab === 'settings' ? (oauthStatus ? <SettingsView key={JSON.stringify(config)} config={config} profiles={profiles} status={status} oauthStatus={oauthStatus} oauthProgress={oauthProgress} steamScan={steamScan} onOAuthConnect={connectOAuth} onTwitchOutputTest={async () => { setToast({ kind: 'warning', text: 'Twitchへ非公開の映像テストを15秒間送信しています' }); const result = await api.testTwitchOutput(); setToast({ kind: result.skippedFrames === 0 ? 'success' : 'warning', text: 'Twitch映像テスト成功: {seconds}秒・{megabytes}MB送信・欠落{skipped}フレーム', values: { seconds: Math.round(result.durationMs / 1000), megabytes: (result.bytesSent / 1_000_000).toFixed(1), skipped: result.skippedFrames } }); await refresh() }} onReconnect={async () => { await refresh(); setToast({ kind: 'success', text: 'OBS接続状態を再確認しました' }) }} onSave={async (next, secrets) => { await saveAppConfig(next, secrets); setToast({ kind: 'success', text: '設定を保存しました' }) }} onTemplateChanged={(template) => setConfig((current) => current ? { ...current, commonTemplate: template } : current)} onBackup={async () => { const backup = await api.backup(); const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `obs-stream-manager-${new Date().toISOString().slice(0, 10)}.json`; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 10_000) }} onRestore={async (file) => { await api.restore(JSON.parse(await file.text())); await refresh(); setToast({ kind: 'success', text: 'バックアップを復元しました' }) }} onSteamScan={scanSteam} onOpenSetup={() => setSetupOpen(true)} /> : <main className="settings-view"><div className="inline-warning error"><AlertTriangle size={14} /><span>{t('OAuth接続状態を取得できません。OBS操作は利用できます。')}</span></div><button className="secondary-button" onClick={() => void refreshOAuth()}><RefreshCw size={14} />{t('状態を再確認')}</button></main>) : <main className="library-view">
    {tab === 'settings' ? (oauthStatus ? <SettingsView key={JSON.stringify(config)} config={config} profiles={profiles} status={status} oauthStatus={oauthStatus} oauthProgress={oauthProgress} steamScan={steamScan} onOAuthConnect={connectOAuth} onTwitchOutputTest={async () => { setToast({ kind: 'warning', text: 'Twitchへ非公開の映像テストを15秒間送信しています' }); const result = await api.testTwitchOutput(); setToast({ kind: result.skippedFrames === 0 ? 'success' : 'warning', text: 'Twitch映像テスト成功: {seconds}秒・{megabytes}MB送信・欠落{skipped}フレーム', values: { seconds: Math.round(result.durationMs / 1000), megabytes: (result.bytesSent / 1_000_000).toFixed(1), skipped: result.skippedFrames } }); await refresh() }} onReconnect={async () => { await refresh(); setToast({ kind: 'success', text: 'OBS接続状態を再確認しました' }) }} onSave={async (next, secrets) => { await saveAppConfig(next, secrets); setToast({ kind: 'success', text: '設定を保存しました' }) }} onTemplateChanged={(template) => setConfig((current) => current ? { ...current, commonTemplate: template } : current)} onBackup={async () => { const backup = await api.backup(); const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `obs-stream-manager-${new Date().toISOString().slice(0, 10)}.json`; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 10_000) }} onRestore={async (file) => { await api.restore(JSON.parse(await file.text())); await refresh(); setToast({ kind: 'success', text: 'バックアップを復元しました' }) }} onSteamScan={scanSteam} onOpenSetup={() => setSetupOpen(true)} /> : <main className="settings-view"><div className="inline-warning error"><AlertTriangle size={14} /><span>{t('OAuth接続状態を取得できません。OBS操作は利用できます。')}</span></div><button className="secondary-button" onClick={() => void refreshOAuth()}><RefreshCw size={14} />{t('状態を再確認')}</button></main>) : tab === 'bgm' ? <main className="settings-view"><BgmLibrarySection obsConnected={status.obsConnected} /></main> : <main className="library-view">
      <div className="search-row"><label className="search-box"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('ゲームを検索')} />{search && <button aria-label={t('検索をクリア')} onClick={() => setSearch('')}><X size={14} /></button>}</label><button className="add-button" disabled={activeOperation} onClick={() => setAdding(true)}><Plus size={14} />{t('追加')}</button></div>
      {selected && <SelectedGameBanner profile={selected} status={status} />}
      {tab === 'switch' && <p className="tab-note">{t('Switchはゲーム名を自動判定しません。配信するゲームを手動で選択してください。')}</p>}{tab === 'exception' && <p className="tab-note">{t('通常のライブラリ連携が難しいゲームを扱います。')}</p>}
      {filtered.some((profile) => profile.favorite) && !search && <section className="library-section favorites"><h2>{t('お気に入り')}</h2><div className="favorite-list">{filtered.filter((profile) => profile.favorite).map((profile) => <button key={profile.id} className={selected?.id === profile.id ? 'selected' : ''} aria-current={selected?.id === profile.id ? 'true' : undefined} disabled={actionBusy} onClick={() => selectGame(profile)}><ProfileArtwork profile={profile} size="favorite" /><strong>{profile.displayName}</strong>{selected?.id === profile.id && <span className="favorite-selected-label"><Check size={10} strokeWidth={3} />{t('選択中')}</span>}</button>)}</div></section>}
      <section className="library-section"><div className="section-title"><h2>{t(platformTitles[tab])}</h2><span>{filtered.length} {t('件')}</span></div><div className="game-list">{filtered.map((profile) => <GameCard key={profile.id} profile={profile} selected={selected?.id === profile.id} busy={actionBusy} onSelect={() => selectGame(profile)} onEdit={() => setEditing(profile)} onFavorite={() => toggleFavorite(profile)} />)}{filtered.length === 0 && <div className="empty"><Gamepad2 size={24} /><strong>{t('ゲームがありません')}</strong><button onClick={() => setAdding(true)}>{t('ゲームを追加')}</button></div>}</div></section>
    </main>}
    <ControlPanel status={status} selected={selected} busy={actionBusy} onChooseGame={chooseGame} onStart={start} onStop={stop} onReplay={replay} onEdit={() => selected && setEditing(selected)} />
    {setupOpen && <FirstRunSetup config={config} status={status} oauthStatus={oauthStatus} steamScan={steamScan} onSaveObs={saveSetupObs} onConnect={connectOAuth} onSteamScan={scanSteam} onFinish={finishSetup} onLanguageChange={changeLanguage} onDismiss={() => { setSetupOpen(false); setToast({ kind: 'success', text: '初期セットアップは次回起動時に再表示されます' }) }} />}
    {editing && <ProfileEditor key={`${editing.id}:${editing.platformGroup}:${editing.state.thumbnailFilename ?? ''}:${editing.state.thumbnailUpdatedAt ?? ''}`} profile={editing} readOnly={activeOperation} onClose={() => setEditing(null)} onSave={async (profile) => { const wasSelected = status.selectedGameId === profile.id; const saved = await api.saveProfile(profile); setProfiles((current) => [...current.filter((item) => item.id !== saved.id), saved]); setStatus(await api.status()); setToast({ kind: 'success', text: wasSelected ? 'ゲーム設定を保存しました。配信前にゲームを選び直してください' : 'ゲーム設定を保存しました' }) }} onDelete={async () => { if (!window.confirm(t('{game}を削除しますか？', { game: editing.displayName }))) return; await api.deleteProfile(editing.id); setProfiles((current) => current.filter((item) => item.id !== editing.id)); setEditing(null) }} onThumbnail={(file, draft) => uploadThumbnail(draft, file)} onDeleteThumbnail={deleteThumbnail} />}
    {adding && <AddGameModal initialGroup={tab === 'settings' || tab === 'bgm' ? 'pc' : tab} onClose={() => setAdding(false)} onCreate={(profile) => { setAdding(false); setEditing(profile) }} />}
    <div className="toast-stack" aria-live="polite">{toast && <div className={`toast ${toast.kind}`}><StatusDot tone={toast.kind === 'success' ? 'live' : toast.kind === 'error' ? 'error' : 'pending'} /><span>{t(toast.text, toast.values)}</span><button aria-label={t('通知を閉じる')} onClick={() => setToast(null)}><X size={14} /></button></div>}</div>
  </div></div></I18nProvider>
}
