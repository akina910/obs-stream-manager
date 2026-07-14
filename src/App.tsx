import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle, ArrowDownToLine, Check, ChevronRight, CircleStop, Clapperboard, Gamepad2,
  Heart, ImagePlus, Library, LoaderCircle, MessageSquareText, MonitorUp, Play, Plus, Radio,
  RefreshCw, Save, Search, Settings, SlidersHorizontal, Sparkles, Star, Trash2, Upload, X, Zap,
} from 'lucide-react'
import type { AppConfig, CaptureMethod, ChatMessage, GameProfile, PlatformGroup, RuntimeStatus } from '../shared/contracts'
import { api, type OAuthConnectionStatus, type OAuthConnectionStatuses, type OAuthProvider } from './api'
import { completedOAuthProviders, oauthRefreshInterval } from './oauth-refresh'
import { getBroadcastStatus, getExternalDeliveryWarning, getRuntimeOutputs } from './runtime-status'

type Tab = PlatformGroup | 'settings'
type Toast = { kind: 'success' | 'error' | 'warning'; text: string }
type OAuthProgress = Partial<Record<OAuthProvider, string>>

const groups: Array<{ id: Tab; label: string; icon: typeof Library }> = [
  { id: 'pc', label: 'PC', icon: Library },
  { id: 'switch', label: 'Switch', icon: Gamepad2 },
  { id: 'exception', label: '例外', icon: Zap },
  { id: 'settings', label: '設定', icon: Settings },
]

const captureLabels: Record<CaptureMethod, string> = {
  auto: '自動判定', local: 'ローカル', geforce_now: 'GeForce NOW', window: 'ウィンドウ', display: '画面', elgato: 'Elgato',
}

function StatusDot({ active }: { active: boolean }) {
  return <span className={`status-dot ${active ? 'active' : ''}`} />
}

function RuntimeStatusBar({ status }: { status: RuntimeStatus }) {
  const broadcast = getBroadcastStatus(status)
  const outputs = getRuntimeOutputs(status)
  const deliveryWarning = getExternalDeliveryWarning(status)

  return (
    <section className="runtime-status" aria-label="現在の配信状態">
      <div className={`broadcast-status ${broadcast.tone}`}>
        <span className="broadcast-icon" aria-hidden="true"><Radio size={17} /></span>
        <span className="broadcast-copy" role="status" aria-live="polite" aria-atomic="true"><strong>{broadcast.label}</strong><small>{broadcast.detail}</small></span>
      </div>
      <div className="runtime-output-list">
        {outputs.map((output) => (
          <span className={`runtime-output ${output.tone}`} key={output.key} aria-label={`${output.label}: ${output.state}`} title={output.detail}>
            <StatusDot active={output.active} />
            <span><strong>{output.label}</strong><small>{output.state}</small></span>
          </span>
        ))}
        <span className={`runtime-output scene ${status.obsConnected && status.currentScene ? 'active' : ''}`} aria-label={`現在のシーン: ${status.currentScene ?? '不明'}`}>
          <span><strong>シーン</strong><small>{status.currentScene ?? '不明'}</small></span>
        </span>
      </div>
      {deliveryWarning && <div className="runtime-status-warning" role="alert"><AlertTriangle size={13} /><span>{deliveryWarning}</span></div>}
    </section>
  )
}

const oauthStageLabels: Record<OAuthConnectionStatus['stage'], string> = {
  setup_required: '配布設定エラー',
  ready: '認証開始できます',
  authorizing: '認証待ち',
  partial: '一部のみ完了',
  connected: '接続済み',
}

function OAuthServiceCard({ status, progress, saving, onConnect }: { status: OAuthConnectionStatus; progress?: string; saving: boolean; onConnect: () => void }) {
  const isYoutube = status.provider === 'youtube'
  const serviceName = isYoutube ? 'YouTube' : 'Twitch'
  const steps = isYoutube
    ? [
        { label: 'アプリ内OAuth', detail: status.appConfigured ? '利用可能' : '配布に未搭載', complete: status.appConfigured },
        { label: 'Googleアカウント認証', detail: status.refreshTokenStored ? '完了' : status.authorizationInProgress ? '承認待ち' : '未完了', complete: status.refreshTokenStored },
        { label: '更新トークン', detail: status.refreshTokenStored ? 'Windowsへ保存済み' : '未保存', complete: status.refreshTokenStored },
      ]
    : [
        { label: 'アプリ内OAuth', detail: status.appConfigured ? '利用可能' : '配布に未搭載', complete: status.appConfigured },
        { label: 'Twitchアカウント認証', detail: status.accessTokenStored && status.refreshTokenStored ? '完了' : status.authorizationInProgress ? '承認待ち' : '未完了', complete: status.accessTokenStored && status.refreshTokenStored },
        { label: '配信者情報', detail: status.accountLinked ? '取得済み' : '未取得', complete: status.accountLinked },
      ]
  const buttonLabel = !status.appConfigured
    ? '接続機能を準備中'
    : status.stage === 'connected'
      ? `${serviceName}で再接続`
      : `${serviceName}で接続`

  return (
    <article className={`oauth-service oauth-${status.stage}`} data-testid={`oauth-${status.provider}`}>
      <div className="oauth-service-heading">
        <strong><StatusDot active={status.stage === 'connected'} />{serviceName}</strong>
        <span className={`oauth-stage oauth-stage-${status.stage}`}>{oauthStageLabels[status.stage]}</span>
      </div>
      <ol className="oauth-steps" aria-label={`${serviceName} 接続状況`}>
        {steps.map((step, index) => {
          const waiting = status.authorizationInProgress && index === 1
          return <li key={step.label} className={step.complete ? 'complete' : waiting ? 'current' : 'pending'} aria-current={waiting ? 'step' : undefined}><span className="oauth-step-marker">{step.complete ? <Check size={12} /> : waiting ? <LoaderCircle className="spin" size={12} /> : index + 1}</span><span>{step.label}<small>{step.detail}</small></span></li>
        })}
      </ol>
      <p className="oauth-detail" role="status">{progress ?? status.detail}</p>
      <button className="secondary" disabled={saving || !status.appConfigured} onClick={onConnect}>{buttonLabel}</button>
    </article>
  )
}

type NumericInputProps = { value: number | undefined; allowEmpty?: boolean; onValueChange: (value: number | undefined) => void }

function NumericInput(props: NumericInputProps) {
  return <NumericInputEditor key={props.value === undefined ? 'empty' : String(props.value)} {...props} />
}

function NumericInputEditor({ value, allowEmpty = false, onValueChange }: NumericInputProps) {
  const [text, setText] = useState(value === undefined ? '' : String(value))
  const commit = () => {
    if (allowEmpty && text.trim() === '') { onValueChange(undefined); return }
    const parsed = Number(text)
    if (Number.isFinite(parsed)) onValueChange(parsed)
    else setText(value === undefined ? '' : String(value))
  }
  return <input type="number" step="any" value={text} onChange={(event) => setText(event.target.value)} onBlur={commit} />
}

function thumbnailStatusLabel(profile: GameProfile): string {
  if (!profile.state.thumbnailFilename) return 'サムネ未登録'
  if (!profile.state.thumbnailAutoApply) return 'サムネ自動適用OFF'
  if (profile.state.thumbnailApplyStatus === 'applied') return 'サムネ自動適用済み'
  if (profile.state.thumbnailApplyStatus === 'failed') return 'サムネ適用失敗'
  return 'サムネ登録済み'
}

function thumbnailUrl(profile: GameProfile): string {
  const version = profile.state.thumbnailUpdatedAt ?? profile.state.thumbnailFilename ?? ''
  return `/api/profiles/${encodeURIComponent(profile.id)}/thumbnail?v=${encodeURIComponent(version)}`
}

function GameCard({ profile, selected, busy, onSelect, onEdit }: { profile: GameProfile; selected: boolean; busy: boolean; onSelect: () => void; onEdit: () => void }) {
  const initials = profile.displayName.replace(/[^A-Za-z0-9\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu, '').slice(0, 2).toUpperCase()
  return (
    <article className={`game-card ${selected ? 'selected' : ''}`}>
      <button className="game-main" onClick={onSelect} disabled={busy}>
        <div className="cover">
          {profile.state.thumbnailFilename ? <img src={thumbnailUrl(profile)} alt="" /> : profile.coverUrl ? <img src={profile.coverUrl} alt="" referrerPolicy="no-referrer" /> : <span>{initials || 'G'}</span>}
          {profile.favorite && <Star className="favorite-badge" size={13} fill="currentColor" />}
        </div>
        <div className="game-copy">
          <strong>{profile.displayName}</strong>
          <span>{captureLabels[profile.capture.preferred]} · {thumbnailStatusLabel(profile)}</span>
        </div>
        {selected ? <Check className="selected-check" size={18} /> : <ChevronRight size={17} />}
      </button>
      <button className="detail-button" onClick={onEdit} aria-label={`${profile.displayName}の設定`}><SlidersHorizontal size={15} /></button>
    </article>
  )
}

function ProfileEditor({ profile, onClose, onSave, onDelete, onThumbnail, onDeleteThumbnail }: { profile: GameProfile; onClose: () => void; onSave: (profile: GameProfile) => Promise<void>; onDelete: () => Promise<void>; onThumbnail: (file: File, draft: GameProfile) => Promise<void>; onDeleteThumbnail: (draft: GameProfile) => Promise<void> }) {
  const [draft, setDraft] = useState(profile)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const savingRef = useRef(false)
  const modalRef = useRef<HTMLElement>(null)
  const lastFocusedRef = useRef<HTMLElement | null>(null)
  useEffect(() => { modalRef.current?.focus() }, [])
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !savingRef.current) onClose() }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])
  const patch = <K extends keyof GameProfile>(key: K, value: GameProfile[K]) => setDraft((current) => ({ ...current, [key]: value }))
  const execute = async (operation: () => Promise<void>) => {
    if (savingRef.current) return
    savingRef.current = true
    lastFocusedRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setSaving(true); setSaveError(null)
    try { await operation() }
    catch (error) { setSaveError(error instanceof Error ? error.message : String(error)) }
    finally {
      savingRef.current = false; setSaving(false)
      window.requestAnimationFrame(() => {
        if (lastFocusedRef.current?.isConnected) lastFocusedRef.current.focus()
        else modalRef.current?.focus()
      })
    }
  }
  const save = () => execute(async () => { await onSave(draft); onClose() })
  const remove = () => execute(onDelete)
  const upload = (file: File) => execute(() => onThumbnail(file, draft))
  const removeThumbnail = () => execute(() => onDeleteThumbnail(draft))
  return (
    <div className="modal-backdrop" onMouseDown={(event) => !savingRef.current && event.target === event.currentTarget && onClose()}>
      <section ref={modalRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="profile-editor-title" aria-busy={saving} tabIndex={-1}>
        <header><div><span className="eyebrow">GAME PROFILE</span><h2 id="profile-editor-title">{profile.displayName}</h2></div><button className="icon-button" aria-label="ゲーム設定を閉じる" disabled={saving} onClick={onClose}><X size={18} /></button></header>
        <fieldset className="modal-body" disabled={saving}>
          <span className="sr-only" role="status" aria-live="polite">{saving ? '設定を保存中です' : ''}</span>
          {saveError && <div className="inline-warning" role="alert"><AlertTriangle size={14} /><span>{saveError}</span></div>}
          <label>表示名<input value={draft.displayName} onChange={(event) => patch('displayName', event.target.value)} /></label>
          <div className="field-row">
            <label>分類<select value={draft.platformGroup} onChange={(event) => patch('platformGroup', event.target.value as PlatformGroup)}><option value="pc">PC</option><option value="switch">Switch</option><option value="exception">例外</option></select></label>
            <label>優先キャプチャ<select value={draft.capture.preferred} onChange={(event) => patch('capture', { ...draft.capture, preferred: event.target.value as CaptureMethod })}>{Object.entries(captureLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          </div>
          <label>実行ファイル名（カンマ区切り）<input value={draft.capture.executableNames.join(', ')} onChange={(event) => patch('capture', { ...draft.capture, executableNames: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) })} /></label>
          <div className="field-row"><label>Steam App ID<NumericInput allowEmpty value={draft.library.steamAppId} onValueChange={(value) => patch('library', { ...draft.library, steamAppId: value })} /></label><label>インストール先<input value={draft.library.installDirectory ?? ''} onChange={(event) => patch('library', { ...draft.library, installDirectory: event.target.value || undefined, installed: Boolean(event.target.value) })} /></label></div>
          <div className="profile-flags"><label className="check-row"><input type="checkbox" checked={draft.library.gamePass} onChange={(event) => patch('library', { ...draft.library, gamePass: event.target.checked })} />Game Pass / Xbox</label><label className="check-row"><input type="checkbox" checked={draft.library.installed} onChange={(event) => patch('library', { ...draft.library, installed: event.target.checked })} />ローカル導入済み</label><label className="check-row"><input type="checkbox" checked={draft.hidden} onChange={(event) => patch('hidden', event.target.checked)} />一覧から非表示</label></div>
          <div className="field-row"><label>OBSシーン<input value={draft.obs.sceneName} onChange={(event) => patch('obs', { ...draft.obs, sceneName: event.target.value })} /></label><label>ローカル映像ソース<input value={draft.capture.localSourceName} onChange={(event) => patch('capture', { ...draft.capture, localSourceName: event.target.value })} /></label></div>
          <div className="field-row"><label>GFN映像ソース<input value={draft.capture.geforceNowSourceName} onChange={(event) => patch('capture', { ...draft.capture, geforceNowSourceName: event.target.value })} /></label><label>ウィンドウ映像ソース<input value={draft.capture.windowSourceName ?? ''} onChange={(event) => patch('capture', { ...draft.capture, windowSourceName: event.target.value || undefined })} /></label></div>
          <div className="profile-flags"><label className="check-row"><input type="checkbox" checked={draft.capture.geforceNowEnabled} onChange={(event) => patch('capture', { ...draft.capture, geforceNowEnabled: event.target.checked })} />GeForce NOW対応</label><label className="check-row"><input type="checkbox" checked={draft.capture.allowDisplayFallback} onChange={(event) => patch('capture', { ...draft.capture, allowDisplayFallback: event.target.checked })} />画面キャプチャへのフォールバックを許可</label></div>
          <div className="form-section"><h3>YouTube</h3><label className="check-row"><input type="checkbox" checked={draft.youtube.enabled} onChange={(event) => patch('youtube', { ...draft.youtube, enabled: event.target.checked })} />このゲームで有効</label><label>タイトルテンプレート<input value={draft.youtube.titleTemplate} onChange={(event) => patch('youtube', { ...draft.youtube, titleTemplate: event.target.value })} /></label><label>説明文<textarea rows={3} value={draft.youtube.description} onChange={(event) => patch('youtube', { ...draft.youtube, description: event.target.value })} /></label><div className="field-row"><label>公開範囲<select value={draft.youtube.privacy} onChange={(event) => patch('youtube', { ...draft.youtube, privacy: event.target.value as GameProfile['youtube']['privacy'] })}><option value="public">公開</option><option value="unlisted">限定公開</option><option value="private">非公開</option></select></label><label>カテゴリID<input value={draft.youtube.categoryId} onChange={(event) => patch('youtube', { ...draft.youtube, categoryId: event.target.value })} /></label></div></div>
          <div className="form-section"><h3>Twitch</h3><label className="check-row"><input type="checkbox" checked={draft.twitch.enabled} onChange={(event) => patch('twitch', { ...draft.twitch, enabled: event.target.checked })} />このゲームで有効</label><label>タイトルテンプレート<input value={draft.twitch.titleTemplate} onChange={(event) => patch('twitch', { ...draft.twitch, titleTemplate: event.target.value })} /></label><div className="field-row"><label>カテゴリ<input value={draft.twitch.categoryName} onChange={(event) => patch('twitch', { ...draft.twitch, categoryName: event.target.value })} /></label><label>タグ（カンマ区切り）<input value={draft.twitch.tags.join(', ')} onChange={(event) => patch('twitch', { ...draft.twitch, tags: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) })} /></label></div></div>
          <div className="form-section"><h3>音声</h3><div className="field-row"><label>マイク (dB)<NumericInput value={draft.audio.microphoneDb} onValueChange={(value) => value !== undefined && patch('audio', { ...draft.audio, microphoneDb: value })} /></label><label>ゲーム (dB)<NumericInput value={draft.audio.gameDb} onValueChange={(value) => value !== undefined && patch('audio', { ...draft.audio, gameDb: value })} /></label></div><div className="field-row"><label>Discord (dB)<NumericInput value={draft.audio.discordDb} onValueChange={(value) => value !== undefined && patch('audio', { ...draft.audio, discordDb: value })} /></label><label>BGM (dB)<NumericInput value={draft.audio.bgmDb} onValueChange={(value) => value !== undefined && patch('audio', { ...draft.audio, bgmDb: value })} /></label></div><label>ダッキング目標 (dB)<NumericInput value={draft.audio.duckingDb} onValueChange={(value) => value !== undefined && patch('audio', { ...draft.audio, duckingDb: value })} /></label></div>
          <div className="form-section"><h3>録画</h3><label>録画先<input value={draft.recording.directory} onChange={(event) => patch('recording', { ...draft.recording, directory: event.target.value })} placeholder="D:\Recordings\Game" /></label><label>リプレイ秒数<NumericInput value={draft.recording.replayBufferSeconds} onValueChange={(value) => value !== undefined && patch('recording', { ...draft.recording, replayBufferSeconds: value })} /></label><div className="profile-flags"><label className="check-row"><input type="checkbox" checked={draft.recording.enabled} onChange={(event) => patch('recording', { ...draft.recording, enabled: event.target.checked })} />通常録画</label><label className="check-row"><input type="checkbox" checked={draft.recording.sourceRecord} onChange={(event) => patch('recording', { ...draft.recording, sourceRecord: event.target.checked })} />Source Record</label><label className="check-row"><input type="checkbox" checked={draft.recording.verticalRecording} onChange={(event) => patch('recording', { ...draft.recording, verticalRecording: event.target.checked })} />Aitum Vertical録画</label></div></div>
          {draft.state.thumbnailFilename && <div className="thumbnail-preview"><img src={thumbnailUrl(draft)} alt={`${draft.displayName}の登録済みサムネイル`} /><div><strong>登録中のサムネイル</strong><span title={draft.state.thumbnailOriginalName ?? draft.state.thumbnailFilename}>{draft.state.thumbnailOriginalName ?? draft.state.thumbnailFilename}</span><small>{thumbnailStatusLabel(draft)}{draft.state.thumbnailUpdatedAt ? ` · ${new Date(draft.state.thumbnailUpdatedAt).toLocaleString('ja-JP')}` : ''}</small></div></div>}
          {draft.state.thumbnailLastError && <div className="inline-warning" role="status"><AlertTriangle size={14} /><span>{draft.state.thumbnailLastError}</span></div>}
          <button className="thumbnail-drop" disabled={saving} onClick={() => fileRef.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) void upload(file) }}>
            <ImagePlus size={22} /><span>{draft.state.thumbnailFilename ? 'サムネイルを差し替える' : 'サムネイルを登録する'}</span><small>PNG / JPG / WEBP · 最大4MB</small>
          </button>
          <input ref={fileRef} hidden disabled={saving} type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ''; if (file) void upload(file) }} />
          {draft.state.thumbnailFilename && <div className="thumbnail-controls"><label className="check-row"><input type="checkbox" checked={draft.state.thumbnailAutoApply} onChange={(event) => patch('state', { ...draft.state, thumbnailAutoApply: event.target.checked, thumbnailApplyStatus: event.target.checked ? 'pending' : 'disabled', thumbnailLastError: undefined })} />選択時にYouTubeへ自動適用</label><button className="danger-link" disabled={saving} onClick={() => void removeThumbnail()}><Trash2 size={14} />サムネイルを削除</button></div>}
          <label className="check-row"><input type="checkbox" checked={draft.favorite} onChange={(event) => patch('favorite', event.target.checked)} /><Heart size={16} />お気に入りに固定</label>
        </fieldset>
        <footer><button className="danger-link" disabled={saving} onClick={() => void remove()}>削除</button><div><button className="secondary" disabled={saving} onClick={onClose}>キャンセル</button><button className="primary small" disabled={saving} onClick={() => void save()}>{saving ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}保存</button></div></footer>
      </section>
    </div>
  )
}

function SettingsView({ config, oauthStatus, oauthProgress, onSave, onBackup, onRestore, onSteamSync, onOAuthConnect, onOAuthRefresh }: { config: AppConfig; oauthStatus: OAuthConnectionStatuses; oauthProgress: OAuthProgress; onSave: (config: AppConfig, secrets: Record<string, string>) => Promise<void>; onBackup: () => Promise<void>; onRestore: (file: File) => Promise<void>; onSteamSync: () => Promise<void>; onOAuthConnect: (provider: OAuthProvider) => Promise<void>; onOAuthRefresh: () => Promise<void> }) {
  const [draft, setDraft] = useState(config)
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const secret = (name: string, value: string) => setSecrets((current) => ({ ...current, [name]: value }))
  const attempt = async (operation: () => Promise<void>) => {
    setSaving(true); setSettingsError(null)
    try { await operation() }
    catch (error) { setSettingsError(error instanceof Error ? error.message : String(error)) }
    finally { setSaving(false) }
  }
  const save = () => attempt(async () => { await onSave(draft, secrets); setSecrets({}) })
  const connectOAuth = (provider: OAuthProvider) => attempt(() => onOAuthConnect(provider))
  return (
    <div className="settings-view">
      <div className="section-heading"><div><span className="eyebrow">CONNECTIONS</span><h2>接続と動作設定</h2></div><button className="primary small" onClick={() => void save()} disabled={saving}>{saving ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}保存</button></div>
      {settingsError && <div className="inline-warning" role="alert"><AlertTriangle size={14} /><span>{settingsError}</span></div>}
      <section className="settings-card"><h3><Radio size={17} />OBS WebSocket</h3><label>接続URL<input value={draft.obs.url} onChange={(event) => setDraft({ ...draft, obs: { ...draft.obs, url: event.target.value } })} /></label><label>パスワード<input type="password" autoComplete="off" placeholder={draft.obs.passwordStored ? '保存済み（変更時のみ入力）' : 'OS資格情報ストアへ保存'} value={secrets['obs-password'] ?? ''} onChange={(event) => secret('obs-password', event.target.value)} /></label><div className="field-row"><label>開始待機（秒）<input type="number" value={draft.obs.startDelaySeconds} onChange={(event) => setDraft({ ...draft, obs: { ...draft.obs, startDelaySeconds: Number(event.target.value) } })} /></label><label>終了待機（秒）<input type="number" value={draft.obs.endDelaySeconds} onChange={(event) => setDraft({ ...draft, obs: { ...draft.obs, endDelaySeconds: Number(event.target.value) } })} /></label></div></section>
      <section className="settings-card"><div className="settings-card-heading"><h3><MonitorUp size={17} />配信サービス</h3><button className="secondary oauth-refresh" disabled={saving} onClick={() => void attempt(onOAuthRefresh)}><RefreshCw size={14} />今すぐ再取得</button></div><p>接続完了は自動で反映されます。「今すぐ再取得」は通信トラブル時の確認用です。各サービスの完了地点と、このPCに保存されている認証状態を表示します。</p><div className="oauth-connect-grid"><OAuthServiceCard status={oauthStatus.youtube} progress={oauthProgress.youtube} saving={saving} onConnect={() => void connectOAuth('youtube')} /><OAuthServiceCard status={oauthStatus.twitch} progress={oauthProgress.twitch} saving={saving} onConnect={() => void connectOAuth('twitch')} /></div></section>
      <section className="settings-card"><h3><Radio size={17} />機能</h3><div className="settings-toggle-grid"><label className="check-row"><input type="checkbox" checked={draft.features.youtube} onChange={(event) => setDraft({ ...draft, features: { ...draft.features, youtube: event.target.checked } })} />YouTube</label><label className="check-row"><input type="checkbox" checked={draft.features.twitch} onChange={(event) => setDraft({ ...draft, features: { ...draft.features, twitch: event.target.checked } })} />Twitch</label><label className="check-row"><input type="checkbox" checked={draft.features.recording} onChange={(event) => setDraft({ ...draft, features: { ...draft.features, recording: event.target.checked } })} />通常録画</label><label className="check-row"><input type="checkbox" checked={draft.features.replayBuffer} onChange={(event) => setDraft({ ...draft, features: { ...draft.features, replayBuffer: event.target.checked } })} />リプレイ</label><label className="check-row"><input type="checkbox" checked={draft.features.sourceRecord} onChange={(event) => setDraft({ ...draft, features: { ...draft.features, sourceRecord: event.target.checked } })} />Source Record</label><label className="check-row"><input type="checkbox" checked={draft.features.verticalRecording} onChange={(event) => setDraft({ ...draft, features: { ...draft.features, verticalRecording: event.target.checked } })} />Aitum Vertical</label></div></section>
      <section className="settings-card"><h3><Radio size={17} />音声ソース名</h3><div className="field-row"><label>マイク<input value={draft.sources.microphone} onChange={(event) => setDraft({ ...draft, sources: { ...draft.sources, microphone: event.target.value } })} /></label><label>PCゲーム<input value={draft.sources.pcGame} onChange={(event) => setDraft({ ...draft, sources: { ...draft.sources, pcGame: event.target.value } })} /></label></div><div className="field-row"><label>GeForce NOW<input value={draft.sources.geforceNow} onChange={(event) => setDraft({ ...draft, sources: { ...draft.sources, geforceNow: event.target.value } })} /></label><label>Switch<input value={draft.sources.switchGame} onChange={(event) => setDraft({ ...draft, sources: { ...draft.sources, switchGame: event.target.value } })} /></label></div><div className="field-row"><label>Discord<input value={draft.sources.discord} onChange={(event) => setDraft({ ...draft, sources: { ...draft.sources, discord: event.target.value } })} /></label><label>BGM<input value={draft.sources.bgm} onChange={(event) => setDraft({ ...draft, sources: { ...draft.sources, bgm: event.target.value } })} /></label></div></section>
      <section className="settings-card"><h3><Sparkles size={17} />Steam</h3><label>SteamID64<input value={draft.steam.steamId64} onChange={(event) => setDraft({ ...draft, steam: { ...draft.steam, steamId64: event.target.value } })} /></label><label>Steam Web API Key<input type="password" autoComplete="off" value={secrets['steam-api-key'] ?? ''} onChange={(event) => secret('steam-api-key', event.target.value)} placeholder="OS資格情報ストアへ保存" /></label><label>Steamインストール先<input value={draft.steam.installPath} onChange={(event) => setDraft({ ...draft, steam: { ...draft.steam, installPath: event.target.value } })} placeholder="C:\Program Files (x86)\Steam" /></label><div className="button-row"><button className="secondary" disabled={saving} onClick={() => void attempt(async () => { await onSave(draft, secrets); setSecrets({}); await onSteamSync() })}><RefreshCw size={16} />保存してライブラリ同期</button></div><p>所有ゲームとローカル導入状態をApp IDで統合します。Game Passは各ゲーム設定から手動登録できます。</p></section>
      <section className="settings-card"><h3><ArrowDownToLine size={17} />バックアップ</h3><p>秘密情報と認証トークンは書き出しません。</p><div className="button-row"><button className="secondary" disabled={saving} onClick={() => void attempt(onBackup)}><ArrowDownToLine size={16} />JSONを書き出す</button><label className="secondary file-button"><Upload size={16} />復元<input hidden type="file" accept="application/json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void attempt(() => onRestore(file)) }} /></label></div></section>
    </div>
  )
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
      setOAuthProgress((current) => Object.fromEntries([
        ...Object.entries(current),
        ...completedProviders.map((provider) => [provider, connections[provider].detail]),
      ]))
      const serviceNames = completedProviders.map((provider) => provider === 'youtube' ? 'YouTube' : 'Twitch')
      setToast({ kind: 'success', text: `${serviceNames.join('・')} 接続が完了しました` })
    }
    return connections
  }, [])

  const refresh = async () => {
    const [data] = await Promise.all([api.bootstrap(), loadOAuthStatus()])
    setProfiles(data.profiles); setConfig(data.config); setStatus(data.status); setLoading(false)
  }
  const refreshOAuth = async () => {
    const connections = await loadOAuthStatus()
    if (!connections) return
    setOAuthProgress((current) => ({
      youtube: connections.youtube.authorizationInProgress ? current.youtube : undefined,
      twitch: connections.twitch.authorizationInProgress ? current.twitch : undefined,
    }))
  }
  const oauthPollingInterval = oauthRefreshInterval(oauthStatus)
  useEffect(() => {
    void api.bootstrap().then((data) => {
      setProfiles(data.profiles); setConfig(data.config); setStatus(data.status); setLoading(false)
      void loadOAuthStatus().catch((error: Error) => setToast({ kind: 'error', text: `OAuth接続状態を取得できません: ${error.message}` }))
    }).catch((error: Error) => { setToast({ kind: 'error', text: error.message }); setLoading(false) })
  }, [loadOAuthStatus])
  useEffect(() => {
    const timer = window.setInterval(() => void api.status().then(setStatus).catch(() => undefined), 2000)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => {
    const load = () => void loadOAuthStatus().catch(() => undefined)
    const visible = () => { if (document.visibilityState === 'visible') load() }
    window.addEventListener('focus', load)
    document.addEventListener('visibilitychange', visible)
    return () => {
      window.removeEventListener('focus', load)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [loadOAuthStatus])
  useEffect(() => {
    const timer = window.setInterval(() => void loadOAuthStatus().catch(() => undefined), oauthPollingInterval)
    return () => window.clearInterval(timer)
  }, [loadOAuthStatus, oauthPollingInterval])
  useEffect(() => {
    if (!status?.streaming) return
    const load = () => void api.comments().then(setComments).catch(() => undefined)
    load()
    const timer = window.setInterval(load, 3000)
    return () => window.clearInterval(timer)
  }, [status?.streaming])
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(null), 5000); return () => window.clearTimeout(timer) }, [toast])
  useEffect(() => {
    const authenticated = (event: MessageEvent) => {
      let origin: URL
      try { origin = new URL(event.origin) } catch { return }
      const trustedLoopback = origin.protocol === 'http:' && (origin.hostname === '127.0.0.1' || origin.hostname === 'localhost')
      if (event.source === oauthPopup.current && trustedLoopback && event.data?.type === 'oauth-complete') {
        oauthPopup.current = null
        void Promise.all([api.bootstrap(), loadOAuthStatus()]).then(([data]) => {
          setConfig(data.config); setStatus(data.status)
        })
      }
    }
    window.addEventListener('message', authenticated)
    return () => window.removeEventListener('message', authenticated)
  }, [loadOAuthStatus])

  const filtered = useMemo(() => profiles.filter((profile) => profile.platformGroup === tab && !profile.hidden && profile.displayName.toLocaleLowerCase().includes(search.toLocaleLowerCase())), [profiles, search, tab])
  const selected = profiles.find((profile) => profile.id === status?.selectedGameId) ?? null

  const run = async (operation: () => Promise<void>) => { if (actionLock.current) return; actionLock.current = true; setActionBusy(true); try { await operation() } catch (error) { setToast({ kind: 'error', text: error instanceof Error ? error.message : String(error) }) } finally { const latest = await api.status().catch(() => null); if (latest) setStatus(latest); actionLock.current = false; setActionBusy(false) } }
  const selectGame = (profile: GameProfile, method?: CaptureMethod) => run(async () => {
    const result = await api.select(profile.id, method)
    setProfiles((current) => current.map((item) => item.id === profile.id ? result.profile : item))
    setToast({ kind: result.warnings.length ? 'warning' : 'success', text: result.warnings[0] ?? `${profile.displayName}を適用しました` })
  })
  const start = () => run(async () => {
    let result: Awaited<ReturnType<typeof api.start>>
    try { result = await api.start() }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('配信サービスの設定に失敗')) {
        if (!window.confirm(`${message}\n\n利用できる配信先だけで続行しますか？`)) throw error
        result = await api.start(true)
      } else throw error
    }
    setToast({ kind: result.warnings.length ? 'warning' : 'success', text: result.warnings[0] ?? '配信と録画を開始しました' })
  })

  const connectOAuth = async (provider: OAuthProvider) => {
    const configured = Boolean(oauthStatus?.[provider].appConfigured)
    if (!configured) {
      const service = provider === 'youtube' ? 'YouTube' : 'Twitch'
      throw new Error(`${service}接続機能が配布パッケージに含まれていません。利用者による開発者登録は不要です`)
    }
    if (oauthPopup.current && !oauthPopup.current.closed) {
      oauthPopup.current.focus()
      throw new Error('認証ウィンドウで接続を完了してください')
    }
    const popup = window.open('about:blank', `${provider}-oauth`, 'width=560,height=720')
    if (!popup) throw new Error('認証ウィンドウを開けませんでした。ポップアップを許可してください')
    oauthPopup.current = popup
    setOAuthProgress((current) => ({ ...current, [provider]: `${provider === 'youtube' ? 'Google' : 'Twitch'}認証を開始しています` }))
    try {
      const started = await api.oauthStart(provider, window.location.origin)
      await loadOAuthStatus()
      popup.location.href = started.url
      if (started.mode === 'redirect') {
        setOAuthProgress((current) => ({ ...current, [provider]: 'Googleのアカウント選択と権限承認を待っています' }))
        return
      }
      setOAuthProgress((current) => ({ ...current, [provider]: `Twitchの承認待ちです。確認コード: ${started.userCode}` }))
      setToast({ kind: 'warning', text: `Twitch 認証コード: ${started.userCode}（画面で求められた場合）` })
      while (Date.now() < started.expiresAt) {
        await new Promise((resolve) => window.setTimeout(resolve, started.intervalMs))
        if (popup.closed) throw new Error('認証ウィンドウが閉じられました')
        const result = await api.oauthPollTwitch(started.requestId)
        if (result.status === 'complete') {
          popup.close(); oauthPopup.current = null
          await refresh()
          setOAuthProgress((current) => ({ ...current, [provider]: 'Twitch認証と配信者情報の取得が完了しました' }))
          return
        }
      }
      throw new Error('Twitch 認証の有効期限が切れました')
    } catch (error) {
      if (!popup.closed) popup.close()
      if (oauthPopup.current === popup) oauthPopup.current = null
      const reason = error instanceof Error ? error.message : String(error)
      setOAuthProgress((current) => ({ ...current, [provider]: `接続に失敗しました: ${reason}` }))
      await loadOAuthStatus().catch(() => undefined)
      throw error
    }
  }

  const addProfile = () => {
    const group = tab === 'settings' ? 'pc' : tab
    const template = profiles.find((profile) => profile.platformGroup === group) ?? profiles[0]
    if (!template) return
    const id = `new_game_${crypto.randomUUID()}`
    setEditing({ ...structuredClone(template), id, displayName: '新しいゲーム', favorite: false, platformGroup: group, state: { lastUsedAt: null, thumbnailAutoApply: true, thumbnailApplyStatus: 'not_registered', thumbnailLastAppliedAt: null }, library: { gamePass: false, exception: group === 'exception', installed: false } })
  }

  const uploadThumbnail = async (profile: GameProfile, file: File) => {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('PNG、JPG、WEBPを選択してください')
    if (file.size > 4 * 1024 * 1024) throw new Error('サムネイルは4MB以下にしてください')
    const persisted = await api.saveProfile(profile)
    setProfiles((current) => [...current.filter((item) => item.id !== persisted.id), persisted])
    let saved: GameProfile
    try {
      const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => { const encoded = String(reader.result).split(',')[1]; if (encoded) resolve(encoded); else reject(new Error('サムネイルの読み込みに失敗しました')) }; reader.onerror = () => reject(new Error('サムネイルの読み込みに失敗しました')); reader.readAsDataURL(file) })
      saved = await api.uploadThumbnail(persisted.id, file.type, data, file.name)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`設定は保存されましたが、サムネイルの更新に失敗しました: ${message}`)
    }
    setProfiles((current) => [...current.filter((item) => item.id !== saved.id), saved]); setEditing(saved)
    const latest = await api.status().catch(() => null); if (latest) setStatus(latest)
    setToast({ kind: 'success', text: '設定とサムネイルを保存しました。以後は自動で使い回します' })
  }

  const deleteThumbnail = async (draft: GameProfile) => {
    if (!window.confirm('登録済みサムネイルを削除しますか？')) return
    const persisted = await api.saveProfile(draft)
    let saved: GameProfile
    try { saved = await api.deleteThumbnail(persisted.id) }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`設定は保存されましたが、サムネイルの削除に失敗しました: ${message}`)
    }
    setProfiles((current) => [...current.filter((item) => item.id !== saved.id), saved]); setEditing(saved)
    const latest = await api.status().catch(() => null); if (latest) setStatus(latest)
    setToast({ kind: 'success', text: '設定を維持したままサムネイルを削除しました' })
  }

  if (loading || !config || !status) return <div className="loading-screen"><LoaderCircle className="spin" /><span>ストリーム環境を読み込み中</span></div>

  return (
    <div className="app-shell">
      <header className="app-header"><div className="brand"><div className="brand-mark"><Clapperboard size={19} /></div><div><strong>STREAM MANAGER</strong><span>OBS CONTROL DOCK</span></div></div><div className="header-status"><StatusDot active={status.obsConnected} /><span>OBS {status.obsConnected ? '接続中' : '未接続'}</span></div></header>
      <nav className="tabs">{groups.map(({ id, label, icon: Icon }) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}><Icon size={16} /><span>{label}</span></button>)}</nav>
      <RuntimeStatusBar status={status} />
      {tab === 'settings' ? (oauthStatus ? <SettingsView key={JSON.stringify(config)} config={config} oauthStatus={oauthStatus} oauthProgress={oauthProgress} onOAuthConnect={connectOAuth} onOAuthRefresh={refreshOAuth} onSave={async (next, secrets) => { const saved = await api.saveConfig(next, secrets); setConfig(saved); await loadOAuthStatus(); setToast({ kind: 'success', text: '設定を保存しました' }) }} onBackup={async () => { const backup = await api.backup(); const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `obs-stream-manager-${new Date().toISOString().slice(0, 10)}.json`; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 10_000) }} onRestore={async (file) => { await api.restore(JSON.parse(await file.text())); await refresh(); setToast({ kind: 'success', text: 'バックアップを復元しました' }) }} onSteamSync={async () => { const result = await api.steamSync(); setProfiles(result.profiles); setToast({ kind: result.warnings.length ? 'warning' : 'success', text: `Steam同期: 新規${result.created}件・更新${result.updated}件${result.warnings[0] ? ` / ${result.warnings[0]}` : ''}` }) }} /> : <div className="settings-view"><div className="section-heading"><div><span className="eyebrow">CONNECTIONS</span><h2>接続状態を取得できません</h2></div></div><div className="inline-warning" role="alert"><AlertTriangle size={14} /><span>OBS操作は利用できます。OAuth接続状態だけ再取得してください。</span></div><button className="secondary" onClick={() => void refreshOAuth().catch((error: Error) => setToast({ kind: 'error', text: error.message }))}><RefreshCw size={15} />状態を再確認</button></div>) : (
        <main>
          <div className="search-row"><div className="search-box"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="ゲームを検索" />{search && <button aria-label="検索をクリア" onClick={() => setSearch('')}><X size={14} /></button>}</div><button className="icon-button add" aria-label="ゲームを追加" onClick={addProfile} title="ゲームを追加"><Plus size={18} /></button></div>
          {filtered.some((profile) => profile.favorite) && !search && <section className="library-section"><div className="mini-heading"><Star size={13} />お気に入り</div><div className="game-list">{filtered.filter((profile) => profile.favorite).map((profile) => <GameCard key={profile.id} profile={profile} selected={selected?.id === profile.id} busy={actionBusy} onSelect={() => void selectGame(profile)} onEdit={() => setEditing(profile)} />)}</div></section>}
          <section className="library-section"><div className="mini-heading"><RefreshCw size={13} />ゲーム一覧 <span>{filtered.length}</span></div><div className="game-list">{filtered.filter((profile) => search || !profile.favorite).map((profile) => <GameCard key={profile.id} profile={profile} selected={selected?.id === profile.id} busy={actionBusy} onSelect={() => void selectGame(profile)} onEdit={() => setEditing(profile)} />)}{filtered.length === 0 && <div className="empty"><Gamepad2 size={28} /><p>ゲームがありません</p><button onClick={addProfile}>ゲームを追加</button></div>}</div></section>
          <section className="chat-preview"><div className="mini-heading"><MessageSquareText size={13} />コメント <span>{comments.length}</span></div>{comments.length ? <div className="chat-list">{comments.slice(-30).map((comment) => <div className={`chat-message ${comment.mention ? 'mention' : ''}`} key={comment.id}><b className={comment.service}>{comment.service === 'youtube' ? 'YT' : 'TW'}</b><div><strong>{comment.author}{comment.moderator && ' ◆'}</strong><p>{comment.body}</p></div><time>{new Date(comment.publishedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}</time></div>)}</div> : <div className="chat-empty"><MessageSquareText size={22} /><span>配信開始後、YouTube / Twitch のコメントをここに表示します</span></div>}</section>
        </main>
      )}
      {tab !== 'settings' && <aside className="control-panel">
        {status.streaming && !selected ? <><div className="inline-warning"><AlertTriangle size={14} /><span>アプリ再起動後の配信を検出しました。安全に終了できます。</span></div><div className="main-actions"><button className="stop-button" disabled={actionBusy || status.busy} onClick={() => void run(async () => { const result = await api.stop(); setToast({ kind: result.warnings.length ? 'warning' : 'success', text: result.warnings[0] ?? '配信を終了しました' }) })}>{actionBusy ? <LoaderCircle className="spin" /> : <CircleStop />}配信終了</button></div></> : selected ? <><div className="selection-summary"><div className="selection-icon">{selected.displayName.slice(0, 1)}</div><div><span>選択中</span><strong>{selected.displayName}</strong><small>{status.captureMethod ? captureLabels[status.captureMethod] : '未判定'} · {thumbnailStatusLabel(selected)}</small></div></div>{!selected.state.thumbnailFilename && !status.streaming && <button className="secondary thumbnail-first-register" onClick={() => setEditing(selected)}><ImagePlus size={15} />初回サムネイルを登録</button>}{status.warning && <div className="inline-warning"><AlertTriangle size={14} /><span>{status.warning}</span></div>}<div className="stream-indicators"><span><StatusDot active={status.streaming} />配信</span><span><StatusDot active={status.recording} />録画</span><span><StatusDot active={status.replayBuffer} />リプレイ</span><span><StatusDot active={status.sourceRecord} />素材</span><span><StatusDot active={status.verticalRecording} />縦録画</span></div><div className="main-actions">{status.streaming ? <button className="stop-button" disabled={actionBusy || status.busy} onClick={() => void run(async () => { const result = await api.stop(); setToast({ kind: result.warnings.length ? 'warning' : 'success', text: result.warnings[0] ?? '配信を終了しました' }) })}>{actionBusy ? <LoaderCircle className="spin" /> : <CircleStop />}配信終了</button> : <button className="start-button" disabled={actionBusy || status.busy || !status.obsConnected} onClick={start}>{actionBusy ? <LoaderCircle className="spin" /> : <Play fill="currentColor" />}配信開始</button>}<button className="replay-button" aria-label="リプレイを保存" disabled={!status.replayBuffer} onClick={() => void run(async () => { await api.replay(); setToast({ kind: 'success', text: 'クリップを保存しました' }) })}><Clapperboard size={17} /></button></div></> : <div className="no-selection"><Radio size={22} /><div><strong>ゲームを選択</strong><span>プロファイルを適用して配信準備を開始</span></div></div>}
      </aside>}
      {editing && <ProfileEditor key={`${editing.id}:${editing.platformGroup}:${editing.state.thumbnailFilename ?? ''}:${editing.state.thumbnailUpdatedAt ?? ''}`} profile={editing} onClose={() => setEditing(null)} onSave={async (profile) => { const wasSelected = status.selectedGameId === profile.id; const saved = await api.saveProfile(profile); setProfiles((current) => [...current.filter((item) => item.id !== saved.id), saved]); setStatus(await api.status()); setToast({ kind: 'success', text: wasSelected ? 'ゲーム設定を保存しました。配信前にゲームを選び直してください' : 'ゲーム設定を保存しました' }) }} onDelete={async () => { if (!window.confirm(`${editing.displayName}を削除しますか？`)) return; await api.deleteProfile(editing.id); setProfiles((current) => current.filter((item) => item.id !== editing.id)); setEditing(null) }} onThumbnail={(file, draft) => uploadThumbnail(draft, file)} onDeleteThumbnail={deleteThumbnail} />}
      {toast && <div className={`toast ${toast.kind}`}>{toast.kind === 'success' ? <Check size={17} /> : <AlertTriangle size={17} />}<span>{toast.text}</span><button onClick={() => setToast(null)}><X size={15} /></button></div>}
    </div>
  )
}
