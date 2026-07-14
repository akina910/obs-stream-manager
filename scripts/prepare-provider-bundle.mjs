import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const output = path.resolve('build/provider-oauth.json')
const source = process.env.OBS_STREAM_MANAGER_PROVIDER_OAUTH_FILE?.trim()
let input = {}

if (source) input = JSON.parse(await readFile(path.resolve(source), 'utf8'))

const youtubeClientId = process.env.OBS_STREAM_MANAGER_YOUTUBE_CLIENT_ID?.trim()
  || input.youtube?.clientId?.trim()
const twitchClientId = process.env.OBS_STREAM_MANAGER_TWITCH_CLIENT_ID?.trim()
  || input.twitch?.clientId?.trim()

const serializedInput = JSON.stringify(input)
if (/client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token/i.test(serializedInput)) {
  throw new Error('Provider bundle contains a secret or token. Only public OAuth client IDs may be packaged.')
}

const bundle = {
  version: 1,
  ...(youtubeClientId ? { youtube: { clientId: youtubeClientId } } : {}),
  ...(twitchClientId ? { twitch: { clientId: twitchClientId } } : {}),
}

await mkdir(path.dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(bundle, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
console.log(`Prepared public OAuth provider bundle (${youtubeClientId ? 'YouTube' : 'no YouTube'}, ${twitchClientId ? 'Twitch' : 'no Twitch'})`)
