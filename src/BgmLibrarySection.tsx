import { AlertTriangle, LoaderCircle, Music2, Pause, Play, SkipBack, Square, Trash2, Upload } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react'
import { STOCK_BGM_INPUT_NAME } from '../shared/bgm'
import type { BgmLibraryStatus, BgmTrack } from '../shared/contracts'
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

function trackFormat(track: BgmTrack): string {
  return track.filename.split('.').pop()?.toUpperCase() ?? 'AUDIO'
}

function Equalizer({ compact = false }: { compact?: boolean }) {
  return <span className={`bgm-equalizer ${compact ? 'compact' : ''}`} aria-hidden="true"><i /><i /><i /></span>
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
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [deletingTrackId, setDeletingTrackId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const receiveLibrary = useCallback((next: BgmLibraryStatus) => {
    setLibrary(next)
    setSelectedTrackId((current) => next.tracks.some((track) => track.id === current)
      ? current
      : next.tracks.some((track) => track.id === next.selectedTrackId)
        ? next.selectedTrackId
        : next.tracks[0]?.id ?? null)
  }, [])

  const load = useCallback(async () => {
    try { receiveLibrary(await api.bgm()) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
  }, [receiveLibrary])

  useEffect(() => {
    let cancelled = false
    void api.bgm()
      .then((value) => { if (!cancelled) receiveLibrary(value) })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { cancelled = true }
  }, [receiveLibrary])

  useEffect(() => {
    if (library?.playback.state !== 'playing') return
    const timer = window.setInterval(() => void load(), 2_000)
    return () => window.clearInterval(timer)
  }, [library?.playback.state, load])

  const selected = useMemo(() => library?.tracks.find((track) => track.id === selectedTrackId) ?? null, [library, selectedTrackId])
  const activeTrack = useMemo(() => library?.tracks.find((track) => track.id === library.selectedTrackId) ?? null, [library])
  const selectedIsActive = Boolean(selected && activeTrack?.id === selected.id)
  const selectedPlaybackState = selectedIsActive ? library?.playback.state ?? 'stopped' : 'stopped'
  const playbackLabel = selectedPlaybackState === 'playing' ? t('再生中') : selectedPlaybackState === 'paused' ? t('一時停止中') : t('停止中')

  const attempt = async (operation: () => Promise<BgmLibraryStatus>) => {
    setBusy(true)
    setError(null)
    try { receiveLibrary(await operation()) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }

  const playSelected = () => {
    if (!selected) return
    if (selectedIsActive && selectedPlaybackState === 'paused') void attempt(() => api.controlBgm('play'))
    else void attempt(() => api.playBgm(selected.id))
  }

  const upload = async (file: File) => {
    if (file.size > maxBgmTrackBytes) { setError(t('BGMは50 MB以下にしてください')); return }
    setUploading(true)
    try { await attempt(async () => api.addBgm(file.name, await fileAsBase64(file))) }
    finally { setUploading(false) }
  }

  const remove = async (track: BgmTrack, event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (!window.confirm(t('BGM「{track}」をストックから削除しますか？', { track: track.name }))) return
    setDeletingTrackId(track.id)
    try { await attempt(() => api.deleteBgm(track.id)) }
    finally { setDeletingTrackId(null) }
  }

  return <main className="bgm-view">
    <header className="bgm-view-header"><h2>{t('BGMストック')}</h2><span>{library?.tracks.length ?? 0}{t('曲')}</span><code>{t('OBSソース')}: {STOCK_BGM_INPUT_NAME}</code></header>
    {!obsConnected && <div className="inline-warning" role="status"><AlertTriangle size={14} /><span>{t('OBS未接続のため再生操作は使えません。曲の追加・選択・削除は行えます。')}</span></div>}
    {error && <div className="inline-warning error" role="alert"><AlertTriangle size={14} /><span>{error}</span></div>}

    <section className={`bgm-player-card state-${selectedPlaybackState}`}>
      <div className="bgm-player-summary">
        <span className="bgm-player-art">{selectedPlaybackState === 'playing' ? <Equalizer /> : <Music2 size={16} />}</span>
        <div><strong title={selected?.originalName}>{selected?.name ?? t('再生する曲を選択')}</strong><span className={`bgm-player-state state-${selectedPlaybackState}`}><span className="status-dot" />{playbackLabel}</span>{selectedIsActive && <code>{formatTime(library?.playback.cursorMs ?? null)} / {formatTime(library?.playback.durationMs ?? null)}</code>}</div>
      </div>
      <div className="bgm-transport">
        <button className="bgm-square-control" type="button" aria-label={t('先頭から再生')} disabled={busy || !obsConnected || !selected} onClick={() => selected && void attempt(() => selectedIsActive ? api.controlBgm('restart') : api.playBgm(selected.id))}><SkipBack size={14} fill="currentColor" /></button>
        <button className="bgm-primary-control" type="button" disabled={busy || !obsConnected || !selected} onClick={() => selectedPlaybackState === 'playing' ? void attempt(() => api.controlBgm('pause')) : playSelected()}>{selectedPlaybackState === 'playing' ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" />}{t(selectedPlaybackState === 'playing' ? '一時停止' : '再生')}</button>
        <button className="bgm-square-control" type="button" aria-label={t('停止')} disabled={busy || !obsConnected || !activeTrack || library?.playback.state === 'stopped'} onClick={() => void attempt(() => api.controlBgm('stop'))}><Square size={12} fill="currentColor" /></button>
      </div>
      <p>{t('全シーン共通のメディアソースで再生します。曲の行は選択のみ。再生は操作ボタンから行います。')}</p>
    </section>

    <div className="bgm-upload-row"><label className={`secondary-button file-button ${busy || uploading ? 'disabled' : ''}`}><Upload size={14} />{uploading ? t('アップロード中…') : t('曲を追加')}<input hidden type="file" disabled={busy || uploading} accept=".mp3,.wav,.ogg,.flac,.m4a,audio/mpeg,audio/wav,audio/ogg,audio/flac,audio/mp4" onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); event.currentTarget.value = '' }} /></label><span>MP3 / WAV / OGG / FLAC / M4A · {t('1曲50MBまで')}</span></div>

    {!library && !error && <div className="bgm-skeleton" aria-label={t('BGMストックを読み込んでいます')}>{[0, 1, 2].map((item) => <span key={item} />)}</div>}
    {library && library.tracks.length === 0 && <div className="bgm-empty"><Music2 size={22} /><strong>{t('まだ曲がありません')}</strong><span>{t('「曲を追加」からアップロードすると、配信中いつでもここから再生できます。')}</span></div>}
    {library && library.tracks.length > 0 && <div className="bgm-track-list">{library.tracks.map((track, index) => {
      const isSelected = track.id === selectedTrackId
      const isActive = track.id === activeTrack?.id
      const isPlaying = isActive && library.playback.state === 'playing'
      const isPaused = isActive && library.playback.state === 'paused'
      const deleting = deletingTrackId === track.id
      return <div className={`bgm-track-row ${isSelected ? 'selected' : ''} ${isActive ? 'active' : ''}`} key={track.id}>
        <button className="bgm-track-select" type="button" aria-pressed={isSelected} onClick={() => setSelectedTrackId(track.id)}>
          <span className="bgm-track-index">{isPlaying ? <Equalizer compact /> : index + 1}</span>
          <span className="bgm-track-copy"><span><strong>{track.name}</strong>{isSelected && <b>{t('選択中')}</b>}{deleting && <em>{t('削除中…')}</em>}</span><small>{formatBytes(track.size)} · {trackFormat(track)}{isActive && library.playback.durationMs !== null ? ` · ${formatTime(library.playback.durationMs)}` : ''}</small></span>
        </button>
        <button className={`bgm-row-control ${isPlaying ? 'is-playing' : ''}`} type="button" aria-label={t(isPlaying ? '{track}を一時停止' : '{track}を再生', { track: track.name })} disabled={busy || !obsConnected} onClick={(event) => { event.stopPropagation(); setSelectedTrackId(track.id); if (isPlaying) void attempt(() => api.controlBgm('pause')); else if (isPaused) void attempt(() => api.controlBgm('play')); else void attempt(() => api.playBgm(track.id)) }}>{isPlaying ? <Pause size={11} fill="currentColor" /> : <Play size={11} fill="currentColor" />}</button>
        <button className="bgm-row-delete" type="button" aria-label={t('{track}を削除', { track: track.name })} disabled={busy} onClick={(event) => void remove(track, event)}>{deleting ? <LoaderCircle className="spin" size={12} /> : <Trash2 size={12} />}</button>
      </div>
    })}</div>}
  </main>
}
