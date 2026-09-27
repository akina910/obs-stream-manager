import { AlertTriangle, Check, Image as ImageIcon, LoaderCircle, LockKeyhole, Trash2, Upload } from 'lucide-react'
import { useMemo, useRef, useState, type CSSProperties } from 'react'
import { renderCommonTemplateText, type CommonTemplateConfig } from '../shared/common-template'
import type { GameProfile } from '../shared/contracts'
import { api, type CommonTemplateSettings } from './api'
import { useI18n } from './i18n'

type TemplateStep = 'image' | 'text' | 'position' | 'apply'

type CommonTemplateEditorProps = {
  config: CommonTemplateConfig
  profiles: GameProfile[]
  disabled: boolean
  onChanged: (config: CommonTemplateConfig, feedback: { kind: 'success' | 'warning'; text: string }) => void
  onProfileChanged: (profile: GameProfile) => Promise<void>
}

const steps: Array<{ id: TemplateStep; label: string }> = [
  { id: 'image', label: '素材' },
  { id: 'text', label: '文字' },
  { id: 'position', label: '配置' },
  { id: 'apply', label: 'OBS反映' },
]

const positionCells = [
  { x: 8, y: 10, label: '左上' }, { x: 50, y: 10, label: '上中央' }, { x: 92, y: 10, label: '右上' },
  { x: 8, y: 50, label: '左中央' }, { x: 50, y: 50, label: '中央' }, { x: 92, y: 50, label: '右中央' },
  { x: 8, y: 90, label: '左下' }, { x: 50, y: 90, label: '下中央' }, { x: 92, y: 90, label: '右下' },
]

const templateFonts = ['DM Sans', 'Noto Sans JP', 'IBM Plex Mono', 'Yu Gothic UI']

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

function gameTemplateLabel(profile: GameProfile): string {
  return profile.presentation?.templateLabel ?? ''
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

export function CommonTemplateEditor({ config, profiles, disabled, onChanged, onProfileChanged }: CommonTemplateEditorProps) {
  const { t } = useI18n()
  const [draft, setDraft] = useState(() => editableSettings(config))
  const [step, setStep] = useState<TemplateStep>('text')
  const [previewTarget, setPreviewTarget] = useState('common')
  const [gameLabelDrafts, setGameLabelDrafts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const operationLock = useRef(false)
  const previewProfileBase = previewTarget === 'common' ? profiles[0] : profiles.find((profile) => profile.id === previewTarget) ?? profiles[0]
  const previewProfile = previewProfileBase && previewTarget !== 'common'
    ? { ...previewProfileBase, presentation: { ...previewProfileBase.presentation, templateLabel: gameLabelDrafts[previewProfileBase.id] ?? gameTemplateLabel(previewProfileBase) } }
    : previewProfileBase
  const previewText = previewProfile ? renderCommonTemplateText({ ...config, ...draft }, {
    displayName: previewProfile.displayName,
    presentation: { templateLabel: gameTemplateLabel(previewProfile) },
    state: { nextPartNumber: previewProfile.state?.nextPartNumber ?? 1 },
  }) : draft.textTemplate
  const imageUrl = config.imageFilename ? `/api/templates/common/image?v=${encodeURIComponent(config.imageUpdatedAt ?? config.imageFilename)}` : null
  const dirty = JSON.stringify(draft) !== JSON.stringify(editableSettings(config))
  const locked = disabled || busy
  const transformX = draft.horizontalAlign === 'left' ? '0%' : draft.horizontalAlign === 'right' ? '-100%' : '-50%'
  const transformY = draft.verticalAlign === 'top' ? '0%' : draft.verticalAlign === 'bottom' ? '-100%' : '-50%'
  const outlineSize = draft.outlineWidth / 19.2
  const previewStyle = useMemo<CSSProperties>(() => ({
    left: `${draft.positionX}%`,
    top: `${draft.positionY}%`,
    transform: `translate(${transformX}, ${transformY})`,
    color: draft.textColor,
    fontFamily: draft.fontFamily,
    fontSize: `${draft.fontSize / 19.2}cqw`,
    textAlign: draft.horizontalAlign,
    textShadow: outlineSize === 0 ? 'none' : [
      `${outlineSize}cqw 0 ${draft.outlineColor}`, `-${outlineSize}cqw 0 ${draft.outlineColor}`,
      `0 ${outlineSize}cqw ${draft.outlineColor}`, `0 -${outlineSize}cqw ${draft.outlineColor}`,
      `${outlineSize}cqw ${outlineSize}cqw ${draft.outlineColor}`, `-${outlineSize}cqw -${outlineSize}cqw ${draft.outlineColor}`,
      `${outlineSize}cqw -${outlineSize}cqw ${draft.outlineColor}`, `-${outlineSize}cqw ${outlineSize}cqw ${draft.outlineColor}`,
    ].join(', '),
  }), [draft.fontFamily, draft.fontSize, draft.horizontalAlign, draft.outlineColor, draft.positionX, draft.positionY, draft.textColor, outlineSize, transformX, transformY])

  const execute = async (operation: () => Promise<void>) => {
    if (operationLock.current || disabled) return
    operationLock.current = true
    setBusy(true)
    setError(null)
    setMessage(null)
    try { await operation() }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
    finally { operationLock.current = false; setBusy(false) }
  }

  const save = () => execute(async () => {
    const saved = await api.saveCommonTemplate(draft)
    setDraft(editableSettings(saved))
    onChanged(saved, { kind: 'success', text: t('共通テンプレートを保存しました') })
  })

  const upload = (file: File) => execute(async () => {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error(t('PNG、JPG、WEBPを選択してください'))
    if (file.size > 12 * 1024 * 1024) throw new Error(t('共通テンプレート画像は12MB以下にしてください'))
    setUploading(true)
    try {
      const saved = await api.uploadCommonTemplateImage(file.type, await fileAsBase64(file, t('共通テンプレート画像の読み込みに失敗しました')), file.name)
      setDraft(editableSettings(saved))
      onChanged(saved, { kind: 'success', text: t('共通テンプレート画像を登録しました') })
    } finally { setUploading(false) }
  })

  const remove = () => execute(async () => {
    if (!window.confirm(t('共通テンプレート画像を削除しますか？文字設定は残ります。'))) return
    const saved = await api.deleteCommonTemplateImage()
    setDraft(editableSettings(saved))
    onChanged(saved, { kind: 'success', text: t('共通テンプレート画像を削除しました') })
  })

  const applyAll = () => execute(async () => {
    if (dirty) throw new Error(t('先に未保存の変更を保存してください'))
    const result = await api.applyCommonTemplate()
    setMessage(t('{count}件のゲームへ共通テンプレートを反映しました', { count: result.rendered }))
  })

  const updateGameLabel = (value: string) => {
    if (!previewProfile || previewTarget === 'common') return
    if (value === gameTemplateLabel(previewProfile)) return
    const changed = { ...previewProfile, presentation: { ...previewProfile.presentation, templateLabel: value } }
    void execute(async () => {
      await onProfileChanged(changed)
      setGameLabelDrafts((current) => {
        const next = { ...current }
        delete next[changed.id]
        return next
      })
    })
  }

  return <section className="settings-card common-template-card">
    <div className="card-title-row"><h2>{t('共通配信画面テンプレート')}</h2><span className={`connection-label ${dirty ? 'pending' : 'optional'}`}><span className="status-dot" />{t(dirty ? '未保存の変更あり' : '保存済み')}</span></div>
    {disabled && <div className="inline-warning"><LockKeyhole size={14} /><span>{t('配信中は編集できません。プレビューのみ確認できます。')}</span></div>}
    {error && <div className="inline-warning error" role="alert"><AlertTriangle size={14} /><span>{error}</span></div>}
    {message && <div className="inline-warning template-success" role="status"><Check size={14} /><span>{message}</span></div>}

    <div className="template-preview-targets"><span>{t('プレビュー')}</span><button className={previewTarget === 'common' ? 'active' : ''} type="button" onClick={() => setPreviewTarget('common')}>{t('共通')}</button>{profiles.map((profile) => <button className={previewTarget === profile.id ? 'active' : ''} type="button" key={profile.id} onClick={() => setPreviewTarget(profile.id)}>{gameTemplateLabel(profile) || profile.displayName}</button>)}</div>
    <div className={`common-template-preview ${imageUrl ? 'has-image' : 'no-image'} ${uploading ? 'is-uploading' : ''}`} aria-label={t('共通テンプレートのプレビュー')}>
      {imageUrl ? <img src={imageUrl} alt="" /> : <div className="common-template-empty"><ImageIcon size={22} /><strong>{t('背景画像なし')}</strong><span>{t('文字のみで反映できます')}</span></div>}
      <span style={previewStyle}>{previewText}</span>
      {uploading && <div className="template-upload-overlay"><LoaderCircle className="spin" size={18} />{t('アップロード中…')}</div>}
    </div>

    {previewTarget !== 'common' && previewProfile && <label className="template-game-label">{t('配信画面ラベル')}<input value={gameLabelDrafts[previewProfile.id] ?? gameTemplateLabel(previewProfile)} disabled={locked} placeholder={previewProfile.displayName} onChange={(event) => setGameLabelDrafts((current) => ({ ...current, [previewProfile.id]: event.target.value }))} onBlur={(event) => updateGameLabel(event.target.value)} /><span>{t('空欄ならゲーム名をそのまま使用')}</span></label>}

    <div className="template-step-tabs" role="tablist" aria-label={t('テンプレート編集ステップ')}>{steps.map((item) => <button role="tab" aria-selected={step === item.id} className={step === item.id ? 'active' : ''} type="button" key={item.id} onClick={() => setStep(item.id)}>{t(item.label)}</button>)}</div>

    <div className="common-template-controls">
      {step === 'image' && <div className="template-step-content"><div className="button-row"><button className="secondary-button" type="button" disabled={locked} onClick={() => fileRef.current?.click()}><Upload size={14} />{t(imageUrl ? '背景画像を変更' : '背景画像を登録')}</button>{imageUrl && <button className="ghost-button" type="button" disabled={locked} onClick={() => void remove()}><Trash2 size={14} />{t('画像を削除')}</button>}</div><input ref={fileRef} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); event.currentTarget.value = '' }} /><p>{t('PNG / JPEG / WEBP・最大12MB。1920×1080推奨。画像がなくても文字だけで反映できます。')}</p></div>}

      {step === 'text' && <div className="template-step-content template-field-grid"><label className="full-span">{t('表示文字')}<span>{t('{game} {part} {date} {time} {datetime} が使えます')}</span><input className="template-text-input" value={draft.textTemplate} disabled={locked} onChange={(event) => setDraft({ ...draft, textTemplate: event.target.value })} /></label><label>{t('フォント')}<select value={draft.fontFamily} disabled={locked} onChange={(event) => setDraft({ ...draft, fontFamily: event.target.value })}>{!templateFonts.includes(draft.fontFamily) && <option>{draft.fontFamily}</option>}{templateFonts.map((font) => <option key={font}>{font}</option>)}</select></label><label>{t('サイズ')}<div className="template-range"><input type="range" min="12" max="400" step="2" value={draft.fontSize} disabled={locked} onChange={(event) => setDraft({ ...draft, fontSize: Number(event.target.value) })} /><code>{draft.fontSize}px</code></div></label><label>{t('文字色')}<input type="color" value={draft.textColor} disabled={locked} onChange={(event) => setDraft({ ...draft, textColor: event.target.value })} /></label><label>{t('縁取り')}<div className="template-outline-row"><ToggleSwitch checked={draft.outlineWidth > 0} disabled={locked} onChange={(checked) => setDraft({ ...draft, outlineWidth: checked ? Math.max(4, draft.outlineWidth) : 0 })} /><span>{t(draft.outlineWidth > 0 ? 'あり' : 'なし')}</span><input aria-label={t('縁取り色')} type="color" value={draft.outlineColor} disabled={locked || draft.outlineWidth === 0} onChange={(event) => setDraft({ ...draft, outlineColor: event.target.value })} /></div></label></div>}

      {step === 'position' && <div className="template-step-content template-position-controls"><div><span>{t('位置')}</span><div className="template-position-grid">{positionCells.map((cell) => <button type="button" aria-label={t(cell.label)} className={draft.positionX === cell.x && draft.positionY === cell.y ? 'active' : ''} disabled={locked} key={cell.label} onClick={() => setDraft({ ...draft, positionX: cell.x, positionY: cell.y, horizontalAlign: cell.x < 50 ? 'left' : cell.x > 50 ? 'right' : 'center', verticalAlign: cell.y < 50 ? 'top' : cell.y > 50 ? 'bottom' : 'center' })}><i /></button>)}</div></div><div><span>{t('整列')}</span><div className="template-align-tabs">{(['left', 'center', 'right'] as const).map((align) => <button type="button" className={draft.horizontalAlign === align ? 'active' : ''} disabled={locked} key={align} onClick={() => setDraft({ ...draft, horizontalAlign: align })}>{t(align === 'left' ? '左' : align === 'center' ? '中央' : '右')}</button>)}</div></div></div>}

      {step === 'apply' && <div className="template-step-content template-apply"><div>{t('OBS画像ソース')}: <code>{draft.obsSourceName}</code></div><label>{t('OBS画像ソース名')}<input value={draft.obsSourceName} disabled={locked} onChange={(event) => setDraft({ ...draft, obsSourceName: event.target.value })} /></label><label className="template-enabled-row"><ToggleSwitch checked={draft.enabled} disabled={locked} onChange={(enabled) => setDraft({ ...draft, enabled })} /><span>{t('ゲーム選択時にテンプレートを自動反映')}</span></label><div className="button-row"><button className="primary-button" type="button" disabled={locked || !dirty} onClick={() => void save()}>{busy ? <LoaderCircle className="spin" size={14} /> : null}{t('保存')}</button><button className="secondary-button" type="button" disabled={locked || dirty || !draft.enabled || !profiles.length} onClick={() => void applyAll()}>{t('全ゲームへ反映')}</button></div></div>}
    </div>
  </section>
}

function ToggleSwitch({ checked, disabled, onChange }: { checked: boolean; disabled: boolean; onChange: (checked: boolean) => void }) {
  return <button className="compact-switch" type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}><span /></button>
}
