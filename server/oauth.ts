import crypto from 'node:crypto'
import type { DataStore } from './storage.js'
import type { SecretStore } from './secrets.js'
import { clearYouTubeStreamSecrets } from './provider-provisioning.js'

export type OAuthProvider = 'youtube' | 'twitch'

export type OAuthStartResult =
  | { mode: 'redirect'; url: string }
  | { mode: 'device'; url: string; userCode: string; requestId: string; intervalMs: number; expiresAt: number }

export type OAuthPollResult = { status: 'pending' } | { status: 'complete' }

export type OAuthConnectionStage = 'setup_required' | 'ready' | 'authorizing' | 'partial' | 'connected'

export type OAuthConnectionStatus = {
  provider: OAuthProvider
  stage: OAuthConnectionStage
  appConfigured: boolean
  authorizationInProgress: boolean
  accessTokenStored: boolean
  refreshTokenStored: boolean
  accountLinked: boolean
  detail: string
}

export type OAuthConnectionStatuses = Record<OAuthProvider, OAuthConnectionStatus>

type GoogleState = { expiresAt: number; openerOrigin: string; codeVerifier: string }
type TwitchDeviceSession = {
  clientId: string
  deviceCode: string
  expiresAt: number
  intervalMs: number
  nextPollAt: number
}

const youtubeScope = 'https://www.googleapis.com/auth/youtube.force-ssl'
const twitchScopes = 'channel:manage:broadcast chat:read'

function codeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url')
}

function message(value: unknown, fallback: string): string {
  if (!value || typeof value !== 'object') return fallback
  const body = value as Record<string, unknown>
  return typeof body.error_description === 'string' ? body.error_description : typeof body.message === 'string' ? body.message : fallback
}

export class OAuthManager {
  private readonly googleStates = new Map<string, GoogleState>()
  private readonly twitchDevices = new Map<string, TwitchDeviceSession>()

  constructor(
    private readonly store: DataStore,
    private readonly secrets: SecretStore,
    private readonly callbackOrigin: string,
    private readonly allowedOpenerOrigins: ReadonlySet<string> = new Set([callbackOrigin]),
  ) {}

  private redirectUri(): string {
    return `${this.callbackOrigin}/api/oauth/youtube/callback`
  }

  private purgeExpiredSessions(): void {
    const now = Date.now()
    for (const [state, session] of this.googleStates) {
      if (session.expiresAt < now) this.googleStates.delete(state)
    }
    for (const [requestId, session] of this.twitchDevices) {
      if (session.expiresAt < now) this.twitchDevices.delete(requestId)
    }
  }

  private prepareStart(openerOrigin: string): void {
    if (!this.allowedOpenerOrigins.has(openerOrigin)) {
      throw Object.assign(new Error('OAuth opener origin is not allowed'), { statusCode: 400 })
    }
    this.purgeExpiredSessions()
  }

  async status(): Promise<OAuthConnectionStatuses> {
    this.purgeExpiredSessions()
    const config = await this.store.getConfig()
    const youtubeRefreshTokenStored = Boolean(this.secrets.get('youtube-refresh-token'))
    const twitchAccessTokenStored = Boolean(this.secrets.get('twitch-access-token'))
    const twitchRefreshTokenStored = Boolean(this.secrets.get('twitch-refresh-token'))

    const youtubeAppConfigured = Boolean(config.youtube.clientId)
    const youtubeAuthorizing = this.googleStates.size > 0
    const youtubeMetadataMismatch = config.youtube.refreshTokenStored !== youtubeRefreshTokenStored
    const youtubeStage: OAuthConnectionStage = youtubeAuthorizing
      ? 'authorizing'
      : youtubeRefreshTokenStored && youtubeAppConfigured
        ? 'connected'
        : youtubeRefreshTokenStored || youtubeMetadataMismatch
          ? 'partial'
          : youtubeAppConfigured
            ? 'ready'
            : 'setup_required'

    const twitchAppConfigured = Boolean(config.twitch.clientId)
    const twitchAuthorizing = this.twitchDevices.size > 0
    const twitchBroadcasterStored = Boolean(config.twitch.broadcasterId)
    const twitchAccountLinked = twitchAccessTokenStored && twitchRefreshTokenStored && twitchBroadcasterStored
    const twitchMetadataMismatch = config.twitch.accessTokenStored !== twitchAccessTokenStored
      || config.twitch.refreshTokenStored !== twitchRefreshTokenStored
    const twitchStage: OAuthConnectionStage = twitchAuthorizing
      ? 'authorizing'
      : twitchAccountLinked && twitchAppConfigured
        ? 'connected'
        : twitchAccessTokenStored || twitchRefreshTokenStored || twitchBroadcasterStored || twitchMetadataMismatch
          ? 'partial'
          : twitchAppConfigured
            ? 'ready'
            : 'setup_required'

    const youtubeDetail = youtubeStage === 'connected'
      ? 'Google認証と更新トークンの保存が完了しています'
      : youtubeStage === 'authorizing'
        ? 'Googleの認証完了を待っています'
        : youtubeStage === 'partial'
          ? '保存状態が不完全です。再接続してください'
          : youtubeStage === 'ready'
            ? 'OAuthアプリ準備済みです。Google認証を開始できます'
            : 'この配布パッケージにYouTube接続機能が含まれていません。更新版を再インストールしてください'
    const twitchDetail = twitchStage === 'connected'
      ? 'Twitch認証と配信者情報の取得が完了しています'
      : twitchStage === 'authorizing'
        ? 'Twitchのデバイス認証完了を待っています'
        : twitchStage === 'partial'
          ? twitchAccessTokenStored && twitchRefreshTokenStored && !twitchBroadcasterStored
            ? 'トークンは保存済みですが、配信者情報が未取得です'
            : '保存状態が不完全です。再接続してください'
          : twitchStage === 'ready'
            ? 'OAuthアプリ準備済みです。Twitch認証を開始できます'
            : 'この配布パッケージにTwitch接続機能が含まれていません。更新版を再インストールしてください'

    return {
      youtube: {
        provider: 'youtube',
        stage: youtubeStage,
        appConfigured: youtubeAppConfigured,
        authorizationInProgress: youtubeAuthorizing,
        accessTokenStored: false,
        refreshTokenStored: youtubeRefreshTokenStored,
        accountLinked: youtubeRefreshTokenStored && youtubeAppConfigured,
        detail: youtubeDetail,
      },
      twitch: {
        provider: 'twitch',
        stage: twitchStage,
        appConfigured: twitchAppConfigured,
        authorizationInProgress: twitchAuthorizing,
        accessTokenStored: twitchAccessTokenStored,
        refreshTokenStored: twitchRefreshTokenStored,
        accountLinked: twitchAccountLinked && twitchAppConfigured,
        detail: twitchDetail,
      },
    }
  }

  async start(provider: OAuthProvider, openerOrigin = this.callbackOrigin): Promise<OAuthStartResult> {
    this.prepareStart(openerOrigin)
    const config = await this.store.getConfig()
    if (provider === 'youtube') {
      if (!config.youtube.clientId) {
        throw new Error('配布パッケージの YouTube 接続情報が不完全です。利用者による開発者登録は不要です')
      }
      const state = crypto.randomBytes(24).toString('base64url')
      const codeVerifier = crypto.randomBytes(48).toString('base64url')
      this.googleStates.set(state, { expiresAt: Date.now() + 10 * 60_000, openerOrigin, codeVerifier })
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
      url.search = new URLSearchParams({
        client_id: config.youtube.clientId,
        redirect_uri: this.redirectUri(),
        response_type: 'code',
        scope: youtubeScope,
        access_type: 'offline',
        prompt: 'consent',
        code_challenge: codeChallenge(codeVerifier),
        code_challenge_method: 'S256',
        state,
      }).toString()
      return { mode: 'redirect', url: url.toString() }
    }

    if (!config.twitch.clientId) throw new Error('配布パッケージに Twitch 接続情報が含まれていません。利用者による開発者登録は不要です')
    const response = await fetch('https://id.twitch.tv/oauth2/device', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.twitch.clientId, scopes: twitchScopes }),
    })
    const body = await response.json().catch(() => ({})) as {
      device_code?: string
      expires_in?: number
      interval?: number
      user_code?: string
      verification_uri?: string
    }
    if (!response.ok || !body.device_code || !body.user_code || !body.verification_uri) throw new Error(message(body, 'Twitch の認証開始に失敗しました'))
    const requestId = crypto.randomBytes(24).toString('base64url')
    const intervalMs = Math.max(1_000, Math.min(10_000, (body.interval ?? 5) * 1_000))
    const expiresAt = Date.now() + (body.expires_in ?? 1_800) * 1_000
    this.twitchDevices.set(requestId, { clientId: config.twitch.clientId, deviceCode: body.device_code, expiresAt, intervalMs, nextPollAt: 0 })
    return { mode: 'device', url: body.verification_uri, userCode: body.user_code, requestId, intervalMs, expiresAt }
  }

  async authorizationUrl(provider: OAuthProvider, openerOrigin = this.callbackOrigin): Promise<string> {
    if (provider !== 'youtube') throw new Error('Twitch はワンボタン接続を使用してください')
    const started = await this.start('youtube', openerOrigin)
    if (started.mode !== 'redirect') throw new Error('YouTube OAuth の開始に失敗しました')
    return started.url
  }

  async exchange(provider: OAuthProvider, code: string, state: string): Promise<string> {
    if (provider !== 'youtube') throw new Error('Twitch はワンボタン接続を使用してください')
    const expected = this.googleStates.get(state)
    this.googleStates.delete(state)
    if (!expected || expected.expiresAt < Date.now()) throw new Error('OAuth state is invalid or expired')
    const config = await this.store.getConfig()
    if (!config.youtube.clientId) {
      throw new Error('配布パッケージの YouTube 接続情報が不完全です。利用者による開発者登録は不要です')
    }
    const tokenBody = new URLSearchParams({
      code,
      client_id: config.youtube.clientId,
      redirect_uri: this.redirectUri(),
      grant_type: 'authorization_code',
      code_verifier: expected.codeVerifier,
    })
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: tokenBody,
    })
    const token = await response.json().catch(() => ({})) as { refresh_token?: string }
    if (!response.ok || !token.refresh_token) throw new Error(message(token, 'YouTube refresh token was not returned'))
    clearYouTubeStreamSecrets(this.secrets)
    this.secrets.set('youtube-refresh-token', token.refresh_token)
    await this.store.saveConfig({
      ...config,
      youtube: { ...config.youtube, refreshTokenStored: true, clientSecretStored: false, broadcastId: '' },
    })
    return expected.openerOrigin
  }

  async pollTwitch(requestId: string): Promise<OAuthPollResult> {
    const session = this.twitchDevices.get(requestId)
    if (!session) throw Object.assign(new Error('Twitch 認証リクエストが見つかりません'), { statusCode: 404 })
    if (session.expiresAt < Date.now()) {
      this.twitchDevices.delete(requestId)
      throw Object.assign(new Error('Twitch 認証の有効期限が切れました'), { statusCode: 410 })
    }
    if (session.nextPollAt > Date.now()) return { status: 'pending' }
    session.nextPollAt = Date.now() + session.intervalMs
    const response = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: session.clientId,
        scopes: twitchScopes,
        device_code: session.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    })
    const token = await response.json().catch(() => ({})) as {
      access_token?: string
      refresh_token?: string
      message?: string
    }
    if (!response.ok) {
      if (token.message === 'authorization_pending') return { status: 'pending' }
      if (token.message === 'slow_down') {
        session.intervalMs = Math.min(15_000, session.intervalMs + 1_000)
        return { status: 'pending' }
      }
      this.twitchDevices.delete(requestId)
      throw new Error(message(token, 'Twitch 認証に失敗しました'))
    }
    if (!token.access_token || !token.refresh_token) {
      this.twitchDevices.delete(requestId)
      throw new Error('Twitch access and refresh tokens were not returned')
    }
    const usersResponse = await fetch('https://api.twitch.tv/helix/users', {
      headers: { authorization: `Bearer ${token.access_token}`, 'client-id': session.clientId },
    })
    const users = await usersResponse.json().catch(() => ({})) as { data?: Array<{ id: string }> }
    const broadcasterId = users.data?.[0]?.id
    if (!usersResponse.ok || !broadcasterId) {
      this.twitchDevices.delete(requestId)
      throw new Error('Twitch broadcaster account could not be identified')
    }
    const config = await this.store.getConfig()
    this.secrets.set('twitch-access-token', token.access_token)
    this.secrets.set('twitch-refresh-token', token.refresh_token)
    await this.store.saveConfig({
      ...config,
      twitch: {
        ...config.twitch,
        broadcasterId,
        accessTokenStored: true,
        refreshTokenStored: true,
        clientSecretStored: Boolean(this.secrets.get('twitch-client-secret')),
      },
    })
    this.twitchDevices.delete(requestId)
    return { status: 'complete' }
  }
}
