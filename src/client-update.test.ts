import { describe, expect, it, vi } from 'vitest'
import type { RuntimeStatus } from '../shared/contracts'
import { canReloadClient, createClientUpdateCheck } from './client-update'

const idle: RuntimeStatus = {
  obsConnected: true,
  streaming: false,
  recording: false,
  recordingOnly: false,
  replayBuffer: false,
  sourceRecord: false,
  verticalRecording: false,
  selectedGameId: null,
  captureMethod: null,
  currentScene: null,
  warning: null,
  busy: false,
  twitchOutputPlugin: { state: 'ready', detail: '', outputActive: false },
  platforms: {
    youtube: { state: 'offline', detail: '', checkedAt: null },
    twitch: { state: 'offline', detail: '', checkedAt: null },
  },
}

describe('safe dock client update', () => {
  it('requires a connected idle OBS and blocks every output independently', () => {
    expect(canReloadClient(idle, false)).toBe(true)
    expect(canReloadClient(null, false)).toBe(false)
    expect(canReloadClient(idle, true)).toBe(false)
    expect(canReloadClient({ ...idle, obsConnected: false }, false)).toBe(false)
    expect(canReloadClient({ ...idle, twitchOutputPlugin: undefined }, false)).toBe(false)
    for (const key of ['busy', 'streaming', 'recording', 'recordingOnly', 'replayBuffer', 'sourceRecord', 'verticalRecording'] as const) {
      expect(canReloadClient({ ...idle, [key]: true }, false), key).toBe(false)
    }
    expect(canReloadClient({ ...idle, twitchOutputPlugin: { state: 'ready', detail: '', outputActive: true } }, false)).toBe(false)
    for (const provider of ['youtube', 'twitch'] as const) {
      for (const state of ['starting', 'live', 'stopping'] as const) {
        expect(canReloadClient({ ...idle, platforms: { ...idle.platforms, [provider]: { ...idle.platforms[provider], state } } }, false), `${provider}:${state}`).toBe(false)
      }
    }
  })

  it('allows an idle dock to update when YouTube needs reauthentication', () => {
    expect(canReloadClient({ ...idle, platforms: { ...idle.platforms, youtube: { state: 'error', detail: '再接続が必要です', checkedAt: null } } }, false)).toBe(true)
  })

  it('checks a new build against fresh output state, defers recording, then reloads once', async () => {
    const getStatus = vi.fn().mockResolvedValueOnce({ ...idle, recording: true }).mockResolvedValue(idle)
    const reload = vi.fn()
    const check = createClientUpdateCheck({
      loadedEntryScript: '/assets/index-old.js',
      getBuild: vi.fn().mockResolvedValue({ entryScript: '/assets/index-new.js' }),
      getStatus,
      isBlocked: () => false,
      reload,
    })
    await check()
    expect(reload).not.toHaveBeenCalled()
    await check()
    await check()
    expect(reload).toHaveBeenCalledTimes(1)
    expect(getStatus).toHaveBeenCalledTimes(2)
  })

  it('does not reload if a user starts an action while the status request is pending', async () => {
    let blocked = false
    const reload = vi.fn()
    const check = createClientUpdateCheck({
      loadedEntryScript: '/assets/index-old.js',
      getBuild: async () => ({ entryScript: '/assets/index-new.js' }),
      getStatus: async () => { blocked = true; return idle },
      isBlocked: () => blocked,
      reload,
    })
    await check()
    expect(reload).not.toHaveBeenCalled()
  })

  it('ignores unchanged, missing and malformed build identities without querying OBS', async () => {
    const getStatus = vi.fn().mockResolvedValue(idle)
    const reload = vi.fn()
    for (const entryScript of ['/assets/index-old.js', null, 'https://example.com/other.js']) {
      await createClientUpdateCheck({
        loadedEntryScript: '/assets/index-old.js',
        getBuild: async () => ({ entryScript }),
        getStatus,
        isBlocked: () => false,
        reload,
      })()
    }
    expect(getStatus).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
  })

  it('recovers after a server restart and does not overlap requests', async () => {
    let finishBuild: ((build: { entryScript: string }) => void) | undefined
    const getBuild = vi.fn()
      .mockRejectedValueOnce(new Error('server offline'))
      .mockImplementationOnce(() => new Promise((resolve) => { finishBuild = resolve }))
    const reload = vi.fn()
    const check = createClientUpdateCheck({
      loadedEntryScript: '/assets/index-old.js', getBuild,
      getStatus: async () => idle, isBlocked: () => false, reload,
    })
    await check()
    const pending = check()
    await check()
    expect(getBuild).toHaveBeenCalledTimes(2)
    finishBuild?.({ entryScript: '/assets/index-new.js' })
    await pending
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
