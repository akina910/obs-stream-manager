import { randomUUID } from 'node:crypto'
import type { GameExitPrompt } from '../shared/game-exit.js'

export type GameExitTarget = Omit<GameExitPrompt, 'id' | 'autoStopAt'> & { key: string; automaticStopAllowed?: boolean }
export type GamePresence = 'running' | 'stopped' | 'unknown'
export const gameExitGraceMs = 15_000
export const gameExitCountdownMs = 60_000
export const gameExitServerPollMs = 5_000

export class GameExitMonitor {
  private targetKey: string | null = null
  private missingSince: number | null = null
  private missingObservations = 0
  private observedRunning = false
  private stopAttempts = 0
  private pending: { target: GameExitTarget; prompt: GameExitPrompt } | null = null
  private dismissedKey: string | null = null

  constructor(private readonly graceMs = gameExitGraceMs, private readonly now = Date.now) {}

  invalidate(): void {
    this.missingSince = null
    this.missingObservations = 0
    this.pending = null
    this.stopAttempts = 0
  }

  observe(target: GameExitTarget | null, presence: GamePresence): GameExitPrompt | null {
    if (!target) {
      this.invalidate()
      return null
    }
    if (target.key !== this.targetKey) {
      this.invalidate()
      this.targetKey = target.key
      this.observedRunning = false
      if (this.dismissedKey !== target.key) this.dismissedKey = null
    }
    if (presence !== 'stopped') {
      this.invalidate()
      if (presence === 'running') {
        this.dismissedKey = null
        this.observedRunning = true
      }
      return null
    }
    if (this.dismissedKey === target.key) return null
    if (this.pending) return this.pending.prompt
    const now = this.now()
    if (this.missingSince === null) this.missingSince = now
    this.missingObservations += 1
    if (this.missingObservations < 2 || now - this.missingSince < this.graceMs) return null
    this.pending = { target, prompt: {
      gameId: target.gameId, gameName: target.gameName, kind: target.kind, id: randomUUID(),
      // A stale selected profile or persisted OBS profile label must not be
      // enough to stop a recording started directly in OBS for another game.
      autoStopAt: target.kind === 'recording' && target.automaticStopAllowed === true && this.observedRunning ? now + gameExitCountdownMs : null,
    } }
    return this.pending.prompt
  }

  currentPrompt(): GameExitPrompt | null {
    return this.pending?.prompt ?? null
  }

  automaticStopDue(id: string): boolean {
    const prompt = this.getPending(id)?.prompt
    return Boolean(prompt && prompt.kind === 'recording' && prompt.autoStopAt !== null && this.now() >= prompt.autoStopAt)
  }

  getPending(id: string): { target: GameExitTarget; prompt: GameExitPrompt } | null {
    return this.pending?.prompt.id === id ? this.pending : null
  }

  retryAutomaticStop(id: string, target?: GameExitTarget): { prompt: GameExitPrompt; attempt: number } | null {
    const pending = this.getPending(id)
    if (!pending || pending.prompt.autoStopAt === null) return null
    if (target) {
      if (!target.automaticStopAllowed || target.kind !== 'recording' || target.gameId !== pending.target.gameId) return null
      // A successful own StopRecord can leave an optional recorder still on.
      // The caller's ownership guard rejects any intervening new output start.
      this.targetKey = target.key
      pending.target = target
    }
    this.stopAttempts += 1
    const retryDelay = Math.min(15_000 * 2 ** Math.min(this.stopAttempts - 1, 2), 60_000)
    pending.prompt = { ...pending.prompt, autoStopAt: this.now() + retryDelay }
    return { prompt: pending.prompt, attempt: this.stopAttempts }
  }

  suppress(id: string): boolean {
    if (!this.pending || this.pending.prompt.id !== id) return false
    this.dismissedKey = this.pending.target.key
    this.invalidate()
    return true
  }
}
