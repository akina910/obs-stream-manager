import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle, ArrowDownToLine, Check, ChevronRight, CircleStop, Clapperboard, Gamepad2,
  Heart, ImagePlus, Library, LoaderCircle, MessageSquareText, MonitorUp, Play, Plus, Radio,
  RefreshCw, Save, Search, Settings, SlidersHorizontal, Sparkles, Star, Upload, X, Zap,
} from 'lucide-react'
import type { AppConfig, CaptureMethod, ChatMessage, GameProfile, PlatformGroup, RuntimeStatus } from '../shared/contracts'
import { api } from './api'

type Tab = PlatformGroup | 'settings'
type Toast = { kind: 'success' | 'error' | 'warning'; text: string }

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

function GameCard({ profile, selected, busy, onSelect, onEdit }: { profile: GameProfile; selected: boolean; busy: boolean; onSelect: () => void; onEdit: () => void }) {
  const initials = profile.displayName.replace(/[^A-Za-z0-9\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu, '').slice(0, 2).toUpperCase()
  return (
    <article className={`game-card ${selected ? 'selected' : ''}`}>
      <button className="game-main" onClick={onSelect} disabled={busy}>
        <div className="cover">
          {profile.state.thumbnailFilename ? <img src={`/api/profiles/${profile.id}/thumbnail?v=${encodeURIComponent(profile.state.thumbnailFilename)}`} alt="" /> : <span>{initials || 'G'}</span>}
          {profile.favorite && <Star className="favorite-badge" size={13} fill="currentColor" />}
        </div>
        <div className="game-copy">
          <strong>{profile.displayName}</strong>
          <span>{captureLabels[profile.capture.preferred]} · {profile.state.thumbnailFilename ? 'サムネ登録済み' : 'サムネ未登録'}</span>
        </div>
        {selected ? <Check className="selected-check" size={18} /> : <ChevronRight size={17} />}
      </button>
      <button className="detail-button" onClick={onEdit} aria-label={`${profile.displayName}の設定`}><SlidersHorizontal size={15} /></button>
    </article>
  )
}

function ProfileEditor({ profile, onClose, onSave, onDelete, onThumbnail }: { profile: GameProfile; onClose: () => void; onSave: (profile: GameProfile) => Promise<void>; onDelete: () => Promise<void>; onThumbnail: (file: File, draft: GameProfile) => Promise<void> }) {
  const [draft, setDraft] = useState(profile)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const patch = <K extends keyof GameProfile>(key: K, value: GameProfile[K]) => setDraft((current) => ({ ...current, [key]: value }))
  const save = async () => {
    setSaving(true); setSaveError(null)
    try { await onSave(draft); onClose() }
    catch (error) { setSaveError(error instanceof Error ? error.message : String(error)) }
    finally { setSaving(false) }
  }
  const remove = async () => {
    setSaving(true); setSaveError(null)
    try { await onDelete() }
    catch (error) { setSaveError(error instanceof Error ? error.message : String(error)) }
    finally { setSaving(false) }
  }
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal" role="dialog" aria-modal="true">
        <header><div><span className="eyebrow">GAME PROFILE</span><h2>{profile.displayName}</h2></div><button className="icon-button" onClick={onClose}><X size={18} /></button></header>
        <div className="modal-body">
          {saveError && <div className="inline-warning"><AlertTriangle size={14} /><span>{saveError}</span></div>}
          <label>表示名<input value={draft.displayName} onChange={(event) => patch('displayName', event.target.value)} /></label>
          <div className="field-row">
            <label>分類<select value={draft.platformGroup} onChange={(event) => patch('platformGroup', event.target.value as PlatformGroup)}><option value="pc">PC</option><option value="switch">Switch</option><option value="exception">例外</option></select></label>
            <label>優先キャプチャ<select value={draft.capture.preferred} onChange={(event) => patch('capture', { ...draft.capture, preferred: event.target.value as CaptureMethod })}>{Object.entries(captureLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          </div>
          <label>実行ファイル名（カンマ区切り）<input value={draft.capture.executableNames.join(', ')} onChange={(event) => patch('capture', { ...draft.capture, executableNames: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) })} /></label>
          <div className="field-row"><label>OBSシーン<input value={draft.obs.sceneName} onChange={(event) => patch('obs', { ...draft.obs, sceneName: event.target.value })} /></label><label>映像ソース<input value={draft.capture.localSourceName} onChange={(event) => patch('capture', { ...draft.capture, localSourceName: event.target.value })} /></label></div>
          <label>YouTube タイトル<input value={draft.youtube.titleTemplate} onChange={(event) => patch('youtube', { ...draft.youtube, titleTemplate: event.target.value })} /></label>
          <label>Twitch カテゴリ<input value={draft.twitch.categoryName} onChange={(event) => patch('twitch', { ...draft.twitch, categoryName: event.target.value })} /></label>
          <div className="field-row"><label>ゲーム音量 (dB)<input type="number" value={draft.audio.gameDb} onChange={(event) => patch('audio', { ...draft.audio, gameDb: Number(event.target.value) })} /></label><label>リプレイ秒数<input type="number" value={draft.recording.replayBufferSeconds} onChange={(event) => patch('recording', { ...draft.recording, replayBufferSeconds: Number(event.target.value) })} /></label></div>
          <button className="thumbnail-drop" onClick={() => fileRef.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) void onThumbnail(file, draft) }}>
            <ImagePlus size={22} /><span>{draft.state.thumbnailFilename ? 'サムネイルを差し替える' : 'サムネイルを登録する'}</span><small>PNG / JPG / WEBP · 最大4MB</small>
          </button>
          <input ref={fileRef} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) void onThumbnail(file, draft) }} />
          <label className="check-row"><input type="checkbox" checked={draft.favorite} onChange={(event) => patch('favorite', event.target.checked)} /><Heart size={16} />お気に入りに固定</label>
        </div>
        <footer><button className="danger-link" disabled={saving} onClick={() => void remove()}>削除</button><div><button className="secondary" onClick={onClose}>キャンセル</button><button className="primary small" disabled={saving} onClick={() => void save()}>{saving ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}保存</button></div></footer>
      </section>
    </div>
  )
}

function SettingsView({ config, onSave, onBackup, onRestore }: { config: AppConfig; onSave: (config: AppConfig, secrets: Record<string, string>) => Promise<void>; onBackup: () => Promise<void>; onRestore: (file: File) => Promise<void> }) {
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
  return (
    <div className="settings-view">
      <div className="section-heading"><div><span className="eyebrow">CONNECTIONS</span><h2>接続と動作設定</h2></div><button className="primary small" onClick={() => void save()} disabled={saving}>{saving ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}保存</button></div>
      {settingsError && <div className="inline-warning"><AlertTriangle size={14} /><span>{settingsError}</span></div>}
      <section className="settings-card"><h3><Radio size={17} />OBS WebSocket</h3><label>接続URL<input value={draft.obs.url} onChange={(event) => setDraft({ ...draft, obs: { ...draft.obs, url: event.target.value } })} /></label><label>パスワード<input type="password" placeholder={draft.obs.passwordStored ? '保存済み（変更時のみ入力）' : 'OS資格情報ストアへ保存'} value={secrets['obs-password'] ?? ''} onChange={(event) => secret('obs-password', event.target.value)} /></label><div className="field-row"><label>開始待機（秒）<input type="number" value={draft.obs.startDelaySeconds} onChange={(event) => setDraft({ ...draft, obs: { ...draft.obs, startDelaySeconds: Number(event.target.value) } })} /></label><label>終了待機（秒）<input type="number" value={draft.obs.endDelaySeconds} onChange={(event) => setDraft({ ...draft, obs: { ...draft.obs, endDelaySeconds: Number(event.target.value) } })} /></label></div></section>
      <section className="settings-card"><h3><MonitorUp size={17} />配信サービス</h3><label>YouTube Client ID<input value={draft.youtube.clientId} onChange={(event) => setDraft({ ...draft, youtube: { ...draft.youtube, clientId: event.target.value } })} /></label><label>YouTube Client Secret<input type="password" value={secrets['youtube-client-secret'] ?? ''} onChange={(event) => secret('youtube-client-secret', event.target.value)} placeholder="OS資格情報ストアへ保存" /></label><div className="oauth-row"><span><StatusDot active={draft.youtube.refreshTokenStored} />YouTube {draft.youtube.refreshTokenStored ? '認証済み' : '未認証'}</span><button className="secondary" onClick={() => window.open('/api/oauth/youtube/start', 'youtube-oauth', 'width=560,height=720')}>Googleで認証</button></div><label>Twitch Client ID<input value={draft.twitch.clientId} onChange={(event) => setDraft({ ...draft, twitch: { ...draft.twitch, clientId: event.target.value } })} /></label><label>Twitch Client Secret<input type="password" value={secrets['twitch-client-secret'] ?? ''} onChange={(event) => secret('twitch-client-secret', event.target.value)} placeholder="OS資格情報ストアへ保存" /></label><div className="oauth-row"><span><StatusDot active={draft.twitch.accessTokenStored} />Twitch {draft.twitch.accessTokenStored ? '認証済み' : '未認証'}</span><button className="secondary" onClick={() => window.open('/api/oauth/twitch/start', 'twitch-oauth', 'width=560,height=720')}>Twitchで認証</button></div></section>
      <section className="settings-card"><h3><Sparkles size={17} />Steam</h3><label>SteamID64<input value={draft.steam.steamId64} onChange={(event) => setDraft({ ...draft, steam: { ...draft.steam, steamId64: event.target.value } })} /></label><label>Steam Web API Key<input type="password" value={secrets['steam-api-key'] ?? ''} onChange={(event) => secret('steam-api-key', event.target.value)} placeholder="OS資格情報ストアへ保存" /></label><label>Steamインストール先<input value={draft.steam.installPath} onChange={(event) => setDraft({ ...draft, steam: { ...draft.steam, installPath: event.target.value } })} placeholder="C:\Program Files (x86)\Steam" /></label></section>
      <section className="settings-card"><h3><ArrowDownToLine size={17} />バックアップ</h3><p>秘密情報と認証トークンは書き出しません。</p><div className="button-row"><button className="secondary" disabled={saving} onClick={() => void attempt(onBackup)}><ArrowDownToLine size={16} />JSONを書き出す</button><label className="secondary file-button"><Upload size={16} />復元<input hidden type="file" accept="application/json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void attempt(() => onRestore(file)) }} /></label></div></section>
    </div>
  )
}

export default function App() {
  const [tab, setTab] = useState<Tab>('pc')
  const [profiles, setProfiles] = useState<GameProfile[]>([])
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [status, setStatus] = useState<RuntimeStatus | null>(null)
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<GameProfile | null>(null)
  const [toast, setToast] = useState<Toast | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionBusy, setActionBusy] = useState(false)
  const [comments, setComments] = useState<ChatMessage[]>([])

  const refresh = async () => {
    const data = await api.bootstrap()
    setProfiles(data.profiles); setConfig(data.config); setStatus(data.status); setLoading(false)
  }
  useEffect(() => {
    void api.bootstrap().then((data) => {
      setProfiles(data.profiles); setConfig(data.config); setStatus(data.status); setLoading(false)
    }).catch((error: Error) => { setToast({ kind: 'error', text: error.message }); setLoading(false) })
  }, [])
  useEffect(() => {
    const timer = window.setInterval(() => void api.status().then(setStatus).catch(() => undefined), 2000)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => {
    if (!status?.streaming) return
    const load = () => void api.comments().then(setComments).catch(() => undefined)
    load()
    const timer = window.setInterval(load, 3000)
    return () => window.clearInterval(timer)
  }, [status?.streaming])
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(null), 5000); return () => window.clearTimeout(timer) }, [toast])
  useEffect(() => {
    const authenticated = (event: MessageEvent) => { if (event.data?.type === 'oauth-complete') void api.bootstrap().then((data) => { setConfig(data.config); setStatus(data.status); setToast({ kind: 'success', text: 'OAuth認証が完了しました' }) }) }
    window.addEventListener('message', authenticated)
    return () => window.removeEventListener('message', authenticated)
  }, [])

  const filtered = useMemo(() => profiles.filter((profile) => profile.platformGroup === tab && !profile.hidden && profile.displayName.toLocaleLowerCase().includes(search.toLocaleLowerCase())), [profiles, search, tab])
  const selected = profiles.find((profile) => profile.id === status?.selectedGameId) ?? null

  const run = async (operation: () => Promise<void>) => { setActionBusy(true); try { await operation() } catch (error) { setToast({ kind: 'error', text: error instanceof Error ? error.message : String(error) }) } finally { setActionBusy(false); setStatus(await api.status().catch(() => status)) } }
  const selectGame = (profile: GameProfile, method?: CaptureMethod) => run(async () => {
    const result = await api.select(profile.id, method)
    setProfiles((current) => current.map((item) => item.id === profile.id ? result.profile : item))
    setToast({ kind: result.warnings.length ? 'warning' : 'success', text: result.warnings[0] ?? `${profile.displayName}を適用しました` })
  })
  const start = () => run(async () => {
    try { await api.start() }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('配信サービスの設定に失敗')) {
        if (!window.confirm(`${message}\n\n利用できる配信先だけで続行しますか？`)) throw error
        await api.start(true)
      } else throw error
    }
    setToast({ kind: 'success', text: '配信と録画を開始しました' })
  })

  const addProfile = () => {
    const group = tab === 'settings' ? 'pc' : tab
    const template = profiles.find((profile) => profile.platformGroup === group) ?? profiles[0]
    if (!template) return
    const id = `new_game_${Date.now()}`
    setEditing({ ...structuredClone(template), id, displayName: '新しいゲーム', favorite: false, platformGroup: group, state: { lastUsedAt: null }, library: { gamePass: false, exception: group === 'exception' } })
  }

  const uploadThumbnail = async (profile: GameProfile, file: File) => {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('PNG、JPG、WEBPを選択してください')
    const persisted = await api.saveProfile(profile)
    setProfiles((current) => [...current.filter((item) => item.id !== persisted.id), persisted])
    const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reject; reader.readAsDataURL(file) })
    const saved = await api.uploadThumbnail(profile.id, file.type, data)
    setProfiles((current) => current.map((item) => item.id === saved.id ? saved : item)); setEditing(saved); setStatus(await api.status()); setToast({ kind: 'success', text: 'サムネイルを登録しました。配信前にゲームを選び直してください' })
  }

  if (loading || !config || !status) return <div className="loading-screen"><LoaderCircle className="spin" /><span>ストリーム環境を読み込み中</span></div>

  return (
    <div className="app-shell">
      <header className="app-header"><div className="brand"><div className="brand-mark"><Clapperboard size={19} /></div><div><strong>STREAM MANAGER</strong><span>OBS CONTROL DOCK</span></div></div><div className="header-status"><StatusDot active={status.obsConnected} /><span>OBS {status.obsConnected ? '接続中' : '未接続'}</span></div></header>
      <nav className="tabs">{groups.map(({ id, label, icon: Icon }) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}><Icon size={16} /><span>{label}</span></button>)}</nav>
      {tab === 'settings' ? <SettingsView key={JSON.stringify(config)} config={config} onSave={async (next, secrets) => { const saved = await api.saveConfig(next, secrets); setConfig(saved); setToast({ kind: 'success', text: '設定を保存しました' }) }} onBackup={async () => { const backup = await api.backup(); const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `obs-stream-manager-${new Date().toISOString().slice(0, 10)}.json`; anchor.click(); URL.revokeObjectURL(url) }} onRestore={async (file) => { await api.restore(JSON.parse(await file.text())); await refresh(); setToast({ kind: 'success', text: 'バックアップを復元しました' }) }} /> : (
        <main>
          <div className="search-row"><div className="search-box"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="ゲームを検索" />{search && <button onClick={() => setSearch('')}><X size={14} /></button>}</div><button className="icon-button add" onClick={addProfile} title="ゲームを追加"><Plus size={18} /></button></div>
          {filtered.some((profile) => profile.favorite) && !search && <section className="library-section"><div className="mini-heading"><Star size={13} />お気に入り</div><div className="game-list">{filtered.filter((profile) => profile.favorite).map((profile) => <GameCard key={profile.id} profile={profile} selected={selected?.id === profile.id} busy={actionBusy} onSelect={() => void selectGame(profile)} onEdit={() => setEditing(profile)} />)}</div></section>}
          <section className="library-section"><div className="mini-heading"><RefreshCw size={13} />ゲーム一覧 <span>{filtered.length}</span></div><div className="game-list">{filtered.filter((profile) => search || !profile.favorite).map((profile) => <GameCard key={profile.id} profile={profile} selected={selected?.id === profile.id} busy={actionBusy} onSelect={() => void selectGame(profile)} onEdit={() => setEditing(profile)} />)}{filtered.length === 0 && <div className="empty"><Gamepad2 size={28} /><p>ゲームがありません</p><button onClick={addProfile}>ゲームを追加</button></div>}</div></section>
          <section className="chat-preview"><div className="mini-heading"><MessageSquareText size={13} />コメント <span>{comments.length}</span></div>{comments.length ? <div className="chat-list">{comments.slice(-30).map((comment) => <div className={`chat-message ${comment.mention ? 'mention' : ''}`} key={comment.id}><b className={comment.service}>{comment.service === 'youtube' ? 'YT' : 'TW'}</b><div><strong>{comment.author}{comment.moderator && ' ◆'}</strong><p>{comment.body}</p></div><time>{new Date(comment.publishedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}</time></div>)}</div> : <div className="chat-empty"><MessageSquareText size={22} /><span>配信開始後、YouTube / Twitch のコメントをここに表示します</span></div>}</section>
        </main>
      )}
      {tab !== 'settings' && <aside className="control-panel">
        {status.streaming && !selected ? <><div className="inline-warning"><AlertTriangle size={14} /><span>アプリ再起動後の配信を検出しました。安全に終了できます。</span></div><div className="main-actions"><button className="stop-button" disabled={actionBusy || status.busy} onClick={() => void run(async () => { await api.stop(); setToast({ kind: 'success', text: '配信を終了しました' }) })}>{actionBusy ? <LoaderCircle className="spin" /> : <CircleStop />}配信終了</button></div></> : selected ? <><div className="selection-summary"><div className="selection-icon">{selected.displayName.slice(0, 1)}</div><div><span>選択中</span><strong>{selected.displayName}</strong><small>{status.captureMethod ? captureLabels[status.captureMethod] : '未判定'} · {selected.state.thumbnailFilename ? 'サムネ登録済み' : 'サムネ未登録'}</small></div></div>{status.warning && <div className="inline-warning"><AlertTriangle size={14} /><span>{status.warning}</span></div>}<div className="stream-indicators"><span><StatusDot active={status.streaming} />配信</span><span><StatusDot active={status.recording} />録画</span><span><StatusDot active={status.replayBuffer} />リプレイ</span></div><div className="main-actions">{status.streaming ? <button className="stop-button" disabled={actionBusy || status.busy} onClick={() => void run(async () => { await api.stop(); setToast({ kind: 'success', text: '配信を終了しました' }) })}>{actionBusy ? <LoaderCircle className="spin" /> : <CircleStop />}配信終了</button> : <button className="start-button" disabled={actionBusy || status.busy || !status.obsConnected} onClick={start}>{actionBusy ? <LoaderCircle className="spin" /> : <Play fill="currentColor" />}配信開始</button>}<button className="replay-button" disabled={!status.replayBuffer} onClick={() => void run(async () => { await api.replay(); setToast({ kind: 'success', text: 'クリップを保存しました' }) })}><Clapperboard size={17} /></button></div></> : <div className="no-selection"><Radio size={22} /><div><strong>ゲームを選択</strong><span>プロファイルを適用して配信準備を開始</span></div></div>}
      </aside>}
      {editing && <ProfileEditor key={`${editing.id}:${editing.platformGroup}:${editing.state.thumbnailFilename ?? ''}`} profile={editing} onClose={() => setEditing(null)} onSave={async (profile) => { const wasSelected = status.selectedGameId === profile.id; const saved = await api.saveProfile(profile); setProfiles((current) => [...current.filter((item) => item.id !== saved.id), saved]); setStatus(await api.status()); setToast({ kind: 'success', text: wasSelected ? 'ゲーム設定を保存しました。配信前にゲームを選び直してください' : 'ゲーム設定を保存しました' }) }} onDelete={async () => { if (!window.confirm(`${editing.displayName}を削除しますか？`)) return; await api.deleteProfile(editing.id); setProfiles((current) => current.filter((item) => item.id !== editing.id)); setEditing(null) }} onThumbnail={(file, draft) => run(() => uploadThumbnail(draft, file))} />}
      {toast && <div className={`toast ${toast.kind}`}>{toast.kind === 'success' ? <Check size={17} /> : <AlertTriangle size={17} />}<span>{toast.text}</span><button onClick={() => setToast(null)}><X size={15} /></button></div>}
    </div>
  )
}
