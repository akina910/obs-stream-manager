import { describe, expect, it, vi } from 'vitest'
import type { GameExitAction, GameExitPrompt } from '../shared/game-exit.js'
import { GameExitDialogController, gameExitActionFromResponse, gameExitDialogOptions, type GameExitDialogEvent } from './game-exit-dialog.js'

const prompt: GameExitPrompt = { id: 'session-1', gameId: 'minecraft', gameName: 'Minecraft', kind: 'recording', autoStopAt: 60_000 }
const settle = async () => { await new Promise<void>((resolve) => setImmediate(resolve)) }

function harness() {
  const answers: Array<(action: GameExitAction) => void> = []
  const dependencies = {
    poll: vi.fn<() => Promise<GameExitPrompt | null>>().mockResolvedValue(prompt),
    show: vi.fn<(prompt: GameExitPrompt, signal: AbortSignal) => Promise<GameExitAction>>()
      .mockImplementation(() => new Promise<GameExitAction>((resolve) => { answers.push(resolve) })),
    respond: vi.fn().mockResolvedValue({ stopped: true, warnings: [] }),
    completed: vi.fn(),
    failed: vi.fn(),
    recordEvent: vi.fn<(event: GameExitDialogEvent) => void>(),
  }
  return { ...dependencies, controller: new GameExitDialogController(dependencies), answer: (action: GameExitAction, index = answers.length - 1) => answers[index]?.(action) }
}

describe('game exit native confirmation', () => {
  it('shows a fixed recording deadline and the remaining time without implying a live countdown', () => {
    const options = gameExitDialogOptions(prompt, new AbortController().signal, 1_000)
    const expectedDeadline = new Date(prompt.autoStopAt!).toLocaleTimeString('ja-JP', { hour12: false })
    expect(options.message).toContain('Minecraft')
    expect(options.message).toContain(`録画を${expectedDeadline}に自動終了`)
    expect(options.detail).toContain('開いた時点で残り59秒')
    expect(options.detail).toContain('回答しない場合も予定時刻に録画を終了')
    expect(options.detail).toContain('ゲームの再開を確認した場合は自動終了を取り消し')
    expect(options.buttons).toEqual(['録画を続ける', '今すぐ録画を終了', '閉じる（自動終了は継続）'])
    expect(options.defaultId).toBe(2)
    expect(options.cancelId).toBe(2)
    expect(gameExitDialogOptions(prompt, new AbortController().signal, 70_000).detail).toContain('残り0秒')
  })

  it('does not offer automatic streaming stops, even if a stream prompt carries a deadline', () => {
    for (const [kind, label] of [['recording', '録画'], ['stream', '配信'], ['stream-and-recording', '配信・録画']] as const) {
      const options = gameExitDialogOptions({ ...prompt, kind, autoStopAt: kind === 'recording' ? null : 60_000 }, new AbortController().signal)
      expect(options.message).toContain('Minecraft')
      expect(options.message).not.toContain('自動終了')
      expect(options.buttons).toEqual(['続ける', `今すぐ${label}を終了`, '閉じる'])
      expect(options.defaultId).toBe(2)
      expect(options.cancelId).toBe(2)
    }
  })

  it('maps X, Escape and dismiss to dismiss, not explicit Continue', () => {
    const options = gameExitDialogOptions(prompt, new AbortController().signal)
    expect(gameExitActionFromResponse(options.cancelId)).toBe('dismiss')
    expect(gameExitActionFromResponse(-1)).toBe('dismiss')
    expect(gameExitActionFromResponse(0)).toBe('continue')
    expect(gameExitActionFromResponse(1)).toBe('stop')
  })

  it('sends explicit Continue only when chosen and shows only one dialog per exit', async () => {
    const h = harness()
    h.respond.mockResolvedValue({ stopped: false, warnings: [] })
    await h.controller.check()
    await h.controller.check()
    expect(h.show).toHaveBeenCalledTimes(1)
    expect(h.respond).not.toHaveBeenCalled()
    h.answer('continue')
    await settle()
    expect(h.respond).toHaveBeenCalledWith(prompt.id, 'continue')
    expect(h.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ event: 'game_exit.dialog_response', action: 'continue', reason: 'explicit-continue' }))
    await h.controller.check()
    expect(h.show).toHaveBeenCalledTimes(1)
    h.controller.stop()
  })

  it('does not cancel or renew the backend deadline when the native dialog is dismissed', async () => {
    const h = harness()
    h.respond.mockResolvedValue({ stopped: false, warnings: [] })
    await h.controller.check()
    h.answer('dismiss')
    await settle()
    expect(h.respond).toHaveBeenCalledExactlyOnceWith(prompt.id, 'dismiss')
    expect(h.show.mock.calls[0][0].autoStopAt).toBe(60_000)
    expect(h.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ event: 'game_exit.dialog_response', action: 'dismiss', reason: 'close-button-or-window-dismissal', autoStopAt: 60_000 }))
    await h.controller.check()
    expect(h.show).toHaveBeenCalledTimes(1)
    await h.controller.stop()
  })

  it('keeps polling an unanswered or hidden dialog and cancels it when the backend stop clears the prompt', async () => {
    const h = harness()
    await h.controller.check()
    const signal = h.show.mock.calls[0][1]
    for (let index = 0; index < 3; index += 1) await h.controller.check()
    expect(h.poll).toHaveBeenCalledTimes(4)
    expect(h.show).toHaveBeenCalledTimes(1)
    expect(h.respond).not.toHaveBeenCalled()
    expect(h.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ event: 'game_exit.dialog_requested', autoStopAt: 60_000 }))
    expect(h.recordEvent.mock.calls.some(([event]) => event.event.includes('shown'))).toBe(false)
    h.poll.mockResolvedValue(null)
    await h.controller.check()
    expect(signal.aborted).toBe(true)
    expect(h.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ event: 'game_exit.dialog_cancelled', reason: 'server-prompt-cleared' }))
    h.answer('dismiss')
    await settle()
    expect(h.respond).not.toHaveBeenCalled()
    await h.controller.stop()
  })

  it('requests a checked stop only after the user selects Stop', async () => {
    const h = harness()
    await h.controller.check()
    h.answer('stop')
    await settle()
    expect(h.respond).toHaveBeenCalledExactlyOnceWith(prompt.id, 'stop')
    expect(h.completed).toHaveBeenCalledWith({ stopped: true, warnings: [] })
    expect(h.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ event: 'game_exit.dialog_outcome', action: 'stop', stopped: true }))
    h.controller.stop()
  })

  it('cancels a stale dialog on game restart and ignores its delayed Stop answer', async () => {
    const h = harness()
    await h.controller.check()
    const signal = h.show.mock.calls[0][1]
    h.poll.mockResolvedValue(null)
    await h.controller.check()
    expect(signal.aborted).toBe(true)
    h.answer('stop')
    await settle()
    expect(h.respond).not.toHaveBeenCalled()
    expect(h.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ event: 'game_exit.dialog_response_ignored', action: 'stop', reason: 'stale-or-cancelled' }))
    h.controller.stop()
  })

  it('discards the old session answer and shows a new prompt without changing its deadline', async () => {
    const h = harness()
    await h.controller.check()
    const oldSignal = h.show.mock.calls[0][1]
    const newPrompt = { ...prompt, id: 'session-2', gameId: 'terraria', gameName: 'Terraria', autoStopAt: 120_000 }
    h.poll.mockResolvedValue(newPrompt)
    await h.controller.check()
    expect(oldSignal.aborted).toBe(true)
    expect(h.show).toHaveBeenCalledTimes(2)
    expect(h.show.mock.calls[1][0]).toEqual(newPrompt)
    h.answer('stop', 0)
    await settle()
    expect(h.respond).not.toHaveBeenCalled()
    h.answer('continue', 1)
    await settle()
    expect(h.respond).toHaveBeenCalledExactlyOnceWith(newPrompt.id, 'continue')
    expect(h.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ event: 'game_exit.dialog_cancelled', promptId: prompt.id, reason: 'prompt-replaced' }))
    await h.controller.stop()
  })

  it('cancels confirmations when observation fails or the app exits', async () => {
    for (const shutdown of [false, true]) {
      const h = harness()
      await h.controller.check()
      const signal = h.show.mock.calls[0][1]
      if (shutdown) h.controller.stop()
      else { h.poll.mockRejectedValue(new Error('OBS unavailable')); await h.controller.check() }
      expect(signal.aborted).toBe(true)
      h.answer('stop')
      await settle()
      expect(h.respond).not.toHaveBeenCalled()
      h.controller.stop()
    }
  })

  it('does not reopen a failed confirmation endlessly', async () => {
    const h = harness()
    h.respond.mockRejectedValue(new Error('Stop failed'))
    await h.controller.check()
    h.answer('stop')
    await settle()
    expect(h.failed).toHaveBeenCalledTimes(1)
    expect(h.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ event: 'game_exit.dialog_failed', error: 'Stop failed' }))
    await h.controller.check()
    expect(h.show).toHaveBeenCalledTimes(1)
    h.controller.stop()
  })

  it('waits for an already confirmed stop/remux before allowing server shutdown', async () => {
    const h = harness()
    let finish: ((result: { stopped: boolean; warnings: string[] }) => void) | undefined
    h.respond.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    await h.controller.check()
    h.answer('stop')
    await settle()
    let shutdownDone = false
    const stopping = h.controller.stop().then(() => { shutdownDone = true })
    await settle()
    expect(shutdownDone).toBe(false)
    finish?.({ stopped: true, warnings: [] })
    await stopping
    expect(shutdownDone).toBe(true)
    expect(h.respond).toHaveBeenCalledTimes(1)
    expect(h.completed).not.toHaveBeenCalled()
    expect(h.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ event: 'game_exit.dialog_outcome', stopped: true }))
  })

  it('logs an in-flight stop failure during shutdown without opening another native dialog', async () => {
    const h = harness()
    let fail: ((error: Error) => void) | undefined
    h.respond.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject }))
    await h.controller.check()
    h.answer('stop')
    await settle()
    const stopping = h.controller.stop()
    fail?.(new Error('Shutdown stop failed'))
    await stopping
    await settle()
    expect(h.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ event: 'game_exit.dialog_failed', error: 'Shutdown stop failed' }))
    expect(h.failed).not.toHaveBeenCalled()
    expect(h.show).toHaveBeenCalledTimes(1)
  })

  it('does not allow a diagnostics failure to change the explicit user action', async () => {
    const h = harness()
    h.recordEvent.mockImplementation(() => { throw new Error('Log unavailable') })
    await h.controller.check()
    h.answer('dismiss')
    await settle()
    expect(h.respond).toHaveBeenCalledExactlyOnceWith(prompt.id, 'dismiss')
    expect(h.failed).not.toHaveBeenCalled()
    await h.controller.stop()
  })

  it('polls without overlapping and discards a response arriving after shutdown', async () => {
    const h = harness()
    let resolve: ((value: GameExitPrompt) => void) | undefined
    h.poll.mockImplementation(() => new Promise((done) => { resolve = done }))
    const pending = h.controller.check()
    await h.controller.check()
    expect(h.poll).toHaveBeenCalledTimes(1)
    h.controller.stop()
    resolve?.(prompt)
    await pending
    expect(h.show).not.toHaveBeenCalled()
  })

  it('does not open another modal when an older poll returns during an approved stop', async () => {
    const h = harness()
    await h.controller.check()
    let finishPoll: ((value: GameExitPrompt) => void) | undefined
    let finishStop: ((value: { stopped: boolean; warnings: string[] }) => void) | undefined
    h.poll.mockImplementation(() => new Promise((resolve) => { finishPoll = resolve }))
    h.respond.mockImplementation(() => new Promise((resolve) => { finishStop = resolve }))
    const pendingPoll = h.controller.check()
    h.answer('stop')
    await settle()
    finishPoll?.({ ...prompt, id: 'session-2' })
    await pendingPoll
    expect(h.show).toHaveBeenCalledTimes(1)
    expect(h.respond).toHaveBeenCalledTimes(1)
    finishStop?.({ stopped: true, warnings: [] })
    await settle()
    await h.controller.stop()
  })
})
