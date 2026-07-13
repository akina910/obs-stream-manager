import type { OAuthConnectionStatuses, OAuthProvider } from './api'

const providers: OAuthProvider[] = ['youtube', 'twitch']

export function completedOAuthProviders(
  previous: OAuthConnectionStatuses | null,
  current: OAuthConnectionStatuses,
): OAuthProvider[] {
  if (!previous) return []
  return providers.filter((provider) => {
    const before = previous[provider]
    const after = current[provider]
    if (!before || !after) return false
    return (!before.accountLinked && after.accountLinked)
      || (before.authorizationInProgress && after.stage === 'connected')
  })
}

export function oauthRefreshInterval(status: OAuthConnectionStatuses | null): number {
  return status?.youtube.authorizationInProgress || status?.twitch.authorizationInProgress ? 1_000 : 5_000
}
