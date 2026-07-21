import { LoaderCircle, Music2, Pause, Play, RotateCw, Square, Trash2, Upload } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { BgmLibraryStatus } from '../shared/contracts'
import { api } from './api'
import { useI18n } from './i18n'

const maxBgmTrackBytes = 50 * 1024 * 1024

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`
}

function formatTime(milliseconds: number | null): string {
  if (milliseconds === null) return '--:--'
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

async function fileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const encoded = String(reader.result).split(',')[1]
      if (encoded) resolve(encoded)
      else reject(new Error('BGMファイルを読み込めませんでした'))
    }
    reader.onerror = () => reject(new Error('BGMファイルを読み込めませんでした'))
    reader.readAsDataURL(file)
  })
}

export function BgmLibrarySection({ obsConnected }: { obsConnected: boolean }) {
  const { t } = useI18n()
  const [library, setLibrary] = useState<BgmLibraryStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try { setLibrary(await api.bgm()) } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
  }, [])

  useEffect(() => {
    let cancelled = false
    void api.bgm()
      .then((value) => { if (!cancelled) setLibrary(value) })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { cancelled = true }
  }, [])
  useEffect(() => {
    if (library?.playback.state !== 'playing') return
    const timer = window.setInterval(() => void load(), 2_000)
    return () => window.clearInterval(timer)
  }, [library?.playback.state, load])

  const selected = useMemo(() => library?.tracks.find((track) => track.id === library.selectedTrackId) ?? null, [library])
  const attempt = async (operation: () => Promise<BgmLibraryStatus>) => {
    setBusy(true)
    setError(null)
    try { setLibrary(await operation()) } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) } finally { setBusy(false) }
  }
  const upload = async (file: File) => {
    if (file.size > maxBgmTrackBytes) { setError(t('BGMは50 MB以下にしてください')); return }
    await attempt(async () => api.addBgm(file.name, await fileAsBase64(file)))
  }

  const playbackLabel = library?.playback.state === 'playing'
    ? t('再生中')
    : library?.playback.state === 'paused'
      ? t('一時停止中')
      : t('停止中')

  return <section className="settings-card bgm-library-card">
    <div className="card-title-row">
      <h2><Music2 size={15} />{t('BGMストック')}</h2>
      <span className={`connection-label ${library?.playback.state === 'playing' ? 'connected' : 'optional'}`}>{playbackLabel}</span>
    </div>
    <p>{t('MP3などを保存し、OBSの全シーンで共通のBGMとして選んで再生できます。曲は自動でループします。')}</p>
    {selected && <div className="bgm-now-playing">
      <div><span>{t('選択中')}</span><strong title={selected.originalName}>{selected.name}</strong></div>
      <code>{formatTime(library?.playback.cursorMs ?? null)} / {formatTime(library?.playback.durationMs ?? null)}</code>
    </div>}
    <div className="bgm-controls">
      <button className="secondary-button" disabled={busy || !obsConnected || !selected} onClick={() => void attempt(() => api.controlBgm('play'))}><Play size={14} fill="currentColor" />{t('再生')}</button>
      <button className="ghost-button" disabled={busy || !obsConnected || library?.playback.state !== 'playing'} onClick={() => void attempt(() => api.controlBgm('pause'))}><Pause size={14} />{t('一時停止')}</button>
      <button className="ghost-button" disabled={busy || !obsConnected || !selected} onClick={() => void attempt(() => api.controlBgm('stop'))}><Square size={13} fill="currentColor" />{t('停止')}</button>
      <button className="square-button" aria-label={t('BGMを先頭から再生')} title={t('先頭から再生')} disabled={busy || !obsConnected || !selected} onClick={() => void attempt(() => api.controlBgm('restart'))}><RotateCw size={14} /></button>
    </div>
    <div className="bgm-stock-list">
      {library?.tracks.map((track) => <div className={`bgm-stock-row ${track.id === library.selectedTrackId ? 'selected' : ''}`} key={track.id}>
        <button className="bgm-track-select" disabled={busy || !obsConnected} onClick={() => void attempt(() => api.playBgm(track.id))}>
          <Music2 size={14} />
          <span><strong>{track.name}</strong><small>{formatBytes(track.size)}</small></span>
          {track.id === library.selectedTrackId && <b>{t('選択中')}</b>}
        </button>
        <button className="square-button" aria-label={t('{track}を削除', { track: track.name })} disabled={busy} onClick={() => { if (window.confirm(t('BGM「{track}」をストックから削除しますか？', { track: track.name }))) void attempt(() => api.deleteBgm(track.id)) }}><Trash2 size={13} /></button>
      </div>)}
      {library && library.tracks.length === 0 && <div className="bgm-empty"><Music2 size={20} /><span>{t('BGMはまだ登録されていません')}</span></div>}
      {!library && !error && <div className="bgm-empty"><LoaderCircle className="spin" size={18} /><span>{t('BGMストックを読み込んでいます')}</span></div>}
    </div>
    {error && <div className="oauth-error" role="alert">{error}</div>}
    <label className={`secondary-button file-button bgm-upload ${busy ? 'disabled' : ''}`}><Upload size={14} />{busy ? t('処理中') : t('BGMを追加')}<input hidden type="file" disabled={busy} accept=".mp3,.wav,.ogg,.flac,.m4a,audio/mpeg,audio/wav,audio/ogg,audio/flac,audio/mp4" onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); event.currentTarget.value = '' }} /></label>
  </section>
}
