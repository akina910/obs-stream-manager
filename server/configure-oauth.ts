import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { getDataDirectory } from './paths.js'
import { provisionProviderOAuth, type ProviderOAuthCredentials } from './provider-provisioning.js'
import { SecretStore } from './secrets.js'
import { DataStore } from './storage.js'

type GoogleClientFile = {
  installed?: { client_id?: string; client_secret?: string }
  web?: { client_id?: string; client_secret?: string }
}

async function googleCredentials(): Promise<ProviderOAuthCredentials['youtube']> {
  const filename = process.env.OBS_STREAM_MANAGER_GOOGLE_CLIENT_JSON?.trim()
  if (!filename) {
    const clientId = process.env.OBS_STREAM_MANAGER_YOUTUBE_CLIENT_ID?.trim()
    const clientSecret = process.env.OBS_STREAM_MANAGER_YOUTUBE_CLIENT_SECRET?.trim()
    if (clientId && process.env.OBS_STREAM_MANAGER_YOUTUBE_CLIENT_TYPE?.trim() !== 'desktop') {
      throw new Error('OBS_STREAM_MANAGER_YOUTUBE_CLIENT_TYPE must be desktop')
    }
    if (clientId && !clientSecret) throw new Error('OBS_STREAM_MANAGER_YOUTUBE_CLIENT_SECRET is required')
    return clientId ? { clientId, clientSecret: clientSecret! } : undefined
  }
  const parsed = JSON.parse(await readFile(path.resolve(filename), 'utf8')) as GoogleClientFile
  if (!parsed.installed && parsed.web) throw new Error('Google client JSON is a Web client. Create a Desktop app OAuth client instead')
  const client = parsed.installed
  if (!client?.client_id?.trim() || !client.client_secret?.trim()) {
    throw new Error('Google client JSON does not contain the required Desktop app credentials')
  }
  return { clientId: client.client_id.trim(), clientSecret: client.client_secret.trim() }
}

const store = new DataStore(getDataDirectory())
await store.initialize()
const secrets = new SecretStore()
const youtube = await googleCredentials()
const twitchClientId = process.env.OBS_STREAM_MANAGER_TWITCH_CLIENT_ID?.trim()
const credentials: ProviderOAuthCredentials = {
  youtube,
  twitch: twitchClientId ? { clientId: twitchClientId } : undefined,
}

if (!credentials.youtube && !credentials.twitch) {
  throw new Error('Maintainer provisioning requires Google client JSON or provider environment variables')
}

const saved = await provisionProviderOAuth(store, secrets, credentials)
console.log(JSON.stringify({
  dataDirectory: store.dataDir,
  youtubeConfigured: Boolean(saved.youtube.clientId),
  twitchConfigured: Boolean(saved.twitch.clientId),
}, null, 2))
