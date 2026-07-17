import { Download, ExternalLink, LoaderCircle, RefreshCw, RotateCw } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { RuntimeStatus } from '../shared/contracts'
import type { DesktopUpdatePhase, DesktopUpdateState, UpdateBlockReason } from '../shared/update-contracts'
import { useI18n } from './i18n'
import { getDesktopUpdateAction, type DesktopUpdateAction } from './update-ui'

const phaseMessages: Record<DesktopUpdatePhase, string> = {
  idle: '更新を確認していません',
  checking: '更新を確認しています',
  'up-to-date': 'このアプリは最新です',
  available: '新しいバージョンを利用できます',
  downloading: '更新をダウンロードしています',
  downloaded: '更新の準備ができました',
  installing: '更新を開始しています',
  error: '更新を確認できませんでした',
  unsupported: 'この開発版では更新機能を利用できません',
}

const actionLabels: Record<Exclude<DesktopUpdateAction, 'none'>, string> = {
  check: '更新を確認',
  download: '更新をダウンロード',
  install: '再起動して更新',
  'open-releases': 'ダウンロードページを開く',
}

const blockMessages: Record<UpdateBlockReason, string> = {
  streaming: '配信を終了してから更新してください',
  recording: '録画を停止してから更新してください',
  'replay-buffer': 'リプレイバッファを停止してから更新してください',
  busy: '処理が完了してから更新してください',
  'external-live': 'YouTubeとTwitchの配信を終了してから更新してください',
  'status-unavailable': '配信状態を確認できません。少し待ってからもう一度押してください',
}

function ActionIcon({ action, busy }: { action: DesktopUpdateAction; busy: boolean }) {
  if (busy) return <LoaderCircle className="spin" size={15} />
  if (action === 'download') return <Download size={15} />
  if (action === 'install') return <RotateCw size={15} />
  if (action === 'open-releases') return <ExternalLink size={15} />
  return <RefreshCw size={15} />
}

export function DesktopUpdateControl({ status }: { status: RuntimeStatus }) {
  const { t } = useI18n()
  const desktop = window.obsStreamManagerDesktop
  const [state, setState] = useState<DesktopUpdateState | null>(null)
  const [requestBusy, setRequestBusy] = useState(false)
  const [requestError, setRequestError] = useState<string | null>(null)

  useEffect(() => {
    if (!desktop) return
    let active = true
    const unsubscribe = desktop.onUpdateState((next) => { if (active) setState(next) })
    void desktop.getUpdateState()
      .then((next) => { if (active) setState(next) })
      .catch((error) => { if (active) setRequestError(error instanceof Error ? error.message : String(error)) })
    return () => {
      active = false
      unsubscribe()
    }
  }, [desktop])

  const actionState = useMemo(
    () => state ? getDesktopUpdateAction(state, status) : { action: 'none' as const, disabled: true },
    [state, status],
  )
  if (!desktop) return null

  const runAction = async () => {
    if (!state || actionState.action === 'none' || actionState.disabled || requestBusy) return
    setRequestBusy(true)
    setRequestError(null)
    try {
      const next = actionState.action === 'check'
        ? await desktop.checkForUpdates()
        : actionState.action === 'download'
          ? await desktop.downloadUpdate()
          : actionState.action === 'install'
            ? await desktop.installUpdate()
            : null
      if (next) setState(next)
      else await desktop.openReleasePage()
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : String(error))
    } finally {
      setRequestBusy(false)
    }
  }

  const activeBlockReason = actionState.blockReason ?? state?.blockReason
  const phase = state?.phase ?? 'checking'
  const progress = Math.round(state?.progressPercent ?? 0)
  const operationBusy = requestBusy || ['checking', 'downloading', 'installing'].includes(phase)

  return <section className="settings-card update-card" aria-live="polite">
    <div className="card-title-row">
      <h2>{t('アプリの更新')}</h2>
      {state && <span className={`connection-label update-${phase}`}>{t(state.errorKind === 'no-release' ? '公開済みの更新はまだありません' : phaseMessages[phase])}</span>}
    </div>
    <p>{t('更新は自動で開始されません。確認、ダウンロード、再起動はこの画面から行います。')}</p>
    {state && <div className="update-version-grid">
      <div><span>{t('現在のバージョン')}</span><strong>v{state.currentVersion}</strong></div>
      {state.availableVersion && <div><span>{t('利用できるバージョン')}</span><strong>v{state.availableVersion}</strong></div>}
    </div>}
    {phase === 'downloading' && <div className="update-progress">
      <div><span>{t('ダウンロード {percent}%', { percent: progress })}</span><strong>{progress}%</strong></div>
      <progress max={100} value={progress} />
    </div>}
    {state?.availableVersion && <details className="settings-details update-notes" open={phase === 'available'}>
      <summary>{t('変更内容')}</summary>
      <div className="settings-details-body"><p>{state.releaseNotes || t('変更内容はありません')}</p></div>
    </details>}
    {!state?.installSupported && state?.phase !== 'unsupported' && <p className="update-edition-note">{t('インストーラー版ではアプリ内で更新できます。Portable版はダウンロードページから最新版を取得してください。')}</p>}
    {activeBlockReason && <div className="inline-warning"><span>{t(blockMessages[activeBlockReason])}</span></div>}
    {(requestError || state?.errorMessage) && <details className="settings-details update-error"><summary>{t('エラー詳細')}</summary><div className="settings-details-body"><code>{requestError || state?.errorMessage}</code></div></details>}
    {state?.phase === 'downloaded' && <p>{t('更新するとアプリを再起動します。設定、ゲーム、接続情報はそのまま維持されます。')}</p>}
    {actionState.action !== 'none' && <button
      className={actionState.action === 'install' ? 'primary-button' : 'secondary-button'}
      disabled={actionState.disabled || requestBusy}
      onClick={() => void runAction()}
    >
      <ActionIcon action={actionState.action} busy={operationBusy} />
      {t(actionLabels[actionState.action])}
    </button>}
  </section>
}
