import crypto from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import type { AppConfig, ChatMessage, GameProfile } from '../shared/contracts.js'
import { SecretStore } from './secrets.js'
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

  constructor(private readonly secrets: SecretStore, private readonly store: DataStore) {}

  private async youtubeAccessToken(config: AppConfig): Promise<string> {
    const clientSecret = this.secrets.get('youtube-client-secret')
    const refreshToken = this.secrets.get('youtube-refresh-token')
    if (!config.youtube.clientId || !clientSecret || !refreshToken) throw new Error('YouTube OAuth が未設定です')
    const credentialKey = crypto.createHash('sha256').update(`${config.youtube.clientId}\0${refreshToken}`).digest('hex')
    if (this.youtubeToken?.credentialKey === credentialKey && this.youtubeToken.expiresAt > Date.now() + 60_000) return this.youtubeToken.value
    const body = new URLSearchParams({ client_id: config.youtube.clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' })
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
      if (owned && owned.status.lifeCycleStatus !== 'complete') broadcast = owned
    }
    if (!broadcast) {
      const insert = new URL('https://www.googleapis.com/youtube/v3/liveBroadcasts')
      insert.search = new URLSearchParams({ part: 'snippet,status,contentDetails' }).toString()
      broadcast = await apiJson<YouTubeBroadcast>(insert.toString(), {
        method: 'POST', headers,
        body: JSON.stringify({ snippet: { title: title(profile.youtube.titleTemplate, profile), description: profile.youtube.description, scheduledStartTime: new Date(Date.now() + 60_000).toISOString() }, status: { privacyStatus: profile.youtube.privacy, selfDeclaredMadeForKids: false }, contentDetails: { enableAutoStart: true, enableAutoStop: true, latencyPreference: 'low' } }),
      })
      const latest = await this.store.getConfig()
      await this.store.saveConfig({ ...latest, youtube: { ...latest.youtube, broadcastId: broadcast.id } })
    } else {
      const update = new URL('https://www.googleapis.com/youtube/v3/liveBroadcasts')
      update.search = new URLSearchParams({ part: 'snippet,status' }).toString()
      await apiJson(update.toString(), { method: 'PUT', headers, body: JSON.stringify({ id: broadcast.id, snippet: { title: title(profile.youtube.titleTemplate, profile), description: profile.youtube.description, scheduledStartTime: broadcast.snippet.scheduledStartTime }, status: { privacyStatus: profile.youtube.privacy, selfDeclaredMadeForKids: Boolean(broadcast.status.selfDeclaredMadeForKids) } }) })
    }
    const videoUrl = new URL('https://www.googleapis.com/youtube/v3/videos')
    videoUrl.search = new URLSearchParams({ part: 'snippet' }).toString()
    await apiJson(videoUrl.toString(), { method: 'PUT', headers, body: JSON.stringify({ id: broadcast.id, snippet: { title: title(profile.youtube.titleTemplate, profile), description: profile.youtube.description, categoryId: profile.youtube.categoryId } }) })
    if (!broadcast.contentDetails.boundStreamId) {
      const streamsUrl = new URL('https://www.googleapis.com/youtube/v3/liveStreams')
      streamsUrl.search = new URLSearchParams({ part: 'id', mine: 'true', maxResults: '1' }).toString()
      const streams = await apiJson<{ items: Array<{ id: string }> }>(streamsUrl.toString(), { headers })
      const stream = streams.items[0]
      if (!stream) throw new Error('YouTube に再利用可能な配信ストリームがありません。YouTube Studio でストリームを作成し、同じキーを Aitum Multistream に設定してください')
      const bindUrl = new URL('https://www.googleapis.com/youtube/v3/liveBroadcasts/bind')
      bindUrl.search = new URLSearchParams({ id: broadcast.id, streamId: stream.id, part: 'id,contentDetails' }).toString()
      await apiJson(bindUrl.toString(), { method: 'POST', headers })
    }
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
    if (config.twitch.clientId && clientSecret && refreshToken) {
      const credentialKey = crypto.createHash('sha256').update(`${config.twitch.clientId}\0${refreshToken}`).digest('hex')
      if (this.twitchToken?.credentialKey === credentialKey && this.twitchToken.expiresAt > Date.now() + 60_000) return this.twitchToken.value
      if (this.twitchTokenRefresh?.credentialKey === credentialKey) return this.twitchTokenRefresh.promise
      const promise = (async () => {
        const refreshStartedAt = Date.now()
        const response = await fetch('https://id.twitch.tv/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: config.twitch.clientId, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken }) })
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
    return Promise.all(([
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
  }

  async steamOwnedGames(config: AppConfig): Promise<Array<{ appId: number; name: string; playtimeMinutes: number }>> {
    const key = this.secrets.get('steam-api-key')
    if (!key || !config.steam.steamId64) throw new Error('Steam API キーと SteamID64 を設定してください')
    const url = new URL('https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/')
    url.search = new URLSearchParams({ key, steamid: config.steam.steamId64, include_appinfo: 'true', include_played_free_games: 'true' }).toString()
    const result = await apiJson<{ response: { games?: Array<{ appid: number; name: string; playtime_forever: number }> } }>(url.toString(), {})
    return (result.response.games ?? []).map((game) => ({ appId: game.appid, name: game.name, playtimeMinutes: game.playtime_forever }))
  }

  async steamInstalledGames(config: AppConfig): Promise<Array<{ appId: number; name: string; installDir: string }>> {
    if (!config.steam.installPath) return []
    const steamApps = path.join(config.steam.installPath, 'steamapps')
    const files = (await readdir(steamApps)).filter((file) => /^appmanifest_\d+\.acf$/.test(file))
    return Promise.all(files.map(async (file) => {
      const body = await readFile(path.join(steamApps, file), 'utf8')
      const value = (key: string) => body.match(new RegExp(`"${key}"\\s+"([^"]*)"`, 'i'))?.[1] ?? ''
      return { appId: Number(value('appid')), name: value('name'), installDir: path.join(steamApps, 'common', value('installdir')) }
    }))
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
