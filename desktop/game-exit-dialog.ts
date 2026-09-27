import type { GameExitAction, GameExitPrompt, GameExitResponse } from '../shared/game-exit.js'

export const gameExitPollIntervalMs = 5_000

export function gameExitDialogOptions(prompt: GameExitPrompt, signal: AbortSignal, now = Date.now()) {
  const output = prompt.kind === 'recording' ? '録画' : prompt.kind === 'stream' ? '配信' : '配信・録画'
  const automatic = prompt.kind === 'recording' && prompt.autoStopAt !== null && Number.isFinite(prompt.autoStopAt)
  const remainingSeconds = automatic ? Math.max(0, Math.ceil((prompt.autoStopAt! - now) / 1_000)) : null
  const deadline = automatic ? new Date(prompt.autoStopAt!).toLocaleTimeString('ja-JP', { hour12: false }) : null
  return {
    type: 'question' as const,
    title: 'OBS Stream Manager — ゲーム終了の確認',
    message: `「${prompt.gameName}」の終了を検出しました。\n${automatic ? `録画を${deadline}に自動終了します。` : `${output}を終了しますか？`}`,
    detail: automatic
      ? `自動終了まで、この確認を開いた時点で残り${remainingSeconds}秒です。\n「録画を続ける」で今回の自動終了を取り消せます。閉じる・×・Esc、または回答しない場合も予定時刻に録画を終了します。ゲームの再開を確認した場合は自動終了を取り消します。OBSやゲーム自体は終了しません。`
      : `${output}はまだ続いています。「続ける」を選ぶと、この終了については再通知しません。閉じる・×・Escでは${output}を終了しません。OBSやゲーム自体を終了する操作ではありません。`,
    buttons: [automatic ? '録画を続ける' : '続ける', `今すぐ${output}を終了`, automatic ? '閉じる（自動終了は継続）' : '閉じる'],
    defaultId: 2,
    cancelId: 2,
    noLink: true,
    signal,
  }
}

export function gameExitActionFromResponse(response: number): GameExitAction {
  return response === 0 ? 'continue' : response === 1 ? 'stop' : 'dismiss'
}

export type GameExitDialogEvent = {
  event: 'game_exit.dialog_requested' | 'game_exit.dialog_response' | 'game_exit.dialog_cancelled'
    | 'game_exit.dialog_response_ignored' | 'game_exit.dialog_outcome' | 'game_exit.dialog_failed'
  promptId: string
  gameId: string
  kind: GameExitPrompt['kind']
  autoStopAt: number | null
  action?: GameExitAction
  reason?: string
  stopped?: boolean
  warnings?: string[]
  error?: string
}

type GameExitDialogDependencies = {
  poll: () => Promise<GameExitPrompt | null>
  show: (prompt: GameExitPrompt, signal: AbortSignal) => Promise<GameExitAction>
  respond: (id: string, action: GameExitAction) => Promise<GameExitResponse>
  completed: (response: GameExitResponse) => void
  failed: (error: unknown) => void
  recordEvent?: (event: GameExitDialogEvent) => void
}

// The native dialog works even when there is no desktop window (OBS dock only).
// Polling continues while it is open so stale confirmations can be cancelled.
export class GameExitDialogController {
  private timer: ReturnType<typeof setInterval> | null = null
  private polling = false
  private responding = false
  private responseInFlight: Promise<GameExitResponse> | null = null
  private disposed = false
  private handledId: string | null = null
  private active: { prompt: GameExitPrompt; abort: AbortController } | null = null

  constructor(private readonly dependencies: GameExitDialogDependencies) {}

  start(): void {
    if (this.timer || this.disposed) return
    this.timer = setInterval(() => void this.check(), gameExitPollIntervalMs)
    this.timer.unref()
    void this.check()
  }

  stop(): Promise<void> {
    this.disposed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.cancelActive('shutdown')
    return this.responseInFlight?.then(() => undefined, () => undefined) ?? Promise.resolve()
  }

  private record(event: GameExitDialogEvent['event'], prompt: GameExitPrompt, details: Partial<GameExitDialogEvent> = {}): void {
    try {
      this.dependencies.recordEvent?.({ event, promptId: prompt.id, gameId: prompt.gameId, kind: prompt.kind, autoStopAt: prompt.autoStopAt, ...details })
    } catch { /* Diagnostics must not change the answer or stop result. */ }
  }

  private cancelActive(reason: string): void {
    const active = this.active
    this.active = null
    if (active) {
      this.record('game_exit.dialog_cancelled', active.prompt, { reason })
      active.abort.abort()
    }
  }

  async check(): Promise<void> {
    if (this.disposed || this.polling || this.responding) return
    this.polling = true
    try {
      const prompt = await this.dependencies.poll()
      if (this.disposed || this.responding) return
      if (this.active && (!prompt || JSON.stringify(prompt) !== JSON.stringify(this.active.prompt))) {
        this.cancelActive(prompt ? 'prompt-replaced' : 'server-prompt-cleared')
      }
      if (!prompt || this.active || this.handledId === prompt.id) return
      const active = { prompt, abort: new AbortController() }
      this.active = active
      void this.present(active)
    } catch {
      // Missing observation is not evidence of game exit. Never retain an
      // actionable old dialog during an OBS/server connection failure.
      this.cancelActive('poll-failed')
    } finally {
      this.polling = false
    }
  }

  private async present(active: NonNullable<GameExitDialogController['active']>): Promise<void> {
    try {
      // Calling the native API is observable; whether the OS actually displayed
      // the dialog or the user saw it is not. Keep that distinction in the log.
      this.record('game_exit.dialog_requested', active.prompt)
      const action = await this.dependencies.show(active.prompt, active.abort.signal)
      if (this.disposed || this.active !== active || active.abort.signal.aborted) {
        this.record('game_exit.dialog_response_ignored', active.prompt, { action, reason: 'stale-or-cancelled' })
        return
      }
      this.active = null
      this.handledId = active.prompt.id
      this.record('game_exit.dialog_response', active.prompt, {
        action,
        reason: action === 'dismiss' ? 'close-button-or-window-dismissal' : action === 'continue' ? 'explicit-continue' : 'explicit-stop',
      })
      this.responding = true
      try {
        this.responseInFlight = Promise.resolve().then(() => this.dependencies.respond(active.prompt.id, action))
        const result = await this.responseInFlight
        this.record('game_exit.dialog_outcome', active.prompt, { action, stopped: result.stopped, warnings: result.warnings })
        if (!this.disposed) this.dependencies.completed(result)
      } finally {
        this.responseInFlight = null
        this.responding = false
      }
    } catch (error) {
      if (active.abort.signal.aborted) return
      this.record('game_exit.dialog_failed', active.prompt, { error: error instanceof Error ? error.message : String(error) })
      if (this.disposed) return
      this.handledId = active.prompt.id
      if (this.active === active) this.active = null
      this.dependencies.failed(error)
    }
  }
}
