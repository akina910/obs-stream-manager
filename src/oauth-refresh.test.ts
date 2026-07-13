import { describe, expect, it } from 'vitest'
import type { OAuthConnectionStatus, OAuthConnectionStatuses } from './api'
import { completedOAuthProviders, oauthRefreshInterval } from './oauth-refresh'

function status(provider: 'youtube' | 'twitch', overrides: Partial<OAuthConnectionStatus> = {}): OAuthConnectionStatus {
  return {
    provider,
    stage: 'ready',
    appConfigured: true,
    authorizationInProgress: false,
    accessTokenStored: false,
    refreshTokenStored: false,
    accountLinked: false,
    detail: 'ready',
    ...overrides,
  }
}

function statuses(
  youtube: Partial<OAuthConnectionStatus> = {},
  twitch: Partial<OAuthConnectionStatus> = {},
): OAuthConnectionStatuses {
  return { youtube: status('youtube', youtube), twitch: status('twitch', twitch) }
}

describe('OAuth automatic refresh', () => {
  it('detects a newly linked account without a popup completion message', () => {
    const previous = statuses({}, {})
    const current = statuses({ stage: 'connected', accountLinked: true, refreshTokenStored: true }, {})
    expect(completedOAuthProviders(previous, current)).toEqual(['youtube'])
  })

  it('detects completion when reconnecting an already linked account', () => {
    const previous = statuses({ stage: 'authorizing', authorizationInProgress: true, accountLinked: true }, {})
    const current = statuses({ stage: 'connected', accountLinked: true, refreshTokenStored: true }, {})
    expect(completedOAuthProviders(previous, current)).toEqual(['youtube'])
  })

  it('does not announce completion on initial page load or ordinary refreshes', () => {
    const connected = statuses({ stage: 'connected', accountLinked: true, refreshTokenStored: true }, {})
    expect(completedOAuthProviders(null, connected)).toEqual([])
    expect(completedOAuthProviders(connected, connected)).toEqual([])
  })

  it('reports every provider that completed in the same refresh', () => {
    const previous = statuses(
      { stage: 'authorizing', authorizationInProgress: true },
      { stage: 'authorizing', authorizationInProgress: true },
    )
    const current = statuses(
      { stage: 'connected', accountLinked: true, refreshTokenStored: true },
      { stage: 'connected', accountLinked: true, accessTokenStored: true, refreshTokenStored: true },
    )
    expect(completedOAuthProviders(previous, current)).toEqual(['youtube', 'twitch'])
  })

  it('polls quickly during authorization and backs off otherwise', () => {
    expect(oauthRefreshInterval(statuses({ stage: 'authorizing', authorizationInProgress: true }))).toBe(1_000)
    expect(oauthRefreshInterval(statuses())).toBe(5_000)
  })
})
