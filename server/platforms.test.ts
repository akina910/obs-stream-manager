import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GameProfile } from '../shared/contracts.js'
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
      ['twitch-client-secret', 'client-secret'],
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
    expect(secrets.get('twitch-refresh-token')).toBe('refresh-two')
    expect(secrets.get('twitch-access-token')).toBe('access-two')
  })
})
