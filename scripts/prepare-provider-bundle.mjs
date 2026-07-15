import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const output = path.resolve('build/provider-oauth.json')
const source = process.env.OBS_STREAM_MANAGER_PROVIDER_OAUTH_FILE?.trim()
let input = {}

if (source) input = JSON.parse(await readFile(path.resolve(source), 'utf8'))

const youtubeClientId = process.env.OBS_STREAM_MANAGER_YOUTUBE_CLIENT_ID?.trim()
  || input.youtube?.clientId?.trim()
const youtubeClientType = process.env.OBS_STREAM_MANAGER_YOUTUBE_CLIENT_TYPE?.trim()
  || input.youtube?.clientType?.trim()
const youtubeClientSecret = process.env.OBS_STREAM_MANAGER_YOUTUBE_CLIENT_SECRET?.trim()
  || input.youtube?.clientSecret?.trim()
const twitchClientId = process.env.OBS_STREAM_MANAGER_TWITCH_CLIENT_ID?.trim()
  || input.twitch?.clientId?.trim()

const serializedInput = JSON.stringify(input)
if (/api[_-]?key|access[_-]?token|refresh[_-]?token|twitch[^}]*client[_-]?secret/i.test(serializedInput)) {
  throw new Error('Provider bundle contains a forbidden API key, token, or Twitch client secret.')
}
if (youtubeClientId && youtubeClientType !== 'desktop') {
  throw new Error('YouTube OAuth must use a Google Desktop app client (clientType: "desktop").')
}
if (youtubeClientId && !youtubeClientSecret) {
  throw new Error('The Google Desktop app client credential is required for YouTube token exchange and refresh.')
}

const bundle = {
  version: 3,
  ...(youtubeClientId ? { youtube: { clientId: youtubeClientId, clientType: 'desktop', clientSecret: youtubeClientSecret } } : {}),
  ...(twitchClientId ? { twitch: { clientId: twitchClientId } } : {}),
}

await mkdir(path.dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(bundle, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
console.log(`Prepared OAuth provider bundle (${youtubeClientId ? 'YouTube Desktop' : 'no YouTube'}, ${twitchClientId ? 'Twitch public client' : 'no Twitch'})`)
