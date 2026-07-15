import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  loadDistributorOAuthCredentials,
  loadProviderOAuthBundle,
  parseProviderOAuthBundle,
  provisionProviderOAuth,
} from './provider-provisioning.js'
import type { SecretName, SecretStore } from './secrets.js'
import { DataStore } from './storage.js'

const directories: string[] = []

async function harness() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'obs-stream-manager-provider-'))
  directories.push(directory)
  const store = new DataStore(directory)
  await store.initialize()
  const values = new Map<SecretName, string>()
  const secrets = {
    get: vi.fn((name: SecretName) => values.get(name) ?? null),
    set: vi.fn((name: SecretName, value: string) => value ? values.set(name, value) : values.delete(name)),
  } as unknown as SecretStore
  return { directory, store, secrets, values }
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('distributor OAuth provisioning', () => {
  it('loads a release-time bundle without exposing provider setup to end users', async () => {
    const test = await harness()
    const filename = path.join(test.directory, 'provider-oauth.json')
    await writeFile(filename, JSON.stringify({
      version: 3,
      youtube: { clientId: 'youtube-client', clientType: 'desktop', clientSecret: 'youtube-desktop-credential' },
      twitch: { clientId: 'twitch-client' },
    }))

    await expect(loadProviderOAuthBundle(filename)).resolves.toEqual({
      youtube: { clientId: 'youtube-client', clientSecret: 'youtube-desktop-credential' },
      twitch: { clientId: 'twitch-client' },
    })
  })

  it('rejects unsupported or incomplete release-time bundles', () => {
    expect(() => parseProviderOAuthBundle({ version: 1, twitch: { clientId: 'twitch-client' } })).toThrow(/version/)
    expect(() => parseProviderOAuthBundle({ version: 3, youtube: { clientType: 'desktop' } })).toThrow(/youtube.clientId/)
    expect(() => parseProviderOAuthBundle({ version: 3, youtube: { clientId: 'youtube-client', clientType: 'desktop' } })).toThrow(/youtube.clientSecret/)
    expect(() => parseProviderOAuthBundle({ version: 3, youtube: { clientId: 'youtube-client', clientType: 'web', clientSecret: 'credential' } })).toThrow(/Desktop app/)
    expect(() => parseProviderOAuthBundle({ version: 3 })).toThrow(/does not contain a provider/)
  })

  it('loads distributor YouTube Desktop app credentials from the release environment', async () => {
    vi.stubEnv('OBS_STREAM_MANAGER_PROVIDER_OAUTH_FILE', '')
    vi.stubEnv('OBS_STREAM_MANAGER_YOUTUBE_CLIENT_ID', 'youtube-client')
    vi.stubEnv('OBS_STREAM_MANAGER_YOUTUBE_CLIENT_TYPE', 'desktop')
    vi.stubEnv('OBS_STREAM_MANAGER_YOUTUBE_CLIENT_SECRET', 'youtube-desktop-credential')
    vi.stubEnv('OBS_STREAM_MANAGER_TWITCH_CLIENT_ID', '')

    await expect(loadDistributorOAuthCredentials()).resolves.toEqual({
      youtube: { clientId: 'youtube-client', clientSecret: 'youtube-desktop-credential' },
    })
  })

  it('persists provider configuration and preserves account links across a restart', async () => {
    const test = await harness()
    const credentials = {
      youtube: { clientId: 'youtube-client', clientSecret: 'youtube-desktop-credential' },
      twitch: { clientId: 'twitch-client' },
    }
    await provisionProviderOAuth(test.store, test.secrets, credentials)
    const configured = await test.store.getConfig()
    test.values.set('youtube-refresh-token', 'youtube-refresh')
    test.values.set('youtube-stream-key', 'youtube-stream-key')
    test.values.set('youtube-stream-server', 'rtmps://test.youtube/live2')
    test.values.set('twitch-access-token', 'twitch-access')
    test.values.set('twitch-refresh-token', 'twitch-refresh')
    test.values.set('twitch-stream-key', 'twitch-stream-key')
    test.values.set('twitch-stream-server', 'rtmp://twitch.example/app')
    test.values.set('twitch-client-secret', 'legacy-twitch-secret')
    await test.store.saveConfig({
      ...configured,
      youtube: { ...configured.youtube, refreshTokenStored: true },
      twitch: { ...configured.twitch, accessTokenStored: true, refreshTokenStored: true, broadcasterId: 'broadcaster' },
    })

    await provisionProviderOAuth(test.store, test.secrets, credentials)
    const restarted = new DataStore(test.directory)
    await restarted.initialize()

    await expect(restarted.getConfig()).resolves.toMatchObject({
      youtube: { clientId: 'youtube-client', clientSecretStored: true, refreshTokenStored: true },
      twitch: { clientId: 'twitch-client', accessTokenStored: true, refreshTokenStored: true, broadcasterId: 'broadcaster' },
    })
    expect(test.values.get('youtube-client-secret')).toBe('youtube-desktop-credential')
    expect(test.values.get('youtube-refresh-token')).toBe('youtube-refresh')
    expect(test.values.get('youtube-stream-key')).toBe('youtube-stream-key')
    expect(test.values.get('youtube-stream-server')).toBe('rtmps://test.youtube/live2')
    expect(test.values.get('twitch-access-token')).toBe('twitch-access')
    expect(test.values.get('twitch-refresh-token')).toBe('twitch-refresh')
    expect(test.values.get('twitch-stream-key')).toBe('twitch-stream-key')
    expect(test.values.get('twitch-stream-server')).toBe('rtmp://twitch.example/app')
    expect(test.values.get('twitch-client-secret')).toBe('legacy-twitch-secret')
  })

  it('invalidates old account tokens only when the distributor client changes', async () => {
    const test = await harness()
    await provisionProviderOAuth(test.store, test.secrets, {
      youtube: { clientId: 'youtube-old', clientSecret: 'youtube-old-credential' },
      twitch: { clientId: 'twitch-old' },
    })
    const configured = await test.store.getConfig()
    test.values.set('youtube-refresh-token', 'youtube-refresh')
    test.values.set('youtube-stream-key', 'youtube-stream-key')
    test.values.set('youtube-stream-server', 'rtmps://test.youtube/live2')
    test.values.set('youtube-client-secret', 'legacy-youtube-secret')
    test.values.set('twitch-access-token', 'twitch-access')
    test.values.set('twitch-refresh-token', 'twitch-refresh')
    test.values.set('twitch-stream-key', 'twitch-stream-key')
    test.values.set('twitch-stream-server', 'rtmp://twitch.example/app')
    test.values.set('twitch-client-secret', 'legacy-twitch-secret')
    await test.store.saveConfig({
      ...configured,
      youtube: { ...configured.youtube, refreshTokenStored: true, broadcastId: 'broadcast' },
      twitch: { ...configured.twitch, accessTokenStored: true, refreshTokenStored: true, broadcasterId: 'broadcaster' },
    })

    const changed = await provisionProviderOAuth(test.store, test.secrets, {
      youtube: { clientId: 'youtube-new', clientSecret: 'youtube-new-credential' },
      twitch: { clientId: 'twitch-new' },
    })

    expect(changed.youtube).toMatchObject({ refreshTokenStored: false, broadcastId: '' })
    expect(changed.twitch).toMatchObject({ accessTokenStored: false, refreshTokenStored: false, broadcasterId: '' })
    expect(test.values.has('youtube-refresh-token')).toBe(false)
    expect(test.values.has('youtube-stream-key')).toBe(false)
    expect(test.values.has('youtube-stream-server')).toBe(false)
    expect(test.values.get('youtube-client-secret')).toBe('youtube-new-credential')
    expect(test.values.has('twitch-access-token')).toBe(false)
    expect(test.values.has('twitch-refresh-token')).toBe(false)
    expect(test.values.has('twitch-stream-key')).toBe(false)
    expect(test.values.has('twitch-stream-server')).toBe(false)
    expect(test.values.has('twitch-client-secret')).toBe(false)
  })
})
