import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GameProfile } from '../shared/contracts.js'
import { defaultConfig, starterProfiles } from './defaults.js'
import { PlatformServices, type ThumbnailPreparation } from './platforms.js'
import { SecretStore } from './secrets.js'
import { DataStore } from './storage.js'

const directories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('PlatformServices thumbnail preparation', () => {
  it('retries a failed upload and returns a non-throwing fallback result', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'obs-stream-manager-platforms-'))
    directories.push(directory)
    const store = new DataStore(directory)
    await store.initialize()
    const profile = (await store.listProfiles())[0]
    const bytes = await sharp({ create: { width: 16, height: 9, channels: 3, background: '#123456' } }).png().toBuffer()
    const saved = await store.saveThumbnail(profile, bytes, 'image/png')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('temporary failure', { status: 500 }))
    const platforms = new PlatformServices(new SecretStore(), store)
    const result = await (platforms as unknown as {
      applyYouTubeThumbnail: (accessToken: string, videoId: string, profile: GameProfile) => Promise<ThumbnailPreparation>
    }).applyYouTubeThumbnail('token', 'video', saved)
    expect(result.status).toBe('failed')
    expect(result.message).toContain('前回画像を維持')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('PlatformServices Twitch token management', () => {
  it('deduplicates refreshes and reuses the rotated refresh-token cache key', async () => {
    const secrets = new Map([
      ['twitch-refresh-token', 'refresh-one'],
    ])
    const secretStore = {
      get: vi.fn((name: string) => secrets.get(name) ?? null),
      set: vi.fn((name: string, value: string) => { secrets.set(name, value) }),
    } as unknown as SecretStore
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      access_token: 'access-two',
      refresh_token: 'refresh-two',
      expires_in: 3600,
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const platforms = new PlatformServices(secretStore, {} as DataStore)
    const config = (await import('./defaults.js')).defaultConfig
    const configured = structuredClone(config)
    configured.twitch.clientId = 'client-id'
    const accessToken = (platforms as unknown as { twitchAccessToken: (value: typeof configured) => Promise<string> }).twitchAccessToken.bind(platforms)

    await expect(Promise.all([accessToken(configured), accessToken(configured)])).resolves.toEqual(['access-two', 'access-two'])
    await expect(accessToken(configured)).resolves.toBe('access-two')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const refreshBody = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams
    expect(refreshBody.get('client_id')).toBe('client-id')
    expect(refreshBody.has('client_secret')).toBe(false)
    expect(secrets.get('twitch-refresh-token')).toBe('refresh-two')
    expect(secrets.get('twitch-access-token')).toBe('access-two')
  })
})

describe('PlatformServices YouTube token management', () => {
  it('refreshes an installed-app token with the distributor client secret', async () => {
    const secrets = new Map([
      ['youtube-refresh-token', 'youtube-refresh'],
      ['youtube-client-secret', 'youtube-client-secret'],
    ])
    const secretStore = {
      get: vi.fn((name: string) => secrets.get(name) ?? null),
      set: vi.fn((name: string, value: string) => { secrets.set(name, value) }),
    } as unknown as SecretStore
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ access_token: 'youtube-access', expires_in: 3600 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const platforms = new PlatformServices(secretStore, {} as DataStore)
    const config = (await import('./defaults.js')).defaultConfig
    const configured = structuredClone(config)
    configured.youtube.clientId = 'youtube-client-id'
    const accessToken = (platforms as unknown as { youtubeAccessToken: (value: typeof configured) => Promise<string> }).youtubeAccessToken.bind(platforms)

    await expect(accessToken(configured)).resolves.toBe('youtube-access')

    const refreshBody = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams
    expect(refreshBody.get('client_id')).toBe('youtube-client-id')
    expect(refreshBody.get('client_secret')).toBe('youtube-client-secret')
  })

  it('stores the bound YouTube ingestion key in the OS secret store during preparation', async () => {
    const values = new Map([
      ['youtube-refresh-token', 'youtube-refresh'],
      ['youtube-client-secret', 'youtube-client-secret'],
    ])
    const secretStore = {
      get: vi.fn((name: string) => values.get(name) ?? null),
      set: vi.fn((name: string, value: string) => { values.set(name, value) }),
    } as unknown as SecretStore
    const configured = structuredClone(defaultConfig)
    configured.youtube.clientId = 'youtube-client-id'
    configured.youtube.broadcastId = 'broadcast-id'
    const profile = structuredClone(starterProfiles[0])
    profile.youtube.privacy = 'private'
    const json = (value: unknown) => new Response(JSON.stringify(value), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
    let broadcastLifeCycle = 'ready'
    let broadcastAutoStart = true
    let broadcastAutoStop = true
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url === 'https://oauth2.googleapis.com/token') return json({ access_token: 'youtube-access', expires_in: 3600 })
      if (url.includes('/liveBroadcasts?') && init?.method === 'POST') return json({
        id: 'new-broadcast-id',
        snippet: { scheduledStartTime: '2026-07-14T00:01:00.000Z' },
        status: { lifeCycleStatus: 'ready', privacyStatus: 'private' },
        contentDetails: {},
      })
      if (url.includes('/liveBroadcasts?')) return json({ items: [{
        id: 'broadcast-id',
        snippet: { scheduledStartTime: '2026-07-14T00:00:00.000Z' },
        status: { lifeCycleStatus: broadcastLifeCycle, privacyStatus: 'private' },
        contentDetails: { boundStreamId: 'stream-id', enableAutoStart: broadcastAutoStart, enableAutoStop: broadcastAutoStop, monitorStream: { enableMonitorStream: !broadcastAutoStart, broadcastStreamDelayMs: 2500 } },
      }] })
      if (url.includes('/liveStreams?')) return json({ items: [{
        id: 'stream-id',
        cdn: { ingestionInfo: { streamName: 'test-youtube-stream-key', rtmpsIngestionAddress: 'rtmps://test.youtube/live2' } },
      }] })
      return json({})
    })
    const store = {
      getConfig: vi.fn().mockResolvedValue(configured),
      saveConfig: vi.fn(async (value) => value),
      getThumbnailPath: vi.fn().mockReturnValue(null),
    } as unknown as DataStore
    const platforms = new PlatformServices(secretStore, store)
    const prepareYouTube = (platforms as unknown as {
      prepareYouTube: (config: typeof configured, selected: GameProfile) => Promise<ThumbnailPreparation>
    }).prepareYouTube.bind(platforms)

    await expect(prepareYouTube(configured, profile)).resolves.toMatchObject({ status: 'not_registered' })

    expect(values.get('youtube-stream-key')).toBe('test-youtube-stream-key')
    expect(values.get('youtube-stream-server')).toBe('rtmps://test.youtube/live2')
    const streamRequest = fetchMock.mock.calls.find(([input]) => String(input).includes('/liveStreams?'))
    expect(String(streamRequest?.[0])).toContain('part=id%2Ccdn')
    expect(String(streamRequest?.[0])).toContain('id=stream-id')
    const broadcastUpdate = fetchMock.mock.calls.find(([input, init]) => String(input).includes('/liveBroadcasts?') && init?.method === 'PUT')
    expect(new URL(String(broadcastUpdate?.[0])).searchParams.get('part')).toBe('snippet,status')
    expect(JSON.parse(String(broadcastUpdate?.[1]?.body))).not.toHaveProperty('contentDetails')

    broadcastLifeCycle = 'testing'
    broadcastAutoStart = false
    broadcastAutoStop = false
    fetchMock.mockClear()
    await expect(prepareYouTube(configured, profile)).resolves.toMatchObject({ status: 'not_registered' })
    const testingUpdate = fetchMock.mock.calls.find(([input, init]) => String(input).includes('/liveBroadcasts?') && init?.method === 'PUT')
    expect(new URL(String(testingUpdate?.[0])).searchParams.get('part')).toBe('snippet,status')
    expect(JSON.parse(String(testingUpdate?.[1]?.body))).not.toHaveProperty('contentDetails')

    broadcastLifeCycle = 'ready'
    fetchMock.mockClear()
    await expect(prepareYouTube(configured, profile)).resolves.toMatchObject({ status: 'not_registered' })
    const reused = fetchMock.mock.calls.find(([input, init]) => String(input).includes('/liveBroadcasts?') && init?.method === 'PUT')
    expect(new URL(String(reused?.[0])).searchParams.get('part')).toBe('snippet,status')
    expect(JSON.parse(String(reused?.[1]?.body))).not.toHaveProperty('contentDetails')
    expect(fetchMock.mock.calls.some(([input, init]) => String(input).includes('/liveBroadcasts?') && init?.method === 'POST')).toBe(false)

    broadcastLifeCycle = 'complete'
    fetchMock.mockClear()
    await expect(prepareYouTube(configured, profile)).resolves.toMatchObject({ status: 'not_registered' })
    const inserted = fetchMock.mock.calls.find(([input, init]) => String(input).includes('/liveBroadcasts?') && init?.method === 'POST')
    const insertedBody = JSON.parse(String(inserted?.[1]?.body)) as { contentDetails: { enableAutoStart: boolean; enableAutoStop: boolean; monitorStream: { enableMonitorStream: boolean; broadcastStreamDelayMs: number } } }
    expect(insertedBody.contentDetails).toEqual({
      enableAutoStart: true,
      enableAutoStop: true,
      monitorStream: { enableMonitorStream: false, broadcastStreamDelayMs: 0 },
      latencyPreference: 'low',
    })
    expect(store.saveConfig).toHaveBeenCalled()
  })
})

describe('PlatformServices YouTube broadcast lifecycle', () => {
  it('waits for active ingest and transitions the prepared broadcast to live', async () => {
    const secrets = new Map([
      ['youtube-refresh-token', 'youtube-refresh'],
      ['youtube-client-secret', 'youtube-client-secret'],
    ])
    const secretStore = {
      get: vi.fn((name: string) => secrets.get(name) ?? null),
      set: vi.fn((name: string, value: string) => { secrets.set(name, value) }),
    } as unknown as SecretStore
    const configured = structuredClone(defaultConfig)
    configured.features.youtube = true
    configured.youtube.clientId = 'youtube-client-id'
    configured.youtube.broadcastId = 'broadcast-id'
    const profile = structuredClone(starterProfiles[0])
    profile.youtube.enabled = true
    let streamReads = 0
    let broadcastReads = 0
    let broadcastLookupAttempts = 0
    const json = (value: unknown) => new Response(JSON.stringify(value), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input))
      if (url.toString() === 'https://oauth2.googleapis.com/token') return json({ access_token: 'youtube-access', expires_in: 3600 })
      if (url.pathname.endsWith('/liveStreams')) {
        streamReads += 1
        return json({ items: [{ id: 'stream-id', status: { streamStatus: streamReads > 1 ? 'active' : 'inactive' } }] })
      }
      if (url.pathname.endsWith('/liveBroadcasts/transition')) {
        const requested = url.searchParams.get('broadcastStatus')
        return json({ id: 'broadcast-id', status: { lifeCycleStatus: requested === 'testing' ? 'testStarting' : 'liveStarting' } })
      }
      if (url.pathname.endsWith('/liveBroadcasts')) {
        broadcastLookupAttempts += 1
        if (broadcastLookupAttempts === 1) return json({ items: [] })
        broadcastReads += 1
        const lifeCycleStatus = ['ready', 'ready', 'testStarting', 'testing', 'liveStarting', 'live'][broadcastReads - 1] ?? 'live'
        return json({ items: [{ id: 'broadcast-id', status: { lifeCycleStatus }, contentDetails: { boundStreamId: 'stream-id' } }] })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const platforms = new PlatformServices(secretStore, {} as DataStore, {
      pollIntervalMs: 1,
      streamActiveTimeoutMs: 100,
      transitionTimeoutMs: 100,
    })

    await expect(platforms.startYouTubeBroadcast(configured, profile)).resolves.toBeUndefined()

    expect(streamReads).toBe(2)
    expect(broadcastLookupAttempts).toBeGreaterThan(broadcastReads)
    const transitions = fetchMock.mock.calls.filter(([input]) => String(input).includes('/liveBroadcasts/transition'))
    expect(transitions.map(([input]) => new URL(String(input)).searchParams.get('broadcastStatus'))).toEqual(['testing', 'live'])
    expect(transitions.every(([, init]) => init?.method === 'POST')).toBe(true)
    expect(new URL(String(transitions[0]?.[0])).searchParams.get('id')).toBe('broadcast-id')
  })

  it('transitions a live broadcast to complete after the encoder stops', async () => {
    const secrets = new Map([
      ['youtube-refresh-token', 'youtube-refresh'],
      ['youtube-client-secret', 'youtube-client-secret'],
    ])
    const secretStore = {
      get: vi.fn((name: string) => secrets.get(name) ?? null),
      set: vi.fn((name: string, value: string) => { secrets.set(name, value) }),
    } as unknown as SecretStore
    const configured = structuredClone(defaultConfig)
    configured.features.youtube = true
    configured.youtube.clientId = 'youtube-client-id'
    configured.youtube.broadcastId = 'broadcast-id'
    const profile = structuredClone(starterProfiles[0])
    profile.youtube.enabled = true
    let broadcastReads = 0
    const json = (value: unknown) => new Response(JSON.stringify(value), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input))
      if (url.toString() === 'https://oauth2.googleapis.com/token') return json({ access_token: 'youtube-access', expires_in: 3600 })
      if (url.pathname.endsWith('/liveBroadcasts/transition')) return json({ id: 'broadcast-id', status: { lifeCycleStatus: 'complete' } })
      if (url.pathname.endsWith('/liveBroadcasts')) {
        broadcastReads += 1
        return json({ items: [{ id: 'broadcast-id', status: { lifeCycleStatus: broadcastReads === 1 ? 'live' : 'complete' }, contentDetails: { boundStreamId: 'stream-id' } }] })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const platforms = new PlatformServices(secretStore, {} as DataStore, { pollIntervalMs: 1, transitionTimeoutMs: 100 })

    await expect(platforms.completeYouTubeBroadcast(configured, profile)).resolves.toBeUndefined()

    const transition = fetchMock.mock.calls.find(([input]) => String(input).includes('/liveBroadcasts/transition'))
    const transitionUrl = new URL(String(transition?.[0]))
    expect(transition?.[1]?.method).toBe('POST')
    expect(transitionUrl.searchParams.get('broadcastStatus')).toBe('complete')
  })

  it('rejects a completed broadcast and leaves a ready rollback broadcast reusable', async () => {
    const secrets = new Map([
      ['youtube-refresh-token', 'youtube-refresh'],
      ['youtube-client-secret', 'youtube-client-secret'],
    ])
    const secretStore = {
      get: vi.fn((name: string) => secrets.get(name) ?? null),
      set: vi.fn((name: string, value: string) => { secrets.set(name, value) }),
    } as unknown as SecretStore
    const configured = structuredClone(defaultConfig)
    configured.features.youtube = true
    configured.youtube.clientId = 'youtube-client-id'
    configured.youtube.broadcastId = 'broadcast-id'
    const profile = structuredClone(starterProfiles[0])
    profile.youtube.enabled = true
    let lifeCycleStatus = 'complete'
    const json = (value: unknown) => new Response(JSON.stringify(value), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input))
      if (url.toString() === 'https://oauth2.googleapis.com/token') return json({ access_token: 'youtube-access', expires_in: 3600 })
      if (url.pathname.endsWith('/liveBroadcasts')) {
        return json({ items: [{ id: 'broadcast-id', status: { lifeCycleStatus }, contentDetails: { boundStreamId: 'stream-id' } }] })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const platforms = new PlatformServices(secretStore, {} as DataStore, { pollIntervalMs: 1, transitionTimeoutMs: 100 })

    await expect(platforms.startYouTubeBroadcast(configured, profile)).rejects.toThrow('既に終了しています')
    lifeCycleStatus = 'ready'
    await expect(platforms.completeYouTubeBroadcast(configured, profile)).resolves.toBeUndefined()
    lifeCycleStatus = 'testing'
    await expect(platforms.completeYouTubeBroadcast(configured, profile)).resolves.toBeUndefined()
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/liveBroadcasts/transition'))).toBe(false)
  })
})

describe('PlatformServices external live status', () => {
  it('uses the actual YouTube lifecycle and Twitch stream API and caches the result', async () => {
    const secrets = new Map([
      ['youtube-refresh-token', 'youtube-refresh'],
      ['youtube-client-secret', 'youtube-client-secret'],
      ['twitch-access-token', 'twitch-access'],
    ])
    const secretStore = {
      get: vi.fn((name: string) => secrets.get(name) ?? null),
      set: vi.fn((name: string, value: string) => { secrets.set(name, value) }),
    } as unknown as SecretStore
    const configured = structuredClone(defaultConfig)
    configured.youtube = { clientId: 'youtube-client', clientSecretStored: true, refreshTokenStored: true, broadcastId: 'broadcast-id' }
    configured.twitch = { clientId: 'twitch-client', clientSecretStored: false, accessTokenStored: true, refreshTokenStored: false, broadcasterId: 'broadcaster-id' }
    const profile = structuredClone(starterProfiles[0])
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input))
      if (url.toString() === 'https://oauth2.googleapis.com/token') return json({ access_token: 'youtube-access', expires_in: 3600 })
      if (url.hostname === 'www.googleapis.com' && url.pathname.endsWith('/liveBroadcasts')) {
        return json({ items: [{ id: 'broadcast-id', status: { lifeCycleStatus: 'live' }, contentDetails: { boundStreamId: 'stream-id' } }] })
      }
      if (url.hostname === 'api.twitch.tv' && url.pathname === '/helix/streams') return json({ data: [{ id: 'stream-id', type: 'live' }] })
      throw new Error(`Unexpected request: ${url}`)
    })
    const platforms = new PlatformServices(secretStore, {} as DataStore)

    await expect(platforms.getLiveStatus(configured, profile)).resolves.toMatchObject({
      youtube: { state: 'live', detail: 'YouTubeで公開配信中' },
      twitch: { state: 'live', detail: 'Twitchで公開配信中' },
    })
    await platforms.getLiveStatus(configured, profile)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('does not let an invalidated in-flight status request repopulate the cache', async () => {
    const secrets = new Map([
      ['youtube-refresh-token', 'youtube-refresh'],
      ['youtube-client-secret', 'youtube-client-secret'],
      ['twitch-access-token', 'twitch-access'],
    ])
    const secretStore = {
      get: vi.fn((name: string) => secrets.get(name) ?? null),
      set: vi.fn((name: string, value: string) => { secrets.set(name, value) }),
    } as unknown as SecretStore
    const configured = structuredClone(defaultConfig)
    configured.youtube = { clientId: 'youtube-client', clientSecretStored: true, refreshTokenStored: true, broadcastId: 'broadcast-id' }
    configured.twitch = { clientId: 'twitch-client', clientSecretStored: false, accessTokenStored: true, refreshTokenStored: false, broadcasterId: 'broadcaster-id' }
    const profile = structuredClone(starterProfiles[0])
    let releaseFirstBroadcast!: () => void
    const firstBroadcastBlocked = new Promise<void>((resolve) => { releaseFirstBroadcast = resolve })
    let broadcastRequests = 0
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input))
      if (url.toString() === 'https://oauth2.googleapis.com/token') return json({ access_token: 'youtube-access', expires_in: 3600 })
      if (url.hostname === 'www.googleapis.com' && url.pathname.endsWith('/liveBroadcasts')) {
        const requestNumber = ++broadcastRequests
        if (requestNumber === 1) await firstBroadcastBlocked
        return json({ items: [{ id: 'broadcast-id', status: { lifeCycleStatus: requestNumber === 1 ? 'ready' : 'live' }, contentDetails: { boundStreamId: 'stream-id' } }] })
      }
      if (url.hostname === 'api.twitch.tv' && url.pathname === '/helix/streams') return json({ data: [] })
      throw new Error(`Unexpected request: ${url}`)
    })
    const platforms = new PlatformServices(secretStore, {} as DataStore)

    const stale = platforms.getLiveStatus(configured, profile)
    await vi.waitFor(() => expect(broadcastRequests).toBe(1))
    platforms.invalidateLiveStatus()
    const fresh = platforms.getLiveStatus(configured, profile)
    await vi.waitFor(() => expect(broadcastRequests).toBe(2))
    releaseFirstBroadcast()

    await expect(stale).resolves.toMatchObject({ youtube: { state: 'live' } })
    await expect(fresh).resolves.toMatchObject({ youtube: { state: 'live' } })
    await expect(platforms.getLiveStatus(configured, profile)).resolves.toMatchObject({ youtube: { state: 'live' } })
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('/liveBroadcasts')).length).toBe(2)
  })

  it('lets YouTube auto-start continue asynchronously and does not send a manual transition', async () => {
    const secrets = new Map([
      ['youtube-refresh-token', 'youtube-refresh'],
      ['youtube-client-secret', 'youtube-client-secret'],
    ])
    const secretStore = {
      get: vi.fn((name: string) => secrets.get(name) ?? null),
      set: vi.fn((name: string, value: string) => { secrets.set(name, value) }),
    } as unknown as SecretStore
    const configured = structuredClone(defaultConfig)
    configured.youtube.clientId = 'youtube-client'
    configured.youtube.broadcastId = 'broadcast-id'
    const profile = structuredClone(starterProfiles[0])
    let broadcastReads = 0
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input))
      if (url.toString() === 'https://oauth2.googleapis.com/token') return json({ access_token: 'youtube-access', expires_in: 3600 })
      if (url.pathname.endsWith('/liveStreams')) return json({ items: [{ id: 'stream-id', status: { streamStatus: 'active' } }] })
      if (url.pathname.endsWith('/liveBroadcasts')) {
        broadcastReads += 1
        const lifeCycleStatus = ['ready', 'liveStarting', 'live'][broadcastReads - 1] ?? 'live'
        return json({ items: [{ id: 'broadcast-id', status: { lifeCycleStatus }, contentDetails: { boundStreamId: 'stream-id', enableAutoStart: true, enableAutoStop: true } }] })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const platforms = new PlatformServices(secretStore, {} as DataStore, { pollIntervalMs: 1, transitionTimeoutMs: 100 })

    await expect(platforms.startYouTubeBroadcast(configured, profile)).resolves.toBeUndefined()
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/liveBroadcasts/transition'))).toBe(false)
    expect(broadcastReads).toBe(2)
  })

  it('lets YouTube auto-stop finish the broadcast without racing a manual transition', async () => {
    const secrets = new Map([
      ['youtube-refresh-token', 'youtube-refresh'],
      ['youtube-client-secret', 'youtube-client-secret'],
    ])
    const secretStore = {
      get: vi.fn((name: string) => secrets.get(name) ?? null),
      set: vi.fn((name: string, value: string) => { secrets.set(name, value) }),
    } as unknown as SecretStore
    const configured = structuredClone(defaultConfig)
    configured.youtube.clientId = 'youtube-client'
    configured.youtube.broadcastId = 'broadcast-id'
    const profile = structuredClone(starterProfiles[0])
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input))
      if (url.toString() === 'https://oauth2.googleapis.com/token') return json({ access_token: 'youtube-access', expires_in: 3600 })
      if (url.pathname.endsWith('/liveBroadcasts')) {
        return json({ items: [{ id: 'broadcast-id', status: { lifeCycleStatus: 'live' }, contentDetails: { boundStreamId: 'stream-id', enableAutoStop: true } }] })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const platforms = new PlatformServices(secretStore, {} as DataStore)

    await expect(platforms.completeYouTubeBroadcast(configured, profile)).resolves.toBeUndefined()
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/liveBroadcasts/transition'))).toBe(false)
  })
})
