import type { AppConfig } from '../shared/contracts.js'
import type { SecretName } from './secrets.js'

export function reconcileImportedConfig(
  imported: AppConfig,
  providerConfig: AppConfig,
  hasSecret: (name: SecretName) => boolean,
): AppConfig {
  const youtubeRefreshTokenStored = hasSecret('youtube-refresh-token')
  const twitchAccessTokenStored = hasSecret('twitch-access-token')
  const twitchRefreshTokenStored = hasSecret('twitch-refresh-token')
  return {
    ...imported,
    obs: { ...imported.obs, passwordStored: hasSecret('obs-password') },
    steam: { ...imported.steam, apiKeyStored: hasSecret('steam-api-key') },
    youtube: {
      ...imported.youtube,
      clientId: providerConfig.youtube.clientId || imported.youtube.clientId,
      clientSecretStored: hasSecret('youtube-client-secret'),
      refreshTokenStored: youtubeRefreshTokenStored,
      broadcastId: youtubeRefreshTokenStored ? imported.youtube.broadcastId : '',
    },
    twitch: {
      ...imported.twitch,
      clientId: providerConfig.twitch.clientId || imported.twitch.clientId,
      clientSecretStored: hasSecret('twitch-client-secret'),
      accessTokenStored: twitchAccessTokenStored,
      refreshTokenStored: twitchRefreshTokenStored,
      broadcasterId: twitchAccessTokenStored || twitchRefreshTokenStored ? imported.twitch.broadcasterId : '',
    },
  }
}
