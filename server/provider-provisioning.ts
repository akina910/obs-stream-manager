import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { AppConfig } from '../shared/contracts.js'
import type { SecretStore } from './secrets.js'
import type { DataStore } from './storage.js'

export type ProviderOAuthCredentials = {
  youtube?: { clientId: string; clientSecret: string }
  twitch?: { clientId: string }
}

type ProviderOAuthBundle = ProviderOAuthCredentials & { version: 1 }

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Provider OAuth bundle is missing ${field}`)
  return value.trim()
}

export function parseProviderOAuthBundle(value: unknown): ProviderOAuthCredentials {
  if (!value || typeof value !== 'object') throw new Error('Provider OAuth bundle must be a JSON object')
  const bundle = value as Partial<ProviderOAuthBundle>
  if (bundle.version !== 1) throw new Error('Unsupported provider OAuth bundle version')
  if (!bundle.youtube && !bundle.twitch) throw new Error('Provider OAuth bundle does not contain a provider')
  return {
    youtube: bundle.youtube
      ? {
          clientId: requiredString(bundle.youtube.clientId, 'youtube.clientId'),
          clientSecret: requiredString(bundle.youtube.clientSecret, 'youtube.clientSecret'),
        }
      : undefined,
    twitch: bundle.twitch
      ? { clientId: requiredString(bundle.twitch.clientId, 'twitch.clientId') }
      : undefined,
  }
}

export async function loadProviderOAuthBundle(filename: string): Promise<ProviderOAuthCredentials> {
  return parseProviderOAuthBundle(JSON.parse(await readFile(path.resolve(filename), 'utf8')) as unknown)
}

export async function loadDistributorOAuthCredentials(): Promise<ProviderOAuthCredentials | null> {
  const filename = process.env.OBS_STREAM_MANAGER_PROVIDER_OAUTH_FILE?.trim()
  if (filename) return loadProviderOAuthBundle(filename)

  const youtubeClientId = process.env.OBS_STREAM_MANAGER_YOUTUBE_CLIENT_ID?.trim()
  const youtubeClientSecret = process.env.OBS_STREAM_MANAGER_YOUTUBE_CLIENT_SECRET?.trim()
  const twitchClientId = process.env.OBS_STREAM_MANAGER_TWITCH_CLIENT_ID?.trim()
  if (!youtubeClientId && !youtubeClientSecret && !twitchClientId) return null
  if (Boolean(youtubeClientId) !== Boolean(youtubeClientSecret)) {
    throw new Error('Distributor provisioning requires both YouTube Client ID and Client Secret')
  }
  return {
    youtube: youtubeClientId && youtubeClientSecret ? { clientId: youtubeClientId, clientSecret: youtubeClientSecret } : undefined,
    twitch: twitchClientId ? { clientId: twitchClientId } : undefined,
  }
}

export async function provisionProviderOAuth(
  store: DataStore,
  secrets: SecretStore,
  credentials: ProviderOAuthCredentials,
): Promise<AppConfig> {
  const current = await store.getConfig()
  const youtubeClientChanged = Boolean(credentials.youtube && credentials.youtube.clientId !== current.youtube.clientId)
  const twitchClientChanged = Boolean(credentials.twitch && credentials.twitch.clientId !== current.twitch.clientId)

  if (youtubeClientChanged) secrets.set('youtube-refresh-token', '')
  if (twitchClientChanged) {
    secrets.set('twitch-access-token', '')
    secrets.set('twitch-refresh-token', '')
  }
  if (credentials.youtube) secrets.set('youtube-client-secret', credentials.youtube.clientSecret)

  return store.saveConfig({
    ...current,
    youtube: credentials.youtube
      ? {
          ...current.youtube,
          clientId: credentials.youtube.clientId,
          clientSecretStored: true,
          refreshTokenStored: youtubeClientChanged ? false : current.youtube.refreshTokenStored,
          broadcastId: youtubeClientChanged ? '' : current.youtube.broadcastId,
        }
      : current.youtube,
    twitch: credentials.twitch
      ? {
          ...current.twitch,
          clientId: credentials.twitch.clientId,
          accessTokenStored: twitchClientChanged ? false : current.twitch.accessTokenStored,
          refreshTokenStored: twitchClientChanged ? false : current.twitch.refreshTokenStored,
          broadcasterId: twitchClientChanged ? '' : current.twitch.broadcasterId,
        }
      : current.twitch,
  })
}

export async function provisionDistributorOAuth(store: DataStore, secrets: SecretStore): Promise<AppConfig | null> {
  const credentials = await loadDistributorOAuthCredentials()
  return credentials ? provisionProviderOAuth(store, secrets, credentials) : null
}
