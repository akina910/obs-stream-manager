import { describe, expect, it } from 'vitest'
import { defaultConfig } from './defaults.js'
import { reconcileImportedConfig } from './secret-flags.js'
import type { SecretName } from './secrets.js'

describe('backup secret metadata reconciliation', () => {
  it('keeps distributor client IDs and derives every stored flag from the credential store', () => {
    const imported = structuredClone(defaultConfig)
    imported.obs.passwordStored = true
    imported.steam.apiKeyStored = true
    imported.youtube = { ...imported.youtube, clientId: 'backup-google-client', clientSecretStored: true, refreshTokenStored: true, broadcastId: 'stale-broadcast' }
    imported.twitch = { ...imported.twitch, clientId: 'backup-twitch-client', accessTokenStored: true, refreshTokenStored: true, broadcasterId: 'stale-user' }
    const current = structuredClone(defaultConfig)
    current.youtube.clientId = 'release-google-client'
    current.twitch.clientId = 'release-twitch-client'
    const stored = new Set<SecretName>(['youtube-client-secret', 'twitch-refresh-token'])

    const result = reconcileImportedConfig(imported, current, (name) => stored.has(name))

    expect(result.obs.passwordStored).toBe(false)
    expect(result.steam.apiKeyStored).toBe(false)
    expect(result.youtube).toMatchObject({ clientId: 'release-google-client', clientSecretStored: true, refreshTokenStored: false, broadcastId: '' })
    expect(result.twitch).toMatchObject({ clientId: 'release-twitch-client', accessTokenStored: false, refreshTokenStored: true, broadcasterId: 'stale-user' })
  })
})
