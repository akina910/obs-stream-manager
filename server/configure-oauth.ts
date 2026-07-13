import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { getDataDirectory } from './paths.js'
import { SecretStore } from './secrets.js'
import { DataStore } from './storage.js'

type GoogleClientFile = {
  installed?: { client_id?: string; client_secret?: string }
  web?: { client_id?: string; client_secret?: string }
}

async function googleCredentials(): Promise<{ clientId?: string; clientSecret?: string }> {
  const filename = process.env.OBS_STREAM_MANAGER_GOOGLE_CLIENT_JSON?.trim()
  if (!filename) {
    return {
      clientId: process.env.OBS_STREAM_MANAGER_YOUTUBE_CLIENT_ID?.trim(),
      clientSecret: process.env.OBS_STREAM_MANAGER_YOUTUBE_CLIENT_SECRET?.trim(),
    }
  }
  const parsed = JSON.parse(await readFile(path.resolve(filename), 'utf8')) as GoogleClientFile
  const client = parsed.installed ?? parsed.web
  return { clientId: client?.client_id?.trim(), clientSecret: client?.client_secret?.trim() }
}

const store = new DataStore(getDataDirectory())
await store.initialize()
const secrets = new SecretStore()
const current = await store.getConfig()
const google = await googleCredentials()
const twitchClientId = process.env.OBS_STREAM_MANAGER_TWITCH_CLIENT_ID?.trim()
const twitchClientSecret = process.env.OBS_STREAM_MANAGER_TWITCH_CLIENT_SECRET?.trim()

if (!google.clientId && !twitchClientId) {
  throw new Error('Google client JSON または YouTube/Twitch Client ID の環境変数を指定してください')
}

const youtubeClientChanged = Boolean(google.clientId && google.clientId !== current.youtube.clientId)
const twitchClientChanged = Boolean(twitchClientId && twitchClientId !== current.twitch.clientId)
const staged = await store.saveConfig({
  ...current,
  youtube: {
    ...current.youtube,
    clientId: google.clientId ?? current.youtube.clientId,
    clientSecretStored: google.clientSecret ? false : youtubeClientChanged ? false : current.youtube.clientSecretStored,
    refreshTokenStored: youtubeClientChanged ? false : current.youtube.refreshTokenStored,
    broadcastId: youtubeClientChanged ? '' : current.youtube.broadcastId,
  },
  twitch: {
    ...current.twitch,
    clientId: twitchClientId ?? current.twitch.clientId,
    clientSecretStored: twitchClientSecret ? false : twitchClientChanged ? false : current.twitch.clientSecretStored,
    accessTokenStored: twitchClientChanged ? false : current.twitch.accessTokenStored,
    refreshTokenStored: twitchClientChanged ? false : current.twitch.refreshTokenStored,
    broadcasterId: twitchClientChanged ? '' : current.twitch.broadcasterId,
  },
})
if (youtubeClientChanged) {
  secrets.set('youtube-refresh-token', '')
  if (!google.clientSecret) secrets.set('youtube-client-secret', '')
}
if (twitchClientChanged) {
  secrets.set('twitch-access-token', '')
  secrets.set('twitch-refresh-token', '')
  if (!twitchClientSecret) secrets.set('twitch-client-secret', '')
}
if (google.clientSecret) secrets.set('youtube-client-secret', google.clientSecret)
if (twitchClientSecret) secrets.set('twitch-client-secret', twitchClientSecret)
const saved = await store.saveConfig({
  ...staged,
  youtube: {
    ...staged.youtube,
    clientSecretStored: google.clientSecret ? true : staged.youtube.clientSecretStored,
  },
  twitch: {
    ...staged.twitch,
    clientSecretStored: twitchClientSecret ? true : staged.twitch.clientSecretStored,
  },
})

console.log(JSON.stringify({
  dataDirectory: store.dataDir,
  youtubeConfigured: Boolean(saved.youtube.clientId),
  twitchConfigured: Boolean(saved.twitch.clientId),
}, null, 2))
