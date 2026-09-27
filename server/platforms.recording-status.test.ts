import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PlatformRuntimeStatus } from '../shared/contracts.js'
import { defaultConfig, starterProfiles } from './defaults.js'
import { PlatformServices } from './platforms.js'
import type { SecretStore } from './secrets.js'
import type { DataStore } from './storage.js'

afterEach(() => vi.restoreAllMocks())

function fixture() {
  const config = structuredClone(defaultConfig)
  config.features.youtube = true
  config.features.twitch = true
  const profile = structuredClone(starterProfiles[0])
  profile.youtube.enabled = true
  profile.twitch.enabled = true
  const secrets = { get: vi.fn().mockReturnValue(null), set: vi.fn() }
  const platforms = new PlatformServices(secrets as unknown as SecretStore, {} as DataStore)
  const internals = platforms as unknown as {
    youtubeLiveStatus: () => Promise<PlatformRuntimeStatus>
    twitchLiveStatus: () => Promise<PlatformRuntimeStatus>
  }
  const youtube = vi.spyOn(internals, 'youtubeLiveStatus').mockResolvedValue({ state: 'error', detail: '400 invalid_grant', checkedAt: '2026-09-27T11:00:00.000Z' })
  const twitch = vi.spyOn(internals, 'twitchLiveStatus').mockResolvedValue({ state: 'offline', detail: 'Twitchはオフライン', checkedAt: '2026-09-27T11:00:00.000Z' })
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Recording must not access providers'))
  return { config, profile, platforms, secrets, youtube, twitch, fetch }
}

describe('recording-only platform status snapshots', () => {
  it('does not refresh tokens or claim offline without an observation', () => {
    const h = fixture()
    const result = h.platforms.getDeferredLiveStatus(h.config, h.profile)
    expect(result.youtube).toMatchObject({ state: 'unprepared', observation: 'deferred', checkedAt: null })
    expect(result.twitch).toMatchObject({ state: 'unprepared', observation: 'deferred', checkedAt: null })
    expect(result.youtube.detail).toContain('録画のみ')
    expect(h.youtube).not.toHaveBeenCalled()
    expect(h.twitch).not.toHaveBeenCalled()
    expect(h.fetch).not.toHaveBeenCalled()
    expect(h.secrets.set).not.toHaveBeenCalled()
  })

  it('does not surface a cached authentication failure as a recording failure or destroy its cache', async () => {
    const h = fixture()
    await h.platforms.getLiveStatus(h.config, h.profile)
    const local = h.platforms.getDeferredLiveStatus(h.config, h.profile)
    expect(local.youtube).toMatchObject({ state: 'unprepared', checkedAt: null })
    expect(local.youtube.detail).not.toContain('invalid_grant')
    expect(await h.platforms.getLiveStatus(h.config, h.profile)).toMatchObject({ youtube: { state: 'error', detail: '400 invalid_grant' } })
    expect(h.youtube).toHaveBeenCalledTimes(1)
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it.each(['starting', 'live', 'stopping'] as const)('retains last-known %s without showing stale viewers as current', async (state) => {
    const h = fixture()
    h.youtube.mockResolvedValue({ state, detail: 'YouTube公開状態', checkedAt: '2026-09-27T11:00:00.000Z', viewerCount: 42, viewerCountState: 'available' })
    await h.platforms.getLiveStatus(h.config, h.profile)
    const local = h.platforms.getDeferredLiveStatus(h.config, h.profile)
    expect(local.youtube).toMatchObject({ state, observation: 'deferred', checkedAt: '2026-09-27T11:00:00.000Z', viewerCount: null, viewerCountState: 'unavailable' })
    expect(local.youtube.detail).toContain('未確認')
    expect((await h.platforms.getLiveStatus(h.config, h.profile)).youtube.viewerCount).toBe(42)
    expect(h.youtube).toHaveBeenCalledTimes(1)
  })

  it('never reuses a cached broadcast for a different configuration', async () => {
    const h = fixture()
    h.youtube.mockResolvedValue({ state: 'live', detail: 'old broadcast', checkedAt: '2026-09-27T11:00:00.000Z' })
    await h.platforms.getLiveStatus(h.config, h.profile)
    h.config.youtube.broadcastId = 'different-broadcast'
    expect(h.platforms.getDeferredLiveStatus(h.config, h.profile).youtube).toMatchObject({ state: 'unprepared', checkedAt: null })
    expect(h.youtube).toHaveBeenCalledTimes(1)
  })

  it('retains explicitly disabled providers without making calls', () => {
    const h = fixture()
    h.config.features.youtube = false
    h.profile.twitch.enabled = false
    const local = h.platforms.getDeferredLiveStatus(h.config, h.profile)
    expect(local.youtube.state).toBe('disabled')
    expect(local.twitch.state).toBe('disabled')
    expect(h.youtube).not.toHaveBeenCalled()
    expect(h.twitch).not.toHaveBeenCalled()
  })

  it('does not refresh again when local recording supersedes an invalidated in-flight request', async () => {
    const h = fixture()
    let finishYouTube!: (value: PlatformRuntimeStatus) => void
    h.youtube.mockImplementationOnce(() => new Promise((resolve) => { finishYouTube = resolve }))
    let canRefresh = true
    const oldRequest = h.platforms.getLiveStatus(h.config, h.profile, () => canRefresh)
    expect(h.youtube).toHaveBeenCalledOnce()
    h.platforms.invalidateLiveStatus()
    canRefresh = false
    finishYouTube({ state: 'error', detail: '400 invalid_grant', checkedAt: '2026-09-27T11:00:00.000Z' })
    await expect(oldRequest).resolves.toMatchObject({ youtube: { state: 'unprepared', observation: 'deferred' } })
    expect(h.youtube).toHaveBeenCalledOnce()
    expect(h.twitch).toHaveBeenCalledOnce()
    // Explicit later streaming checks still observe authentication failures.
    await expect(h.platforms.getLiveStatus(h.config, h.profile)).resolves.toMatchObject({ youtube: { state: 'error', detail: '400 invalid_grant' } })
    expect(h.youtube).toHaveBeenCalledTimes(2)
    expect(h.fetch).not.toHaveBeenCalled()
  })
})
