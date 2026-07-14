import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import {
  AlertTriangle, ArrowDownToLine, Check, ChevronRight, CircleStop, Gamepad2,
  Image as ImageIcon, LoaderCircle, LockKeyhole, MessageSquareText, Play, Plus, RefreshCw,
  Search, Settings, Star, Trash2, Upload, X,
} from 'lucide-react'
import type { AppConfig, CaptureMethod, ChatMessage, GameProfile, PlatformGroup, RuntimeStatus } from '../shared/contracts'
import { api, type OAuthConnectionStatus, type OAuthConnectionStatuses, type OAuthProvider } from './api'
import { completedOAuthProviders, oauthRefreshInterval } from './oauth-refresh'
import { getBroadcastStatus, getExternalDeliveryWarning, getRuntimeOutputs, type RuntimeOutputStatus } from './runtime-status'

type Tab = PlatformGroup | 'settings'
type Toast = { kind: 'success' | 'error' | 'warning'; text: string }
type OAuthProgress = Partial<Record<OAuthProvider, string>>
type AddGameDraft = { name: string; platformGroup: PlatformGroup; captureMethod: CaptureMethod; steamAppId: string }

const groups: Array<{ id: Tab; label: string }> = [
  { id: 'pc', label: 'PC' },
  { id: 'switch', label: 'Switch' },
  { id: 'exception', label: '例外' },
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

function ServiceIcon({ service }: { service: 'obs' | 'youtube' | 'twitch' }) {
  if (service === 'youtube') return <svg className="service-icon youtube" viewBox="0 0 24 24" aria-hidden="true"><path d="M21.6 7.2a2.7 2.7 0 0 0-1.9-1.9C18 4.8 12 4.8 12 4.8s-6 0-7.7.5a2.7 2.7 0 0 0-1.9 1.9A28 28 0 0 0 2 12a28 28 0 0 0 .4 4.8 2.7 2.7 0 0 0 1.9 1.9c1.7.5 7.7.5 7.7.5s6 0 7.7-.5a2.7 2.7 0 0 0 1.9-1.9A28 28 0 0 0 22 12a28 28 0 0 0-.4-4.8Z" /><path className="service-icon-cut" d="m10 15.5 5-3.5-5-3.5Z" /></svg>
  if (service === 'twitch') return <svg className="service-icon twitch" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 3h17v12l-5 5h-4l-3 3v-3H4Zm3 3v10h4v2l2-2h4l2-2V6Z" /><path className="service-icon-cut" d="M10 8h2v5h-2Zm5 0h2v5h-2Z" /></svg>
  return <svg className="service-icon obs" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" /><circle cx="12" cy="12" r="2.5" /></svg>
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
  const [recordingsOpen, setRecordingsOpen] = useState(false)
  const broadcast = getBroadcastStatus(status)
  const outputs = getRuntimeOutputs(status)
  const platformOutputs = outputs.slice(0, 3)
  const recordingOutputs = outputs.slice(3)
  const activeRecordings = recordingOutputs.filter((output) => output.active).length
  const deliveryWarning = getExternalDeliveryWarning(status)
  const live = broadcast.tone === 'live'

  return (
    <section className={`runtime-status tone-${broadcast.tone}`} aria-label="現在の配信状態">
      <div className="runtime-overall-row">
        <div className="runtime-overall" role="status" aria-live="polite" aria-atomic="true">
          <StatusDot tone={broadcast.tone === 'live' ? 'live' : broadcast.tone === 'sending' ? 'pending' : broadcast.tone === 'unknown' ? 'error' : 'inactive'} pulse={broadcast.tone === 'live'} />
          <strong>{broadcast.label}</strong>
          <span className="overall-detail">{broadcast.detail}</span>
        </div>
        <span className="scene-label">SCENE: {status.currentScene ?? '不明'}{live && <> ・ LIVE{status.streaming && status.streamElapsedMs !== undefined ? <> <LiveElapsed milliseconds={status.streamElapsedMs} /></> : null}</>}</span>
      </div>
      {deliveryWarning && <div className={`runtime-status-warning ${!status.streaming && status.platforms.youtube.state === 'live' || !status.streaming && status.platforms.twitch.state === 'live' ? 'danger' : ''}`} role="alert"><AlertTriangle size={14} /><span>{deliveryWarning}</span></div>}
      <div className="platform-grid">
        {platformOutputs.map((output) => (
          <div className={`platform-card ${output.tone}`} key={output.key} aria-label={`${output.label}: ${output.state}`} title={output.detail}>
            <div><ServiceIcon service={output.key === 'youtube' ? 'youtube' : output.key === 'twitch' ? 'twitch' : 'obs'} /><span>{output.label}</span></div>
            <strong><StatusDot tone={output.tone} pulse={output.active} />{output.state}</strong>
          </div>
        ))}
      </div>
      <div className="recording-status">
        <button className="recording-toggle" aria-expanded={recordingsOpen} onClick={() => setRecordingsOpen((current) => !current)}><ChevronRight size={12} /><span>録画系ステータス</span><b>{activeRecordings}/{recordingOutputs.length} 稼働</b></button>
        {recordingsOpen && <div className="recording-grid">{recordingOutputs.map((output) => <div className="recording-item" key={output.key}><StatusDot tone={output.tone} /><span>{output.label}</span><strong>{output.active ? '稼働中' : '停止'}</strong></div>)}</div>}
      </div>
    </section>
  )
}

const oauthStageLabels: Record<OAuthConnectionStatus['stage'], string> = {
  setup_required: '配布設定エラー', ready: '認証開始できます', authorizing: '認証待ち', partial: '一部のみ完了', connected: '接続済み',
}

function OAuthServiceCard({ status, progress, saving, onConnect }: { status: OAuthConnectionStatus; progress?: string; saving: boolean; onConnect: () => void }) {
  const isYoutube = status.provider === 'youtube'
  const serviceName = isYoutube ? 'YouTube' : 'Twitch'
  const steps = isYoutube
    ? [
        { label: 'アプリ内OAuth', complete: status.appConfigured },
        { label: 'Googleアカウント認証', complete: status.refreshTokenStored },
        { label: '更新トークン保存', complete: status.refreshTokenStored },
      ]
    : [
        { label: 'アプリ内OAuth', complete: status.appConfigured },
        { label: 'Twitchアカウント認証', complete: status.accessTokenStored && status.refreshTokenStored },
        { label: '配信者情報取得', complete: status.accountLinked },
      ]
  const buttonLabel = !status.appConfigured ? '接続機能を準備中' : status.stage === 'connected' ? '今すぐ再取得' : `${serviceName}で接続`
  return (
    <section className={`settings-card oauth-service oauth-${status.stage}`} data-testid={`oauth-${status.provider}`}>
      <div className="card-title-row">
        <ServiceIcon service={status.provider} />
        <h2>{serviceName} 接続</h2>
        <span className={`oauth-stage oauth-stage-${status.stage}`}><StatusDot tone={status.stage === 'connected' ? 'live' : status.stage === 'setup_required' ? 'error' : 'pending'} pulse={status.stage === 'authorizing'} />{oauthStageLabels[status.stage]}</span>
      </div>
      <ol className="oauth-steps" aria-label={`${serviceName} 接続状況`}>
        {steps.map((step, index) => {
          const current = status.authorizationInProgress && index === 1
          return <li key={step.label} className={step.complete ? 'complete' : current ? 'current' : 'pending'} aria-current={current ? 'step' : undefined}><span className="oauth-step-marker">{step.complete ? <Check size={11} /> : current ? <LoaderCircle className="spin" size={11} /> : index + 1}</span><span>{step.label}</span></li>
        })}
      </ol>
      {(status.stage === 'setup_required' || status.stage === 'partial') && <div className="oauth-error" role="alert">{progress ?? status.detail}</div>}
      <div className="oauth-footer">
        {status.stage === 'connected' && <span>{status.detail} ・ 自動更新有効</span>}
        {status.stage !== 'connected' && status.stage !== 'setup_required' && <span>{progress ?? status.detail}</span>}
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

function thumbnailStatusLabel(profile: GameProfile): string {
  if (!profile.state.thumbnailFilename) return 'サムネ未登録'
  if (!profile.state.thumbnailAutoApply) return 'サムネ自動適用OFF'
  if (profile.state.thumbnailApplyStatus === 'applied') return 'サムネ自動適用済み'
  if (profile.state.thumbnailApplyStatus === 'failed') return 'サムネ適用失敗'
  return 'サムネ登録済み'
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

function GameCard({ profile, selected, busy, onSelect, onEdit, onFavorite }: { profile: GameProfile; selected: boolean; busy: boolean; onSelect: () => void; onEdit: () => void; onFavorite: () => void }) {
  const activate = () => { if (!busy) onSelect() }
  return (
    <article className={`game-card ${selected ? 'selected' : ''}`} role="button" tabIndex={busy ? -1 : 0} aria-disabled={busy} onClick={activate} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate() } }}>
      <div className="game-tile" style={tileStyle(profile)}>{profileInitial(profile)}</div>
      <div className="game-copy">
        <div className="game-name-row"><strong>{profile.displayName}</strong>{selected && <span className="selected-badge">選択中</span>}</div>
        <div className="game-meta"><span>{captureLabels[profile.capture.preferred]}</span><span className={`thumb-meta tone-${thumbnailTone(profile)}`}><ImageIcon size={11} />{thumbnailStatusLabel(profile)}</span></div>
      </div>
      <div className="game-actions">
        <button className="square-button favorite-button" aria-label={`${profile.displayName}をお気に入り${profile.favorite ? 'から外す' : 'に追加'}`} disabled={busy} onClick={(event) => { event.stopPropagation(); onFavorite() }}><Star size={14} fill={profile.favorite ? 'currentColor' : 'none'} /></button>
        <button className="square-button" aria-label={`${profile.displayName}の設定`} onClick={(event) => { event.stopPropagation(); onEdit() }}><Settings size={14} /></button>
      </div>
    </article>
  )
}

function AccordionSection({ title, summary, open, onToggle, children }: { title: string; summary: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  return <section className="editor-section"><button type="button" className="editor-section-toggle" aria-expanded={open} onClick={onToggle}><ChevronRight size={13} /><strong>{title}</strong><span>{summary}</span></button>{open && <div className="editor-section-body">{children}</div>}</section>
}

function RangeField({ label, value, disabled, onChange }: { label: string; value: number; disabled: boolean; onChange: (value: number) => void }) {
  return <label>{label}<div className="range-control"><input type="range" min="-30" max="6" step="1" value={value} disabled={disabled} onChange={(event) => onChange(Number(event.target.value))} /><span>{value > 0 ? '+' : ''}{value} dB</span></div></label>
}

function Toggle({ checked, disabled = false, label, onChange }: { checked: boolean; disabled?: boolean; label: string; onChange: (checked: boolean) => void }) {
  return <label className="toggle-row"><button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}><span /></button><span>{label}</span></label>
}

function ProfileEditor({ profile, readOnly, onClose, onSave, onDelete, onThumbnail, onDeleteThumbnail }: { profile: GameProfile; readOnly: boolean; onClose: () => void; onSave: (profile: GameProfile) => Promise<void>; onDelete: () => Promise<void>; onThumbnail: (file: File, draft: GameProfile) => Promise<void>; onDeleteThumbnail: (draft: GameProfile) => Promise<void> }) {
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
        <header className="modal-header"><div className="game-tile small" style={tileStyle(profile)}>{profileInitial(profile)}</div><div><h2 id="profile-editor-title">{profile.displayName}</h2><span>ゲーム設定</span></div><button className="square-button" aria-label="ゲーム設定を閉じる" disabled={saving} onClick={onClose}><X size={15} /></button></header>
        {readOnly && <div className="readonly-banner"><LockKeyhole size={14} /><span>配信中のため読み取り専用です。変更は配信終了後に行えます。</span></div>}
        <div className="modal-scroll">
          {saveError && <div className="inline-warning error" role="alert"><AlertTriangle size={14} /><span>{saveError}</span></div>}
          <AccordionSection title="基本" summary={`${draft.platformGroup === 'pc' ? 'PC' : draft.platformGroup === 'switch' ? 'Switch' : '例外'} ・ ${draft.displayName}`} open={openSections.has('basic')} onToggle={() => toggleSection('basic')}>
            <fieldset disabled={locked}>
              <label>表示名<input value={draft.displayName} onChange={(event) => patch('displayName', event.target.value)} /></label>
              <div className="field-grid"><label>分類<select value={draft.platformGroup} onChange={(event) => patch('platformGroup', event.target.value as PlatformGroup)}><option value="pc">PC</option><option value="switch">Switch</option><option value="exception">例外</option></select></label><label>Steam App ID<NumericInput disabled={locked} allowEmpty value={draft.library.steamAppId} onValueChange={(value) => patch('library', { ...draft.library, steamAppId: value })} /></label></div>
              <label>インストール先<input value={draft.library.installDirectory ?? ''} onChange={(event) => patch('library', { ...draft.library, installDirectory: event.target.value || undefined, installed: Boolean(event.target.value) })} /></label>
              <div className="toggle-grid"><Toggle disabled={locked} checked={draft.favorite} label="お気に入り" onChange={(value) => patch('favorite', value)} /><Toggle disabled={locked} checked={draft.library.gamePass} label="Game Pass / Xbox" onChange={(value) => patch('library', { ...draft.library, gamePass: value })} /><Toggle disabled={locked} checked={draft.library.installed} label="ローカル導入済み" onChange={(value) => patch('library', { ...draft.library, installed: value })} /><Toggle disabled={locked} checked={draft.hidden} label="一覧から非表示" onChange={(value) => patch('hidden', value)} /></div>
            </fieldset>
          </AccordionSection>
          <AccordionSection title="キャプチャ" summary={captureLabels[draft.capture.preferred]} open={openSections.has('capture')} onToggle={() => toggleSection('capture')}>
            <fieldset disabled={locked}>
              <div className="field-grid"><label>優先キャプチャ<select value={draft.capture.preferred} onChange={(event) => patch('capture', { ...draft.capture, preferred: event.target.value as CaptureMethod })}>{Object.entries(captureLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>OBSシーン<input value={draft.obs.sceneName} onChange={(event) => patch('obs', { ...draft.obs, sceneName: event.target.value })} /></label></div>
              <label>実行ファイル名（カンマ区切り）<input value={draft.capture.executableNames.join(', ')} onChange={(event) => patch('capture', { ...draft.capture, executableNames: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) })} /></label>
              <div className="field-grid"><label>ローカル映像ソース<input value={draft.capture.localSourceName} onChange={(event) => patch('capture', { ...draft.capture, localSourceName: event.target.value })} /></label><label>GFN映像ソース<input value={draft.capture.geforceNowSourceName} onChange={(event) => patch('capture', { ...draft.capture, geforceNowSourceName: event.target.value })} /></label></div>
              <label>ウィンドウ映像ソース<input value={draft.capture.windowSourceName ?? ''} onChange={(event) => patch('capture', { ...draft.capture, windowSourceName: event.target.value || undefined })} /></label>
              <div className="toggle-grid"><Toggle disabled={locked} checked={draft.capture.geforceNowEnabled} label="GeForce NOW対応" onChange={(value) => patch('capture', { ...draft.capture, geforceNowEnabled: value })} /><Toggle disabled={locked} checked={draft.capture.allowDisplayFallback} label="画面キャプチャへフォールバック" onChange={(value) => patch('capture', { ...draft.capture, allowDisplayFallback: value })} /></div>
            </fieldset>
          </AccordionSection>
          <AccordionSection title="YouTube" summary={`${draft.youtube.enabled ? '有効' : '無効'} ・ ${draft.youtube.privacy === 'public' ? '公開' : draft.youtube.privacy === 'unlisted' ? '限定公開' : '非公開'}`} open={openSections.has('youtube')} onToggle={() => toggleSection('youtube')}>
            <fieldset disabled={locked}><Toggle disabled={locked} checked={draft.youtube.enabled} label="このゲームで有効" onChange={(value) => patch('youtube', { ...draft.youtube, enabled: value })} /><label>タイトルテンプレート<input value={draft.youtube.titleTemplate} onChange={(event) => patch('youtube', { ...draft.youtube, titleTemplate: event.target.value })} /></label><label>説明文<textarea rows={3} value={draft.youtube.description} onChange={(event) => patch('youtube', { ...draft.youtube, description: event.target.value })} /></label><div className="field-grid"><label>公開範囲<select value={draft.youtube.privacy} onChange={(event) => patch('youtube', { ...draft.youtube, privacy: event.target.value as GameProfile['youtube']['privacy'] })}><option value="public">公開</option><option value="unlisted">限定公開</option><option value="private">非公開</option></select></label><label>カテゴリID<input value={draft.youtube.categoryId} onChange={(event) => patch('youtube', { ...draft.youtube, categoryId: event.target.value })} /></label></div></fieldset>
          </AccordionSection>
          <AccordionSection title="Twitch" summary={`${draft.twitch.enabled ? '有効' : '無効'} ・ ${draft.twitch.categoryName || 'カテゴリ未設定'}`} open={openSections.has('twitch')} onToggle={() => toggleSection('twitch')}>
            <fieldset disabled={locked}><Toggle disabled={locked} checked={draft.twitch.enabled} label="このゲームで有効" onChange={(value) => patch('twitch', { ...draft.twitch, enabled: value })} /><label>タイトルテンプレート<input value={draft.twitch.titleTemplate} onChange={(event) => patch('twitch', { ...draft.twitch, titleTemplate: event.target.value })} /></label><div className="field-grid"><label>カテゴリ<input value={draft.twitch.categoryName} onChange={(event) => patch('twitch', { ...draft.twitch, categoryName: event.target.value })} /></label><label>タグ（カンマ区切り）<input value={draft.twitch.tags.join(', ')} onChange={(event) => patch('twitch', { ...draft.twitch, tags: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) })} /></label></div></fieldset>
          </AccordionSection>
          <AccordionSection title="音声" summary={`ゲーム ${draft.audio.gameDb > 0 ? '+' : ''}${draft.audio.gameDb} dB`} open={openSections.has('audio')} onToggle={() => toggleSection('audio')}>
            <fieldset disabled={locked} className="field-grid"><RangeField disabled={locked} label="マイク" value={draft.audio.microphoneDb} onChange={(value) => patch('audio', { ...draft.audio, microphoneDb: value })} /><RangeField disabled={locked} label="ゲーム" value={draft.audio.gameDb} onChange={(value) => patch('audio', { ...draft.audio, gameDb: value })} /><RangeField disabled={locked} label="Discord" value={draft.audio.discordDb} onChange={(value) => patch('audio', { ...draft.audio, discordDb: value })} /><RangeField disabled={locked} label="BGM" value={draft.audio.bgmDb} onChange={(value) => patch('audio', { ...draft.audio, bgmDb: value })} /></fieldset>
          </AccordionSection>
          <AccordionSection title="録画" summary={`リプレイ ${draft.recording.replayBufferSeconds}秒`} open={openSections.has('recording')} onToggle={() => toggleSection('recording')}>
            <fieldset disabled={locked}><label>録画先<div className="folder-control"><span title={draft.recording.directory}>{draft.recording.directory || '未設定'}</span><button type="button" disabled={locked} onClick={() => void browseFolder()}>参照</button></div></label><label>リプレイ秒数<NumericInput disabled={locked} value={draft.recording.replayBufferSeconds} onValueChange={(value) => value !== undefined && patch('recording', { ...draft.recording, replayBufferSeconds: value })} /></label><div className="toggle-grid"><Toggle disabled={locked} checked={draft.recording.enabled} label="通常録画" onChange={(value) => patch('recording', { ...draft.recording, enabled: value })} /><Toggle disabled={locked} checked={draft.recording.sourceRecord} label="Source Record" onChange={(value) => patch('recording', { ...draft.recording, sourceRecord: value })} /><Toggle disabled={locked} checked={draft.recording.verticalRecording} label="Aitum Vertical" onChange={(value) => patch('recording', { ...draft.recording, verticalRecording: value })} /></div></fieldset>
          </AccordionSection>
          <section className="thumbnail-section">
            <div className="thumbnail-heading"><strong>YouTube用サムネイル</strong><span className={`thumbnail-status tone-${thumbnailTone(draft)}`}><StatusDot tone={thumbnailTone(draft)} />{thumbnailStatusLabel(draft)}</span></div>
            <div className="thumbnail-content">
              <div className="thumbnail-preview-frame">{draft.state.thumbnailFilename ? <img src={thumbnailUrl(draft)} alt={`${draft.displayName}の登録済みサムネイル`} /> : <div><ImageIcon size={21} /><span>未登録</span></div>}</div>
              <div className="thumbnail-options">
                {draft.state.thumbnailLastError && <div className="oauth-error">{draft.state.thumbnailLastError}</div>}
                <div className="button-row"><button className="secondary-button" disabled={locked} onClick={() => fileRef.current?.click()}>{draft.state.thumbnailFilename ? '差し替え' : '画像を登録'}</button>{draft.state.thumbnailFilename && <button className="ghost-button" disabled={locked} onClick={() => void removeThumbnail()}>削除</button>}</div>
                <input ref={fileRef} hidden disabled={locked} type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); event.currentTarget.value = '' }} />
                <Toggle disabled={locked} checked={draft.state.thumbnailAutoApply} label="ゲーム選択時に自動適用" onChange={(value) => patch('state', { ...draft.state, thumbnailAutoApply: value })} />
                <p>PNG / JPG / WEBP・最大4MB。初回登録後は毎回の選択は不要です。未登録でも配信は開始できます。</p>
              </div>
            </div>
          </section>
        </div>
        <footer className="modal-footer"><button className="primary-button" disabled={locked} onClick={() => void save()}>{saving ? <LoaderCircle className="spin" size={15} /> : null}保存</button><button className="danger-outline" disabled={locked} onClick={() => void execute(onDelete)}><Trash2 size={14} />削除</button><button className="ghost-button close-button" disabled={saving} onClick={onClose}>閉じる</button></footer>
      </section>
    </div>
  )
}

function AddGameModal({ initialGroup, template, onClose, onCreate }: { initialGroup: PlatformGroup; template: GameProfile; onClose: () => void; onCreate: (profile: GameProfile) => void }) {
  const [draft, setDraft] = useState<AddGameDraft>({ name: '', platformGroup: initialGroup, captureMethod: initialGroup === 'switch' ? 'elgato' : 'auto', steamAppId: '' })
  const modalRef = useRef<HTMLElement>(null)
  useEffect(() => { modalRef.current?.focus() }, [])
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey) }, [onClose])
  const create = () => {
    const name = draft.name.trim()
    if (!name) return
    const steamAppId = Number(draft.steamAppId)
    onCreate({
      ...structuredClone(template), id: `new_game_${crypto.randomUUID()}`, displayName: name, favorite: false, hidden: false,
      platformGroup: draft.platformGroup,
      library: { gamePass: false, exception: draft.platformGroup === 'exception', installed: false, ...(Number.isInteger(steamAppId) && steamAppId > 0 ? { steamAppId } : {}) },
      capture: { ...template.capture, preferred: draft.captureMethod },
      obs: { ...template.obs, sceneName: template.obs.sceneName },
      state: { lastUsedAt: null, thumbnailAutoApply: true, thumbnailApplyStatus: 'not_registered', thumbnailLastAppliedAt: null },
    })
  }
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section ref={modalRef} className="modal add-game-modal" role="dialog" aria-modal="true" aria-labelledby="add-game-title" tabIndex={-1}><header className="modal-header"><div className="empty-tile"><Plus size={15} /></div><h2 id="add-game-title">ゲームを追加</h2><button className="square-button" aria-label="閉じる" onClick={onClose}><X size={15} /></button></header><div className="add-game-body"><label>ゲーム名<input autoFocus value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例: Elden Ring" /></label><div className="field-grid"><label>分類<select value={draft.platformGroup} onChange={(event) => setDraft({ ...draft, platformGroup: event.target.value as PlatformGroup })}><option value="pc">PC</option><option value="switch">Switch</option><option value="exception">例外</option></select></label><label>ソース<select value={draft.captureMethod} onChange={(event) => setDraft({ ...draft, captureMethod: event.target.value as CaptureMethod })}>{Object.entries(captureLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div><label>Steam App ID（任意）<input inputMode="numeric" value={draft.steamAppId} onChange={(event) => setDraft({ ...draft, steamAppId: event.target.value })} placeholder="Steamのゲームのみ" /></label><p>追加後にゲーム設定が開き、キャプチャ方式・タイトル・サムネイルなどを編集できます。</p></div><footer className="modal-footer"><button className="primary-button" disabled={!draft.name.trim()} onClick={create}>追加して設定を開く</button><button className="ghost-button close-button" onClick={onClose}>キャンセル</button></footer></section></div>
}

function SettingsView({ config, status, oauthStatus, oauthProgress, onSave, onBackup, onRestore, onSteamSync, onOAuthConnect, onReconnect }: { config: AppConfig; status: RuntimeStatus; oauthStatus: OAuthConnectionStatuses; oauthProgress: OAuthProgress; onSave: (config: AppConfig, secrets: Record<string, string>) => Promise<void>; onBackup: () => Promise<void>; onRestore: (file: File) => Promise<void>; onSteamSync: () => Promise<void>; onOAuthConnect: (provider: OAuthProvider) => Promise<void>; onReconnect: () => Promise<void> }) {
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
    { key: 'youtube', label: 'YouTube', note: 'YouTubeへの外部配信を管理' }, { key: 'twitch', label: 'Twitch', note: 'Twitchへの外部配信を管理' },
    { key: 'recording', label: '通常録画', note: 'OBSの通常録画を連動' }, { key: 'replayBuffer', label: 'リプレイバッファ', note: 'クリップ保存を有効化' },
    { key: 'sourceRecord', label: 'Source Record', note: '素材録画を連動' }, { key: 'verticalRecording', label: 'Aitum Vertical', note: '縦型録画を連動' },
  ]
  return <main className="settings-view">
    {settingsError && <div className="inline-warning error" role="alert"><AlertTriangle size={14} /><span>{settingsError}</span></div>}
    <section className="settings-card obs-settings-card"><div className="card-title-row"><h2>OBS WebSocket</h2><span className={`connection-label ${status.obsConnected ? 'connected' : 'error'}`}><StatusDot tone={status.obsConnected ? 'live' : 'error'} />OBS{status.obsConnected ? '接続中' : '未接続'}</span></div><div className="connection-actions"><code>{draft.obs.url}</code><button className="secondary-button" disabled={saving} onClick={() => void attempt(onReconnect)}>再接続</button></div><details className="settings-details"><summary>接続詳細を編集</summary><div className="settings-details-body"><label>接続URL<input value={draft.obs.url} onChange={(event) => setDraft({ ...draft, obs: { ...draft.obs, url: event.target.value } })} /></label><label>パスワード<input type="password" autoComplete="off" placeholder={draft.obs.passwordStored ? '保存済み（変更時のみ入力）' : 'Windows資格情報へ保存'} value={secrets['obs-password'] ?? ''} onChange={(event) => secret('obs-password', event.target.value)} /></label><div className="field-grid"><label>開始待機（秒）<input type="number" value={draft.obs.startDelaySeconds} onChange={(event) => setDraft({ ...draft, obs: { ...draft.obs, startDelaySeconds: Number(event.target.value) } })} /></label><label>終了待機（秒）<input type="number" value={draft.obs.endDelaySeconds} onChange={(event) => setDraft({ ...draft, obs: { ...draft.obs, endDelaySeconds: Number(event.target.value) } })} /></label></div><button className="primary-button" disabled={saving} onClick={() => void save()}>接続設定を保存</button></div></details></section>
    <OAuthServiceCard status={oauthStatus.youtube} progress={oauthProgress.youtube} saving={saving} onConnect={() => void attempt(() => onOAuthConnect('youtube'))} />
    <OAuthServiceCard status={oauthStatus.twitch} progress={oauthProgress.twitch} saving={saving} onConnect={() => void attempt(() => onOAuthConnect('twitch'))} />
    <section className="settings-card"><h2>機能</h2><div className="feature-list">{featureRows.map((feature) => <div className="feature-row" key={feature.key}><div><strong>{feature.label}</strong><span>{feature.note}</span></div><Toggle disabled={saving || status.streaming} checked={draft.features[feature.key]} label={draft.features[feature.key] ? '有効' : '無効'} onChange={(value) => updateFeature(feature.key, value)} /></div>)}</div></section>
    <section className="settings-card"><h2>OBS音声ソース名</h2><div className="source-chips">{Object.values(draft.sources).map((source) => <code key={source}>{source}</code>)}</div><details className="settings-details"><summary>ソース名を編集</summary><div className="settings-details-body field-grid">{Object.entries(draft.sources).map(([key, value]) => <label key={key}>{key}<input value={value} onChange={(event) => setDraft({ ...draft, sources: { ...draft.sources, [key]: event.target.value } })} /></label>)}<button className="primary-button" disabled={saving} onClick={() => void save()}>ソース名を保存</button></div></details></section>
    <section className="settings-card"><h2>Steam</h2><p>所有ゲームとローカル導入状態をApp IDで統合します。</p><label>SteamID64<input value={draft.steam.steamId64} onChange={(event) => setDraft({ ...draft, steam: { ...draft.steam, steamId64: event.target.value } })} /></label><label>Steam Web API Key<input type="password" autoComplete="off" value={secrets['steam-api-key'] ?? ''} onChange={(event) => secret('steam-api-key', event.target.value)} placeholder={draft.steam.apiKeyStored ? '保存済み（変更時のみ入力）' : 'Windows資格情報へ保存'} /></label><label>Steamインストール先<input value={draft.steam.installPath} onChange={(event) => setDraft({ ...draft, steam: { ...draft.steam, installPath: event.target.value } })} /></label><button className="secondary-button" disabled={saving || status.streaming} onClick={() => void attempt(async () => { await onSave(draft, secrets); setSecrets({}); await onSteamSync() })}><RefreshCw size={14} />保存してライブラリ同期</button></section>
    <section className="settings-card"><h2>バックアップ / 復元</h2><p>アプリ設定・ゲームプロファイル・サムネイルを書き出します。OBS本体の設定と、OAuthトークンなどの秘密情報は含まれません。</p><div className="button-row"><button className="secondary-button" disabled={saving} onClick={() => void attempt(onBackup)}><ArrowDownToLine size={14} />書き出し</button><label className="ghost-button file-button"><Upload size={14} />復元<input hidden type="file" accept="application/json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void attempt(() => onRestore(file)); event.currentTarget.value = '' }} /></label></div></section>
  </main>
}

function ControlPanel({ status, selected, busy, onStart, onStop, onReplay, onEdit }: { status: RuntimeStatus; selected: GameProfile | null; busy: boolean; onStart: () => void; onStop: () => void; onReplay: () => void; onEdit: () => void }) {
  const externalActive = status.platforms.youtube.state === 'live' || status.platforms.twitch.state === 'live' || status.platforms.youtube.state === 'stopping' || status.platforms.twitch.state === 'stopping'
  const showStop = status.streaming || externalActive
  const restartDetected = status.streaming && !selected
  const disabled = busy || status.busy || !status.obsConnected || !selected
  const reason = !status.obsConnected ? 'OBSへ接続すると配信を開始できます' : !selected ? '配信前にゲームを選択してください' : status.busy || busy ? '処理が完了するまでお待ちください' : null
  return <aside className="control-panel" aria-label="配信操作">
    {restartDetected && <div className="control-warning"><AlertTriangle size={14} /><span>アプリ再起動後の配信を検出しました。現在の配信を安全に終了できます。</span></div>}
    <div className="selection-summary">{selected ? <><div className="game-tile small" style={tileStyle(selected)}>{profileInitial(selected)}</div><div><strong>{selected.displayName}</strong><span>{status.captureMethod ? captureLabels[status.captureMethod] : '未判定'} ・ {thumbnailStatusLabel(selected)}</span></div>{status.selectedGameId === selected.id && <b><Check size={12} />適用済み</b>}</> : <><div className="empty-tile"><Plus size={15} /></div><div><strong className="muted">ゲームを選択</strong><span>配信前にプロファイル適用が必要です</span></div></>}</div>
    {!restartDetected && selected && !selected.state.thumbnailFilename && !showStop && <button className="thumbnail-register-link" onClick={onEdit}><ImageIcon size={14} />初回サムネイルを登録</button>}
    {status.warning && <div className="control-warning"><AlertTriangle size={14} /><span>{status.warning}</span></div>}
    <div className="control-actions">{showStop ? <button className="stop-button" disabled={busy || status.busy} onClick={onStop}>{busy ? <LoaderCircle className="spin" size={15} /> : <CircleStop size={15} />}配信終了</button> : <button className="start-button" disabled={disabled} onClick={onStart}>{busy ? <LoaderCircle className="spin" size={15} /> : <Play size={15} fill="currentColor" />}配信開始</button>}<button className="clip-button" disabled={!status.replayBuffer || busy} onClick={onReplay}><ArrowDownToLine size={14} />クリップ保存</button></div>
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
  const [toast, setToast] = useState<Toast | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionBusy, setActionBusy] = useState(false)
  const [comments, setComments] = useState<ChatMessage[]>([])
  const actionLock = useRef(false)
  const oauthPopup = useRef<Window | null>(null)
  const oauthStatusRequest = useRef(0)
  const previousOAuthStatus = useRef<OAuthConnectionStatuses | null>(null)

  const loadOAuthStatus = useCallback(async (): Promise<OAuthConnectionStatuses | null> => {
    const requestId = ++oauthStatusRequest.current
    const connections = await api.oauthStatus()
    if (requestId !== oauthStatusRequest.current) return null
    const completedProviders = completedOAuthProviders(previousOAuthStatus.current, connections)
    previousOAuthStatus.current = connections
    setOAuthStatus(connections)
    if (completedProviders.length) {
      setOAuthProgress((current) => Object.fromEntries([...Object.entries(current), ...completedProviders.map((provider) => [provider, connections[provider].detail])]))
      setToast({ kind: 'success', text: `${completedProviders.map((provider) => provider === 'youtube' ? 'YouTube' : 'Twitch').join('・')} 接続が完了しました` })
    }
    return connections
  }, [])

  const refresh = async () => { const [data] = await Promise.all([api.bootstrap(), loadOAuthStatus()]); setProfiles(data.profiles); setConfig(data.config); setStatus(data.status); setLoading(false) }
  const refreshOAuth = async () => { const connections = await loadOAuthStatus(); if (!connections) return; setOAuthProgress((current) => ({ youtube: connections.youtube.authorizationInProgress ? current.youtube : undefined, twitch: connections.twitch.authorizationInProgress ? current.twitch : undefined })) }
  const oauthPollingInterval = oauthRefreshInterval(oauthStatus)
  useEffect(() => { void api.bootstrap().then((data) => { setProfiles(data.profiles); setConfig(data.config); setStatus(data.status); setLoading(false); void loadOAuthStatus().catch((error: Error) => setToast({ kind: 'error', text: `OAuth接続状態を取得できません: ${error.message}` })) }).catch((error: Error) => { setToast({ kind: 'error', text: error.message }); setLoading(false) }) }, [loadOAuthStatus])
  useEffect(() => { const timer = window.setInterval(() => void api.status().then(setStatus).catch(() => undefined), 2_000); return () => window.clearInterval(timer) }, [])
  useEffect(() => { const load = () => void loadOAuthStatus().catch(() => undefined); const visible = () => { if (document.visibilityState === 'visible') load() }; window.addEventListener('focus', load); document.addEventListener('visibilitychange', visible); return () => { window.removeEventListener('focus', load); document.removeEventListener('visibilitychange', visible) } }, [loadOAuthStatus])
  useEffect(() => { const timer = window.setInterval(() => void loadOAuthStatus().catch(() => undefined), oauthPollingInterval); return () => window.clearInterval(timer) }, [loadOAuthStatus, oauthPollingInterval])
  useEffect(() => { if (!status?.streaming) return; const load = () => void api.comments().then(setComments).catch(() => undefined); load(); const timer = window.setInterval(load, 3_000); return () => window.clearInterval(timer) }, [status?.streaming])
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
  const template = profiles.find((profile) => profile.platformGroup === (tab === 'settings' ? 'pc' : tab)) ?? profiles[0]

  const run = async (operation: () => Promise<void>) => { if (actionLock.current) return; actionLock.current = true; setActionBusy(true); try { await operation() } catch (error) { setToast({ kind: 'error', text: error instanceof Error ? error.message : String(error) }) } finally { const latest = await api.status().catch(() => null); if (latest) setStatus(latest); actionLock.current = false; setActionBusy(false) } }
  const selectGame = (profile: GameProfile, method?: CaptureMethod) => {
    if (activeOperation) { setToast({ kind: 'warning', text: '配信中はゲームを切り替えられません' }); return }
    void run(async () => { const result = await api.select(profile.id, method); setProfiles((current) => current.map((item) => item.id === profile.id ? result.profile : item)); setToast({ kind: result.warnings.length ? 'warning' : 'success', text: result.warnings[0] ?? `${profile.displayName}を適用しました` }) })
  }
  const toggleFavorite = (profile: GameProfile) => {
    if (activeOperation) { setToast({ kind: 'warning', text: '配信中はゲーム設定を変更できません' }); return }
    void run(async () => { const saved = await api.saveProfile({ ...profile, favorite: !profile.favorite }); setProfiles((current) => current.map((item) => item.id === saved.id ? saved : item)); setToast({ kind: 'success', text: saved.favorite ? 'お気に入りに追加しました' : 'お気に入りから外しました' }) })
  }
  const start = () => void run(async () => {
    let result: Awaited<ReturnType<typeof api.start>>
    try { result = await api.start() } catch (error) { const message = error instanceof Error ? error.message : String(error); if (message.includes('配信サービスの設定に失敗')) { if (!window.confirm(`${message}\n\n利用できる配信先だけで続行しますか？`)) throw error; result = await api.start(true) } else throw error }
    setToast({ kind: result.warnings.length ? 'warning' : 'success', text: result.warnings[0] ?? '配信と録画を開始しました' })
  })
  const stop = () => void run(async () => { const result = await api.stop(); setToast({ kind: result.warnings.length ? 'warning' : 'success', text: result.warnings[0] ?? '配信を終了しました' }) })
  const replay = () => void run(async () => { await api.replay(); setToast({ kind: 'success', text: 'クリップを保存しました' }) })

  const connectOAuth = async (provider: OAuthProvider) => {
    const configured = Boolean(oauthStatus?.[provider].appConfigured)
    if (!configured) throw new Error(`${provider === 'youtube' ? 'YouTube' : 'Twitch'}接続機能が配布パッケージに含まれていません。利用者による開発者登録は不要です`)
    if (oauthPopup.current && !oauthPopup.current.closed) { oauthPopup.current.focus(); throw new Error('認証ウィンドウで接続を完了してください') }
    const popup = window.open('about:blank', `${provider}-oauth`, 'width=560,height=720')
    if (!popup) throw new Error('認証ウィンドウを開けませんでした。ポップアップを許可してください')
    oauthPopup.current = popup; setOAuthProgress((current) => ({ ...current, [provider]: `${provider === 'youtube' ? 'Google' : 'Twitch'}認証を開始しています` }))
    try {
      const started = await api.oauthStart(provider, window.location.origin); await loadOAuthStatus(); popup.location.href = started.url
      if (started.mode === 'redirect') { setOAuthProgress((current) => ({ ...current, [provider]: 'Googleのアカウント選択と権限承認を待っています' })); return }
      setOAuthProgress((current) => ({ ...current, [provider]: `Twitchの承認待ちです。確認コード: ${started.userCode}` })); setToast({ kind: 'warning', text: `Twitch 認証コード: ${started.userCode}（画面で求められた場合）` })
      while (Date.now() < started.expiresAt) { await new Promise((resolve) => window.setTimeout(resolve, started.intervalMs)); if (popup.closed) throw new Error('認証ウィンドウが閉じられました'); const result = await api.oauthPollTwitch(started.requestId); if (result.status === 'complete') { popup.close(); oauthPopup.current = null; await refresh(); setOAuthProgress((current) => ({ ...current, [provider]: 'Twitch認証と配信者情報の取得が完了しました' })); return } }
      throw new Error('Twitch 認証の有効期限が切れました')
    } catch (error) { if (!popup.closed) popup.close(); if (oauthPopup.current === popup) oauthPopup.current = null; const reason = error instanceof Error ? error.message : String(error); setOAuthProgress((current) => ({ ...current, [provider]: `接続に失敗しました: ${reason}` })); await loadOAuthStatus().catch(() => undefined); throw error }
  }

  const uploadThumbnail = async (profile: GameProfile, file: File) => {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('PNG、JPG、WEBPを選択してください')
    if (file.size > 4 * 1024 * 1024) throw new Error('サムネイルは4MB以下にしてください')
    const persisted = await api.saveProfile(profile); setProfiles((current) => [...current.filter((item) => item.id !== persisted.id), persisted])
    let saved: GameProfile
    try { const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => { const encoded = String(reader.result).split(',')[1]; if (encoded) resolve(encoded); else reject(new Error('サムネイルの読み込みに失敗しました')) }; reader.onerror = () => reject(new Error('サムネイルの読み込みに失敗しました')); reader.readAsDataURL(file) }); saved = await api.uploadThumbnail(persisted.id, file.type, data, file.name) } catch (error) { throw new Error(`設定は保存されましたが、サムネイルの更新に失敗しました: ${error instanceof Error ? error.message : String(error)}`) }
    setProfiles((current) => [...current.filter((item) => item.id !== saved.id), saved]); setEditing(saved); const latest = await api.status().catch(() => null); if (latest) setStatus(latest); setToast({ kind: 'success', text: '設定とサムネイルを保存しました。以後は自動で使い回します' })
  }
  const deleteThumbnail = async (draft: GameProfile) => { if (!window.confirm('登録済みサムネイルを削除しますか？')) return; const persisted = await api.saveProfile(draft); let saved: GameProfile; try { saved = await api.deleteThumbnail(persisted.id) } catch (error) { throw new Error(`設定は保存されましたが、サムネイルの削除に失敗しました: ${error instanceof Error ? error.message : String(error)}`) }; setProfiles((current) => [...current.filter((item) => item.id !== saved.id), saved]); setEditing(saved); const latest = await api.status().catch(() => null); if (latest) setStatus(latest); setToast({ kind: 'success', text: '設定を維持したままサムネイルを削除しました' }) }

  if (loading || !config || !status) return <div className="loading-screen"><LoaderCircle className="spin" /><span>ストリーム環境を読み込み中</span></div>

  return <div className="app-frame"><div className="app-shell">
    <header className="app-header"><div className="brand"><div className="brand-mark"><BrandGlyph /></div><strong>STREAM MANAGER</strong></div><div className={`header-status ${status.obsConnected ? 'connected' : 'error'}`}><StatusDot tone={status.obsConnected ? 'live' : 'error'} /><span>OBS{status.obsConnected ? '接続中' : '未接続'}</span></div></header>
    <nav className="tabs">{groups.map(({ id, label }) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>)}</nav>
    <RuntimeStatusBar status={status} />
    {tab === 'settings' ? (oauthStatus ? <SettingsView key={JSON.stringify(config)} config={config} status={status} oauthStatus={oauthStatus} oauthProgress={oauthProgress} onOAuthConnect={connectOAuth} onReconnect={async () => { await refresh(); setToast({ kind: 'success', text: 'OBS接続状態を再確認しました' }) }} onSave={async (next, secrets) => { const saved = await api.saveConfig(next, secrets); setConfig(saved); await loadOAuthStatus(); setToast({ kind: 'success', text: '設定を保存しました' }) }} onBackup={async () => { const backup = await api.backup(); const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `obs-stream-manager-${new Date().toISOString().slice(0, 10)}.json`; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 10_000) }} onRestore={async (file) => { await api.restore(JSON.parse(await file.text())); await refresh(); setToast({ kind: 'success', text: 'バックアップを復元しました' }) }} onSteamSync={async () => { const result = await api.steamSync(); setProfiles(result.profiles); setToast({ kind: result.warnings.length ? 'warning' : 'success', text: `Steam同期: 新規${result.created}件・更新${result.updated}件${result.warnings[0] ? ` / ${result.warnings[0]}` : ''}` }) }} /> : <main className="settings-view"><div className="inline-warning error"><AlertTriangle size={14} /><span>OAuth接続状態を取得できません。OBS操作は利用できます。</span></div><button className="secondary-button" onClick={() => void refreshOAuth()}><RefreshCw size={14} />状態を再確認</button></main>) : <main className="library-view">
      <div className="search-row"><label className="search-box"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="ゲームを検索" />{search && <button aria-label="検索をクリア" onClick={() => setSearch('')}><X size={14} /></button>}</label><button className="add-button" disabled={activeOperation || !template} onClick={() => setAdding(true)}><Plus size={14} />追加</button></div>
      {tab === 'switch' && <p className="tab-note">Switchはゲーム名を自動判定しません。配信するゲームを手動で選択してください。</p>}{tab === 'exception' && <p className="tab-note">通常のライブラリ連携が難しいゲームを扱います。</p>}
      {filtered.some((profile) => profile.favorite) && !search && <section className="library-section favorites"><h2>お気に入り</h2><div className="favorite-list">{filtered.filter((profile) => profile.favorite).map((profile) => <button key={profile.id} className={selected?.id === profile.id ? 'selected' : ''} disabled={actionBusy} onClick={() => selectGame(profile)}><span className="favorite-tile" style={tileStyle(profile)}>{profileInitial(profile)}</span><strong>{profile.displayName}</strong></button>)}</div></section>}
      <section className="library-section"><div className="section-title"><h2>{platformTitles[tab]}</h2><span>{filtered.length}件</span></div><div className="game-list">{filtered.map((profile) => <GameCard key={profile.id} profile={profile} selected={selected?.id === profile.id} busy={actionBusy} onSelect={() => selectGame(profile)} onEdit={() => setEditing(profile)} onFavorite={() => toggleFavorite(profile)} />)}{filtered.length === 0 && <div className="empty"><Gamepad2 size={24} /><strong>ゲームがありません</strong><button onClick={() => setAdding(true)}>ゲームを追加</button></div>}</div></section>
      <section className="comments-section"><div className="section-title"><h2>統合コメント</h2><span className={status.streaming ? 'active-text' : ''}>{status.streaming ? '配信中・自動更新' : '配信開始後に表示されます'}</span></div>{status.streaming && comments.length ? <div className="comment-list">{comments.slice(-30).map((comment) => <div className={`comment-row ${comment.mention ? 'mention' : ''}`} key={comment.id}><ServiceIcon service={comment.service} /><div><div><strong>{comment.author}</strong>{comment.moderator && <b>MOD</b>}<time>{new Date(comment.publishedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}</time></div><p>{comment.body}</p></div></div>)}</div> : <div className="comment-empty"><MessageSquareText size={20} /><span>YouTube / Twitch の実際のコメントをここに表示します</span></div>}</section>
    </main>}
    <ControlPanel status={status} selected={selected} busy={actionBusy} onStart={start} onStop={stop} onReplay={replay} onEdit={() => selected && setEditing(selected)} />
    {editing && <ProfileEditor key={`${editing.id}:${editing.platformGroup}:${editing.state.thumbnailFilename ?? ''}:${editing.state.thumbnailUpdatedAt ?? ''}`} profile={editing} readOnly={activeOperation} onClose={() => setEditing(null)} onSave={async (profile) => { const wasSelected = status.selectedGameId === profile.id; const saved = await api.saveProfile(profile); setProfiles((current) => [...current.filter((item) => item.id !== saved.id), saved]); setStatus(await api.status()); setToast({ kind: 'success', text: wasSelected ? 'ゲーム設定を保存しました。配信前にゲームを選び直してください' : 'ゲーム設定を保存しました' }) }} onDelete={async () => { if (!window.confirm(`${editing.displayName}を削除しますか？`)) return; await api.deleteProfile(editing.id); setProfiles((current) => current.filter((item) => item.id !== editing.id)); setEditing(null) }} onThumbnail={(file, draft) => uploadThumbnail(draft, file)} onDeleteThumbnail={deleteThumbnail} />}
    {adding && template && <AddGameModal initialGroup={tab === 'settings' ? 'pc' : tab} template={template} onClose={() => setAdding(false)} onCreate={(profile) => { setAdding(false); setEditing(profile) }} />}
    <div className="toast-stack" aria-live="polite">{toast && <div className={`toast ${toast.kind}`}><StatusDot tone={toast.kind === 'success' ? 'live' : toast.kind === 'error' ? 'error' : 'pending'} /><span>{toast.text}</span><button aria-label="通知を閉じる" onClick={() => setToast(null)}><X size={14} /></button></div>}</div>
  </div></div>
}
