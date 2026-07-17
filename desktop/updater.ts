import type { RuntimeStatus } from '../shared/contracts.js'
import type { DesktopUpdateState, UpdateBlockReason } from '../shared/update-contracts.js'

type ReleaseNote = { version?: string; note?: string | null }

export type ManualUpdateEvent =
  | { type: 'available'; version: string; releaseName?: string | null; releaseNotes?: string | ReleaseNote[] | null }
  | { type: 'not-available' }
  | { type: 'progress'; percent: number }
  | { type: 'downloaded' }
  | { type: 'error'; message: string }

export interface ManualUpdateAdapter {
  configureManual(): void
  subscribe(listener: (event: ManualUpdateEvent) => void): () => void
  check(): Promise<void>
  download(): Promise<void>
  install(): void
}

export type ManualUpdateServiceOptions = {
  currentVersion: string
  packaged: boolean
  portable: boolean
  getInstallBlocker: () => Promise<UpdateBlockReason | null>
  onStateChange?: (state: Readonly<DesktopUpdateState>) => void
}

const activeExternalStates = new Set(['starting', 'live', 'stopping'])

export function getUpdateBlockReason(status: RuntimeStatus): UpdateBlockReason | null {
  if (status.streaming) return 'streaming'
  if (status.recording) return 'recording'
  if (status.replayBuffer) return 'replay-buffer'
  if (status.busy) return 'busy'
  if (activeExternalStates.has(status.platforms.youtube.state) || activeExternalStates.has(status.platforms.twitch.state)) {
    return 'external-live'
  }
  return null
}

function normalizeReleaseNotes(value: ManualUpdateEvent & { type: 'available' }): string | undefined {
  if (typeof value.releaseNotes === 'string') {
    const note = value.releaseNotes.trim()
    return note || undefined
  }
  if (!Array.isArray(value.releaseNotes)) return undefined
  const notes = value.releaseNotes
    .map(({ note }) => typeof note === 'string' ? note.trim() : '')
    .filter(Boolean)
  return notes.length > 0 ? notes.join('\n\n') : undefined
}

function safeUpdateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 1_000) || 'Unknown update error'
}

export class ManualUpdateService {
  private state: DesktopUpdateState
  private operation: Promise<Readonly<DesktopUpdateState>> | null = null
  private readonly unsubscribe: () => void

  constructor(
    private readonly adapter: ManualUpdateAdapter,
    private readonly options: ManualUpdateServiceOptions,
  ) {
    const installSupported = options.packaged && !options.portable
    this.state = {
      phase: options.packaged ? 'idle' : 'unsupported',
      currentVersion: options.currentVersion,
      portable: options.portable,
      installSupported,
    }
    adapter.configureManual()
    this.unsubscribe = adapter.subscribe((event) => this.handleEvent(event))
  }

  getState(): Readonly<DesktopUpdateState> {
    return { ...this.state }
  }

  dispose(): void {
    this.unsubscribe()
  }

  async check(): Promise<Readonly<DesktopUpdateState>> {
    if (!this.options.packaged) return this.getState()
    return this.runExclusive(async () => {
      this.replaceState({ phase: 'checking' })
      try {
        await this.adapter.check()
        if (this.state.phase === 'checking') this.replaceState({ phase: 'up-to-date' })
      } catch (error) {
        this.replaceState({ phase: 'error', errorMessage: safeUpdateError(error) })
      }
    })
  }

  async download(): Promise<Readonly<DesktopUpdateState>> {
    if (!this.state.installSupported || this.state.phase !== 'available') return this.getState()
    return this.runExclusive(async () => {
      this.patchState({ phase: 'downloading', progressPercent: 0, errorMessage: undefined, blockReason: undefined })
      try {
        await this.adapter.download()
      } catch (error) {
        this.patchState({ phase: 'error', errorMessage: safeUpdateError(error) })
      }
    })
  }

  async install(): Promise<Readonly<DesktopUpdateState>> {
    if (!this.state.installSupported || this.state.phase !== 'downloaded') return this.getState()
    return this.runExclusive(async () => {
      try {
        const blockReason = await this.options.getInstallBlocker()
        if (blockReason) {
          this.patchState({ phase: 'downloaded', blockReason })
          return
        }
        this.patchState({ phase: 'installing', blockReason: undefined, errorMessage: undefined })
        this.adapter.install()
      } catch (error) {
        this.patchState({ phase: 'error', errorMessage: safeUpdateError(error) })
      }
    })
  }

  private async runExclusive(operation: () => Promise<void>): Promise<Readonly<DesktopUpdateState>> {
    if (this.operation) return this.operation
    this.operation = (async () => {
      await operation()
      return this.getState()
    })()
    try {
      return await this.operation
    } finally {
      this.operation = null
    }
  }

  private handleEvent(event: ManualUpdateEvent): void {
    switch (event.type) {
      case 'available':
        this.replaceState({
          phase: 'available',
          availableVersion: event.version,
          releaseName: event.releaseName?.trim() || undefined,
          releaseNotes: normalizeReleaseNotes(event),
          progressPercent: 0,
        })
        break
      case 'not-available':
        this.replaceState({ phase: 'up-to-date' })
        break
      case 'progress':
        this.patchState({ phase: 'downloading', progressPercent: Math.max(0, Math.min(100, event.percent)) })
        break
      case 'downloaded':
        this.patchState({ phase: 'downloaded', progressPercent: 100, errorMessage: undefined, blockReason: undefined })
        break
      case 'error':
        this.patchState({ phase: 'error', errorMessage: safeUpdateError(event.message) })
        break
    }
  }

  private replaceState(next: Pick<DesktopUpdateState, 'phase'> & Partial<DesktopUpdateState>): void {
    const { phase, ...details } = next
    this.state = {
      phase,
      currentVersion: this.options.currentVersion,
      portable: this.options.portable,
      installSupported: this.options.packaged && !this.options.portable,
      ...details,
    }
    this.notify()
  }

  private patchState(patch: Partial<DesktopUpdateState>): void {
    this.state = { ...this.state, ...patch }
    this.notify()
  }

  private notify(): void {
    this.options.onStateChange?.(this.getState())
  }
}
