import crypto from 'node:crypto'
import { readFile } from 'node:fs/promises'
import sharp from 'sharp'
import type { AppConfig, ChatMessage, GameProfile, PlatformRuntimeStatus, PlatformRuntimeStatuses } from '../shared/contracts.js'
import { SecretStore } from './secrets.js'
import { scanSteamLibraries, type SteamLibraryScan } from './steam-library.js'
import type { DataStore } from './storage.js'

export type ThumbnailPreparation = {
  status: 'not_registered' | 'applied' | 'failed' | 'disabled'
  message: string
  appliedAt?: string
}

export type Preparation = {
  service: 'youtube' | 'twitch'
  ok: boolean
  message: string
  thumbnail?: ThumbnailPreparation
}
type YouTubeBroadcast = { id: string; snippet: Record<string, unknown>; status: Record<string, unknown>; contentDetails: Record<string, unknown> }
type YouTubeStream = {
  id: string
  cdn?: { ingestionInfo?: { streamName?: string; rtmpsIngestionAddress?: string; ingestionAddress?: string } }
  status?: { streamStatus?: string; healthStatus?: { status?: string } }
}

type YouTubeLifecyclePolling = {
  pollIntervalMs?: number
  broadcastLookupTimeoutMs?: number
  streamActiveTimeoutMs?: number
  transitionTimeoutMs?: number
}

const defaultYouTubeLifecyclePolling = {
  pollIntervalMs: 1000,
  broadcastLookupTimeoutMs: 10_000,
  streamActiveTimeoutMs: 45_000,
  transitionTimeoutMs: 60_000,
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function apiJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
  return response.json() as Promise<T>
}

function title(template: string, profile: GameProfile): string {
  return template.replaceAll('{game}', profile.displayName).slice(0, 100)
}

export class PlatformServices {
  private readonly comments = new Map<string, ChatMessage>()
  private youtubeTimer: NodeJS.Timeout | null = null
  private twitchSocket: WebSocket | null = null
  private youtubeChatId: string | null = null
  private youtubePageToken: string | undefined
  private youtubeToken: { value: string; expiresAt: number; credentialKey: string } | null = null
  private twitchToken: { value: string; expiresAt: number; credentialKey: string } | null = null
  private twitchTokenRefresh: { credentialKey: string; promise: Promise<string> } | null = null
  private commentsGeneration = 0
  private twitchReconnectTimer: NodeJS.Timeout | null = null
  private readonly youtubeLifecyclePolling: Required<YouTubeLifecyclePolling>
  private platformStatusCache: { key: string; value: PlatformRuntimeStatuses; expiresAt: number } | null = null
  private platformStatusRefresh: { key: string; promise: Promise<PlatformRuntimeStatuses> } | null = null
  private platformStatusGeneration = 0

  constructor(private readonly secrets: SecretStore, private readonly store: DataStore, youtubeLifecyclePolling: YouTubeLifecyclePolling = {}) {
    this.youtubeLifecyclePolling = { ...defaultYouTubeLifecyclePolling, ...youtubeLifecyclePolling }
  }

  invalidateLiveStatus(): void {
    this.platformStatusGeneration += 1
    this.platformStatusCache = null
    this.platformStatusRefresh = null
  }

  private statusKey(config: AppConfig, profile: GameProfile | null): string {
    return JSON.stringify({
      youtube: [config.features.youtube, config.youtube.clientId, config.youtube.refreshTokenStored, config.youtube.broadcastId, profile?.youtube.enabled ?? null],
      twitch: [config.features.twitch, config.twitch.clientId, config.twitch.accessTokenStored, config.twitch.refreshTokenStored, config.twitch.broadcasterId, profile?.twitch.enabled ?? null],
    })
  }

  private async youtubeLiveStatus(config: AppConfig, profile: GameProfile | null): Promise<PlatformRuntimeStatus> {
    if (!config.features.youtube || profile?.youtube.enabled === false) return { state: 'disabled', detail: 'YouTube配信は無効です', checkedAt: null }
    if (!config.youtube.clientId || !config.youtube.refreshTokenStored || !config.youtube.broadcastId) return { state: 'unprepared', detail: '配信枠が準備されていません', checkedAt: null }
    const checkedAt = new Date().toISOString()
    try {
      const accessToken = await this.youtubeAccessToken(config)
      const url = new URL('https://www.googleapis.com/youtube/v3/liveBroadcasts')
      url.search = new URLSearchParams({ part: 'id,status,contentDetails', id: config.youtube.broadcastId }).toString()
      const result = await apiJson<{ items: YouTubeBroadcast[] }>(url.toString(), { headers: { authorization: `Bearer ${accessToken}` } })
      const broadcast = result.items[0]
      if (!broadcast) return { state: 'unprepared', detail: '準備済みの配信枠が見つかりません', checkedAt }
      const lifeCycle = String(broadcast.status.lifeCycleStatus ?? '')
      if (lifeCycle === 'live') return { state: 'live', detail: 'YouTubeで公開配信中', checkedAt }
      if (lifeCycle === 'liveStarting') return { state: 'starting', detail: 'YouTubeで公開開始処理中', checkedAt }
      if (lifeCycle === 'testing' || lifeCycle === 'testStarting') return { state: 'starting', detail: 'YouTubeテスト配信中（視聴者には未公開）', checkedAt }
      if (lifeCycle === 'ready') return { state: 'ready', detail: 'YouTube公開開始待ち', checkedAt }
      if (lifeCycle === 'created') return { state: 'unprepared', detail: 'YouTube配信枠を準備中', checkedAt }
      if (lifeCycle === 'complete') return { state: 'offline', detail: 'YouTube配信は終了済み', checkedAt }
      return { state: 'error', detail: `YouTube状態を判定できません（${lifeCycle || 'unknown'}）`, checkedAt }
    } catch (error) {
      return { state: 'error', detail: `YouTube状態の確認に失敗: ${error instanceof Error ? error.message : String(error)}`, checkedAt }
    }
  }

  private async twitchLiveStatus(config: AppConfig, profile: GameProfile | null): Promise<PlatformRuntimeStatus> {
    if (!config.features.twitch || profile?.twitch.enabled === false) return { state: 'disabled', detail: 'Twitch配信は無効です', checkedAt: null }
    if (!config.twitch.clientId || (!config.twitch.accessTokenStored && !config.twitch.refreshTokenStored) || !config.twitch.broadcasterId) return { state: 'unprepared', detail: 'Twitch配信先が準備されていません', checkedAt: null }
    const checkedAt = new Date().toISOString()
    try {
      const token = await this.twitchAccessToken(config)
      const url = `https://api.twitch.tv/helix/streams?user_id=${encodeURIComponent(config.twitch.broadcasterId)}`
      const result = await apiJson<{ data: Array<{ id: string; type: string }> }>(url, {
        headers: { authorization: `Bearer ${token}`, 'client-id': config.twitch.clientId },
      })
      const live = result.data.some((stream) => stream.type === 'live')
      return live
        ? { state: 'live', detail: 'Twitchで公開配信中', checkedAt }
        : { state: 'offline', detail: 'Twitchはオフライン', checkedAt }
    } catch (error) {
      return { state: 'error', detail: `Twitch状態の確認に失敗: ${error instanceof Error ? error.message : String(error)}`, checkedAt }
    }
  }

  async getLiveStatus(config: AppConfig, profile: GameProfile | null): Promise<PlatformRuntimeStatuses> {
    const key = this.statusKey(config, profile)
    if (this.platformStatusCache?.key === key && this.platformStatusCache.expiresAt > Date.now()) return this.platformStatusCache.value
    if (this.platformStatusRefresh?.key === key) return this.platformStatusRefresh.promise
    const generation = this.platformStatusGeneration
    const promise = Promise.all([this.youtubeLiveStatus(config, profile), this.twitchLiveStatus(config, profile)]).then(([youtube, twitch]) => {
      const value = { youtube, twitch }
      if (generation !== this.platformStatusGeneration) return this.getLiveStatus(config, profile)
      const active = [youtube.state, twitch.state].some((state) => ['ready', 'starting', 'live', 'stopping'].includes(state))
      this.platformStatusCache = { key, value, expiresAt: Date.now() + (active ? 10_000 : 30_000) }
      return value
    })
    this.platformStatusRefresh = { key, promise }
    try { return await promise } finally {
      if (this.platformStatusRefresh?.promise === promise) this.platformStatusRefresh = null
    }
  }

  private async youtubeAccessToken(config: AppConfig): Promise<string> {
    const refreshToken = this.secrets.get('youtube-refresh-token')
    if (!config.youtube.clientId || !refreshToken) throw new Error('YouTube OAuth が未設定です')
    const credentialKey = crypto.createHash('sha256').update(`${config.youtube.clientId}\0${refreshToken}`).digest('hex')
    if (this.youtubeToken?.credentialKey === credentialKey && this.youtubeToken.expiresAt > Date.now() + 60_000) return this.youtubeToken.value
    const body = new URLSearchParams({ client_id: config.youtube.clientId, refresh_token: refreshToken, grant_type: 'refresh_token' })
    const token = await apiJson<{ access_token: string; expires_in?: number }>('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body })
    this.youtubeToken = { value: token.access_token, expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000, credentialKey }
    return token.access_token
  }

  private async applyYouTubeThumbnail(accessToken: string, videoId: string, profile: GameProfile): Promise<ThumbnailPreparation> {
    if (!profile.state.thumbnailFilename) return { status: 'not_registered', message: 'サムネイル未登録のため YouTube の前回画像を維持します' }
    if (!profile.state.thumbnailAutoApply) return { status: 'disabled', message: 'サムネイル自動適用は無効です' }
    const thumbnail = this.store.getThumbnailPath(profile)
    if (!thumbnail) return { status: 'not_registered', message: 'サムネイル未登録のため YouTube の前回画像を維持します' }

    try {
      let bytes: Buffer<ArrayBufferLike> = await readFile(thumbnail)
      let contentType = thumbnail.endsWith('.png') ? 'image/png' : 'image/jpeg'
      if (thumbnail.endsWith('.webp') || bytes.byteLength > 2_000_000) {
        bytes = await sharp(bytes).resize({ width: 1280, height: 720, fit: 'cover', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer()
        if (bytes.byteLength > 2_000_000) bytes = await sharp(bytes).jpeg({ quality: 65 }).toBuffer()
        contentType = 'image/jpeg'
      }
      if (bytes.byteLength > 2_000_000) throw new Error('2 MB 以下に変換できませんでした')
      const upload = new URL('https://www.googleapis.com/upload/youtube/v3/thumbnails/set')
      upload.search = new URLSearchParams({ videoId, uploadType: 'media' }).toString()
      let lastError = ''
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await fetch(upload, { method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': contentType }, body: new Uint8Array(bytes) })
        if (response.ok) return { status: 'applied', message: '保存済みサムネイルを自動適用しました', appliedAt: new Date().toISOString() }
        lastError = `${response.status} ${await response.text()}`
      }
      throw new Error(lastError)
    } catch (error) {
      return { status: 'failed', message: `サムネイル適用に失敗しました。YouTube の前回画像を維持します: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  private async prepareYouTube(config: AppConfig, profile: GameProfile): Promise<ThumbnailPreparation> {
    if (!config.features.youtube || !profile.youtube.enabled) return { status: 'disabled', message: 'YouTube またはサムネイル自動適用が無効です' }
    const accessToken = await this.youtubeAccessToken(config)
    const headers = { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' }
    let broadcast: YouTubeBroadcast | undefined
    if (config.youtube.broadcastId) {
      const listUrl = new URL('https://www.googleapis.com/youtube/v3/liveBroadcasts')
      listUrl.search = new URLSearchParams({ part: 'id,snippet,status,contentDetails', id: config.youtube.broadcastId }).toString()
      const broadcasts = await apiJson<{ items: YouTubeBroadcast[] }>(listUrl.toString(), { headers })
      const owned = broadcasts.items[0]
      const lifeCycle = String(owned?.status.lifeCycleStatus ?? '')
      const reusable = ['created', 'ready', 'testing', 'testStarting', 'liveStarting', 'live'].includes(lifeCycle)
      if (owned && reusable) broadcast = owned
    }
    if (!broadcast) {
      const insert = new URL('https://www.googleapis.com/youtube/v3/liveBroadcasts')
      insert.search = new URLSearchParams({ part: 'snippet,status,contentDetails' }).toString()
      broadcast = await apiJson<YouTubeBroadcast>(insert.toString(), {
        method: 'POST', headers,
        body: JSON.stringify({ snippet: { title: title(profile.youtube.titleTemplate, profile), description: profile.youtube.description, scheduledStartTime: new Date(Date.now() + 60_000).toISOString() }, status: { privacyStatus: profile.youtube.privacy, selfDeclaredMadeForKids: false }, contentDetails: { enableAutoStart: true, enableAutoStop: true, monitorStream: { enableMonitorStream: false, broadcastStreamDelayMs: 0 }, latencyPreference: 'low' } }),
      })
      const latest = await this.store.getConfig()
      await this.store.saveConfig({ ...latest, youtube: { ...latest.youtube, broadcastId: broadcast.id } })
    } else {
      const update = new URL('https://www.googleapis.com/youtube/v3/liveBroadcasts')
      update.search = new URLSearchParams({ part: 'snippet,status' }).toString()
      const updateBody: Record<string, unknown> = {
        id: broadcast.id,
        snippet: { title: title(profile.youtube.titleTemplate, profile), description: profile.youtube.description, scheduledStartTime: broadcast.snippet.scheduledStartTime },
        status: { privacyStatus: profile.youtube.privacy, selfDeclaredMadeForKids: Boolean(broadcast.status.selfDeclaredMadeForKids) },
      }
      await apiJson(update.toString(), {
        method: 'PUT',
        headers,
        body: JSON.stringify(updateBody),
      })
    }
    const videoUrl = new URL('https://www.googleapis.com/youtube/v3/videos')
    videoUrl.search = new URLSearchParams({ part: 'snippet' }).toString()
    await apiJson(videoUrl.toString(), { method: 'PUT', headers, body: JSON.stringify({ id: broadcast.id, snippet: { title: title(profile.youtube.titleTemplate, profile), description: profile.youtube.description, categoryId: profile.youtube.categoryId } }) })
    let streamId = typeof broadcast.contentDetails.boundStreamId === 'string' ? broadcast.contentDetails.boundStreamId : ''
    let stream: YouTubeStream | undefined
    if (!streamId) {
      const streamsUrl = new URL('https://www.googleapis.com/youtube/v3/liveStreams')
      streamsUrl.search = new URLSearchParams({ part: 'id,cdn', mine: 'true', maxResults: '1' }).toString()
      const streams = await apiJson<{ items: YouTubeStream[] }>(streamsUrl.toString(), { headers })
      stream = streams.items[0]
      if (!stream) {
        const createStreamUrl = new URL('https://www.googleapis.com/youtube/v3/liveStreams')
        createStreamUrl.search = new URLSearchParams({ part: 'id,snippet,cdn,contentDetails' }).toString()
        stream = await apiJson<YouTubeStream>(createStreamUrl.toString(), {
          method: 'POST',
          headers,
          body: JSON.stringify({
            snippet: { title: 'OBS Stream Manager reusable stream' },
            cdn: { ingestionType: 'rtmp', resolution: 'variable', frameRate: 'variable' },
            contentDetails: { isReusable: true },
          }),
        })
      }
      streamId = stream.id
      const bindUrl = new URL('https://www.googleapis.com/youtube/v3/liveBroadcasts/bind')
      bindUrl.search = new URLSearchParams({ id: broadcast.id, streamId: stream.id, part: 'id,contentDetails' }).toString()
      await apiJson(bindUrl.toString(), { method: 'POST', headers })
    }
    if (!stream) {
      const streamsUrl = new URL('https://www.googleapis.com/youtube/v3/liveStreams')
      streamsUrl.search = new URLSearchParams({ part: 'id,cdn', id: streamId }).toString()
      const streams = await apiJson<{ items: YouTubeStream[] }>(streamsUrl.toString(), { headers })
      stream = streams.items[0]
    }
    const streamKey = stream?.cdn?.ingestionInfo?.streamName
    if (!streamKey) throw new Error('YouTube 配信キーを取得できませんでした。YouTube Studio のストリーム設定を確認してください')
    const streamServer = stream?.cdn?.ingestionInfo?.rtmpsIngestionAddress
    if (!streamServer) throw new Error('YouTubeの暗号化されたRTMPS配信サーバーを取得できませんでした。YouTube Studioのストリーム設定を確認してください')
    this.secrets.set('youtube-stream-key', streamKey)
    this.secrets.set('youtube-stream-server', streamServer)
    return this.applyYouTubeThumbnail(accessToken, broadcast.id, profile)
  }

  private async prepareTwitch(config: AppConfig, profile: GameProfile): Promise<void> {
    if (!config.features.twitch || !profile.twitch.enabled) return
    const token = await this.twitchAccessToken(config)
    if (!config.twitch.clientId || !config.twitch.broadcasterId || !token) throw new Error('Twitch OAuth が未設定です')
    const headers = { authorization: `Bearer ${token}`, 'client-id': config.twitch.clientId, 'content-type': 'application/json' }
    let gameId: string | undefined
    if (profile.twitch.categoryName) {
      const categories = await apiJson<{ data: Array<{ id: string }> }>(`https://api.twitch.tv/helix/search/categories?query=${encodeURIComponent(profile.twitch.categoryName)}&first=1`, { headers })
      gameId = categories.data[0]?.id
    }
    const response = await fetch(`https://api.twitch.tv/helix/channels?broadcaster_id=${encodeURIComponent(config.twitch.broadcasterId)}`, {
      method: 'PATCH', headers, body: JSON.stringify({ title: title(profile.twitch.titleTemplate, profile), game_id: gameId, tags: profile.twitch.tags.slice(0, 10) }),
    })
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
  }

  private async twitchAccessToken(config: AppConfig): Promise<string> {
    const clientSecret = this.secrets.get('twitch-client-secret')
    const refreshToken = this.secrets.get('twitch-refresh-token')
    if (config.twitch.clientId && refreshToken) {
      const credentialKey = crypto.createHash('sha256').update(`${config.twitch.clientId}\0${refreshToken}`).digest('hex')
      if (this.twitchToken?.credentialKey === credentialKey && this.twitchToken.expiresAt > Date.now() + 60_000) return this.twitchToken.value
      if (this.twitchTokenRefresh?.credentialKey === credentialKey) return this.twitchTokenRefresh.promise
      const promise = (async () => {
        const refreshStartedAt = Date.now()
        const body = new URLSearchParams({ client_id: config.twitch.clientId, grant_type: 'refresh_token', refresh_token: refreshToken })
        if (clientSecret) body.set('client_secret', clientSecret)
        const response = await fetch('https://id.twitch.tv/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body })
        const token = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; message?: string }
        if (!response.ok || !token.access_token) throw new Error(token.message ?? 'Twitch token refresh failed')
        const nextRefreshToken = token.refresh_token ?? refreshToken
        this.secrets.set('twitch-access-token', token.access_token)
        if (token.refresh_token) this.secrets.set('twitch-refresh-token', token.refresh_token)
        const nextCredentialKey = crypto.createHash('sha256').update(`${config.twitch.clientId}\0${nextRefreshToken}`).digest('hex')
        this.twitchToken = { value: token.access_token, expiresAt: refreshStartedAt + (token.expires_in ?? 3600) * 1000, credentialKey: nextCredentialKey }
        return token.access_token
      })()
      this.twitchTokenRefresh = { credentialKey, promise }
      try { return await promise } finally {
        if (this.twitchTokenRefresh?.promise === promise) this.twitchTokenRefresh = null
      }
    }
    const accessToken = this.secrets.get('twitch-access-token')
    if (!accessToken) throw new Error('Twitch OAuth が未設定です')
    return accessToken
  }

  async prepare(config: AppConfig, profile: GameProfile): Promise<Preparation[]> {
    const results = await Promise.all(([
      ['youtube', () => this.prepareYouTube(config, profile)],
      ['twitch', () => this.prepareTwitch(config, profile)],
    ] as const).map(async ([service, operation]) => {
      try {
        const result = await operation()
        return { service, ok: true, message: '適用済み', ...(service === 'youtube' ? { thumbnail: result as ThumbnailPreparation } : {}) }
      } catch (error) {
        return { service, ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    }))
    this.invalidateLiveStatus()
    return results
  }

  private async getYouTubeBroadcast(accessToken: string, broadcastId: string): Promise<YouTubeBroadcast> {
    const url = new URL('https://www.googleapis.com/youtube/v3/liveBroadcasts')
    url.search = new URLSearchParams({ part: 'id,status,contentDetails', id: broadcastId }).toString()
    const deadline = Date.now() + this.youtubeLifecyclePolling.broadcastLookupTimeoutMs
    do {
      const result = await apiJson<{ items: YouTubeBroadcast[] }>(url.toString(), { headers: { authorization: `Bearer ${accessToken}` } })
      const broadcast = result.items[0]
      if (broadcast) return broadcast
      if (Date.now() >= deadline) break
      await wait(Math.min(this.youtubeLifecyclePolling.pollIntervalMs, Math.max(deadline - Date.now(), 0)))
    } while (Date.now() <= deadline)
    throw new Error('YouTubeの配信枠が見つかりません。ゲームを選び直して配信設定を更新してください')
  }

  private async getYouTubeStream(accessToken: string, streamId: string): Promise<YouTubeStream> {
    const url = new URL('https://www.googleapis.com/youtube/v3/liveStreams')
    url.search = new URLSearchParams({ part: 'id,status', id: streamId }).toString()
    const result = await apiJson<{ items: YouTubeStream[] }>(url.toString(), { headers: { authorization: `Bearer ${accessToken}` } })
    const stream = result.items[0]
    if (!stream) throw new Error('YouTubeの配信ストリームが見つかりません。ゲームを選び直して配信設定を更新してください')
    return stream
  }

  private async waitForYouTubeState<T>(read: () => Promise<T>, ready: (value: T) => boolean, timeoutMs: number, failure: (value: T) => string): Promise<T> {
    const deadline = Date.now() + timeoutMs
    let value = await read()
    while (!ready(value)) {
      if (Date.now() >= deadline) throw new Error(failure(value))
      await wait(Math.min(this.youtubeLifecyclePolling.pollIntervalMs, Math.max(deadline - Date.now(), 0)))
      value = await read()
    }
    return value
  }

  private async transitionYouTubeBroadcast(accessToken: string, broadcastId: string, broadcastStatus: 'testing' | 'live' | 'complete'): Promise<void> {
    const url = new URL('https://www.googleapis.com/youtube/v3/liveBroadcasts/transition')
    url.search = new URLSearchParams({ part: 'id,status,contentDetails', id: broadcastId, broadcastStatus }).toString()
    await apiJson(url.toString(), { method: 'POST', headers: { authorization: `Bearer ${accessToken}` } })
  }

  async startYouTubeBroadcast(config: AppConfig, profile: GameProfile): Promise<void> {
    if (!config.features.youtube || !profile.youtube.enabled) return
    const broadcastId = config.youtube.broadcastId
    if (!broadcastId) throw new Error('YouTubeの配信枠が未設定です。ゲームを選び直して配信設定を作成してください')
    const accessToken = await this.youtubeAccessToken(config)
    let broadcast = await this.getYouTubeBroadcast(accessToken, broadcastId)
    let lifeCycleStatus = String(broadcast.status.lifeCycleStatus ?? '')
    if (lifeCycleStatus === 'live') return
    if (lifeCycleStatus === 'complete') throw new Error('YouTubeの配信枠は既に終了しています。ゲームを選び直して新しい配信枠を作成してください')
    const streamId = typeof broadcast.contentDetails.boundStreamId === 'string' ? broadcast.contentDetails.boundStreamId : ''
    if (!streamId) throw new Error('YouTubeの配信枠にストリームが接続されていません。ゲームを選び直して配信設定を更新してください')

    await this.waitForYouTubeState(
      () => this.getYouTubeStream(accessToken, streamId),
      (stream) => stream.status?.streamStatus === 'active',
      this.youtubeLifecyclePolling.streamActiveTimeoutMs,
      (stream) => `YouTubeがOBSの映像を受信できませんでした（streamStatus: ${stream.status?.streamStatus ?? 'unknown'}）`,
    )

    broadcast = await this.getYouTubeBroadcast(accessToken, broadcastId)
    lifeCycleStatus = String(broadcast.status.lifeCycleStatus ?? '')
    if (broadcast.contentDetails.enableAutoStart === true) {
      if (lifeCycleStatus === 'complete') throw new Error('YouTubeの配信枠は既に終了しています。ゲームを選び直して新しい配信枠を作成してください')
      if (lifeCycleStatus === 'revoked') throw new Error('YouTubeの配信枠が取り消されています。ゲームを選び直して新しい配信枠を作成してください')
      if (!['created', 'ready', 'testStarting', 'testing', 'liveStarting', 'live'].includes(lifeCycleStatus)) {
        throw new Error(`YouTubeの自動配信開始を待機できない状態です（lifeCycleStatus: ${lifeCycleStatus || 'unknown'}）`)
      }
      this.invalidateLiveStatus()
      return
    }
    if (lifeCycleStatus === 'ready' || lifeCycleStatus === 'created') {
      await this.transitionYouTubeBroadcast(accessToken, broadcastId, 'testing')
      lifeCycleStatus = 'testStarting'
    }
    if (lifeCycleStatus === 'testStarting') {
      broadcast = await this.waitForYouTubeState(
        () => this.getYouTubeBroadcast(accessToken, broadcastId),
        (current) => ['testing', 'liveStarting', 'live', 'complete'].includes(String(current.status.lifeCycleStatus ?? '')),
        this.youtubeLifecyclePolling.transitionTimeoutMs,
        (current) => `YouTubeのテスト配信開始処理が完了しませんでした（lifeCycleStatus: ${String(current.status.lifeCycleStatus ?? 'unknown')}）`,
      )
      lifeCycleStatus = String(broadcast.status.lifeCycleStatus ?? '')
    }
    if (lifeCycleStatus === 'complete') throw new Error('YouTubeの配信枠は既に終了しています。ゲームを選び直して新しい配信枠を作成してください')
    if (lifeCycleStatus !== 'live' && lifeCycleStatus !== 'liveStarting') {
      await this.transitionYouTubeBroadcast(accessToken, broadcastId, 'live')
    }
    await this.waitForYouTubeState(
      () => this.getYouTubeBroadcast(accessToken, broadcastId),
      (current) => current.status.lifeCycleStatus === 'live',
      this.youtubeLifecyclePolling.transitionTimeoutMs,
      (current) => `YouTube配信を開始状態にできませんでした（lifeCycleStatus: ${String(current.status.lifeCycleStatus ?? 'unknown')}）`,
    )
    this.invalidateLiveStatus()
  }

  async completeYouTubeBroadcast(config: AppConfig, profile: GameProfile | null): Promise<void> {
    // `profile === null` is intentional for a manual OBS stop after an app restart.
    // Only a genuinely live lifecycle is completed below; stale ready/created IDs remain untouched.
    if (!config.features.youtube || profile?.youtube.enabled === false || !config.youtube.broadcastId) return
    const accessToken = await this.youtubeAccessToken(config)
    const broadcastId = config.youtube.broadcastId
    let broadcast = await this.getYouTubeBroadcast(accessToken, broadcastId)
    let lifeCycleStatus = String(broadcast.status.lifeCycleStatus ?? '')
    if (lifeCycleStatus === 'complete' || lifeCycleStatus === 'ready' || lifeCycleStatus === 'created') return
    if (broadcast.contentDetails.enableAutoStop === true) {
      this.invalidateLiveStatus()
      return
    }
    if (lifeCycleStatus === 'liveStarting' || lifeCycleStatus === 'testStarting') {
      broadcast = await this.waitForYouTubeState(
        () => this.getYouTubeBroadcast(accessToken, broadcastId),
        (current) => ['live', 'testing', 'complete', 'ready'].includes(String(current.status.lifeCycleStatus ?? '')),
        this.youtubeLifecyclePolling.transitionTimeoutMs,
        (current) => `YouTube配信の開始処理が完了せず、終了できませんでした（lifeCycleStatus: ${String(current.status.lifeCycleStatus ?? 'unknown')}）`,
      )
      lifeCycleStatus = String(broadcast.status.lifeCycleStatus ?? '')
    }
    if (lifeCycleStatus === 'complete' || lifeCycleStatus === 'ready' || lifeCycleStatus === 'testing') return
    if (lifeCycleStatus !== 'live') {
      throw new Error(`YouTube配信を終了できない状態です（lifeCycleStatus: ${lifeCycleStatus || 'unknown'}）`)
    }
    await this.transitionYouTubeBroadcast(accessToken, broadcastId, 'complete')
    await this.waitForYouTubeState(
      () => this.getYouTubeBroadcast(accessToken, broadcastId),
      (current) => current.status.lifeCycleStatus === 'complete',
      this.youtubeLifecyclePolling.transitionTimeoutMs,
      (current) => `YouTube配信の終了を確認できませんでした（lifeCycleStatus: ${String(current.status.lifeCycleStatus ?? 'unknown')}）`,
    )
    this.invalidateLiveStatus()
  }

  async steamOwnedGames(config: AppConfig): Promise<Array<{ appId: number; name: string; playtimeMinutes: number }>> {
    const key = this.secrets.get('steam-api-key')
    if (!key || !config.steam.steamId64) throw new Error('Steam API キーと SteamID64 を設定してください')
    const url = new URL('https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/')
    url.search = new URLSearchParams({ key, steamid: config.steam.steamId64, include_appinfo: 'true', include_played_free_games: 'true' }).toString()
    const result = await apiJson<{ response: { games?: Array<{ appid: number; name: string; playtime_forever: number }> } }>(url.toString(), {})
    return (result.response.games ?? []).map((game) => ({ appId: game.appid, name: game.name, playtimeMinutes: game.playtime_forever }))
  }

  async steamInstalledGames(config: AppConfig): Promise<SteamLibraryScan> {
    return scanSteamLibraries(config.steam.installPath)
  }

  private addComment(message: ChatMessage): void {
    this.comments.set(message.id, message)
    while (this.comments.size > 200) this.comments.delete(this.comments.keys().next().value as string)
  }

  getComments(): ChatMessage[] {
    return [...this.comments.values()].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt))
  }

  private async pollYouTubeComments(config: AppConfig): Promise<number> {
    if (!config.features.youtube || !config.youtube.clientId || !config.youtube.refreshTokenStored) return 5000
    const token = await this.youtubeAccessToken(config)
    const headers = { authorization: `Bearer ${token}` }
    const broadcastsUrl = new URL('https://www.googleapis.com/youtube/v3/liveBroadcasts')
    broadcastsUrl.search = new URLSearchParams({ part: 'snippet', mine: 'true', broadcastStatus: 'active', maxResults: '1' }).toString()
    const broadcasts = await apiJson<{ items: Array<{ snippet: { liveChatId?: string } }> }>(broadcastsUrl.toString(), { headers })
    const liveChatId = broadcasts.items[0]?.snippet.liveChatId
    if (!liveChatId) return 5000
    if (this.youtubeChatId !== liveChatId) {
      this.youtubeChatId = liveChatId
      this.youtubePageToken = undefined
    }
    const messagesUrl = new URL('https://www.googleapis.com/youtube/v3/liveChat/messages')
    messagesUrl.search = new URLSearchParams({ part: 'id,snippet,authorDetails', liveChatId, maxResults: '200', ...(this.youtubePageToken ? { pageToken: this.youtubePageToken } : {}) }).toString()
    const messages = await apiJson<{ nextPageToken?: string; pollingIntervalMillis?: number; items: Array<{ id: string; snippet: { displayMessage: string; publishedAt: string }; authorDetails: { displayName: string; isChatModerator?: boolean } }> }>(messagesUrl.toString(), { headers })
    this.youtubePageToken = messages.nextPageToken
    for (const item of messages.items) this.addComment({ id: `youtube:${item.id}`, service: 'youtube', author: item.authorDetails.displayName, body: item.snippet.displayMessage, publishedAt: item.snippet.publishedAt, moderator: Boolean(item.authorDetails.isChatModerator), mention: item.snippet.displayMessage.includes('@') })
    return Math.max(messages.pollingIntervalMillis ?? 5000, 1000)
  }

  private scheduleTwitchReconnect(config: AppConfig, generation: number): void {
    if (this.commentsGeneration !== generation) return
    if (this.twitchReconnectTimer) clearTimeout(this.twitchReconnectTimer)
    this.twitchReconnectTimer = setTimeout(() => {
      this.twitchReconnectTimer = null
      void this.connectTwitchComments(config, generation).catch(() => this.scheduleTwitchReconnect(config, generation))
    }, 3000)
  }

  private async connectTwitchComments(config: AppConfig, generation: number): Promise<void> {
    if (!config.features.twitch || !config.twitch.clientId || this.twitchSocket) return
    const token = await this.twitchAccessToken(config)
    if (this.commentsGeneration !== generation) return
    const users = await apiJson<{ data: Array<{ login: string }> }>('https://api.twitch.tv/helix/users', { headers: { authorization: `Bearer ${token}`, 'client-id': config.twitch.clientId } })
    if (this.commentsGeneration !== generation) return
    const login = users.data[0]?.login
    if (!login) return
    const socket = new WebSocket('wss://irc-ws.chat.twitch.tv:443')
    this.twitchSocket = socket
    socket.addEventListener('open', () => socket.send(`CAP REQ :twitch.tv/tags twitch.tv/commands\r\nPASS oauth:${token}\r\nNICK ${login}\r\nJOIN #${login}\r\n`))
    socket.addEventListener('message', (event) => {
      const payload = String(event.data)
      if (payload.startsWith('PING')) { socket.send(payload.replace('PING', 'PONG')); return }
      for (const line of payload.split('\r\n')) {
        const match = line.match(/^@([^ ]+) :[^!]+![^ ]+ PRIVMSG #[^ ]+ :(.+)$/)
        if (!match) continue
        const tags = Object.fromEntries(match[1].split(';').map((tag) => { const [key, ...value] = tag.split('='); return [key, value.join('=')] }))
        const body = match[2]
        this.addComment({ id: `twitch:${tags.id ?? crypto.randomUUID()}`, service: 'twitch', author: (tags['display-name'] || 'Twitch user').replaceAll('\\s', ' '), body, publishedAt: new Date().toISOString(), moderator: tags.mod === '1', mention: body.toLowerCase().includes(`@${login.toLowerCase()}`) })
      }
    })
    socket.addEventListener('close', () => {
      if (this.twitchSocket === socket) this.twitchSocket = null
      this.scheduleTwitchReconnect(config, generation)
    })
  }

  async startComments(config: AppConfig): Promise<void> {
    await this.stopComments()
    const generation = ++this.commentsGeneration
    await this.connectTwitchComments(config, generation).catch(() => this.scheduleTwitchReconnect(config, generation))
    const poll = async () => {
      const delay = await this.pollYouTubeComments(config).catch(() => 5000)
      if (this.commentsGeneration === generation) this.youtubeTimer = setTimeout(poll, delay)
    }
    void poll()
  }

  async stopComments(): Promise<void> {
    this.commentsGeneration += 1
    if (this.youtubeTimer) clearTimeout(this.youtubeTimer)
    if (this.twitchReconnectTimer) clearTimeout(this.twitchReconnectTimer)
    this.youtubeTimer = null
    this.twitchReconnectTimer = null
    this.youtubeChatId = null
    this.youtubePageToken = undefined
    this.twitchSocket?.close()
    this.twitchSocket = null
  }
}
