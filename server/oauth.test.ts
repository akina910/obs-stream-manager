import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppConfig } from '../shared/contracts.js'
import { defaultConfig } from './defaults.js'
import { OAuthManager } from './oauth.js'
import type { SecretStore } from './secrets.js'
import type { DataStore } from './storage.js'

function harness() {
  let config = structuredClone(defaultConfig)
  const secretValues = new Map<string, string>()
  const store = {
    getConfig: vi.fn(async () => structuredClone(config)),
    saveConfig: vi.fn(async (next: AppConfig) => { config = structuredClone(next); return structuredClone(config) }),
  } as unknown as DataStore
  const secrets = {
    get: vi.fn((name: string) => secretValues.get(name) ?? null),
    set: vi.fn((name: string, value: string) => {
      if (value) secretValues.set(name, value)
      else secretValues.delete(name)
    }),
  } as unknown as SecretStore
  return {
    oauth: new OAuthManager(store, secrets, 'http://127.0.0.1:4417'),
    config: () => config,
    setConfig: (next: AppConfig) => { config = structuredClone(next) },
    secretValues,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('OAuthManager one-button authorization', () => {
  it('reports setup, ready, and in-progress stages from the real OAuth session state', async () => {
    const test = harness()

    await expect(test.oauth.status()).resolves.toMatchObject({
      youtube: { stage: 'setup_required', appConfigured: false, refreshTokenStored: false },
      twitch: { stage: 'setup_required', appConfigured: false, accessTokenStored: false, refreshTokenStored: false },
    })

    const configured = structuredClone(defaultConfig)
    configured.youtube.clientId = 'youtube-public-client'
    test.setConfig(configured)
    await expect(test.oauth.status()).resolves.toMatchObject({ youtube: { stage: 'partial', appConfigured: false } })
    test.secretValues.set('youtube-client-secret', 'youtube-distributor-secret')
    await expect(test.oauth.status()).resolves.toMatchObject({ youtube: { stage: 'ready', appConfigured: true } })

    await test.oauth.start('youtube', 'http://127.0.0.1:4417')
    await expect(test.oauth.status()).resolves.toMatchObject({ youtube: { stage: 'authorizing', authorizationInProgress: true } })
  })

  it('uses the OS secret store as connection truth and exposes incomplete Twitch state', async () => {
    const test = harness()
    const configured = structuredClone(defaultConfig)
    configured.youtube.clientId = 'youtube-public-client'
    configured.youtube.refreshTokenStored = true
    configured.twitch.clientId = 'twitch-public-client'
    configured.twitch.accessTokenStored = true
    test.setConfig(configured)

    await expect(test.oauth.status()).resolves.toMatchObject({
      youtube: { stage: 'partial', refreshTokenStored: false, accountLinked: false },
      twitch: { stage: 'partial', accessTokenStored: false, refreshTokenStored: false, accountLinked: false },
    })

    test.secretValues.set('youtube-refresh-token', 'youtube-refresh')
    test.secretValues.set('youtube-client-secret', 'youtube-distributor-secret')
    test.secretValues.set('twitch-access-token', 'twitch-access')
    test.secretValues.set('twitch-refresh-token', 'twitch-refresh')
    configured.twitch.refreshTokenStored = true
    configured.twitch.broadcasterId = 'broadcaster-id'
    test.setConfig(configured)

    await expect(test.oauth.status()).resolves.toMatchObject({
      youtube: { stage: 'connected', refreshTokenStored: true, accountLinked: true },
      twitch: { stage: 'connected', accessTokenStored: true, refreshTokenStored: true, accountLinked: true },
    })
  })

  it('starts and exchanges Google desktop OAuth with PKCE and the distributor client secret', async () => {
    const test = harness()
    const configured = structuredClone(defaultConfig)
    configured.youtube.clientId = 'youtube-public-client'
    test.setConfig(configured)
    test.secretValues.set('youtube-client-secret', 'youtube-distributor-secret')
    const started = await test.oauth.start('youtube', 'http://127.0.0.1:4417')
    expect(started.mode).toBe('redirect')
    if (started.mode !== 'redirect') throw new Error('Expected redirect mode')
    const authorizationUrl = new URL(started.url)
    expect(authorizationUrl.searchParams.get('client_id')).toBe('youtube-public-client')
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorizationUrl.searchParams.get('code_challenge')).toBeTruthy()
    const state = authorizationUrl.searchParams.get('state')
    if (!state) throw new Error('Missing OAuth state')
    test.secretValues.set('youtube-stream-key', 'old-stream-key')
    test.secretValues.set('youtube-stream-server', 'rtmps://old.youtube/live2')
    test.setConfig({
      ...test.config(),
      youtube: { ...test.config().youtube, broadcastId: 'old-broadcast-id' },
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ refresh_token: 'youtube-refresh' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))

    await expect(test.oauth.exchange('youtube', 'authorization-code', state)).resolves.toBe('http://127.0.0.1:4417')

    const tokenBody = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams
    expect(tokenBody.get('client_id')).toBe('youtube-public-client')
    expect(tokenBody.get('code_verifier')).toBeTruthy()
    expect(tokenBody.get('client_secret')).toBe('youtube-distributor-secret')
    expect(test.secretValues.get('youtube-refresh-token')).toBe('youtube-refresh')
    expect(test.secretValues.has('youtube-stream-key')).toBe(false)
    expect(test.secretValues.has('youtube-stream-server')).toBe(false)
    expect(test.config().youtube).toMatchObject({ refreshTokenStored: true, clientSecretStored: true, broadcastId: '' })
  })

  it('does not start a broken YouTube flow when distributor credentials are incomplete', async () => {
    const test = harness()
    const configured = structuredClone(defaultConfig)
    configured.youtube.clientId = 'youtube-public-client'
    test.setConfig(configured)

    await expect(test.oauth.start('youtube', 'http://127.0.0.1:4417')).rejects.toThrow(/配布パッケージ/)
  })

  it('rejects an OAuth opener origin outside the fixed local allowlist', async () => {
    const test = harness()
    const configured = structuredClone(defaultConfig)
    configured.youtube.clientId = 'youtube-public-client'
    test.setConfig(configured)

    await expect(test.oauth.start('youtube', 'https://attacker.example')).rejects.toMatchObject({
      message: 'OAuth opener origin is not allowed',
      statusCode: 400,
    })
  })

  it('completes Twitch public-client device authorization without a client secret', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-13T00:00:00Z'))
    const test = harness()
    const configured = structuredClone(defaultConfig)
    configured.twitch.clientId = 'twitch-public-client'
    test.setConfig(configured)
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        device_code: 'device-code',
        expires_in: 1_800,
        interval: 5,
        user_code: 'ABCDEFGH',
        verification_uri: 'https://www.twitch.tv/activate?public=true&device-code=ABCDEFGH',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'authorization_pending' }), { status: 400, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'twitch-access', refresh_token: 'twitch-refresh' }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'broadcaster-id' }] }), { status: 200, headers: { 'content-type': 'application/json' } }))

    const started = await test.oauth.start('twitch')
    expect(started.mode).toBe('device')
    if (started.mode !== 'device') throw new Error('Expected device mode')
    expect(started.userCode).toBe('ABCDEFGH')
    await expect(test.oauth.pollTwitch(started.requestId)).resolves.toEqual({ status: 'pending' })
    vi.advanceTimersByTime(started.intervalMs)
    await expect(test.oauth.pollTwitch(started.requestId)).resolves.toEqual({ status: 'complete' })

    const deviceBody = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams
    const tokenBody = fetchMock.mock.calls[2]?.[1]?.body as URLSearchParams
    expect(deviceBody.get('client_id')).toBe('twitch-public-client')
    expect(tokenBody.get('client_id')).toBe('twitch-public-client')
    expect(tokenBody.has('client_secret')).toBe(false)
    expect(test.secretValues.get('twitch-access-token')).toBe('twitch-access')
    expect(test.secretValues.get('twitch-refresh-token')).toBe('twitch-refresh')
    expect(test.config().twitch).toMatchObject({
      broadcasterId: 'broadcaster-id',
      accessTokenStored: true,
      refreshTokenStored: true,
      clientSecretStored: false,
    })
  })
})
