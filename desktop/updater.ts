import { redactSensitiveText } from '../shared/redaction.js'
import { getUpdateBlockReason, type DesktopUpdateState, type UpdateBlockReason } from '../shared/update-contracts.js'

export { getUpdateBlockReason } from '../shared/update-contracts.js'

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

export interface ElectronUpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  on(eventName: string, listener: (...arguments_: unknown[]) => void): unknown
  removeListener(eventName: string, listener: (...arguments_: unknown[]) => void): unknown
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

export type ManualUpdateServiceOptions = {
  currentVersion: string
  packaged: boolean
  portable: boolean
  installSupported?: boolean
  getInstallBlocker: () => Promise<UpdateBlockReason | null>
  onStateChange?: (state: Readonly<DesktopUpdateState>) => void
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function releaseNotesValue(value: unknown): string | ReleaseNote[] | null | undefined {
  if (typeof value === 'string' || value === null || value === undefined) return value
  if (!Array.isArray(value)) return undefined
  return value.map((entry) => {
    const note = objectValue(entry)
    return {
      version: typeof note.version === 'string' ? note.version : undefined,
      note: typeof note.note === 'string' || note.note === null ? note.note : undefined,
    }
  })
}

export function createElectronUpdateAdapter(updater: ElectronUpdaterLike): ManualUpdateAdapter {
  return {
    configureManual() {
      updater.autoDownload = false
      updater.autoInstallOnAppQuit = false
    },
    subscribe(listener) {
      const handlers: Array<[string, (...arguments_: unknown[]) => void]> = [
        ['update-available', (value) => {
          const info = objectValue(value)
          if (typeof info.version !== 'string') return
          listener({
            type: 'available',
            version: info.version,
            releaseName: typeof info.releaseName === 'string' ? info.releaseName : undefined,
            releaseNotes: releaseNotesValue(info.releaseNotes),
          })
        }],
        ['update-not-available', () => listener({ type: 'not-available' })],
        ['download-progress', (value) => {
          const progress = objectValue(value)
          if (typeof progress.percent === 'number') listener({ type: 'progress', percent: progress.percent })
        }],
        ['update-downloaded', () => listener({ type: 'downloaded' })],
        ['error', (value) => listener({ type: 'error', message: value instanceof Error ? value.message : String(value) })],
      ]
      for (const [eventName, handler] of handlers) updater.on(eventName, handler)
      return () => {
        for (const [eventName, handler] of handlers) updater.removeListener(eventName, handler)
      }
    },
    async check() {
      await updater.checkForUpdates()
    },
    async download() {
      await updater.downloadUpdate()
    },
    install() {
      updater.quitAndInstall(true, true)
    },
  }
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
  return redactSensitiveText(message).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 1_000) || 'Unknown update error'
}

export class ManualUpdateService {
  private state: DesktopUpdateState
  private operation: Promise<Readonly<DesktopUpdateState>> | null = null
  private readonly unsubscribe: () => void

  constructor(
    private readonly adapter: ManualUpdateAdapter,
    private readonly options: ManualUpdateServiceOptions,
  ) {
    const installSupported = options.installSupported ?? (options.packaged && !options.portable)
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
      installSupported: this.options.installSupported ?? (this.options.packaged && !this.options.portable),
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
