import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultConfig, starterProfiles } from './defaults.js'
import { PlatformServices } from './platforms.js'
import type { SecretStore } from './secrets.js'
import type { DataStore } from './storage.js'

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
function fixture() {
  const config = structuredClone(defaultConfig)
  config.features.youtube = true
  config.features.twitch = false
  config.youtube = { clientId: 'client-a', clientSecretStored: true, refreshTokenStored: true, broadcastId: '' }
  const profile = structuredClone(starterProfiles[0])
  profile.youtube.enabled = true
  const values = new Map([['youtube-refresh-token', 'refresh-a'], ['youtube-client-secret', 'secret-a']])
  const secrets = { get: vi.fn((key: string) => values.get(key) ?? null), set: vi.fn((key: string, value: string) => { values.set(key, value) }) }
  const store = { getConfig: vi.fn(async () => structuredClone(config)) }
  const platforms = new PlatformServices(secrets as unknown as SecretStore, store as unknown as DataStore)
  const token = () => (platforms as unknown as { youtubeAccessToken: (config: typeof defaultConfig) => Promise<string> }).youtubeAccessToken(config)
  return { config, profile, values, secrets, store, platforms, token }
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('YouTube reconnect-required status and authentication fencing', () => {
  it.each(['invalid_grant', 'invalid_client', 'invalid_request'])('suppresses repeated %s refreshes until reconnection, including expired status polls', async (error) => {
    vi.useFakeTimers()
    const h = fixture()
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ error, error_description: 'Bad Request' }, 400))
    await expect(h.platforms.getLiveStatus(h.config, h.profile)).resolves.toMatchObject({ youtube: { state: 'error', connectionIssue: 'reconnect_required', detail: expect.stringContaining('録画のみ') } })
    vi.advanceTimersByTime(120_000)
    await h.platforms.getLiveStatus(h.config, h.profile)
    h.platforms.invalidateLiveStatus()
    await h.platforms.getLiveStatus(h.config, h.profile)
    await expect(h.token()).rejects.toThrow('再接続')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(h.values.get('youtube-oauth-health')).toBe('reconnect_required')
  })

  it('uses persisted reconnect health without network or mutations, while disabled remains disabled', async () => {
    const h = fixture()
    h.values.set('youtube-oauth-health', 'reconnect_required')
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not fetch'))
    await expect(h.platforms.getLiveStatus(h.config, h.profile)).resolves.toMatchObject({ youtube: { state: 'error', connectionIssue: 'reconnect_required' } })
    expect(h.platforms.getDeferredLiveStatus(h.config, h.profile).youtube).toMatchObject({ state: 'unprepared', observation: 'deferred', connectionIssue: 'reconnect_required', checkedAt: null })
    h.profile.youtube.enabled = false
    expect(h.platforms.getDeferredLiveStatus(h.config, h.profile).youtube).toEqual({ state: 'disabled', detail: 'YouTube配信は無効です', checkedAt: null })
    expect(fetch).not.toHaveBeenCalled()
    expect(h.secrets.set).not.toHaveBeenCalled()
  })

  it.each(['http500', 'network', 'quota'])('preserves genuine %s errors rather than labeling authentication or offline', async (failure) => {
    const h = fixture()
    const fetch = vi.spyOn(globalThis, 'fetch')
    if (failure === 'network') fetch.mockRejectedValue(new Error('network unavailable'))
    else fetch.mockResolvedValue(failure === 'quota'
      ? json({ error: { errors: [{ reason: 'quotaExceeded' }] } }, 403)
      : json({ error: 'server_error' }, 500))
    const result = await h.platforms.getLiveStatus(h.config, h.profile)
    if (failure === 'quota') {
      expect(result.youtube.state).toBe('unprepared')
      expect(result.youtube.detail).toContain('API上限')
    } else expect(result.youtube.state).toBe('error')
    expect(result.youtube.connectionIssue).toBeUndefined()
    expect(h.values.get('youtube-oauth-health')).toBeUndefined()
  })

  it('resumes immediately after reconnect health is cleared with the same credential strings', async () => {
    const h = fixture()
    h.values.set('youtube-oauth-health', 'reconnect_required')
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => String(url).includes('/token') ? json({ access_token: 'new-access' }) : json({ items: [] }))
    await h.platforms.getLiveStatus(h.config, h.profile)
    h.platforms.invalidateYouTubeAuthentication()
    h.values.set('youtube-oauth-health', '')
    const result = await h.platforms.getLiveStatus(h.config, h.profile)
    expect(result.youtube).toMatchObject({ state: 'unprepared', detail: '準備済みの配信枠が見つかりません' })
    expect(result.youtube.connectionIssue).toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('retains a known active state in a deferred snapshot while reporting reconnect health', async () => {
    const h = fixture()
    h.config.youtube.broadcastId = 'broadcast'
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => String(url).includes('/token') ? json({ access_token: 'access' })
      : String(url).includes('/videos') ? json({ items: [{ liveStreamingDetails: { concurrentViewers: '4' } }] })
        : json({ items: [{ id: 'broadcast', status: { lifeCycleStatus: 'live' }, contentDetails: {} }] }))
    await h.platforms.getLiveStatus(h.config, h.profile)
    h.values.set('youtube-oauth-health', 'reconnect_required')
    const result = h.platforms.getDeferredLiveStatus(h.config, h.profile)
    expect(result.youtube).toMatchObject({ state: 'live', observation: 'deferred', connectionIssue: 'reconnect_required', viewerCount: null })
  })

  it.each(['refresh-token', 'client-secret', 'client-id', 'same-token-reauth'])('discards an old failed response after %s changes without poisoning current health/status', async (change) => {
    const h = fixture()
    const old = deferred<Response>()
    const started = deferred<void>()
    let refreshCount = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (!String(url).includes('/token')) return json({ items: [] })
      if (++refreshCount === 1) { started.resolve(); return old.promise }
      return json({ access_token: 'current-access', expires_in: 3600 })
    })
    const pending = h.platforms.getLiveStatus(h.config, h.profile)
    await started.promise
    if (change === 'refresh-token') h.values.set('youtube-refresh-token', 'refresh-b')
    if (change === 'client-secret') h.values.set('youtube-client-secret', 'secret-b')
    if (change === 'client-id') h.config.youtube.clientId = 'client-b'
    if (change === 'same-token-reauth') h.platforms.invalidateYouTubeAuthentication()
    h.values.set('youtube-oauth-health', '')
    await h.platforms.getLiveStatus(h.config, h.profile)
    old.resolve(json({ error: 'invalid_grant' }, 400))
    expect((await pending).youtube.state).toBe('unprepared')
    expect(h.values.get('youtube-oauth-health')).toBe('')
    await expect(h.token()).resolves.toBe('current-access')
    expect(refreshCount).toBe(2)
  })

  it('does not let an old success clear a new authentication failure', async () => {
    const h = fixture()
    const old = deferred<Response>()
    const started = deferred<void>()
    let refreshCount = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      if (++refreshCount === 1) { started.resolve(); return old.promise }
      return json({ error: 'invalid_client' }, 400)
    })
    const pending = h.token().catch((error: Error) => error)
    await started.promise
    h.platforms.invalidateYouTubeAuthentication()
    await expect(h.token()).rejects.toThrow('invalid_client')
    old.resolve(json({ access_token: 'stale-access', expires_in: 3600 }))
    expect(await pending).toBeInstanceOf(Error)
    expect(h.values.get('youtube-oauth-health')).toBe('reconnect_required')
    await expect(h.token()).rejects.toThrow('再接続')
    expect(refreshCount).toBe(2)
  })

  it('does not let an old same-token success overwrite a freshly authorized access token', async () => {
    const h = fixture()
    const old = deferred<Response>()
    const started = deferred<void>()
    let refreshCount = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      if (++refreshCount === 1) { started.resolve(); return old.promise }
      return json({ access_token: 'current-access', expires_in: 3600 })
    })
    const pending = h.token().catch((error: Error) => error)
    await started.promise
    h.platforms.invalidateYouTubeAuthentication()
    await expect(h.token()).resolves.toBe('current-access')
    old.resolve(json({ access_token: 'stale-access', expires_in: 3600 }))
    expect(await pending).toBeInstanceOf(Error)
    await expect(h.token()).resolves.toBe('current-access')
    expect(refreshCount).toBe(2)
  })
})
