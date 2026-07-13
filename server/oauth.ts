import crypto from 'node:crypto'
import type { DataStore } from './storage.js'
import type { SecretStore } from './secrets.js'

type Provider = 'youtube' | 'twitch'

export class OAuthManager {
  private readonly states = new Map<string, { provider: Provider; expiresAt: number; openerOrigin: string }>()

  constructor(private readonly store: DataStore, private readonly secrets: SecretStore, private readonly callbackOrigin: string) {}

  private state(provider: Provider, openerOrigin: string): string {
    const state = crypto.randomBytes(24).toString('base64url')
    this.states.set(state, { provider, expiresAt: Date.now() + 10 * 60_000, openerOrigin })
    return state
  }

  private redirectUri(provider: Provider): string {
    return `${this.callbackOrigin}/api/oauth/${provider}/callback`
  }

  async authorizationUrl(provider: Provider, openerOrigin = this.callbackOrigin): Promise<string> {
    const config = await this.store.getConfig()
    const state = this.state(provider, openerOrigin)
    if (provider === 'youtube') {
      if (!config.youtube.clientId || !this.secrets.get('youtube-client-secret')) throw new Error('先に YouTube Client ID と Client Secret を保存してください')
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
      url.search = new URLSearchParams({ client_id: config.youtube.clientId, redirect_uri: this.redirectUri(provider), response_type: 'code', scope: 'https://www.googleapis.com/auth/youtube.force-ssl', access_type: 'offline', prompt: 'consent', state }).toString()
      return url.toString()
    }
    if (!config.twitch.clientId || !this.secrets.get('twitch-client-secret')) throw new Error('先に Twitch Client ID と Client Secret を保存してください')
    const url = new URL('https://id.twitch.tv/oauth2/authorize')
    url.search = new URLSearchParams({ client_id: config.twitch.clientId, redirect_uri: this.redirectUri(provider), response_type: 'code', scope: 'channel:manage:broadcast chat:read', force_verify: 'true', state }).toString()
    return url.toString()
  }

  async exchange(provider: Provider, code: string, state: string): Promise<string> {
    const expected = this.states.get(state)
    this.states.delete(state)
    if (!expected || expected.provider !== provider || expected.expiresAt < Date.now()) throw new Error('OAuth state is invalid or expired')
    const config = await this.store.getConfig()
    if (provider === 'youtube') {
      const clientSecret = this.secrets.get('youtube-client-secret')
      if (!clientSecret) throw new Error('YouTube Client Secret がありません')
      const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: config.youtube.clientId, client_secret: clientSecret, redirect_uri: this.redirectUri(provider), grant_type: 'authorization_code' }) })
      const token = await response.json() as { refresh_token?: string; error_description?: string }
      if (!response.ok || !token.refresh_token) throw new Error(token.error_description ?? 'YouTube refresh token was not returned')
      this.secrets.set('youtube-refresh-token', token.refresh_token)
      await this.store.saveConfig({ ...config, youtube: { ...config.youtube, refreshTokenStored: true, clientSecretStored: true } })
      return expected.openerOrigin
    }
    const clientSecret = this.secrets.get('twitch-client-secret')
    if (!clientSecret) throw new Error('Twitch Client Secret がありません')
    const tokenResponse = await fetch('https://id.twitch.tv/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: config.twitch.clientId, client_secret: clientSecret, redirect_uri: this.redirectUri(provider), grant_type: 'authorization_code' }) })
    const token = await tokenResponse.json() as { access_token?: string; refresh_token?: string; message?: string }
    if (!tokenResponse.ok || !token.access_token || !token.refresh_token) throw new Error(token.message ?? 'Twitch access and refresh tokens were not returned')
    const usersResponse = await fetch('https://api.twitch.tv/helix/users', { headers: { authorization: `Bearer ${token.access_token}`, 'client-id': config.twitch.clientId } })
    const users = await usersResponse.json() as { data?: Array<{ id: string }> }
    const broadcasterId = users.data?.[0]?.id
    if (!usersResponse.ok || !broadcasterId) throw new Error('Twitch broadcaster account could not be identified')
    this.secrets.set('twitch-access-token', token.access_token)
    this.secrets.set('twitch-refresh-token', token.refresh_token)
    await this.store.saveConfig({ ...config, twitch: { ...config.twitch, broadcasterId, accessTokenStored: true, refreshTokenStored: true, clientSecretStored: true } })
    return expected.openerOrigin
  }
}
