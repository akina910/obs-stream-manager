import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Image as ImageIcon, LoaderCircle, Trash2, Upload } from 'lucide-react'
import { renderCommonTemplateText, type CommonTemplateConfig } from '../shared/common-template'
import type { GameProfile } from '../shared/contracts'
import { api, type CommonTemplateSettings } from './api'
import { useI18n } from './i18n'

type CommonTemplateEditorProps = {
  config: CommonTemplateConfig
  profiles: GameProfile[]
  disabled: boolean
  onChanged: (config: CommonTemplateConfig) => void
}

function editableSettings(config: CommonTemplateConfig): CommonTemplateSettings {
  return {
    enabled: config.enabled,
    obsSourceName: config.obsSourceName,
    textTemplate: config.textTemplate,
    fontFamily: config.fontFamily,
    fontSize: config.fontSize,
    textColor: config.textColor,
    outlineColor: config.outlineColor,
    outlineWidth: config.outlineWidth,
    horizontalAlign: config.horizontalAlign,
    verticalAlign: config.verticalAlign,
    positionX: config.positionX,
    positionY: config.positionY,
  }
}

function fileAsBase64(file: File, errorMessage: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const encoded = String(reader.result).split(',')[1]
      if (encoded) resolve(encoded)
      else reject(new Error(errorMessage))
    }
    reader.onerror = () => reject(new Error(errorMessage))
    reader.readAsDataURL(file)
  })
}

export function CommonTemplateEditor({ config, profiles, disabled, onChanged }: CommonTemplateEditorProps) {
  const { t } = useI18n()
  const [draft, setDraft] = useState(() => editableSettings(config))
  const [previewProfileId, setPreviewProfileId] = useState(profiles[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const previewImageRef = useRef<HTMLImageElement>(null)
  const [previewScale, setPreviewScale] = useState(1)
  const [previewAspectRatio, setPreviewAspectRatio] = useState<string | undefined>()
  const previewProfile = profiles.find((profile) => profile.id === previewProfileId) ?? profiles[0]
  const previewText = previewProfile ? renderCommonTemplateText({ ...config, ...draft }, previewProfile) : draft.textTemplate
  const imageUrl = config.imageFilename ? `/api/templates/common/image?v=${encodeURIComponent(config.imageUpdatedAt ?? config.imageFilename)}` : null
  const transformX = draft.horizontalAlign === 'left' ? '0%' : draft.horizontalAlign === 'right' ? '-100%' : '-50%'
  const transformY = draft.verticalAlign === 'top' ? '0%' : draft.verticalAlign === 'bottom' ? '-100%' : '-50%'
  useEffect(() => {
    const preview = previewRef.current
    const image = previewImageRef.current
    if (!preview || !imageUrl || !image) return
    const updateScale = () => {
      if (!image.naturalWidth) return
      const nextScale = preview.clientWidth / image.naturalWidth
      setPreviewScale((currentScale) => Math.abs(currentScale - nextScale) < 0.001 ? currentScale : nextScale)
    }
    const observer = new ResizeObserver(updateScale)
    observer.observe(preview)
    updateScale()
    return () => observer.disconnect()
  }, [imageUrl])
  const previewStyle = useMemo<CSSProperties>(() => ({
    left: `${draft.positionX}%`,
    top: `${draft.positionY}%`,
    transform: `translate(${transformX}, ${transformY})`,
    color: draft.textColor,
    WebkitTextStroke: `${Math.max(0, draft.outlineWidth * previewScale)}px ${draft.outlineColor}`,
    fontFamily: draft.fontFamily,
    fontSize: `${Math.max(1, draft.fontSize * previewScale)}px`,
    textAlign: draft.horizontalAlign,
  }), [draft.fontFamily, draft.fontSize, draft.horizontalAlign, draft.outlineColor, draft.outlineWidth, draft.positionX, draft.positionY, draft.textColor, previewScale, transformX, transformY])

  const execute = async (operation: () => Promise<void>) => {
    if (busy || disabled) return
    setBusy(true)
    setError(null)
    setMessage(null)
    try { await operation() }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
    finally { setBusy(false) }
  }
  const save = () => execute(async () => {
    const saved = await api.saveCommonTemplate(draft)
    onChanged(saved)
    setMessage(t('共通テンプレートを保存し、全ゲーム分の画像を更新しました'))
  })
  const upload = (file: File) => execute(async () => {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error(t('PNG、JPG、WEBPを選択してください'))
    if (file.size > 12 * 1024 * 1024) throw new Error(t('共通テンプレート画像は12MB以下にしてください'))
    const saved = await api.uploadCommonTemplateImage(file.type, await fileAsBase64(file, t('共通テンプレート画像の読み込みに失敗しました')), file.name)
    onChanged(saved)
    setMessage(t('共通テンプレート画像を登録しました'))
  })
  const remove = () => execute(async () => {
    if (!window.confirm(t('共通テンプレート画像と生成済み画像を削除しますか？'))) return
    const saved = await api.deleteCommonTemplateImage()
    setDraft(editableSettings(saved))
    onChanged(saved)
    setMessage(t('共通テンプレート画像を削除しました'))
  })
  const applyAll = () => execute(async () => {
    const result = await api.applyCommonTemplate()
    setMessage(t('{count}件のゲームへ共通テンプレートを適用しました', { count: result.rendered }))
  })

  return <section className="settings-card common-template-card">
    <div className="card-title-row"><ImageIcon size={18} /><h2>{t('共通配信テンプレート')}</h2><span className={`connection-label ${draft.enabled && config.imageFilename ? 'connected' : 'optional'}`}>{t(draft.enabled ? '全ゲームへ適用' : '無効')}</span></div>
    <p>{t('共通の配信画面を1枚登録し、ゲーム名などの文字だけをプロファイルごとに差し替えます。')}</p>
    {error && <div className="inline-warning error" role="alert">{error}</div>}
    {message && <div className="inline-warning template-success" role="status">{message}</div>}
    <div className="common-template-layout">
      <div ref={previewRef} className="common-template-preview" style={{ aspectRatio: previewAspectRatio }} aria-label={t('共通テンプレートのプレビュー')}>
        {imageUrl ? <img ref={previewImageRef} src={imageUrl} alt={t('登録済みの共通テンプレート背景')} onLoad={(event) => {
          setPreviewScale(event.currentTarget.clientWidth / event.currentTarget.naturalWidth)
          setPreviewAspectRatio(`${event.currentTarget.naturalWidth} / ${event.currentTarget.naturalHeight}`)
        }} /> : <div className="common-template-empty"><ImageIcon size={24} /><span>{t('背景画像を登録してください')}</span></div>}
        {imageUrl && <span style={previewStyle}>{previewText}</span>}
      </div>
      <div className="common-template-controls">
        <label className="native-toggle"><input type="checkbox" checked={draft.enabled} disabled={disabled || busy || !config.imageFilename} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /><span>{t('全プロファイルで有効')}</span></label>
        <label>{t('プレビューするゲーム')}<select value={previewProfile?.id ?? ''} disabled={!profiles.length} onChange={(event) => setPreviewProfileId(event.target.value)}>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.displayName}</option>)}</select></label>
        <label>{t('表示文字テンプレート')}<input value={draft.textTemplate} onChange={(event) => setDraft({ ...draft, textTemplate: event.target.value })} /><span className="field-hint">{t('例: {game} / Part {part}。ゲーム別の表示名は各プロファイルで変更できます。')}</span></label>
        <label>{t('OBS画像ソース名')}<input value={draft.obsSourceName} onChange={(event) => setDraft({ ...draft, obsSourceName: event.target.value })} /><span className="field-hint">{t('OBS側に同じ名前の画像ソースを作成してください')}</span></label>
        <div className="field-grid"><label>{t('フォント')}<input value={draft.fontFamily} onChange={(event) => setDraft({ ...draft, fontFamily: event.target.value })} /></label><label>{t('文字サイズ')}<input type="number" min="12" max="400" value={draft.fontSize} onChange={(event) => setDraft({ ...draft, fontSize: Number(event.target.value) })} /></label></div>
        <div className="field-grid"><label>{t('文字色')}<input type="color" value={draft.textColor} onChange={(event) => setDraft({ ...draft, textColor: event.target.value })} /></label><label>{t('縁取り色')}<input type="color" value={draft.outlineColor} onChange={(event) => setDraft({ ...draft, outlineColor: event.target.value })} /></label></div>
        <label>{t('縁取り幅')}<input type="range" min="0" max="20" value={draft.outlineWidth} onChange={(event) => setDraft({ ...draft, outlineWidth: Number(event.target.value) })} /><span>{draft.outlineWidth}px</span></label>
        <div className="field-grid"><label>{t('横位置')}<input type="range" min="0" max="100" value={draft.positionX} onChange={(event) => setDraft({ ...draft, positionX: Number(event.target.value) })} /><span>{draft.positionX}%</span></label><label>{t('縦位置')}<input type="range" min="0" max="100" value={draft.positionY} onChange={(event) => setDraft({ ...draft, positionY: Number(event.target.value) })} /><span>{draft.positionY}%</span></label></div>
        <div className="field-grid"><label>{t('横揃え')}<select value={draft.horizontalAlign} onChange={(event) => setDraft({ ...draft, horizontalAlign: event.target.value as CommonTemplateSettings['horizontalAlign'] })}><option value="left">{t('左')}</option><option value="center">{t('中央')}</option><option value="right">{t('右')}</option></select></label><label>{t('縦揃え')}<select value={draft.verticalAlign} onChange={(event) => setDraft({ ...draft, verticalAlign: event.target.value as CommonTemplateSettings['verticalAlign'] })}><option value="top">{t('上')}</option><option value="center">{t('中央')}</option><option value="bottom">{t('下')}</option></select></label></div>
      </div>
    </div>
    <div className="button-row common-template-actions">
      <button className="secondary-button" disabled={disabled || busy} onClick={() => fileRef.current?.click()}><Upload size={14} />{t(config.imageFilename ? '背景画像を差し替え' : '背景画像を登録')}</button>
      <input ref={fileRef} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); event.currentTarget.value = '' }} />
      <button className="primary-button" disabled={disabled || busy || (draft.enabled && !config.imageFilename)} onClick={() => void save()}>{busy ? <LoaderCircle className="spin" size={14} /> : null}{t('設定を保存')}</button>
      <button className="secondary-button" disabled={disabled || busy || !config.enabled || !config.imageFilename || !profiles.length} onClick={() => void applyAll()}>{t('今すぐ全ゲームへ適用')}</button>
      {config.imageFilename && <button className="danger-outline" disabled={disabled || busy} onClick={() => void remove()}><Trash2 size={14} />{t('画像を削除')}</button>}
    </div>
    <p className="field-hint">{t('PNG / JPG / WEBP・最大12MB。ゲーム選択時に生成済みPNGを指定したOBS画像ソースへ自動設定します。')}</p>
  </section>
}
