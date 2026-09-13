const { readFile } = require('node:fs/promises')
const path = require('node:path')

function assertCompleteProviderBundle(value) {
  if (!value || typeof value !== 'object' || value.version !== 3) {
    throw new Error('Distribution OAuth provider bundle is missing or has an unsupported version.')
  }
  const serialized = JSON.stringify(value)
  if (/api[_-]?key|access[_-]?token|refresh[_-]?token|twitch[^}]*client[_-]?secret/i.test(serialized)) {
    throw new Error('Distribution OAuth provider bundle contains a forbidden API key, token, or Twitch client secret.')
  }
  const youtube = value.youtube
  const twitch = value.twitch
  if (
    !youtube
    || typeof youtube.clientId !== 'string'
    || !youtube.clientId.trim()
    || youtube.clientType !== 'desktop'
    || typeof youtube.clientSecret !== 'string'
    || !youtube.clientSecret.trim()
  ) {
    throw new Error('Distribution package requires complete YouTube Desktop app credentials.')
  }
  if (!twitch || typeof twitch.clientId !== 'string' || !twitch.clientId.trim()) {
    throw new Error('Distribution package requires a Twitch public client ID.')
  }
}

async function beforePack(context) {
  const filename = path.join(context.packager.projectDir, 'build', 'provider-oauth.json')
  let bundle
  try {
    bundle = JSON.parse(await readFile(filename, 'utf8'))
  } catch {
    throw new Error('Distribution OAuth provider bundle is missing or unreadable. Run the distribution build with both providers configured.')
  }
  assertCompleteProviderBundle(bundle)
}

module.exports = beforePack
module.exports.assertCompleteProviderBundle = assertCompleteProviderBundle
