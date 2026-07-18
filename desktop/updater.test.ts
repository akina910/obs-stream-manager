import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { RuntimeStatus } from '../shared/contracts.js'
import type { ManualUpdateEvent } from './updater.js'
import { createElectronUpdateAdapter, getUpdateBlockReason, ManualUpdateService, type ManualUpdateAdapter } from './updater.js'

class FakeUpdateAdapter implements ManualUpdateAdapter {
  configured = 0
  checks = 0
  downloads = 0
  installs = 0
  listener: ((event: ManualUpdateEvent) => void) | null = null
  onCheck: (() => void) | null = null
  onDownload: (() => void) | null = null

  configureManual(): void {
    this.configured += 1
  }

  subscribe(listener: (event: ManualUpdateEvent) => void): () => void {
    this.listener = listener
    return () => { this.listener = null }
  }

  async check(): Promise<void> {
    this.checks += 1
    this.onCheck?.()
  }

  async download(): Promise<void> {
    this.downloads += 1
    this.onDownload?.()
  }

  install(): void {
    this.installs += 1
  }

  emit(event: ManualUpdateEvent): void {
    this.listener?.(event)
  }
}

class FakeElectronUpdater extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = true
  checks = 0
  downloads = 0
  installArguments: [boolean | undefined, boolean | undefined] | null = null

  async checkForUpdates(): Promise<void> {
    this.checks += 1
  }

  async downloadUpdate(): Promise<string[]> {
    this.downloads += 1
    return []
  }

  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.installArguments = [isSilent, isForceRunAfter]
  }
}

const stoppedStatus: RuntimeStatus = {
  obsConnected: true,
  streaming: false,
  recording: false,
  replayBuffer: false,
  sourceRecord: false,
  verticalRecording: false,
  selectedGameId: null,
  captureMethod: null,
  currentScene: null,
  warning: null,
  busy: false,
  platforms: {
    youtube: { state: 'ready', detail: '', checkedAt: null },
    twitch: { state: 'offline', detail: '', checkedAt: null },
  },
}

function service(adapter = new FakeUpdateAdapter(), options: { packaged?: boolean; portable?: boolean; blocker?: () => Promise<ReturnType<typeof getUpdateBlockReason>> } = {}) {
  return {
    adapter,
    updater: new ManualUpdateService(adapter, {
      currentVersion: '0.2.3',
      packaged: options.packaged ?? true,
      portable: options.portable ?? false,
      getInstallBlocker: options.blocker ?? (async () => null),
    }),
  }
}

describe('manual desktop updater', () => {
  it('adapts electron-updater to explicit-only operations and cleans up listeners', async () => {
    const electronUpdater = new FakeElectronUpdater()
    const adapter = createElectronUpdateAdapter(electronUpdater)
    const events: ManualUpdateEvent[] = []
    adapter.configureManual()
    const unsubscribe = adapter.subscribe((event) => events.push(event))

    expect(electronUpdater.autoDownload).toBe(false)
    expect(electronUpdater.autoInstallOnAppQuit).toBe(false)
    electronUpdater.emit('update-available', { version: '0.2.4', releaseName: 'Release', releaseNotes: 'Notes' })
    electronUpdater.emit('update-not-available', { version: '0.2.3' })
    electronUpdater.emit('download-progress', { percent: 43.2 })
    electronUpdater.emit('update-downloaded', { version: '0.2.4' })
    electronUpdater.emit('error', new Error('safe failure'))
    expect(events).toEqual([
      { type: 'available', version: '0.2.4', releaseName: 'Release', releaseNotes: 'Notes' },
      { type: 'not-available' },
      { type: 'progress', percent: 43.2 },
      { type: 'downloaded' },
      { type: 'error', message: 'safe failure' },
    ])

    await adapter.check()
    await adapter.download()
    adapter.install()
    expect(electronUpdater.checks).toBe(1)
    expect(electronUpdater.downloads).toBe(1)
    expect(electronUpdater.installArguments).toEqual([true, true])

    unsubscribe()
    for (const name of ['update-available', 'update-not-available', 'download-progress', 'update-downloaded', 'error']) {
      expect(electronUpdater.listenerCount(name)).toBe(0)
    }
  })

  it('configures manual operation without checking or downloading at startup', () => {
    const { adapter, updater } = service()

    expect(adapter.configured).toBe(1)
    expect(adapter.checks).toBe(0)
    expect(adapter.downloads).toBe(0)
    expect(updater.getState()).toMatchObject({
      phase: 'idle', currentVersion: '0.2.3', portable: false, installSupported: true,
    })
  })

  it('checks only when requested and stores normalized release information', async () => {
    const { adapter, updater } = service()
    adapter.onCheck = () => adapter.emit({
      type: 'available',
      version: '0.2.4',
      releaseName: 'Safer updates',
      releaseNotes: [
        { version: '0.2.4', note: 'First line' },
        { version: '0.2.3', note: 'Second line' },
      ],
    })

    await expect(updater.check()).resolves.toMatchObject({
      phase: 'available',
      availableVersion: '0.2.4',
      releaseName: 'Safer updates',
      releaseNotes: 'First line\n\nSecond line',
    })
    expect(adapter.checks).toBe(1)
  })

  it('reports the installed version as current when no update is available', async () => {
    const { adapter, updater } = service()
    adapter.onCheck = () => adapter.emit({ type: 'not-available' })

    await expect(updater.check()).resolves.toMatchObject({ phase: 'up-to-date' })
  })

  it('labels a missing public release without presenting it as a successful live update check', async () => {
    const { adapter, updater } = service()
    adapter.onCheck = () => adapter.emit({ type: 'error', message: 'HttpError: 404 latest.yml not found' })

    await expect(updater.check()).resolves.toMatchObject({ phase: 'error', errorKind: 'no-release' })
  })

  it('recognizes multiline missing channel metadata errors', async () => {
    const { adapter, updater } = service()
    adapter.onCheck = () => adapter.emit({ type: 'error', message: 'HttpError: 404 latest.yml\r\nwas not found' })

    await expect(updater.check()).resolves.toMatchObject({ phase: 'error', errorKind: 'no-release' })
  })

  it('labels GitHub latest-release lookup failures as no public release', async () => {
    const { adapter, updater } = service()
    adapter.onCheck = () => adapter.emit({
      type: 'error',
      message: 'Cannot parse releases feed: Error: Unable to find latest version on GitHub (https://github.com/akina910/obs-stream-manager/releases/latest), please ensure a production release exists: HttpError: 406',
    })

    await expect(updater.check()).resolves.toMatchObject({ phase: 'error', errorKind: 'no-release' })
  })

  it('does not hide GitHub authorization failures as a missing public release', async () => {
    const { adapter, updater } = service()
    adapter.onCheck = () => adapter.emit({
      type: 'error',
      message: 'Unable to find latest version on GitHub, please ensure a production release exists: HttpError: 403',
    })

    await expect(updater.check()).resolves.toMatchObject({ phase: 'error', errorKind: 'failed' })
  })

  it('does not classify a missing installer during download as no public release', async () => {
    const { adapter, updater } = service()
    adapter.onCheck = () => adapter.emit({ type: 'available', version: '0.2.5' })
    adapter.onDownload = () => adapter.emit({ type: 'error', message: 'HttpError: 404 update installer not found' })
    await updater.check()

    await expect(updater.download()).resolves.toMatchObject({ phase: 'error', errorKind: 'failed' })
  })

  it('reports download progress and reaches the downloaded phase', async () => {
    const { adapter, updater } = service()
    adapter.onCheck = () => adapter.emit({ type: 'available', version: '0.2.4', releaseNotes: 'Changes' })
    await updater.check()
    adapter.onDownload = () => {
      adapter.emit({ type: 'progress', percent: 52.75 })
      adapter.emit({ type: 'downloaded' })
    }

    await expect(updater.download()).resolves.toMatchObject({
      phase: 'downloaded', progressPercent: 100, availableVersion: '0.2.4',
    })
    expect(adapter.downloads).toBe(1)
  })

  it('re-checks runtime safety immediately before installing', async () => {
    let blocker: ReturnType<typeof getUpdateBlockReason> = 'streaming'
    const { adapter, updater } = service(undefined, { blocker: async () => blocker })
    adapter.onCheck = () => adapter.emit({ type: 'available', version: '0.2.4' })
    adapter.onDownload = () => adapter.emit({ type: 'downloaded' })
    await updater.check()
    await updater.download()

    await expect(updater.install()).resolves.toMatchObject({ phase: 'downloaded', blockReason: 'streaming' })
    expect(adapter.installs).toBe(0)

    blocker = null
    await expect(updater.install()).resolves.toMatchObject({ phase: 'installing' })
    expect(adapter.installs).toBe(1)
  })

  it('blocks every output state that makes replacement unsafe', () => {
    expect(getUpdateBlockReason({ ...stoppedStatus, streaming: true })).toBe('streaming')
    expect(getUpdateBlockReason({ ...stoppedStatus, recording: true })).toBe('recording')
    expect(getUpdateBlockReason({ ...stoppedStatus, sourceRecord: true })).toBe('recording')
    expect(getUpdateBlockReason({ ...stoppedStatus, verticalRecording: true })).toBe('recording')
    expect(getUpdateBlockReason({ ...stoppedStatus, replayBuffer: true })).toBe('replay-buffer')
    expect(getUpdateBlockReason({ ...stoppedStatus, busy: true })).toBe('busy')
    expect(getUpdateBlockReason({
      ...stoppedStatus,
      twitchOutputPlugin: {
        state: 'ready',
        detail: '',
        outputActive: true,
      },
    })).toBe('external-live')
    expect(getUpdateBlockReason({ ...stoppedStatus, platforms: { ...stoppedStatus.platforms, youtube: { ...stoppedStatus.platforms.youtube, state: 'starting' } } })).toBe('external-live')
    expect(getUpdateBlockReason({ ...stoppedStatus, platforms: { ...stoppedStatus.platforms, twitch: { ...stoppedStatus.platforms.twitch, state: 'live' } } })).toBe('external-live')
    expect(getUpdateBlockReason({ ...stoppedStatus, platforms: { ...stoppedStatus.platforms, twitch: { ...stoppedStatus.platforms.twitch, state: 'stopping' } } })).toBe('external-live')
    expect(getUpdateBlockReason(stoppedStatus)).toBeNull()
  })

  it('does not offer updating in an unpackaged development build', async () => {
    const { adapter, updater } = service(undefined, { packaged: false })

    expect(updater.getState()).toMatchObject({ phase: 'unsupported', installSupported: false })
    await updater.check()
    expect(adapter.checks).toBe(0)
  })

  it('allows Portable builds to check but never self-overwrite', async () => {
    const { adapter, updater } = service(undefined, { portable: true })
    adapter.onCheck = () => adapter.emit({ type: 'available', version: '0.2.4' })

    await updater.check()
    expect(updater.getState()).toMatchObject({ phase: 'available', portable: true, installSupported: false })
    await updater.download()
    expect(adapter.downloads).toBe(0)
    expect(updater.getState()).toMatchObject({ phase: 'available' })
  })
})
