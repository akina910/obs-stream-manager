import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GameProfile } from '../shared/contracts.js'
import { defaultConfig, starterProfiles } from './defaults.js'
import { parseYouTubePublicViewerCount, PlatformServices, type ThumbnailPreparation } from './platforms.js'
import { SecretStore } from './secrets.js'
import { DataStore } from './storage.js'

const directories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('PlatformServices integrated comments', () => {
  it('polls and deduplicates YouTube comments with author, moderator and mention state', async () => {
    const values = new Map([
      ['youtube-refresh-token', 'youtube-refresh'],
      ['youtube-client-secret', 'youtube-client-secret'],
    ])
    const secretStore = {
      get: vi.fn((name: string) => values.get(name) ?? null),
      set: vi.fn((name: string, value: string) => { values.set(name, value) }),
    } as unknown as SecretStore
    const configured = structuredClone(defaultConfig)
    configured.features.youtube = true
    configured.features.twitch = false
    configured.youtube.clientId = 'youtube-client-id'
    configured.youtube.refreshTokenStored = true
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input))
      if (url.toString() === 'https://oauth2.googleapis.com/token') return json({ access_token: 'youtube-access', expires_in: 3600 })
      if (url.pathname.endsWith('/liveBroadcasts')) return json({ items: [{ snippet: { liveChatId: 'live-chat-id' } }] })
      if (url.pathname.endsWith('/liveChat/messages')) return json({
        nextPageToken: 'next-page',
        pollingIntervalMillis: 60_000,
        items: [
          { id: 'message-one', snippet: { displayMessage: '通常コメント', publishedAt: '2026-07-17T01:00:00.000Z' }, authorDetails: { displayName: '視聴者' } },
          { id: 'message-one', snippet: { displayMessage: '通常コメント', publishedAt: '2026-07-17T01:00:00.000Z' }, authorDetails: { displayName: '視聴者' } },
          { id: 'message-two', snippet: { displayMessage: '@配信者 確認コメント', publishedAt: '2026-07-17T01:01:00.000Z' }, authorDetails: { displayName: 'モデレーター', isChatModerator: true } },
        ],
      })
      throw new Error(`Unexpected request: ${url}`)
    })
    const platforms = new PlatformServices(secretStore, {} as DataStore)

    await platforms.startComments(configured)
    await vi.waitFor(() => expect(platforms.getComments()).toHaveLength(2))

    expect(platforms.getComments()).toEqual([
      expect.objectContaining({ id: 'youtube:message-one', service: 'youtube', author: '視聴者', body: '通常コメント', moderator: false, mention: false }),
      expect.objectContaining({ id: 'youtube:message-two', service: 'youtube', author: 'モデレーター', body: '@配信者 確認コメント', moderator: true, mention: true }),
    ])
    await platforms.stopComments()
  })

  it('ignores a YouTube response that completes after the comment session stops', async () => {
    const values = new Map([
      ['youtube-refresh-token', 'youtube-refresh'],
      ['youtube-client-secret', 'youtube-client-secret'],
    ])
    const secretStore = {
      get: vi.fn((name: string) => values.get(name) ?? null),
      set: vi.fn((name: string, value: string) => { values.set(name, value) }),
    } as unknown as SecretStore
    const configured = structuredClone(defaultConfig)
    configured.features.youtube = true
    configured.features.twitch = false
    configured.youtube.clientId = 'youtube-client-id'
    configured.youtube.refreshTokenStored = true
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
    let releaseBroadcast!: () => void
    const broadcastBlocked = new Promise<void>((resolve) => { releaseBroadcast = resolve })
    let broadcastRequested = false
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input))
      if (url.toString() === 'https://oauth2.googleapis.com/token') return json({ access_token: 'youtube-access', expires_in: 3600 })
      if (url.pathname.endsWith('/liveBroadcasts')) {
        broadcastRequested = true
        await broadcastBlocked
        return json({ items: [{ snippet: { liveChatId: 'old-live-chat-id' } }] })
      }
      if (url.pathname.endsWith('/liveChat/messages')) return json({ items: [{ id: 'late', snippet: { displayMessage: '遅延コメント', publishedAt: '2026-07-17T01:00:00.000Z' }, authorDetails: { displayName: '古い視聴者' } }] })
      throw new Error(`Unexpected request: ${url}`)
    })
    const platforms = new PlatformServices(secretStore, {} as DataStore)
    const internals = platforms as unknown as { commentsGeneration: number; pollYouTubeComments: (config: typeof configured, generation: number) => Promise<number> }

    const polling = internals.pollYouTubeComments(configured, internals.commentsGeneration)
    await vi.waitFor(() => expect(broadcastRequested).toBe(true))
    await platforms.stopComments()
    releaseBroadcast()
    await polling

    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('/liveChat/messages'))).toHaveLength(0)
    expect(platforms.getComments()).toEqual([])
  })

  it('receives and deduplicates Twitch IRC comments with author, moderator and channel mention state', async () => {
    type Listener = (event: { data?: string }) => void
    class FakeWebSocket {
      static latest: FakeWebSocket | null = null
      readonly sent: string[] = []
      private readonly listeners = new Map<string, Listener[]>()

      constructor() { FakeWebSocket.latest = this }
      addEventListener(type: string, listener: Listener): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]) }
      send(value: string): void { this.sent.push(value) }
      close(): void { this.emit('close', {}) }
      emit(type: string, event: { data?: string }): void { for (const listener of this.listeners.get(type) ?? []) listener(event) }
    }
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const secretStore = {
      get: vi.fn((name: string) => name === 'twitch-access-token' ? 'twitch-access' : null),
      set: vi.fn(),
    } as unknown as SecretStore
    const configured = structuredClone(defaultConfig)
    configured.features.youtube = false
    configured.features.twitch = true
    configured.twitch.clientId = 'twitch-client-id'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [{ login: 'streamer' }] }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const platforms = new PlatformServices(secretStore, {} as DataStore)

    await platforms.startComments(configured)
    const socket = FakeWebSocket.latest
    expect(socket).not.toBeNull()
    socket?.emit('open', {})
    const ircMessage = '@id=message-one;display-name=Viewer\\sName;mod=1 :viewer!viewer@viewer.tmi.twitch.tv PRIVMSG #streamer :Hello @Streamer\r\n'
    socket?.emit('message', { data: ircMessage })
    socket?.emit('message', { data: ircMessage })

    expect(socket?.sent.join('')).toContain('JOIN #streamer')
    expect(platforms.getComments()).toEqual([
      expect.objectContaining({ id: 'twitch:message-one', service: 'twitch', author: 'Viewer Name', body: 'Hello @Streamer', moderator: true, mention: true }),
    ])
    await platforms.stopComments()
  })

  it('ignores Twitch messages delivered by a socket from a stopped session', async () => {
    type Listener = (event: { data?: string }) => void
    class FakeWebSocket {
      static sockets: FakeWebSocket[] = []
      private readonly listeners = new Map<string, Listener[]>()

      constructor() { FakeWebSocket.sockets.push(this) }
      addEventListener(type: string, listener: Listener): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]) }
      send(): void {}
      close(): void { this.emit('close', {}) }
      emit(type: string, event: { data?: string }): void { for (const listener of this.listeners.get(type) ?? []) listener(event) }
    }
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const secretStore = {
      get: vi.fn((name: string) => name === 'twitch-access-token' ? 'twitch-access' : null),
      set: vi.fn(),
    } as unknown as SecretStore
    const configured = structuredClone(defaultConfig)
    configured.features.youtube = false
    configured.features.twitch = true
    configured.twitch.clientId = 'twitch-client-id'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [{ login: 'streamer' }] }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const platforms = new PlatformServices(secretStore, {} as DataStore)

    await platforms.startComments(configured)
    const stoppedSocket = FakeWebSocket.sockets[0]
    await platforms.stopComments()
    await platforms.startComments(configured)
    stoppedSocket?.emit('message', { data: '@id=old;display-name=OldViewer;mod=0 :old!old@old.tmi.twitch.tv PRIVMSG #streamer :前回コメント\r\n' })

    expect(platforms.getComments()).toEqual([])
    await platforms.stopComments()
  })

  it('clears comments before a new stream comment session starts', async () => {
    const configured = structuredClone(defaultConfig)
    configured.features.youtube = false
    configured.features.twitch = false
    const platforms = new PlatformServices({ get: vi.fn(), set: vi.fn() } as unknown as SecretStore, {} as DataStore)
    const addComment = (platforms as unknown as { addComment: (message: { id: string; service: 'youtube'; author: string; body: string; publishedAt: string; moderator: boolean; mention: boolean }) => void }).addComment.bind(platforms)
    addComment({ id: 'youtube:old', service: 'youtube', author: '前回の視聴者', body: '前回のコメント', publishedAt: '2026-07-17T00:00:00.000Z', moderator: false, mention: false })

    await platforms.startComments(configured)

    expect(platforms.getComments()).toEqual([])
    await platforms.stopComments()
  })
})

describe('PlatformServices thumbnail preparation', () => {
  it('retries a failed upload and returns a non-throwing fallback result', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'obs-stream-manager-platforms-'))
    directories.push(directory)
    const store = new DataStore(directory)
    await store.initialize()
    const profile = await store.saveProfile(starterProfiles[0])
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
    expect(secrets.get('twitch-oauth-health')).toBe('')
  })

  it('marks an invalid Twitch refresh token for reconnection', async () => {
    const secrets = new Map([
      ['twitch-refresh-token', 'expired-refresh'],
    ])
    const secretStore = {
      get: vi.fn((name: string) => secrets.get(name) ?? null),
      set: vi.fn((name: string, value: string) => { secrets.set(name, value) }),
    } as unknown as SecretStore
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ message: 'Invalid refresh token' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }))
    const platforms = new PlatformServices(secretStore, {} as DataStore)
    const configured = structuredClone(defaultConfig)
    configured.twitch.clientId = 'client-id'
    const accessToken = (platforms as unknown as { twitchAccessToken: (value: typeof configured) => Promise<string> }).twitchAccessToken.bind(platforms)

    await expect(accessToken(configured)).rejects.toThrow('Invalid refresh token')
    expect(secrets.get('twitch-oauth-health')).toBe('reconnect_required')
  })

  it('does not turn a temporary Twitch outage into a reconnect requirement', async () => {
    const secrets = new Map([
      ['twitch-refresh-token', 'valid-refresh'],
    ])
    const secretStore = {
      get: vi.fn((name: string) => secrets.get(name) ?? null),
      set: vi.fn((name: string, value: string) => { secrets.set(name, value) }),
    } as unknown as SecretStore
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ message: 'temporarily unavailable' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    }))
    const platforms = new PlatformServices(secretStore, {} as DataStore)
    const configured = structuredClone(defaultConfig)
    configured.twitch.clientId = 'client-id'
    const accessToken = (platforms as unknown as { twitchAccessToken: (value: typeof configured) => Promise<string> }).twitchAccessToken.bind(platforms)

    await expect(accessToken(configured)).rejects.toThrow('temporarily unavailable')
    expect(secrets.has('twitch-oauth-health')).toBe(false)
  })
})

describe('PlatformServices YouTube token management', () => {
  it('refreshes an installed-app token with the provisioned Desktop app credential', async () => {
    const secrets = new Map([
      ['youtube-refresh-token', 'youtube-refresh'],
      ['youtube-client-secret', 'youtube-desktop-credential'],
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
    expect(refreshBody.get('client_secret')).toBe('youtube-desktop-credential')
    expect(secrets.get('youtube-oauth-health')).toBe('')
  })

  it('marks stored YouTube credentials for reconnection when Google rejects the client type', async () => {
    const secrets = new Map([
      ['youtube-refresh-token', 'youtube-refresh'],
      ['youtube-client-secret', 'stale-desktop-credential'],
    ])
    const secretStore = {
      get: vi.fn((name: string) => secrets.get(name) ?? null),
      set: vi.fn((name: string, value: string) => { secrets.set(name, value) }),
    } as unknown as SecretStore
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: 'invalid_request',
      error_description: 'client_secret is missing.',
    }), { status: 400, headers: { 'content-type': 'application/json' } }))
    const platforms = new PlatformServices(secretStore, {} as DataStore)
    const configured = structuredClone(defaultConfig)
    configured.youtube.clientId = 'web-client-used-by-mistake'
    const accessToken = (platforms as unknown as { youtubeAccessToken: (value: typeof configured) => Promise<string> }).youtubeAccessToken.bind(platforms)

    await expect(accessToken(configured)).rejects.toThrow('client_secret is missing')
    expect(secrets.get('youtube-oauth-health')).toBe('reconnect_required')
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
        snippet: { title: 'OBS Stream Manager 1080p60 reusable stream' },
        cdn: { resolution: '1080p', frameRate: '60fps', ingestionInfo: { streamName: 'test-youtube-stream-key', rtmpsIngestionAddress: 'rtmps://test.youtube/live2' } },
        status: { streamStatus: 'ready' },
        contentDetails: { isReusable: true },
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
    expect(String(streamRequest?.[0])).toContain('part=id%2Ccdn%2Cstatus')
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

  it('creates and binds a reusable YouTube stream when the channel has none', async () => {
    const values = new Map([
      ['youtube-refresh-token', 'youtube-refresh'],
      ['youtube-client-secret', 'youtube-desktop-credential'],
    ])
    const secretStore = {
      get: vi.fn((name: string) => values.get(name) ?? null),
      set: vi.fn((name: string, value: string) => { values.set(name, value) }),
    } as unknown as SecretStore
    const configured = structuredClone(defaultConfig)
    configured.youtube.clientId = 'youtube-client-id'
    configured.youtube.broadcastId = 'broadcast-id'
    const profile = structuredClone(starterProfiles[0])
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input))
      if (url.toString() === 'https://oauth2.googleapis.com/token') return json({ access_token: 'youtube-access', expires_in: 3600 })
      if (url.pathname.endsWith('/liveBroadcasts') && !init?.method) return json({ items: [{
        id: 'broadcast-id',
        snippet: { scheduledStartTime: '2026-07-14T00:00:00.000Z' },
        status: { lifeCycleStatus: 'ready', privacyStatus: 'private' },
        contentDetails: {},
      }] })
      if (url.pathname.endsWith('/liveStreams') && init?.method === 'POST') return json({
        id: 'created-stream-id',
        cdn: { ingestionInfo: { streamName: 'created-stream-key', rtmpsIngestionAddress: 'rtmps://created.youtube/live2' } },
      })
      if (url.pathname.endsWith('/liveStreams') && url.searchParams.get('mine') === 'true') return json({ items: [] })
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

    const created = fetchMock.mock.calls.find(([input, init]) => String(input).includes('/liveStreams?') && init?.method === 'POST')
    expect(new URL(String(created?.[0])).searchParams.get('part')).toBe('id,snippet,cdn,contentDetails')
    expect(JSON.parse(String(created?.[1]?.body))).toEqual({
      snippet: { title: 'OBS Stream Manager 1080p60 reusable stream' },
      cdn: { ingestionType: 'rtmp', resolution: '1080p', frameRate: '60fps' },
      contentDetails: { isReusable: true },
    })
    expect(fetchMock.mock.calls.some(([input, init]) => String(input).includes('/liveBroadcasts/bind') && init?.method === 'POST')).toBe(true)
    expect(values.get('youtube-stream-key')).toBe('created-stream-key')
    expect(values.get('youtube-stream-server')).toBe('rtmps://created.youtube/live2')
  })

  it('rebinds a ready broadcast from a legacy 720p30 stream to an idle managed 1080p60 stream', async () => {
    const values = new Map([
      ['youtube-refresh-token', 'youtube-refresh'],
      ['youtube-client-secret', 'youtube-desktop-credential'],
    ])
    const secretStore = {
      get: vi.fn((name: string) => values.get(name) ?? null),
      set: vi.fn((name: string, value: string) => { values.set(name, value) }),
    } as unknown as SecretStore
    const configured = structuredClone(defaultConfig)
    configured.youtube.clientId = 'youtube-client-id'
    configured.youtube.broadcastId = 'broadcast-id'
    const profile = structuredClone(starterProfiles[0])
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input))
      if (url.toString() === 'https://oauth2.googleapis.com/token') return json({ access_token: 'youtube-access', expires_in: 3600 })
      if (url.pathname.endsWith('/liveBroadcasts') && !init?.method) return json({ items: [{
        id: 'broadcast-id',
        snippet: { scheduledStartTime: '2026-07-14T00:00:00.000Z' },
        status: { lifeCycleStatus: 'ready', privacyStatus: 'private' },
        contentDetails: { boundStreamId: 'legacy-stream-id' },
      }] })
      if (url.pathname.endsWith('/liveStreams') && url.searchParams.get('id') === 'legacy-stream-id') return json({ items: [{
        id: 'legacy-stream-id',
        cdn: { resolution: '720p', frameRate: '30fps', ingestionInfo: { streamName: 'legacy-key', rtmpsIngestionAddress: 'rtmps://legacy.youtube/live2' } },
        status: { streamStatus: 'ready' },
      }] })
      if (url.pathname.endsWith('/liveStreams') && url.searchParams.get('mine') === 'true') return json({ items: [{
        id: 'managed-stream-id',
        snippet: { title: 'OBS Stream Manager 1080p60 reusable stream' },
        cdn: { resolution: '1080p', frameRate: '60fps', ingestionInfo: { streamName: 'managed-key', rtmpsIngestionAddress: 'rtmps://managed.youtube/live2' } },
        status: { streamStatus: 'ready' },
        contentDetails: { isReusable: true },
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

    const bind = fetchMock.mock.calls.find(([input, init]) => String(input).includes('/liveBroadcasts/bind') && init?.method === 'POST')
    expect(new URL(String(bind?.[0])).searchParams.get('streamId')).toBe('managed-stream-id')
    expect(fetchMock.mock.calls.some(([input, init]) => String(input).includes('/liveStreams?') && init?.method === 'POST')).toBe(false)
    expect(values.get('youtube-stream-key')).toBe('managed-key')
    expect(values.get('youtube-stream-server')).toBe('rtmps://managed.youtube/live2')
  })

  it.each([
    { lifeCycleStatus: 'live', caseName: 'the broadcast is live' },
    { lifeCycleStatus: 'ready', caseName: 'OBS ingest is already active' },
  ])('refuses to replace an incompatible YouTube stream when $caseName', async ({ lifeCycleStatus }) => {
    const values = new Map([
      ['youtube-refresh-token', 'youtube-refresh'],
      ['youtube-client-secret', 'youtube-desktop-credential'],
    ])
    const secretStore = {
      get: vi.fn((name: string) => values.get(name) ?? null),
      set: vi.fn((name: string, value: string) => { values.set(name, value) }),
    } as unknown as SecretStore
    const configured = structuredClone(defaultConfig)
    configured.youtube.clientId = 'youtube-client-id'
    configured.youtube.broadcastId = 'broadcast-id'
    const profile = structuredClone(starterProfiles[0])
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input))
      if (url.toString() === 'https://oauth2.googleapis.com/token') return json({ access_token: 'youtube-access', expires_in: 3600 })
      if (url.pathname.endsWith('/liveBroadcasts') && !init?.method) return json({ items: [{
        id: 'broadcast-id',
        snippet: { scheduledStartTime: '2026-07-14T00:00:00.000Z' },
        status: { lifeCycleStatus, privacyStatus: 'public' },
        contentDetails: { boundStreamId: 'legacy-stream-id' },
      }] })
      if (url.pathname.endsWith('/liveStreams') && url.searchParams.get('id') === 'legacy-stream-id') return json({ items: [{
        id: 'legacy-stream-id',
        cdn: { resolution: '720p', frameRate: '30fps', ingestionInfo: { streamName: 'legacy-key', rtmpsIngestionAddress: 'rtmps://legacy.youtube/live2' } },
        status: { streamStatus: 'active' },
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

    await expect(prepareYouTube(configured, profile)).rejects.toThrow('配信中の枠は変更しません')
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/liveBroadcasts/bind'))).toBe(false)
    expect(fetchMock.mock.calls.some(([input, init]) => String(input).includes('/liveStreams?') && init?.method === 'POST')).toBe(false)
  })
})

describe('YouTube public viewer count parser', () => {
  it.each([
    ['{"videoViewCountRenderer":{"viewCount":{"simpleText":"1,234人が視聴中"},"isLive":true}}', 1234],
    ['{"videoViewCountRenderer":{"viewCount":{"simpleText":"1\u202f234 watching now"},"isLive":true}}', 1234],
  ])('parses localized live viewer text', (html, expected) => {
    expect(parseYouTubePublicViewerCount(html)).toBe(expected)
  })

  it('rejects non-live and ambiguous viewer counts', () => {
    expect(parseYouTubePublicViewerCount('{"videoViewCountRenderer":{"viewCount":{"simpleText":"9人が視聴中"},"isLive":false}}')).toBeNull()
    expect(parseYouTubePublicViewerCount('{"videoViewCountRenderer":{"viewCount":{"simpleText":"1 watching now"},"isLive":true}} {"videoViewCountRenderer":{"viewCount":{"simpleText":"2 watching now"},"isLive":true}}')).toBeNull()
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
      if (url.hostname === 'www.googleapis.com' && url.pathname.endsWith('/videos')) return json({ items: [{ liveStreamingDetails: { concurrentViewers: '12' } }] })
      if (url.hostname === 'api.twitch.tv' && url.pathname === '/helix/streams') return json({ data: [{ id: 'stream-id', type: 'live', viewer_count: 7 }] })
      throw new Error(`Unexpected request: ${url}`)
    })
    const platforms = new PlatformServices(secretStore, {} as DataStore)

    await expect(platforms.getLiveStatus(configured, profile)).resolves.toMatchObject({
      youtube: { state: 'live', detail: 'YouTubeで公開配信中', viewerCount: 12, viewerCountState: 'available' },
      twitch: { state: 'live', detail: 'Twitchで公開配信中', viewerCount: 7, viewerCountState: 'available' },
    })
    expect(String(fetchMock.mock.calls.find(([input]) => String(input).includes('/videos'))?.[0])).toContain('part=liveStreamingDetails%2Cstatus')
    await platforms.getLiveStatus(configured, profile)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('follows the currently active YouTube broadcast when the saved broadcast is ready but stale', async () => {
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
    configured.youtube = { clientId: 'youtube-client', clientSecretStored: true, refreshTokenStored: true, broadcastId: 'stale-broadcast' }
    configured.twitch = { clientId: 'twitch-client', clientSecretStored: false, accessTokenStored: true, refreshTokenStored: false, broadcasterId: 'broadcaster-id' }
    const profile = structuredClone(starterProfiles[0])
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input))
      if (url.toString() === 'https://oauth2.googleapis.com/token') return json({ access_token: 'youtube-access', expires_in: 3600 })
      if (url.pathname.endsWith('/liveBroadcasts') && url.searchParams.get('id') === 'stale-broadcast') {
        return json({ items: [{ id: 'stale-broadcast', status: { lifeCycleStatus: 'ready' }, contentDetails: { boundStreamId: 'managed-stream' } }] })
      }
      if (url.pathname.endsWith('/liveBroadcasts') && url.searchParams.get('broadcastStatus') === 'active') {
        expect(url.searchParams.has('mine')).toBe(false)
        return json({ items: [
          { id: 'unrelated-broadcast', status: { lifeCycleStatus: 'live' }, contentDetails: { boundStreamId: 'other-stream' } },
          { id: 'active-broadcast', status: { lifeCycleStatus: 'live' }, contentDetails: { boundStreamId: 'managed-stream' } },
        ] })
      }
      if (url.pathname.endsWith('/videos')) {
        expect(url.searchParams.get('id')).toBe('active-broadcast')
        return json({ items: [{ liveStreamingDetails: { concurrentViewers: '23' } }] })
      }
      if (url.hostname === 'api.twitch.tv') return json({ data: [] })
      throw new Error(`Unexpected request: ${url}`)
    })

    await expect(new PlatformServices(secretStore, {} as DataStore).getLiveStatus(configured, profile)).resolves.toMatchObject({
      youtube: { state: 'live', viewerCount: 23, viewerCountState: 'available' },
    })
    expect(fetchMock.mock.calls.some(([input]) => new URL(String(input)).searchParams.get('broadcastStatus') === 'active')).toBe(true)
  })

  it('keeps a confirmed YouTube live state and exposes retry detail when viewer metrics fail', async () => {
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
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input))
      if (url.toString() === 'https://oauth2.googleapis.com/token') return json({ access_token: 'youtube-access', expires_in: 3600 })
      if (url.pathname.endsWith('/liveBroadcasts')) return json({ items: [{ id: 'broadcast-id', status: { lifeCycleStatus: 'live' }, contentDetails: {} }] })
      if (url.pathname.endsWith('/videos')) return json({ error: 'quota temporarily unavailable' }, 503)
      if (url.hostname === 'api.twitch.tv') return json({ data: [] })
      throw new Error(`Unexpected request: ${url}`)
    })

    await expect(new PlatformServices(secretStore, {} as DataStore).getLiveStatus(configured, structuredClone(starterProfiles[0]))).resolves.toMatchObject({
      youtube: { state: 'live', viewerCount: null, viewerCountState: 'unavailable', viewerCountDetail: expect.stringContaining('10秒ごとに再取得') },
    })
  })

  it.each([
    { publicStatsViewable: true, expectedCount: 0, expectedState: 'available' },
    { publicStatsViewable: false, expectedCount: null, expectedState: 'hidden' },
  ])('distinguishes a public-page zero YouTube audience from a hidden viewer count', async ({ publicStatsViewable, expectedCount, expectedState }) => {
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
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input))
      if (url.toString() === 'https://oauth2.googleapis.com/token') return json({ access_token: 'youtube-access', expires_in: 3600 })
      if (url.pathname.endsWith('/liveBroadcasts')) return json({ items: [{ id: 'broadcast-id', status: { lifeCycleStatus: 'live' }, contentDetails: { boundStreamId: 'stream-id' } }] })
      if (url.pathname.endsWith('/videos')) return json({ items: [{ liveStreamingDetails: {}, status: { publicStatsViewable } }] })
      if (url.hostname === 'www.youtube.com') return new Response('{"videoViewCountRenderer":{"viewCount":{"simpleText":"0 watching now"},"isLive":true}}', { status: 200 })
      if (url.hostname === 'api.twitch.tv') return json({ data: [] })
      throw new Error(`Unexpected request: ${url}`)
    })

    const result = await new PlatformServices(secretStore, {} as DataStore).getLiveStatus(configured, profile)
    expect(result.youtube).toMatchObject({ state: 'live', viewerCount: expectedCount, viewerCountState: expectedState })
  })

  it('does not turn an unparseable YouTube public page into a false zero audience', async () => {
    const secrets = new Map([
      ['youtube-refresh-token', 'youtube-refresh'],
      ['youtube-client-secret', 'youtube-client-secret'],
    ])
    const secretStore = {
      get: vi.fn((name: string) => secrets.get(name) ?? null),
      set: vi.fn((name: string, value: string) => { secrets.set(name, value) }),
    } as unknown as SecretStore
    const configured = structuredClone(defaultConfig)
    configured.features.twitch = false
    configured.youtube = { clientId: 'youtube-client', clientSecretStored: true, refreshTokenStored: true, broadcastId: 'broadcast-id' }
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input))
      if (url.toString() === 'https://oauth2.googleapis.com/token') return json({ access_token: 'youtube-access', expires_in: 3600 })
      if (url.pathname.endsWith('/liveBroadcasts')) return json({ items: [{ id: 'broadcast-id', status: { lifeCycleStatus: 'live' }, contentDetails: {} }] })
      if (url.pathname.endsWith('/videos')) return json({ items: [{ liveStreamingDetails: {}, status: { publicStatsViewable: true } }] })
      if (url.hostname === 'www.youtube.com') return new Response('<html>viewer count unavailable</html>', { status: 200 })
      throw new Error(`Unexpected request: ${url}`)
    })

    const result = await new PlatformServices(secretStore, {} as DataStore).getLiveStatus(configured, structuredClone(starterProfiles[0]))
    expect(result.youtube).toMatchObject({
      state: 'live',
      viewerCount: null,
      viewerCountState: 'unavailable',
      viewerCountDetail: expect.stringContaining('0人とは断定せず'),
    })
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
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('/liveBroadcasts')).length).toBe(3)
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
