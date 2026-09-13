import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GameProfile } from '../shared/contracts.js'
import { defaultConfig, starterProfiles } from './defaults.js'
import {
  millisecondsUntilNextYouTubeQuotaReset,
  parseYouTubePublicLivePage,
  parseYouTubePublicViewerCount,
  PlatformServices,
  type ThumbnailPreparation,
  youtubeApiLimitBackoffMs,
} from './platforms.js'
import { createPlatformSessionDiagnostics, PlatformDiagnosticsStore } from './platform-diagnostics.js'
import { SecretStore } from './secrets.js'
import { DataStore } from './storage.js'

const directories: string[] = []
const emptySecretStore = () => ({ get: vi.fn().mockReturnValue(null), set: vi.fn() }) as unknown as SecretStore

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('PlatformServices integrated comments', () => {
  it('persists aggregate diagnostics across app restarts without comment bodies or authors', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'obs-stream-manager-platform-diagnostics-'))
    directories.push(directory)
    const store = new DataStore(directory)
    await store.initialize()
    const config = structuredClone(defaultConfig)
    config.features.youtube = false
    config.features.twitch = false
    const first = new PlatformServices(emptySecretStore(), store)
    await first.restoreDiagnostics()
    await first.startComments(config)
    const addComment = (first as unknown as {
      addComment: (message: { id: string; service: 'youtube'; author: string; body: string; publishedAt: string; moderator: boolean; mention: boolean }) => void
    }).addComment.bind(first)
    addComment({
      id: 'youtube:durable-message',
      service: 'youtube',
      author: '保存してはいけない視聴者名',
      body: '保存してはいけないコメント本文',
      publishedAt: '2026-07-24T01:00:00.000Z',
      moderator: false,
      mention: false,
    })
    await first.stopComments()

    const persistedPath = path.join(directory, 'database', 'platform-diagnostics.json')
    const persisted = await readFile(persistedPath, 'utf8')
    expect(persisted).not.toContain('保存してはいけない視聴者名')
    expect(persisted).not.toContain('保存してはいけないコメント本文')

    const restored = new PlatformServices(emptySecretStore(), store)
    await restored.restoreDiagnostics()
    const previousSessionId = restored.getDiagnostics().sessionId
    expect(restored.getDiagnostics()).toMatchObject({
      active: false,
      interrupted: false,
      startedAt: expect.any(String),
      endedAt: expect.any(String),
      comments: { youtube: { received: 1, lastReceivedAt: '2026-07-24T01:00:00.000Z' } },
    })

    await restored.startComments(config)
    await restored.stopComments()
    expect(restored.getDiagnosticsArchive()).toMatchObject({
      version: 1,
      history: [expect.objectContaining({
        sessionId: previousSessionId,
        comments: expect.objectContaining({ youtube: expect.objectContaining({ received: 1 }) }),
      })],
    })
  })

  it('marks a live diagnostic session as interrupted when the app restarts', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'obs-stream-manager-platform-interrupted-'))
    directories.push(directory)
    const store = new DataStore(directory)
    await store.initialize()
    const active = createPlatformSessionDiagnostics()
    active.active = true
    active.startedAt = '2026-07-24T01:00:00.000Z'
    active.comments.twitch.connected = true
    await new PlatformDiagnosticsStore(directory).save({ version: 1, current: active, history: [] })

    const restored = new PlatformServices(emptySecretStore(), store)
    await restored.restoreDiagnostics()

    expect(restored.getDiagnostics()).toMatchObject({
      sessionId: active.sessionId,
      active: false,
      interrupted: true,
      startedAt: '2026-07-24T01:00:00.000Z',
      endedAt: expect.any(String),
      comments: { twitch: { connected: false } },
    })
    const persisted = JSON.parse(await readFile(path.join(directory, 'database', 'platform-diagnostics.json'), 'utf8')) as {
      current: { active: boolean; interrupted: boolean }
    }
    expect(persisted.current).toMatchObject({ active: false, interrupted: true })
  })

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
    expect(platforms.getDiagnostics()).toMatchObject({
      active: false,
      startedAt: expect.any(String),
      endedAt: expect.any(String),
      comments: {
        youtube: {
          received: 2,
          pollAttempts: 1,
          successfulPolls: 1,
          failures: 0,
          lastReceivedAt: '2026-07-17T01:01:00.000Z',
        },
      },
    })
    expect(JSON.stringify(platforms.getDiagnostics())).not.toContain('通常コメント')
    expect(JSON.stringify(platforms.getDiagnostics())).not.toContain('視聴者')
  })

  it('reuses the active YouTube chat id and applies a quota-safe polling floor', async () => {
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
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input))
      if (url.toString() === 'https://oauth2.googleapis.com/token') return json({ access_token: 'youtube-access', expires_in: 3600 })
      if (url.pathname.endsWith('/liveBroadcasts')) return json({ items: [{ snippet: { liveChatId: 'live-chat-id' } }] })
      if (url.pathname.endsWith('/liveChat/messages')) return json({ nextPageToken: 'next-page', pollingIntervalMillis: 1_000, items: [] })
      throw new Error(`Unexpected request: ${url}`)
    })
    const platforms = new PlatformServices(secretStore, {} as DataStore)
    const internals = platforms as unknown as { commentsGeneration: number; pollYouTubeComments: (config: typeof configured, generation: number) => Promise<number> }

    await expect(internals.pollYouTubeComments(configured, internals.commentsGeneration)).resolves.toBe(20_000)
    await expect(internals.pollYouTubeComments(configured, internals.commentsGeneration)).resolves.toBe(20_000)

    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('/liveBroadcasts'))).toHaveLength(1)
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('/liveChat/messages'))).toHaveLength(2)
  })

  it('backs off the expensive active-broadcast lookup when no YouTube chat exists yet', async () => {
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
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input))
      if (url.toString() === 'https://oauth2.googleapis.com/token') return json({ access_token: 'youtube-access', expires_in: 3600 })
      if (url.pathname.endsWith('/liveBroadcasts')) return json({ items: [] })
      throw new Error(`Unexpected request: ${url}`)
    })
    const platforms = new PlatformServices(secretStore, {} as DataStore)
    const internals = platforms as unknown as { commentsGeneration: number; pollYouTubeComments: (config: typeof configured, generation: number) => Promise<number> }

    await expect(internals.pollYouTubeComments(configured, internals.commentsGeneration)).resolves.toBe(60_000)
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('/liveBroadcasts'))).toHaveLength(1)
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

  it('backs Twitch comment reconnects off exponentially and resets only after IRC authentication', async () => {
    vi.useFakeTimers()
    try {
      type Listener = (event?: { data?: unknown }) => void
      class FakeWebSocket {
        static latest: FakeWebSocket | null = null
        private readonly listeners = new Map<string, Listener[]>()
        constructor() { FakeWebSocket.latest = this }
        addEventListener(type: string, listener: Listener): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]) }
        send(): void {}
        close(): void { for (const listener of this.listeners.get('close') ?? []) listener() }
        open(): void { for (const listener of this.listeners.get('open') ?? []) listener() }
        message(data: string): void { for (const listener of this.listeners.get('message') ?? []) listener({ data }) }
      }
      vi.stubGlobal('WebSocket', FakeWebSocket)
      const secretStore = { get: vi.fn(() => null), set: vi.fn() } as unknown as SecretStore
      const configured = structuredClone(defaultConfig)
      configured.features.youtube = false
      configured.features.twitch = true
      configured.twitch.clientId = 'twitch-client-id'
      const platforms = new PlatformServices(secretStore, {} as DataStore)

      await platforms.startComments(configured)
      const initialTokenReads = secretStore.get.mock.calls.length
      await vi.advanceTimersByTimeAsync(3_000)
      const afterFirstRetry = secretStore.get.mock.calls.length
      expect(afterFirstRetry).toBeGreaterThan(initialTokenReads)
      await vi.advanceTimersByTimeAsync(5_999)
      expect(secretStore.get.mock.calls.length).toBe(afterFirstRetry)
      await vi.advanceTimersByTimeAsync(1)
      expect(secretStore.get.mock.calls.length).toBeGreaterThan(afterFirstRetry)

      secretStore.get.mockImplementation((name: string) => name === 'twitch-access-token' ? 'twitch-access' : null)
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [{ login: 'streamer' }] }), { status: 200, headers: { 'content-type': 'application/json' } }))
      await vi.advanceTimersByTimeAsync(12_000)
      FakeWebSocket.latest?.open()
      expect((platforms as unknown as { twitchReconnectFailures: number }).twitchReconnectFailures).toBeGreaterThan(0)
      FakeWebSocket.latest?.message(':tmi.twitch.tv 001 streamer :Welcome, GLHF!\r\n')
      expect((platforms as unknown as { twitchReconnectFailures: number }).twitchReconnectFailures).toBe(0)
      await platforms.stopComments()
    } finally {
      vi.useRealTimers()
    }
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
    const platforms = new PlatformServices(emptySecretStore(), store)
    const result = await (platforms as unknown as {
      applyYouTubeThumbnail: (accessToken: string, videoId: string, profile: GameProfile) => Promise<ThumbnailPreparation>
    }).applyYouTubeThumbnail('token', 'video', saved)
    expect(result.status).toBe('failed')
    expect(result.message).toContain('前回画像を維持')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry a deterministic YouTube quota failure', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'obs-stream-manager-platforms-'))
    directories.push(directory)
    const store = new DataStore(directory)
    await store.initialize()
    const profile = await store.saveProfile(starterProfiles[0])
    const bytes = await sharp({ create: { width: 16, height: 9, channels: 3, background: '#123456' } }).png().toBuffer()
    const saved = await store.saveThumbnail(profile, bytes, 'image/png')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('quotaExceeded', { status: 403 }))
    const platforms = new PlatformServices(emptySecretStore(), store)
    const result = await (platforms as unknown as {
      applyYouTubeThumbnail: (accessToken: string, videoId: string, profile: GameProfile) => Promise<ThumbnailPreparation>
    }).applyYouTubeThumbnail('token', 'video', saved)

    expect(result.status).toBe('failed')
    expect(result.message).toContain('403 quotaExceeded')
    expect(fetchMock).toHaveBeenCalledOnce()
    expect((platforms as unknown as { youtubeApiLimitUntil: number }).youtubeApiLimitUntil).toBeGreaterThan(Date.now())
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

  it('reports quota exhaustion as a concise preparation limit instead of raw API JSON', async () => {
    const values = new Map([
      ['youtube-refresh-token', 'youtube-refresh'],
      ['youtube-client-secret', 'youtube-client-secret'],
    ])
    const secretStore = {
      get: vi.fn((name: string) => values.get(name) ?? null),
      set: vi.fn((name: string, value: string) => { values.set(name, value) }),
    } as unknown as SecretStore
    const configured = structuredClone(defaultConfig)
    configured.features.twitch = false
    configured.youtube.clientId = 'youtube-client-id'
    configured.youtube.refreshTokenStored = true
    configured.youtube.broadcastId = 'broadcast-id'
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input))
      if (url.toString() === 'https://oauth2.googleapis.com/token') return json({ access_token: 'youtube-access', expires_in: 3600 })
      return json({ error: { code: 403, errors: [{ reason: 'quotaExceeded', domain: 'youtube.quota' }] } }, 403)
    })
    const store = { getThumbnailPath: vi.fn().mockReturnValue(null) } as unknown as DataStore

    const result = await new PlatformServices(secretStore, store).prepare(configured, structuredClone(starterProfiles[0]))

    expect(result.find(({ service }) => service === 'youtube')).toEqual({
      service: 'youtube',
      ok: false,
      message: 'YouTube APIの本日利用上限に達しています。OBS・録画・Twitchの設定は適用済みです。現在のゲーム設定は保持され、上限リセット後の配信開始時にYouTube設定を更新します',
    })
  })

  it('does not extend an existing YouTube cooldown when the user retries preparation', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const configured = structuredClone(defaultConfig)
    configured.features.twitch = false
    configured.youtube.clientId = 'youtube-client-id'
    const platforms = new PlatformServices(emptySecretStore(), {} as DataStore)
    const internals = platforms as unknown as { youtubeApiLimitUntil: number }
    internals.youtubeApiLimitUntil = 10_000

    const result = await platforms.prepare(configured, structuredClone(starterProfiles[0]))

    expect(result.find(({ service }) => service === 'youtube')).toMatchObject({ ok: false, message: expect.stringContaining('一時的なリクエスト制限') })
    expect(result.find(({ service }) => service === 'youtube')?.message).not.toContain('本日利用上限')
    expect(internals.youtubeApiLimitUntil).toBe(10_000)
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

  it('distinguishes a playable live page from a playable recording', () => {
    const live = '{"playabilityStatus":{"status":"OK"},"videoDetails":{"isLiveContent":true},"liveBroadcastDetails":{"isLiveNow":true},"videoViewCountRenderer":{"viewCount":{"simpleText":"15人が視聴中"},"isLive":true}}'
    const recording = '{"playabilityStatus":{"status":"OK"},"videoDetails":{"isLiveContent":true,"isPostLiveDvr":true},"liveBroadcastDetails":{"isLiveNow":false,"endTimestamp":"2026-07-22T16:17:16+00:00"}}'

    expect(parseYouTubePublicLivePage(live)).toEqual({ live: true, playable: true, ended: false, viewerCount: 15 })
    expect(parseYouTubePublicLivePage(recording)).toEqual({ live: false, playable: true, ended: true, viewerCount: null })
  })

  it('accepts reordered playability keys and a live renderer when isLiveNow is omitted', () => {
    const html = '{"playabilityStatus":{"reason":"","status":"OK"},"videoViewCountRenderer":{"viewCount":{"simpleText":"8 watching now"},"isLive":true}}'

    expect(parseYouTubePublicLivePage(html)).toEqual({ live: true, playable: true, ended: false, viewerCount: 8 })
  })

  it('keeps a playable page indeterminate without a positive live or ended signal', () => {
    expect(parseYouTubePublicLivePage('{"playabilityStatus":{"status":"OK"}}')).toEqual({ live: false, playable: true, ended: false, viewerCount: null })
  })

  it('does not treat an unrelated recommended live video as the current recording', () => {
    const playerResponse = {
      playabilityStatus: { status: 'OK' },
      videoDetails: { isLiveContent: true, isPostLiveDvr: true },
      microformat: { playerMicroformatRenderer: { liveBroadcastDetails: { isLiveNow: false, endTimestamp: '2026-07-22T16:17:16+00:00' } } },
    }
    const html = `var ytInitialPlayerResponse = ${JSON.stringify(playerResponse)}; {"recommended":{"liveBroadcastDetails":{"isLiveNow":true}}}`

    expect(parseYouTubePublicLivePage(html)).toEqual({ live: false, playable: true, ended: true, viewerCount: null })
  })

  it('ignores recommendation lifecycle markers when the primary player omits microformat', () => {
    const playerResponse = {
      playabilityStatus: { status: 'OK' },
      videoDetails: { isLiveContent: true },
    }
    const liveRecommendation = `var ytInitialPlayerResponse = ${JSON.stringify(playerResponse)}; {"recommended":{"liveBroadcastDetails":{"isLiveNow":true}}}`
    const endedRecommendation = `var ytInitialPlayerResponse = ${JSON.stringify(playerResponse)}; {"recommended":{"liveBroadcastDetails":{"isLiveNow":false,"endTimestamp":"2026-07-22T16:17:16+00:00"}}}`

    expect(parseYouTubePublicLivePage(liveRecommendation)).toEqual({ live: false, playable: true, ended: false, viewerCount: null })
    expect(parseYouTubePublicLivePage(endedRecommendation)).toEqual({ live: false, playable: true, ended: false, viewerCount: null })
  })

  it('reads a live viewer label split across renderer runs', () => {
    const html = '{"videoViewCountRenderer":{"viewCount":{"runs":[{"text":"1,234"},{"text":" watching now"}]},"isLive":true}}'

    expect(parseYouTubePublicViewerCount(html)).toBe(1234)
  })

  it('does not splice digits from adjacent renderer runs into the live viewer count', () => {
    const html = '{"videoViewCountRenderer":{"title":{"runs":[{"text":"Boss Part 2"}]},"viewCount":{"runs":[{"text":"1,234"},{"text":" watching now"}]},"isLive":true}}'

    expect(parseYouTubePublicViewerCount(html)).toBe(1234)
  })

  it('does not scan into another object when viewCount is a scalar renderer field', () => {
    const html = '{"videoViewCountRenderer":{"viewCount":"12345","other":{"simpleText":"99 watching now"},"isLive":true}}'

    expect(parseYouTubePublicViewerCount(html)).toBeNull()
  })
})

describe('YouTube API quota cooldown', () => {
  it.each([
    [Date.UTC(2026, 6, 23, 6, 0), 65 * 60_000], // 23:00 PDT -> 00:05 PDT
    [Date.UTC(2026, 0, 15, 7, 0), 65 * 60_000], // 23:00 PST -> 00:05 PST
  ])('waits until five minutes after the next Pacific midnight', (now, expected) => {
    expect(millisecondsUntilNextYouTubeQuotaReset(now)).toBe(expected)
    expect(youtubeApiLimitBackoffMs(new Error('403 quotaExceeded'), now)).toBe(expected)
  })

  it('uses a short cooldown only for request-rate limits', () => {
    expect(youtubeApiLimitBackoffMs(new Error('403 rateLimitExceeded'), Date.UTC(2026, 6, 23))).toBe(60_000)
    expect(youtubeApiLimitBackoffMs(new Error('403 userRateLimitExceeded'), Date.UTC(2026, 6, 23))).toBe(60_000)
  })

  it('persists a daily quota cooldown across app restarts without another API request', async () => {
    const now = Date.UTC(2026, 6, 23, 6, 0)
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const values = new Map([
      ['youtube-refresh-token', 'youtube-refresh'],
      ['youtube-client-secret', 'youtube-client-secret'],
    ])
    const secretStore = {
      get: vi.fn((name: string) => values.get(name) ?? null),
      set: vi.fn((name: string, value: string) => { if (value) values.set(name, value); else values.delete(name) }),
    } as unknown as SecretStore
    const config = structuredClone(defaultConfig)
    config.features.twitch = false
    config.youtube.clientId = 'youtube-client-id'
    config.youtube.refreshTokenStored = true
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input) === 'https://oauth2.googleapis.com/token') return json({ access_token: 'youtube-access', expires_in: 3600 })
      return json({ error: { code: 403, errors: [{ reason: 'quotaExceeded', domain: 'youtube.quota' }] } }, 403)
    })
    const store = { getThumbnailPath: vi.fn().mockReturnValue(null) } as unknown as DataStore

    await new PlatformServices(secretStore, store).prepare(config, structuredClone(starterProfiles[0]))
    const persisted = Number(values.get('youtube-api-limit-until'))
    expect(persisted).toBe(now + 65 * 60_000)

    fetchMock.mockClear()
    const restarted = new PlatformServices(secretStore, store)
    const result = await restarted.prepare(config, structuredClone(starterProfiles[0]))

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.find(({ service }) => service === 'youtube')).toMatchObject({ ok: false, message: expect.stringContaining('本日利用上限') })
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

  it('reports OBS output stopped immediately while YouTube auto-stop is still updating its public lifecycle', async () => {
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
    configured.features.twitch = false
    configured.youtube.clientId = 'youtube-client-id'
    configured.youtube.refreshTokenStored = true
    configured.youtube.broadcastId = 'broadcast-id'
    const profile = structuredClone(starterProfiles[0])
    profile.youtube.enabled = true
    const json = (value: unknown) => new Response(JSON.stringify(value), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input))
      if (url.toString() === 'https://oauth2.googleapis.com/token') return json({ access_token: 'youtube-access', expires_in: 3600 })
      if (url.pathname.endsWith('/liveBroadcasts')) {
        return json({
          items: [{
            id: 'broadcast-id',
            status: { lifeCycleStatus: 'live' },
            contentDetails: { boundStreamId: 'stream-id', enableAutoStop: true },
          }],
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const platforms = new PlatformServices(secretStore, {} as DataStore)

    await expect(platforms.completeYouTubeBroadcast(configured, profile)).resolves.toBeUndefined()
    await expect(platforms.getLiveStatus(configured, profile)).resolves.toMatchObject({
      youtube: {
        state: 'offline',
        detail: 'OBS送信は停止済みです（YouTube側の終了表示を確認中）',
      },
    })
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('/liveBroadcasts'))).toHaveLength(1)
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
    const diagnosticsConfig = structuredClone(configured)
    diagnosticsConfig.features.youtube = false
    diagnosticsConfig.features.twitch = false
    await platforms.startComments(diagnosticsConfig)

    await expect(platforms.getLiveStatus(configured, profile)).resolves.toMatchObject({
      youtube: { state: 'live', detail: 'YouTubeで公開配信中', viewerCount: 12, viewerCountState: 'available' },
      twitch: { state: 'live', detail: 'Twitchで公開配信中', viewerCount: 7, viewerCountState: 'available' },
    })
    expect(String(fetchMock.mock.calls.find(([input]) => String(input).includes('/videos'))?.[0])).toContain('part=liveStreamingDetails%2Cstatus')
    await platforms.getLiveStatus(configured, profile)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(platforms.getDiagnostics()).toMatchObject({
      viewers: {
        youtube: { liveSamples: 1, availableSamples: 1, lastCount: 12, peakCount: 12 },
        twitch: { liveSamples: 1, availableSamples: 1, lastCount: 7, peakCount: 7 },
      },
    })
    await platforms.stopComments()
  })

  it('treats YouTube quota exhaustion during stop as deferred auto-stop instead of a stop failure', async () => {
    const secrets = new Map([
      ['youtube-refresh-token', 'youtube-refresh'],
      ['youtube-client-secret', 'youtube-client-secret'],
    ])
    const secretStore = {
      get: vi.fn((name: string) => secrets.get(name) ?? null),
      set: vi.fn((name: string, value: string) => { secrets.set(name, value) }),
    } as unknown as SecretStore
    const configured = structuredClone(defaultConfig)
    configured.youtube = { clientId: 'youtube-client', clientSecretStored: true, refreshTokenStored: true, broadcastId: 'broadcast-id' }
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input))
      if (url.toString() === 'https://oauth2.googleapis.com/token') return json({ access_token: 'youtube-access', expires_in: 3600 })
      if (url.hostname === 'www.googleapis.com') return json({ error: { code: 403, errors: [{ reason: 'quotaExceeded', domain: 'youtube.quota' }] } }, 403)
      throw new Error(`Unexpected request: ${url}`)
    })

    const platforms = new PlatformServices(secretStore, {} as DataStore, { pollIntervalMs: 1, transitionTimeoutMs: 100 })
    await expect(platforms.completeYouTubeBroadcast(configured, structuredClone(starterProfiles[0]))).resolves.toBeUndefined()
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

  it('caches a negative active-broadcast search instead of spending quota every status poll', async () => {
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
    configured.youtube = { clientId: 'youtube-client', clientSecretStored: true, refreshTokenStored: true, broadcastId: 'ready-broadcast' }
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input))
      if (url.toString() === 'https://oauth2.googleapis.com/token') return json({ access_token: 'youtube-access', expires_in: 3600 })
      if (url.pathname.endsWith('/liveBroadcasts') && url.searchParams.get('id') === 'ready-broadcast') {
        return json({ items: [{ id: 'ready-broadcast', status: { lifeCycleStatus: 'ready' }, contentDetails: {} }] })
      }
      if (url.pathname.endsWith('/liveBroadcasts') && url.searchParams.get('broadcastStatus') === 'active') return json({ items: [] })
      throw new Error(`Unexpected request: ${url}`)
    })
    const platforms = new PlatformServices(secretStore, {} as DataStore)
    const read = (platforms as unknown as {
      youtubeLiveStatus(config: typeof configured, profile: GameProfile): Promise<{ state: string }>
    }).youtubeLiveStatus.bind(platforms)

    await expect(read(configured, structuredClone(starterProfiles[0]))).resolves.toMatchObject({ state: 'ready' })
    await expect(read(configured, structuredClone(starterProfiles[0]))).resolves.toMatchObject({ state: 'ready' })

    const activeSearches = fetchMock.mock.calls.filter(([input]) => new URL(String(input)).searchParams.get('broadcastStatus') === 'active')
    expect(activeSearches).toHaveLength(1)
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
      youtube: { state: 'live', viewerCount: null, viewerCountState: 'unavailable', viewerCountDetail: expect.stringContaining('30秒ごとに再取得') },
    })
  })

  it('uses the public live page instead of reporting a connection failure when the YouTube API quota is exhausted', async () => {
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
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input))
      if (url.toString() === 'https://oauth2.googleapis.com/token') return json({ access_token: 'youtube-access', expires_in: 3600 })
      if (url.hostname === 'www.googleapis.com') return json({ error: { code: 403, errors: [{ reason: 'quotaExceeded', domain: 'youtube.quota' }] } }, 403)
      if (url.hostname === 'www.youtube.com') return new Response('{"playabilityStatus":{"status":"OK"},"videoDetails":{"isLiveContent":true},"liveBroadcastDetails":{"isLiveNow":true},"videoViewCountRenderer":{"viewCount":{"simpleText":"4人が視聴中"},"isLive":true}}', { status: 200 })
      throw new Error(`Unexpected request: ${url}`)
    })

    const platforms = new PlatformServices(secretStore, {} as DataStore)
    const result = await platforms.getLiveStatus(configured, structuredClone(starterProfiles[0]))

    expect(result.youtube).toMatchObject({
      state: 'live',
      detail: 'YouTubeで公開配信中（API上限のため公開ページで確認）',
      viewerCount: 4,
      viewerCountState: 'available',
    })
    platforms.invalidateLiveStatus()
    await expect(platforms.getLiveStatus(configured, structuredClone(starterProfiles[0]))).resolves.toMatchObject({
      youtube: { state: 'live', viewerCount: 4, viewerCountState: 'available' },
    })
    expect(fetchMock.mock.calls.filter(([input]) => new URL(String(input)).hostname === 'www.googleapis.com')).toHaveLength(1)
  })

  it('falls back to the public viewer count when only videos.list reaches quota', async () => {
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
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input))
      if (url.toString() === 'https://oauth2.googleapis.com/token') return json({ access_token: 'youtube-access', expires_in: 3600 })
      if (url.pathname.endsWith('/liveBroadcasts')) return json({ items: [{ id: 'broadcast-id', status: { lifeCycleStatus: 'live' }, contentDetails: {} }] })
      if (url.pathname.endsWith('/videos')) return json({ error: { code: 403, errors: [{ reason: 'quotaExceeded', domain: 'youtube.quota' }] } }, 403)
      if (url.hostname === 'www.youtube.com') return new Response('{"playabilityStatus":{"status":"OK"},"liveBroadcastDetails":{"isLiveNow":true},"videoViewCountRenderer":{"viewCount":{"runs":[{"text":"7"},{"text":" 人が視聴中"}]},"isLive":true}}', { status: 200 })
      throw new Error(`Unexpected request: ${url}`)
    })

    const result = await new PlatformServices(secretStore, {} as DataStore).getLiveStatus(configured, structuredClone(starterProfiles[0]))

    expect(result.youtube).toMatchObject({
      state: 'live',
      viewerCount: 7,
      viewerCountState: 'available',
      viewerCountDetail: 'YouTube API上限中のため、公開ページのライブ人数から取得しました',
    })
  })

  it('keeps YouTube in a retrying state instead of reporting connection failure when quota fallback is inconclusive', async () => {
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
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input))
      if (url.toString() === 'https://oauth2.googleapis.com/token') return json({ access_token: 'youtube-access', expires_in: 3600 })
      if (url.hostname === 'www.googleapis.com') return json({ error: { code: 403, errors: [{ reason: 'quotaExceeded' }] } }, 403)
      if (url.hostname === 'www.youtube.com') return new Response('<html>temporary public status unavailable</html>', { status: 200 })
      throw new Error(`Unexpected request: ${url}`)
    })

    const result = await new PlatformServices(secretStore, {} as DataStore).getLiveStatus(configured, structuredClone(starterProfiles[0]))

    expect(result.youtube).toMatchObject({
      state: 'starting',
      detail: expect.stringContaining('API上限中'),
      viewerCountState: 'unavailable',
    })
    expect(result.youtube.detail).not.toContain('接続失敗')
  })

  it('reports YouTube offline from the public post-live page when API quota is exhausted', async () => {
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
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input))
      if (url.toString() === 'https://oauth2.googleapis.com/token') return json({ access_token: 'youtube-access', expires_in: 3600 })
      if (url.hostname === 'www.googleapis.com') return json({ error: { code: 403, errors: [{ reason: 'quotaExceeded' }] } }, 403)
      if (url.hostname === 'www.youtube.com') return new Response('{"playabilityStatus":{"status":"OK"},"videoDetails":{"isLiveContent":true,"isPostLiveDvr":true},"liveBroadcastDetails":{"isLiveNow":false,"endTimestamp":"2026-07-22T16:17:16+00:00"}}', { status: 200 })
      throw new Error(`Unexpected request: ${url}`)
    })

    const result = await new PlatformServices(secretStore, {} as DataStore).getLiveStatus(configured, structuredClone(starterProfiles[0]))

    expect(result.youtube).toMatchObject({
      state: 'offline',
      detail: 'YouTube配信は終了済み（API上限のため公開ページで確認）',
      viewerCountState: 'unavailable',
    })
  })

  it('clears an ended observed broadcast during quota fallback', async () => {
    const secrets = new Map([
      ['youtube-api-limit-until', String(Date.now() + 60_000)],
      ['youtube-observed-active', JSON.stringify({ configuredBroadcastId: '', activeBroadcastId: 'ended-id' })],
    ])
    const secretStore = {
      get: vi.fn((name: string) => secrets.get(name) ?? null),
      set: vi.fn((name: string, value: string) => { secrets.set(name, value) }),
    } as unknown as SecretStore
    const configured = structuredClone(defaultConfig)
    configured.features.twitch = false
    configured.youtube = { clientId: 'youtube-client', clientSecretStored: true, refreshTokenStored: true, broadcastId: '' }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      '{"playabilityStatus":{"status":"OK"},"videoDetails":{"isLiveContent":true,"isPostLiveDvr":true},"liveBroadcastDetails":{"isLiveNow":false,"endTimestamp":"2026-07-22T16:17:16+00:00"}}',
      { status: 200 },
    ))

    const result = await new PlatformServices(secretStore, {} as DataStore).getLiveStatus(configured, structuredClone(starterProfiles[0]))

    expect(result.youtube.state).toBe('offline')
    expect(secrets.get('youtube-observed-active')).toBe('')
  })

  it('reports an actionable state when quota is exhausted without any broadcast candidate', async () => {
    const secrets = new Map([['youtube-api-limit-until', String(Date.now() + 60_000)]])
    const secretStore = {
      get: vi.fn((name: string) => secrets.get(name) ?? null),
      set: vi.fn((name: string, value: string) => { secrets.set(name, value) }),
    } as unknown as SecretStore
    const configured = structuredClone(defaultConfig)
    configured.features.twitch = false
    configured.youtube = { clientId: 'youtube-client', clientSecretStored: true, refreshTokenStored: true, broadcastId: '' }
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    const result = await new PlatformServices(secretStore, {} as DataStore).getLiveStatus(configured, structuredClone(starterProfiles[0]))

    expect(result.youtube).toMatchObject({ state: 'unprepared', viewerCountState: 'unavailable' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('restores an auto-discovered active broadcast during quota cooldown after restart', async () => {
    const secrets = new Map([
      ['youtube-api-limit-until', String(Date.now() + 60_000)],
      ['youtube-observed-active', JSON.stringify({ configuredBroadcastId: '', activeBroadcastId: 'active-id' })],
    ])
    const secretStore = {
      get: vi.fn((name: string) => secrets.get(name) ?? null),
      set: vi.fn((name: string, value: string) => { secrets.set(name, value) }),
    } as unknown as SecretStore
    const configured = structuredClone(defaultConfig)
    configured.features.twitch = false
    configured.youtube = { clientId: 'youtube-client', clientSecretStored: true, refreshTokenStored: true, broadcastId: '' }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      '{"playabilityStatus":{"status":"OK"},"liveBroadcastDetails":{"isLiveNow":true},"videoViewCountRenderer":{"viewCount":{"simpleText":"14 watching now"},"isLive":true}}',
      { status: 200 },
    ))

    const result = await new PlatformServices(secretStore, {} as DataStore).getLiveStatus(configured, structuredClone(starterProfiles[0]))

    expect(result.youtube).toMatchObject({ state: 'live', viewerCount: 14, viewerCountState: 'available' })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(String(fetchMock.mock.calls[0][0])).toContain('active-id')
  })

  it('does not report YouTube offline when any quota-fallback candidate page is unavailable', async () => {
    const configured = structuredClone(defaultConfig)
    configured.features.twitch = false
    configured.youtube = { clientId: 'youtube-client', clientSecretStored: true, refreshTokenStored: true, broadcastId: 'configured-id' }
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input))
      if (url.hostname !== 'www.youtube.com') throw new Error(`Unexpected request: ${url}`)
      if (url.searchParams.get('v') === 'active-id') return new Response('temporarily unavailable', { status: 503 })
      return new Response('{"playabilityStatus":{"status":"OK"},"videoDetails":{"isLiveContent":true,"isPostLiveDvr":true},"liveBroadcastDetails":{"isLiveNow":false,"endTimestamp":"2026-07-22T16:17:16+00:00"}}', { status: 200 })
    })
    const platforms = new PlatformServices(emptySecretStore(), {} as DataStore)
    const internals = platforms as unknown as {
      youtubeApiLimitUntil: number
      youtubeObservedActive: { configuredBroadcastId: string; activeBroadcastId: string } | null
    }
    internals.youtubeApiLimitUntil = Date.now() + 60_000
    internals.youtubeObservedActive = { configuredBroadcastId: 'configured-id', activeBroadcastId: 'active-id' }

    const result = await platforms.getLiveStatus(configured, structuredClone(starterProfiles[0]))

    expect(result.youtube).toMatchObject({ state: 'starting', viewerCountState: 'unavailable' })
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
      if (url.hostname === 'www.youtube.com') return new Response('{"playabilityStatus":{"status":"OK"},"liveBroadcastDetails":{"isLiveNow":true},"videoViewCountRenderer":{"viewCount":{"simpleText":"0 watching now"},"isLive":true}}', { status: 200 })
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

  it('arms the YouTube cooldown on a start quota failure and avoids another API request', async () => {
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
    configured.youtube.clientId = 'youtube-client'
    configured.youtube.broadcastId = 'broadcast-id'
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input))
      if (url.toString() === 'https://oauth2.googleapis.com/token') return json({ access_token: 'youtube-access', expires_in: 3600 })
      return json({ error: { code: 403, errors: [{ reason: 'quotaExceeded', domain: 'youtube.quota' }] } }, 403)
    })
    const platforms = new PlatformServices(secretStore, {} as DataStore)

    await expect(platforms.startYouTubeBroadcast(configured, structuredClone(starterProfiles[0])))
      .rejects.toThrow('YouTube APIの本日利用上限に達したため公開開始を確認できません')
    const requestsAfterFailure = fetchMock.mock.calls.length
    await expect(platforms.startYouTubeBroadcast(configured, structuredClone(starterProfiles[0])))
      .rejects.toThrow('YouTube APIの本日利用上限中です')
    expect(fetchMock).toHaveBeenCalledTimes(requestsAfterFailure)
  })

  it('reports a short request-rate cooldown without calling it a daily quota reset', async () => {
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
    configured.youtube.clientId = 'youtube-client'
    configured.youtube.broadcastId = 'broadcast-id'
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input))
      if (url.toString() === 'https://oauth2.googleapis.com/token') return json({ access_token: 'youtube-access', expires_in: 3600 })
      return json({ error: { code: 403, errors: [{ reason: 'rateLimitExceeded', domain: 'youtube.quota' }] } }, 403)
    })
    const platforms = new PlatformServices(secretStore, {} as DataStore)

    await expect(platforms.startYouTubeBroadcast(configured, structuredClone(starterProfiles[0])))
      .rejects.toThrow('YouTube APIの一時的なリクエスト制限により公開開始を確認できません')
    const requestsAfterFailure = fetchMock.mock.calls.length
    await expect(platforms.startYouTubeBroadcast(configured, structuredClone(starterProfiles[0])))
      .rejects.toThrow('約1分後に開始してください')
    expect(fetchMock).toHaveBeenCalledTimes(requestsAfterFailure)
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

  it('clears a stale pending completion marker when the same broadcast is already live again', async () => {
    const secrets = new Map([
      ['youtube-refresh-token', 'youtube-refresh'],
      ['youtube-client-secret', 'youtube-client-secret'],
      ['youtube-pending-completion-id', 'broadcast-id'],
    ])
    const secretStore = {
      get: vi.fn((name: string) => secrets.get(name) ?? null),
      set: vi.fn((name: string, value: string) => { secrets.set(name, value) }),
    } as unknown as SecretStore
    const configured = structuredClone(defaultConfig)
    configured.youtube.clientId = 'youtube-client'
    configured.youtube.broadcastId = 'broadcast-id'
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input))
      if (url.toString() === 'https://oauth2.googleapis.com/token') return json({ access_token: 'youtube-access', expires_in: 3600 })
      if (url.pathname.endsWith('/liveBroadcasts')) {
        return json({ items: [{ id: 'broadcast-id', status: { lifeCycleStatus: 'live' }, contentDetails: { boundStreamId: 'stream-id' } }] })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const platforms = new PlatformServices(secretStore, {} as DataStore)
    const internals = platforms as unknown as { youtubePendingCompletionId: string | null }

    await expect(platforms.startYouTubeBroadcast(configured, structuredClone(starterProfiles[0]))).resolves.toBeUndefined()

    expect(internals.youtubePendingCompletionId).toBeNull()
    expect(secrets.get('youtube-pending-completion-id')).toBe('')
  })

  it('clears the original pending broadcast from the public ended state without OAuth', async () => {
    const secrets = new Map([['youtube-pending-completion-id', 'old-broadcast-id']])
    const secretStore = {
      get: vi.fn((name: string) => secrets.get(name) ?? null),
      set: vi.fn((name: string, value: string) => { secrets.set(name, value) }),
    } as unknown as SecretStore
    const configured = structuredClone(defaultConfig)
    configured.features.youtube = false
    configured.youtube.broadcastId = 'new-broadcast-id'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      '{"playabilityStatus":{"status":"OK"},"videoDetails":{"isPostLiveDvr":true},"liveBroadcastDetails":{"isLiveNow":false,"endTimestamp":"2026-07-22T16:17:16+00:00"}}',
      { status: 200 },
    ))
    const platforms = new PlatformServices(secretStore, {} as DataStore)
    const complete = vi.spyOn(platforms, 'completeYouTubeBroadcast').mockResolvedValue(undefined)

    await expect(platforms.retryPendingYouTubeCompletion(configured)).resolves.toBe(true)

    expect(complete).not.toHaveBeenCalled()
    expect(secrets.get('youtube-pending-completion-id')).toBe('')
  })

  it('keeps a pending completion marker after a transient completion failure', async () => {
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
    configured.youtube.clientId = 'youtube-client'
    configured.youtube.refreshTokenStored = true
    configured.youtube.broadcastId = 'broadcast-id'
    const profile = structuredClone(starterProfiles[0])
    profile.youtube.enabled = true
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input))
      if (url.toString() === 'https://oauth2.googleapis.com/token') return json({ access_token: 'youtube-access', expires_in: 3600 })
      throw new Error('temporary network failure')
    })
    const platforms = new PlatformServices(secretStore, {} as DataStore)
    const internals = platforms as unknown as { youtubePendingCompletionId: string | null }

    await expect(platforms.completeYouTubeBroadcast(configured, profile)).rejects.toThrow('temporary network failure')

    expect(internals.youtubePendingCompletionId).toBe('broadcast-id')
    expect(secrets.get('youtube-pending-completion-id')).toBe('broadcast-id')
  })

  it('never retries a pending completion while the public watch page is still live', async () => {
    const secrets = new Map([['youtube-pending-completion-id', 'broadcast-id']])
    const secretStore = {
      get: vi.fn((name: string) => secrets.get(name) ?? null),
      set: vi.fn((name: string, value: string) => { secrets.set(name, value) }),
    } as unknown as SecretStore
    const configured = structuredClone(defaultConfig)
    configured.youtube.broadcastId = 'broadcast-id'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      '{"playabilityStatus":{"status":"OK"},"liveBroadcastDetails":{"isLiveNow":true},"videoViewCountRenderer":{"viewCount":{"simpleText":"3人が視聴中"},"isLive":true}}',
      { status: 200 },
    ))
    const platforms = new PlatformServices(secretStore, {} as DataStore)
    const complete = vi.spyOn(platforms, 'completeYouTubeBroadcast')

    await expect(platforms.retryPendingYouTubeCompletion(configured)).resolves.toBe(false)

    expect(complete).not.toHaveBeenCalled()
    expect(secrets.get('youtube-pending-completion-id')).toBe('broadcast-id')
  })

  it('clears a quota-deferred completion from the public ended state without an OAuth or transition request', async () => {
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
    configured.youtube.clientId = 'youtube-client'
    configured.youtube.broadcastId = 'broadcast-id'
    let lifeCycleStatus = 'live'
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input))
      if (url.hostname === 'www.youtube.com') {
        return new Response('{"playabilityStatus":{"status":"OK"},"videoDetails":{"isPostLiveDvr":true},"liveBroadcastDetails":{"isLiveNow":false,"endTimestamp":"2026-07-22T16:17:16+00:00"}}', { status: 200 })
      }
      if (url.toString() === 'https://oauth2.googleapis.com/token') return json({ access_token: 'youtube-access', expires_in: 3600 })
      if (url.pathname.endsWith('/liveBroadcasts/transition')) {
        lifeCycleStatus = 'complete'
        return json({ id: 'broadcast-id', status: { lifeCycleStatus } })
      }
      if (url.pathname.endsWith('/liveBroadcasts')) {
        return json({ items: [{ id: 'broadcast-id', status: { lifeCycleStatus }, contentDetails: { boundStreamId: 'stream-id', enableAutoStop: false } }] })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const platforms = new PlatformServices(secretStore, {} as DataStore, { pollIntervalMs: 1, transitionTimeoutMs: 100 })
    const internals = platforms as unknown as { youtubeApiLimitUntil: number; youtubePendingCompletionId: string | null }
    internals.youtubeApiLimitUntil = Date.now() + 60_000

    await expect(platforms.completeYouTubeBroadcast(configured, structuredClone(starterProfiles[0]))).resolves.toBeUndefined()
    expect(internals.youtubePendingCompletionId).toBe('broadcast-id')
    expect(secrets.get('youtube-pending-completion-id')).toBe('broadcast-id')
    expect(fetchMock).not.toHaveBeenCalled()

    const restarted = new PlatformServices(secretStore, {} as DataStore, { pollIntervalMs: 1, transitionTimeoutMs: 100 })
    const restartedInternals = restarted as unknown as { youtubeApiLimitUntil: number; youtubePendingCompletionId: string | null }
    expect(restartedInternals.youtubePendingCompletionId).toBe('broadcast-id')
    await expect(restarted.retryPendingYouTubeCompletion(configured)).resolves.toBe(true)
    expect(restartedInternals.youtubePendingCompletionId).toBeNull()
    expect(secrets.get('youtube-pending-completion-id')).toBe('')
    expect(fetchMock.mock.calls.every(([input]) => new URL(String(input)).hostname === 'www.youtube.com')).toBe(true)
    await expect(restarted.retryPendingYouTubeCompletion(configured)).resolves.toBe(false)
  })

  it('deduplicates concurrent public-page checks of the same pending YouTube completion', async () => {
    const configured = structuredClone(defaultConfig)
    configured.youtube.broadcastId = 'broadcast-id'
    const platforms = new PlatformServices({ get: vi.fn().mockReturnValue(null), set: vi.fn() } as unknown as SecretStore, {} as DataStore)
    const internals = platforms as unknown as { youtubeApiLimitUntil: number; youtubePendingCompletionId: string | null }
    internals.youtubeApiLimitUntil = 0
    internals.youtubePendingCompletionId = 'broadcast-id'
    let finishFetch!: (response: Response) => void
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise<Response>((resolve) => { finishFetch = resolve }))

    const first = platforms.retryPendingYouTubeCompletion(configured)
    const second = platforms.retryPendingYouTubeCompletion(configured)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    finishFetch(new Response(
      '{"playabilityStatus":{"status":"OK"},"videoDetails":{"isPostLiveDvr":true},"liveBroadcastDetails":{"isLiveNow":false,"endTimestamp":"2026-07-22T16:17:16+00:00"}}',
      { status: 200 },
    ))
    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
  })
})
