import crypto from 'node:crypto'
import { readFile } from 'node:fs/promises'
import sharp from 'sharp'
import type { AppConfig, ChatMessage, GameProfile, PlatformRuntimeStatus, PlatformRuntimeStatuses } from '../shared/contracts.js'
import { renderTitleTemplate } from '../shared/title-template.js'
import {
  createPlatformSessionDiagnostics,
  PlatformDiagnosticsStore,
  type PlatformDiagnosticsArchive,
  type PlatformSessionDiagnostics,
} from './platform-diagnostics.js'
import { SecretStore } from './secrets.js'
import { scanSteamAccountLibrary, scanSteamLibraries, type SteamAccountLibraryScan, type SteamLibraryScan, type SteamOwnedGame } from './steam-library.js'
import type { DataStore } from './storage.js'

export type { PlatformDiagnosticsArchive, PlatformSessionDiagnostics } from './platform-diagnostics.js'

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

function diagnosticErrorCategory(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  if (/quotaExceeded|dailyLimitExceeded|youtube\.quota/i.test(detail)) return 'quota_exceeded'
  if (/rateLimitExceeded|userRateLimitExceeded/i.test(detail)) return 'rate_limited'
  if (/LIVE_CHAT_ENDED|liveChatEnded/i.test(detail)) return 'chat_ended'
  if (/liveChatDisabled/i.test(detail)) return 'chat_disabled'
  if (/401|unauthori[sz]ed|authentication|token/i.test(detail)) return 'authentication'
  if (/403|forbidden/i.test(detail)) return 'forbidden'
  if (/429|too many requests/i.test(detail)) return 'rate_limited'
  if (/timeout|timed out|abort/i.test(detail)) return 'timeout'
  if (/network|fetch failed|ECONN|ENOTFOUND|socket/i.test(detail)) return 'network'
  return 'unknown'
}

type YouTubeBroadcast = { id: string; snippet: Record<string, unknown>; status: Record<string, unknown>; contentDetails: Record<string, unknown> }
type YouTubeStream = {
  id: string
  snippet?: { title?: string }
  cdn?: {
    resolution?: string
    frameRate?: string
    ingestionInfo?: { streamName?: string; rtmpsIngestionAddress?: string; ingestionAddress?: string }
  }
  status?: { streamStatus?: string; healthStatus?: { status?: string } }
  contentDetails?: { isReusable?: boolean }
}

type YouTubeLifecyclePolling = {
  pollIntervalMs?: number
  broadcastLookupTimeoutMs?: number
  streamActiveTimeoutMs?: number
  transitionTimeoutMs?: number
}

function parseViewerCount(value: unknown): number | null {
  const count = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN
  return Number.isSafeInteger(count) && count >= 0 ? count : null
}

const youtubeManagedResolution = '1080p'
const youtubeManagedFrameRate = '60fps'
const youtubeManagedStreamTitle = 'OBS Stream Manager 1080p60 reusable stream'

function isManagedYouTubeStream(stream: YouTubeStream | undefined): boolean {
  return stream?.cdn?.resolution === youtubeManagedResolution && stream.cdn.frameRate === youtubeManagedFrameRate
}

function extractJsonObjectAfterMarker(source: string, markerOffset: number, marker: string): string | null {
  const valuePrefix = /^\s*(?::|=)\s*\{/.exec(source.slice(markerOffset + marker.length))
  if (!valuePrefix) return null
  const start = markerOffset + marker.length + valuePrefix[0].lastIndexOf('{')
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '{') depth += 1
    else if (character === '}' && --depth === 0) return source.slice(start, index + 1)
  }
  return null
}

type YouTubeInitialPlayerResponse = {
  playabilityStatus?: { status?: unknown }
  videoDetails?: { isLiveContent?: unknown; isPostLiveDvr?: unknown }
  microformat?: {
    playerMicroformatRenderer?: {
      liveBroadcastDetails?: {
        isLiveNow?: unknown
        endTimestamp?: unknown
      }
    }
  }
}

function parseYouTubeInitialPlayerResponse(html: string): YouTubeInitialPlayerResponse | null {
  const marker = 'ytInitialPlayerResponse'
  let offset = 0
  while ((offset = html.indexOf(marker, offset)) >= 0) {
    const source = extractJsonObjectAfterMarker(html, offset, marker)
    offset += marker.length
    if (!source) continue
    try { return JSON.parse(source) as YouTubeInitialPlayerResponse } catch { /* try another marker instance */ }
  }
  return null
}

function parseObjectAfterFirstMarker<T>(html: string, marker: string): T | null {
  const offset = html.indexOf(marker)
  if (offset < 0) return null
  const source = extractJsonObjectAfterMarker(html, offset, marker)
  if (!source) return null
  try { return JSON.parse(source) as T } catch { return null }
}

export function parseYouTubePublicViewerCount(html: string): number | null {
  const rendererMarker = '"videoViewCountRenderer"'
  const candidates = new Set<number>()
  let offset = 0
  while ((offset = html.indexOf(rendererMarker, offset)) >= 0) {
    const renderer = extractJsonObjectAfterMarker(html, offset, rendererMarker)
    offset += rendererMarker.length
    if (!renderer) continue
    if (!/"isLive":true/.test(renderer)) continue
    const viewCountMarker = '"viewCount"'
    const viewCountOffset = renderer.indexOf(viewCountMarker)
    const viewCount = viewCountOffset >= 0
      ? extractJsonObjectAfterMarker(renderer, viewCountOffset, viewCountMarker)
      : null
    if (!viewCount) continue
    // Depending on the watch-page experiment, YouTube emits the label either
    // as `simpleText` or split across multiple `runs[].text` values. Decode and
    // join both forms inside viewCount only before looking for the live count.
    const label = [...viewCount.matchAll(/"(?:simpleText|text)":"((?:\\.|[^"\\])*)"/g)]
      .map((match) => {
        try { return JSON.parse(`"${match[1]}"`) as string } catch { return match[1] }
      })
      .join(' ')
    const match = label.match(/(\d(?:[\d,.\u00a0\u202f ]*\d)?)[\s\u00a0\u202f]*(?:watching now|人が視聴中)/i)
    if (!match) continue
    const count = parseViewerCount(match[1].replace(/[,.\s\u00a0\u202f]/g, ''))
    if (count !== null) candidates.add(count)
  }
  return candidates.size === 1 ? [...candidates][0] : null
}

function hasYouTubeLiveViewCountRenderer(html: string): boolean {
  const marker = '"videoViewCountRenderer"'
  let offset = 0
  while ((offset = html.indexOf(marker, offset)) >= 0) {
    const renderer = extractJsonObjectAfterMarker(html, offset, marker)
    offset += marker.length
    if (renderer && /"isLive"\s*:\s*true/.test(renderer)) return true
  }
  return false
}

export type YouTubePublicLivePage = {
  live: boolean
  playable: boolean
  ended: boolean
  viewerCount: number | null
}

export function parseYouTubePublicLivePage(html: string): YouTubePublicLivePage {
  const playerResponse = parseYouTubeInitialPlayerResponse(html)
  const playabilityMarker = '"playabilityStatus"'
  const playabilityOffset = html.indexOf(playabilityMarker)
  const fallbackPlayability = playabilityOffset >= 0 ? extractJsonObjectAfterMarker(html, playabilityOffset, playabilityMarker) : null
  let playable = playerResponse?.playabilityStatus?.status === 'OK'
  if (!playerResponse && fallbackPlayability) {
    try { playable = (JSON.parse(fallbackPlayability) as { status?: unknown }).status === 'OK' } catch { /* indeterminate public page */ }
  }
  const liveBroadcastDetails = playerResponse
    ? playerResponse.microformat?.playerMicroformatRenderer?.liveBroadcastDetails
    : parseObjectAfterFirstMarker<{ isLiveNow?: unknown; endTimestamp?: unknown }>(html, '"liveBroadcastDetails"')
  const fallbackVideoDetails = playerResponse ? null : parseObjectAfterFirstMarker<{ isPostLiveDvr?: unknown }>(html, '"videoDetails"')
  const liveNow = liveBroadcastDetails?.isLiveNow
  const isPostLiveDvr = playerResponse?.videoDetails?.isPostLiveDvr === true || fallbackVideoDetails?.isPostLiveDvr === true
  // `isLiveContent` remains true on archived live streams, so it cannot
  // distinguish an active broadcast from its post-live DVR.  The public watch
  // page exposes `isLiveNow` inside the primary player response. Avoid scanning
  // the whole page because recommendations can contain unrelated live videos.
  // A live view-count renderer is a second positive signal for experiments
  // where the primary live flag is moved or omitted.
  const live = playable && (liveNow === true || hasYouTubeLiveViewCountRenderer(html))
  const ended = playable && !live && (liveNow === false || isPostLiveDvr || typeof liveBroadcastDetails?.endTimestamp === 'string')
  return { live, playable, ended, viewerCount: live ? parseYouTubePublicViewerCount(html) : null }
}

function isYouTubeApiLimitError(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error)
  return /quotaExceeded|dailyLimitExceeded|rateLimitExceeded|userRateLimitExceeded|youtube\.quota/i.test(detail)
}

function isDailyYouTubeQuotaError(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error)
  return /quotaExceeded|dailyLimitExceeded|youtube\.quota/i.test(detail) && !/rateLimitExceeded|userRateLimitExceeded/i.test(detail)
}

class YouTubeApiCooldownError extends Error {
  constructor(readonly retryAfterMs: number) {
    super('YouTube APIの利用上限クールダウン中です。公開状態はAPIを使わず確認します')
    this.name = 'YouTubeApiCooldownError'
  }
}

function isYouTubeApiCooldownError(error: unknown): error is YouTubeApiCooldownError {
  return error instanceof YouTubeApiCooldownError
}

function zonedDateParts(timestamp: number, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(timestamp))
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value)
  return { year: value('year'), month: value('month'), day: value('day'), hour: value('hour'), minute: value('minute'), second: value('second') }
}

function timeZoneOffsetMs(timestamp: number, timeZone: string): number {
  const parts = zonedDateParts(timestamp, timeZone)
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - timestamp
}

export function millisecondsUntilNextYouTubeQuotaReset(now = Date.now()): number {
  const timeZone = 'America/Los_Angeles'
  const current = zonedDateParts(now, timeZone)
  const nextLocalDate = new Date(Date.UTC(current.year, current.month - 1, current.day + 1))
  const targetWallClock = Date.UTC(nextLocalDate.getUTCFullYear(), nextLocalDate.getUTCMonth(), nextLocalDate.getUTCDate())
  // Resolve the Pacific offset at the target instant twice so the result stays
  // correct across PST/PDT transitions.
  let target = targetWallClock - timeZoneOffsetMs(targetWallClock, timeZone)
  target = targetWallClock - timeZoneOffsetMs(target, timeZone)
  return Math.max(60_000, target - now + 5 * 60_000)
}

export function youtubeApiLimitBackoffMs(error: unknown, now = Date.now()): number {
  const detail = error instanceof Error ? error.message : String(error)
  if (/rateLimitExceeded|userRateLimitExceeded/i.test(detail)) return 60_000
  if (/quotaExceeded|dailyLimitExceeded|youtube\.quota/i.test(detail)) return millisecondsUntilNextYouTubeQuotaReset(now)
  return 15 * 60_000
}

function youtubeCommentRetryDelay(error: unknown, consecutiveFailures: number): number {
  if (isYouTubeApiCooldownError(error)) return Math.max(1_000, error.retryAfterMs)
  const detail = error instanceof Error ? error.message : String(error)
  if (/rateLimitExceeded|LIVE_CHAT_ENDED|liveChatEnded|liveChatDisabled/i.test(detail)) return 60_000
  if (isYouTubeApiLimitError(error)) return 15 * 60_000
  return Math.min(60_000, 5_000 * (2 ** Math.max(0, consecutiveFailures - 1)))
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

export class PlatformServices {
  private readonly comments = new Map<string, ChatMessage>()
  private youtubeTimer: NodeJS.Timeout | null = null
  private twitchSocket: WebSocket | null = null
  private youtubeChatId: string | null = null
  private youtubePageToken: string | undefined
  private youtubeCommentFailures = 0
  private youtubeToken: { value: string; expiresAt: number; credentialKey: string } | null = null
  private youtubeTokenRefresh: { credentialKey: string; promise: Promise<string> } | null = null
  private twitchToken: { value: string; expiresAt: number; credentialKey: string } | null = null
  private twitchTokenRefresh: { credentialKey: string; promise: Promise<string> } | null = null
  private commentsGeneration = 0
  private twitchReconnectTimer: NodeJS.Timeout | null = null
  private twitchReconnectFailures = 0
  private readonly youtubeLifecyclePolling: Required<YouTubeLifecyclePolling>
  private platformStatusCache: { key: string; value: PlatformRuntimeStatuses; expiresAt: number } | null = null
  private platformStatusRefresh: { key: string; promise: Promise<PlatformRuntimeStatuses> } | null = null
  private platformStatusGeneration = 0
  private youtubeConfiguredBroadcastCache: { broadcastId: string; value: YouTubeBroadcast; expiresAt: number } | null = null
  private youtubeActiveBroadcastSearchCache: { configuredBroadcastId: string; value: YouTubeBroadcast[]; expiresAt: number } | null = null
  private youtubeObservedActive: { configuredBroadcastId: string; activeBroadcastId: string } | null = null
  private readonly youtubePublicPageCache = new Map<string, { value: YouTubePublicLivePage | null; expiresAt: number }>()
  private youtubeApiLimitUntil = 0
  private youtubeApiLimitPersisted = false
  private youtubePendingCompletionId: string | null = null
  private youtubePendingCompletionRetry: { broadcastId: string; promise: Promise<boolean> } | null = null
  private youtubeLocallyStopped: { broadcastId: string; expiresAt: number } | null = null
  private diagnostics = createPlatformSessionDiagnostics()
  private diagnosticsHistory: PlatformSessionDiagnostics[] = []
  private diagnosticsWriteTail: Promise<void> = Promise.resolve()
  private readonly diagnosticsStore: PlatformDiagnosticsStore | null

  constructor(private readonly secrets: SecretStore, private readonly store: DataStore, youtubeLifecyclePolling: YouTubeLifecyclePolling = {}) {
    this.youtubeLifecyclePolling = { ...defaultYouTubeLifecyclePolling, ...youtubeLifecyclePolling }
    this.diagnosticsStore = typeof store.dataDir === 'string' && store.dataDir
      ? new PlatformDiagnosticsStore(store.dataDir)
      : null
    const persistedApiLimit = Number(this.secrets.get('youtube-api-limit-until'))
    if (Number.isSafeInteger(persistedApiLimit) && persistedApiLimit > Date.now()) {
      this.youtubeApiLimitUntil = persistedApiLimit
      this.youtubeApiLimitPersisted = true
    }
    else if (persistedApiLimit) this.secrets.set('youtube-api-limit-until', '')
    this.youtubePendingCompletionId = this.secrets.get('youtube-pending-completion-id')?.trim() || null
    const persistedObservedActive = this.secrets.get('youtube-observed-active')
    if (persistedObservedActive) {
      try {
        const parsed = JSON.parse(persistedObservedActive) as { configuredBroadcastId?: unknown; activeBroadcastId?: unknown }
        if (typeof parsed.configuredBroadcastId === 'string' && typeof parsed.activeBroadcastId === 'string' && parsed.activeBroadcastId) {
          this.youtubeObservedActive = { configuredBroadcastId: parsed.configuredBroadcastId, activeBroadcastId: parsed.activeBroadcastId }
        } else this.secrets.set('youtube-observed-active', '')
      } catch { this.secrets.set('youtube-observed-active', '') }
    }
  }

  private diagnosticsArchive(): PlatformDiagnosticsArchive {
    return {
      version: 1,
      current: structuredClone(this.diagnostics),
      history: structuredClone(this.diagnosticsHistory),
    }
  }

  private persistDiagnostics(): void {
    if (!this.diagnosticsStore) return
    const snapshot = this.diagnosticsArchive()
    this.diagnosticsWriteTail = this.diagnosticsWriteTail
      .catch(() => undefined)
      .then(() => this.diagnosticsStore?.save(snapshot))
      .then(() => undefined)
  }

  private async flushDiagnosticsPersistence(): Promise<void> {
    await this.diagnosticsWriteTail.catch(() => undefined)
  }

  private archiveCurrentDiagnostics(): void {
    if (!this.diagnostics.startedAt) return
    const completed = structuredClone(this.diagnostics)
    completed.active = false
    completed.comments.twitch.connected = false
    this.diagnosticsHistory = [
      completed,
      ...this.diagnosticsHistory.filter(({ sessionId }) => sessionId !== completed.sessionId),
    ].slice(0, 19)
  }

  async restoreDiagnostics(): Promise<void> {
    const persisted = await this.diagnosticsStore?.load()
    if (!persisted) return
    this.diagnostics = structuredClone(persisted.current)
    this.diagnosticsHistory = structuredClone(persisted.history)
    if (!this.diagnostics.active) return
    this.diagnostics.active = false
    this.diagnostics.interrupted = true
    this.diagnostics.endedAt ??= new Date().toISOString()
    this.diagnostics.comments.twitch.connected = false
    this.persistDiagnostics()
    await this.flushDiagnosticsPersistence()
  }

  invalidateLiveStatus(): void {
    this.platformStatusGeneration += 1
    this.platformStatusCache = null
    this.platformStatusRefresh = null
    this.youtubeConfiguredBroadcastCache = null
    this.youtubeActiveBroadcastSearchCache = null
    this.youtubePublicPageCache.clear()
  }

  private recordLiveStatusDiagnostics(statuses: PlatformRuntimeStatuses): void {
    if (!this.diagnostics.active) return
    for (const service of ['youtube', 'twitch'] as const) {
      const status = statuses[service]
      const diagnostics = this.diagnostics.viewers[service]
      diagnostics.statusSamples += 1
      diagnostics.lastState = status.state
      diagnostics.lastDetail = status.detail
      diagnostics.lastCheckedAt = status.checkedAt
      if (status.state !== 'live') continue
      diagnostics.liveSamples += 1
      if (status.viewerCountState === 'available' && status.viewerCount != null) {
        diagnostics.availableSamples += 1
        diagnostics.lastCount = status.viewerCount
        diagnostics.peakCount = diagnostics.peakCount === null
          ? status.viewerCount
          : Math.max(diagnostics.peakCount, status.viewerCount)
      } else if (status.viewerCountState === 'hidden') diagnostics.hiddenSamples += 1
      else diagnostics.unavailableSamples += 1
    }
    this.persistDiagnostics()
  }

  private recordCommentSuccess(service: 'youtube' | 'twitch'): void {
    if (!this.diagnostics.active) return
    const diagnostics = this.diagnostics.comments[service]
    diagnostics.successfulPolls += 1
    diagnostics.lastSuccessAt = new Date().toISOString()
    diagnostics.lastErrorCategory = null
    this.persistDiagnostics()
  }

  private recordCommentFailure(service: 'youtube' | 'twitch', error: unknown): void {
    if (!this.diagnostics.active) return
    const diagnostics = this.diagnostics.comments[service]
    diagnostics.failures += 1
    diagnostics.lastFailureAt = new Date().toISOString()
    diagnostics.lastErrorCategory = diagnosticErrorCategory(error)
    this.persistDiagnostics()
  }

  getDiagnostics(): PlatformSessionDiagnostics {
    return structuredClone(this.diagnostics)
  }

  getDiagnosticsArchive(): PlatformDiagnosticsArchive {
    return this.diagnosticsArchive()
  }

  private deferYouTubeApiAfterLimit(error: unknown): void {
    if (!isYouTubeApiLimitError(error)) return
    const next = Math.max(this.youtubeApiLimitUntil, Date.now() + youtubeApiLimitBackoffMs(error))
    if (next === this.youtubeApiLimitUntil) return
    this.youtubeApiLimitUntil = next
    if (isDailyYouTubeQuotaError(error)) {
      this.youtubeApiLimitPersisted = true
      this.secrets.set('youtube-api-limit-until', String(next))
    }
  }

  private youtubeApiCooldownRemaining(now = Date.now()): number {
    if (this.youtubeApiLimitUntil > now) return this.youtubeApiLimitUntil - now
    if (this.youtubeApiLimitUntil) {
      this.youtubeApiLimitUntil = 0
      if (this.youtubeApiLimitPersisted) {
        this.youtubeApiLimitPersisted = false
        this.secrets.set('youtube-api-limit-until', '')
      }
    }
    return 0
  }

  private setPendingYouTubeCompletion(broadcastId: string | null): void {
    this.youtubePendingCompletionId = broadcastId
    this.secrets.set('youtube-pending-completion-id', broadcastId ?? '')
  }

  private setObservedActive(value: { configuredBroadcastId: string; activeBroadcastId: string } | null): void {
    this.youtubeObservedActive = value
    this.secrets.set('youtube-observed-active', value ? JSON.stringify(value) : '')
  }

  private statusKey(config: AppConfig, profile: GameProfile | null): string {
    return JSON.stringify({
      youtube: [config.features.youtube, config.youtube.clientId, config.youtube.refreshTokenStored, config.youtube.broadcastId, profile?.youtube.enabled ?? null],
      twitch: [config.features.twitch, config.twitch.clientId, config.twitch.accessTokenStored, config.twitch.refreshTokenStored, config.twitch.broadcasterId, profile?.twitch.enabled ?? null],
    })
  }

  private async youtubePublicViewerCount(broadcastId: string): Promise<number | null> {
    const page = await this.youtubePublicLivePage(broadcastId)
    return page?.live ? page.viewerCount : null
  }

  private async youtubePublicLivePage(broadcastId: string): Promise<YouTubePublicLivePage | null> {
    const cached = this.youtubePublicPageCache.get(broadcastId)
    if (cached && cached.expiresAt > Date.now()) return cached.value
    let value: YouTubePublicLivePage | null = null
    try {
      const response = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(broadcastId)}`, {
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138 Safari/537.36',
          'accept-language': 'ja,en-US;q=0.9,en;q=0.8',
        },
        signal: AbortSignal.timeout(5_000),
      })
      if (response.ok) value = parseYouTubePublicLivePage(await response.text())
    } catch {
      value = null
    }
    this.youtubePublicPageCache.set(broadcastId, { value, expiresAt: Date.now() + 30_000 })
    return value
  }

  private async youtubeStatusDuringApiLimit(config: AppConfig, checkedAt: string): Promise<PlatformRuntimeStatus> {
    const observedActiveId = this.youtubeObservedActive?.configuredBroadcastId === config.youtube.broadcastId
      ? this.youtubeObservedActive.activeBroadcastId
      : undefined
    const candidateIds = [...new Set([
      observedActiveId,
      config.youtube.broadcastId,
    ].filter((value): value is string => Boolean(value)))]
    if (!candidateIds.length) {
      return {
        state: 'unprepared',
        detail: 'YouTube API上限中で、公開状態を確認できる配信枠がありません',
        checkedAt,
        viewerCount: null,
        viewerCountState: 'unavailable',
        viewerCountDetail: '配信枠を選択すると、APIを使わず公開ページから状態を再確認できます',
      }
    }
    let confirmedOffline = false
    let publicPageUnavailable = false
    for (const broadcastId of candidateIds) {
      const publicPage = await this.youtubePublicLivePage(broadcastId)
      if (publicPage === null) {
        publicPageUnavailable = true
        continue
      }
      if (publicPage.ended) {
        if (broadcastId === observedActiveId) this.setObservedActive(null)
        confirmedOffline = true
        continue
      }
      if (!publicPage.live) {
        publicPageUnavailable = true
        continue
      }
      return {
        state: 'live',
        detail: 'YouTubeで公開配信中（API上限のため公開ページで確認）',
        checkedAt,
        viewerCount: publicPage.viewerCount,
        viewerCountState: publicPage.viewerCount === null ? 'unavailable' : 'available',
        viewerCountDetail: publicPage.viewerCount === null
          ? 'YouTube API上限中です。公開ページでライブ状態を確認し、視聴者数は30秒ごとに再取得します'
          : 'YouTube API上限中のため、公開ページのライブ人数から取得しました',
      }
    }
    if (confirmedOffline && !publicPageUnavailable) {
      return {
        state: 'offline',
        detail: 'YouTube配信は終了済み（API上限のため公開ページで確認）',
        checkedAt,
        viewerCount: null,
        viewerCountState: 'unavailable',
        viewerCountDetail: 'YouTube API上限中のため、公開ページの終了状態から確認しました',
      }
    }
    return {
      state: 'starting',
      detail: 'YouTube API上限中・公開状態を確認待ち（OBS送信とは別の状態です）',
      checkedAt,
      viewerCount: null,
      viewerCountState: 'unavailable',
      viewerCountDetail: '接続失敗とは判定せず、公開ページを30秒ごとに再確認します',
    }
  }

  private async youtubeLiveStatus(config: AppConfig, profile: GameProfile | null): Promise<PlatformRuntimeStatus> {
    if (!config.features.youtube || profile?.youtube.enabled === false) return { state: 'disabled', detail: 'YouTube配信は無効です', checkedAt: null }
    if (!config.youtube.clientId || !config.youtube.refreshTokenStored) return { state: 'unprepared', detail: 'YouTube接続が完了していません', checkedAt: null }
    const checkedAt = new Date().toISOString()
    if (this.youtubeLocallyStopped?.broadcastId === config.youtube.broadcastId) {
      if (this.youtubeLocallyStopped.expiresAt > Date.now()) {
        return {
          state: 'offline',
          detail: 'OBS送信は停止済みです（YouTube側の終了表示を確認中）',
          checkedAt,
        }
      }
      this.youtubeLocallyStopped = null
    }
    if (this.youtubeApiCooldownRemaining() > 0) return this.youtubeStatusDuringApiLimit(config, checkedAt)
    try {
      const accessToken = await this.youtubeAccessToken(config)
      const headers = { authorization: `Bearer ${accessToken}` }
      const loadBroadcast = async (broadcastId: string): Promise<YouTubeBroadcast | undefined> => {
        const url = new URL('https://www.googleapis.com/youtube/v3/liveBroadcasts')
        url.search = new URLSearchParams({ part: 'id,status,contentDetails', id: broadcastId }).toString()
        const result = await apiJson<{ items: YouTubeBroadcast[] }>(url.toString(), { headers })
        return result.items[0]
      }
      let broadcast: YouTubeBroadcast | undefined
      if (this.youtubeObservedActive && this.youtubeObservedActive.configuredBroadcastId !== config.youtube.broadcastId) {
        this.setObservedActive(null)
      }
      const observedActiveId = this.youtubeObservedActive?.configuredBroadcastId === config.youtube.broadcastId
        ? this.youtubeObservedActive.activeBroadcastId
        : null
      if (observedActiveId) {
        broadcast = await loadBroadcast(observedActiveId)
        const observedLifeCycle = String(broadcast?.status.lifeCycleStatus ?? '')
        if (!['live', 'liveStarting', 'testing', 'testStarting'].includes(observedLifeCycle)) {
          this.setObservedActive(null)
          broadcast = undefined
        }
      }
      if (!broadcast && config.youtube.broadcastId) {
        if (this.youtubeConfiguredBroadcastCache?.broadcastId === config.youtube.broadcastId && this.youtubeConfiguredBroadcastCache.expiresAt > Date.now()) {
          broadcast = this.youtubeConfiguredBroadcastCache.value
        } else {
          broadcast = await loadBroadcast(config.youtube.broadcastId)
          const lifeCycle = String(broadcast?.status.lifeCycleStatus ?? '')
          this.youtubeConfiguredBroadcastCache = broadcast && !['live', 'liveStarting', 'testing', 'testStarting'].includes(lifeCycle)
            ? { broadcastId: config.youtube.broadcastId, value: broadcast, expiresAt: Date.now() + 5 * 60_000 }
            : null
        }
      }
      const configuredLifeCycle = String(broadcast?.status.lifeCycleStatus ?? '')
      if (!['live', 'liveStarting', 'testing', 'testStarting'].includes(configuredLifeCycle)) {
        let activeItems: YouTubeBroadcast[]
        if (this.youtubeActiveBroadcastSearchCache?.configuredBroadcastId === config.youtube.broadcastId
          && this.youtubeActiveBroadcastSearchCache.expiresAt > Date.now()) {
          activeItems = this.youtubeActiveBroadcastSearchCache.value
        } else {
          const activeUrl = new URL('https://www.googleapis.com/youtube/v3/liveBroadcasts')
          activeUrl.search = new URLSearchParams({ part: 'id,status,contentDetails', broadcastStatus: 'active', maxResults: '50' }).toString()
          const active = await apiJson<{ items: YouTubeBroadcast[] }>(activeUrl.toString(), { headers })
          activeItems = active.items
          this.youtubeActiveBroadcastSearchCache = {
            configuredBroadcastId: config.youtube.broadcastId,
            value: activeItems,
            expiresAt: Date.now() + (activeItems.length ? 30_000 : 5 * 60_000),
          }
        }
        const configuredStreamId = config.youtube.broadcastId && broadcast?.id === config.youtube.broadcastId && typeof broadcast.contentDetails.boundStreamId === 'string'
          ? broadcast.contentDetails.boundStreamId
          : ''
        const activeBroadcast = activeItems.find((candidate) => !config.youtube.broadcastId
          || candidate.id === config.youtube.broadcastId
          || Boolean(configuredStreamId && candidate.contentDetails.boundStreamId === configuredStreamId))
        if (!config.youtube.broadcastId && activeItems.length > 1) {
          return { state: 'error', detail: 'YouTubeで複数の公開配信を検出しました。使用する配信枠をゲーム設定から選び直してください', checkedAt }
        }
        if (activeBroadcast) {
          broadcast = activeBroadcast
          this.setObservedActive({ configuredBroadcastId: config.youtube.broadcastId, activeBroadcastId: activeBroadcast.id })
        }
      }
      if (!broadcast) return { state: 'unprepared', detail: '準備済みの配信枠が見つかりません', checkedAt }
      const lifeCycle = String(broadcast.status.lifeCycleStatus ?? '')
      if (lifeCycle === 'live') {
        let viewerCount: number | null = null
        let viewerCountState: 'available' | 'hidden' | 'unavailable' = 'unavailable'
        let viewerCountDetail: string | undefined
        try {
          const videoUrl = new URL('https://www.googleapis.com/youtube/v3/videos')
          videoUrl.search = new URLSearchParams({ part: 'liveStreamingDetails,status', id: broadcast.id }).toString()
          const video = await apiJson<{ items: Array<{ liveStreamingDetails?: { concurrentViewers?: string }; status?: { publicStatsViewable?: boolean } }> }>(videoUrl.toString(), { headers })
          const item = video.items[0]
          const parsed = parseViewerCount(item?.liveStreamingDetails?.concurrentViewers)
          if (parsed !== null) {
            viewerCount = parsed
            viewerCountState = 'available'
          } else if (item?.liveStreamingDetails && item.status?.publicStatsViewable === false) {
            viewerCountState = 'hidden'
          } else if (item?.liveStreamingDetails) {
            const publicCount = await this.youtubePublicViewerCount(broadcast.id).catch(() => null)
            if (publicCount !== null) {
              viewerCount = publicCount
              viewerCountState = 'available'
              viewerCountDetail = 'YouTube公開ページのライブ人数から取得しました'
            } else {
              viewerCountDetail = 'YouTubeがライブ視聴者数を返していません。0人とは断定せず30秒以内に再取得します'
            }
          } else {
            viewerCountDetail = 'YouTubeがライブ視聴統計をまだ返していません。30秒ごとに再取得します'
          }
        } catch (error) {
          // `liveBroadcasts.list` can still succeed immediately before
          // `videos.list` reaches the daily quota. The public watch page does
          // not consume Data API quota, so use it here as well instead of
          // leaving the viewer counter unavailable for the whole broadcast.
          const publicCount = await this.youtubePublicViewerCount(broadcast.id).catch(() => null)
          this.deferYouTubeApiAfterLimit(error)
          if (publicCount !== null) {
            viewerCount = publicCount
            viewerCountState = 'available'
            viewerCountDetail = isYouTubeApiLimitError(error)
              ? 'YouTube API上限中のため、公開ページのライブ人数から取得しました'
              : 'YouTube APIの人数取得に失敗したため、公開ページのライブ人数から取得しました'
          } else {
            viewerCountDetail = 'YouTube視聴者数の取得に失敗しました。30秒ごとに再取得します'
          }
        }
        return { state: 'live', detail: 'YouTubeで公開配信中', checkedAt, viewerCount, viewerCountState, viewerCountDetail }
      }
      if (lifeCycle === 'liveStarting') return { state: 'starting', detail: 'YouTubeで公開開始処理中', checkedAt }
      if (lifeCycle === 'testing' || lifeCycle === 'testStarting') return { state: 'starting', detail: 'YouTubeテスト配信中（視聴者には未公開）', checkedAt }
      if (lifeCycle === 'ready') return { state: 'ready', detail: 'YouTube公開開始待ち', checkedAt }
      if (lifeCycle === 'created') return { state: 'unprepared', detail: 'YouTube配信枠を準備中', checkedAt }
      if (lifeCycle === 'complete') return { state: 'offline', detail: 'YouTube配信は終了済み', checkedAt }
      return { state: 'error', detail: `YouTube状態を判定できません（${lifeCycle || 'unknown'}）`, checkedAt }
    } catch (error) {
      if (isYouTubeApiLimitError(error)) {
        this.deferYouTubeApiAfterLimit(error)
        return this.youtubeStatusDuringApiLimit(config, checkedAt)
      }
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
      const result = await apiJson<{ data: Array<{ id: string; type: string; viewer_count?: number }> }>(url, {
        headers: { authorization: `Bearer ${token}`, 'client-id': config.twitch.clientId },
      })
      const live = result.data.find((stream) => stream.type === 'live')
      if (!live) return { state: 'offline', detail: 'Twitchはオフライン', checkedAt }
      const viewerCount = parseViewerCount(live.viewer_count)
      return { state: 'live', detail: 'Twitchで公開配信中', checkedAt, viewerCount, viewerCountState: viewerCount === null ? 'unavailable' : 'available' }
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
      const realtime = [youtube.state, twitch.state].some((state) => ['starting', 'live', 'stopping'].includes(state))
      this.platformStatusCache = { key, value, expiresAt: Date.now() + (realtime ? 30_000 : 60_000) }
      this.recordLiveStatusDiagnostics(value)
      return value
    })
    this.platformStatusRefresh = { key, promise }
    try { return await promise } finally {
      if (this.platformStatusRefresh?.promise === promise) this.platformStatusRefresh = null
    }
  }

  private async youtubeAccessToken(config: AppConfig): Promise<string> {
    const refreshToken = this.secrets.get('youtube-refresh-token')
    const clientSecret = this.secrets.get('youtube-client-secret')
    if (!config.youtube.clientId || !refreshToken || !clientSecret) throw new Error('YouTube OAuth が未設定です。アプリを最新版へ更新し、再接続してください')
    const credentialKey = crypto.createHash('sha256').update(`${config.youtube.clientId}\0${refreshToken}\0${clientSecret}`).digest('hex')
    if (this.youtubeToken?.credentialKey === credentialKey && this.youtubeToken.expiresAt > Date.now() + 60_000) return this.youtubeToken.value
    if (this.youtubeTokenRefresh?.credentialKey === credentialKey) return this.youtubeTokenRefresh.promise
    const promise = (async () => {
      const refreshStartedAt = Date.now()
      const body = new URLSearchParams({ client_id: config.youtube.clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' })
      const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body })
      const raw = await response.text()
      let token: { access_token?: string; expires_in?: number; error?: string; error_description?: string } = {}
      try { token = JSON.parse(raw) as typeof token } catch { /* retain the HTTP response below */ }
      if (!response.ok || !token.access_token) {
        if ([400, 401].includes(response.status) && ['invalid_client', 'invalid_grant', 'invalid_request'].includes(token.error ?? '')) {
          this.secrets.set('youtube-oauth-health', 'reconnect_required')
        }
        throw new Error(`${response.status} ${raw || response.statusText}`)
      }
      this.secrets.set('youtube-oauth-health', '')
      this.youtubeToken = { value: token.access_token, expiresAt: refreshStartedAt + (token.expires_in ?? 3600) * 1000, credentialKey }
      return token.access_token
    })()
    this.youtubeTokenRefresh = { credentialKey, promise }
    try { return await promise } finally {
      if (this.youtubeTokenRefresh?.promise === promise) this.youtubeTokenRefresh = null
    }
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
        // Retrying quota/auth/input failures only spends more quota and repeats a
        // deterministic failure. Retry once only for transient throttling/server errors.
        if (response.status !== 429 && response.status < 500) break
        if (attempt === 0) await wait(response.status === 429 ? 1_500 : 250)
      }
      throw new Error(lastError)
    } catch (error) {
      this.deferYouTubeApiAfterLimit(error)
      return { status: 'failed', message: `サムネイル適用に失敗しました。YouTube の前回画像を維持します: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  private async prepareYouTube(config: AppConfig, profile: GameProfile, preparedAt: Date): Promise<ThumbnailPreparation> {
    if (!config.features.youtube || !profile.youtube.enabled) return { status: 'disabled', message: 'YouTube またはサムネイル自動適用が無効です' }
    const cooldownRemaining = this.youtubeApiCooldownRemaining()
    if (cooldownRemaining > 0) throw new YouTubeApiCooldownError(cooldownRemaining)
    const renderedTitle = renderTitleTemplate(profile.youtube.titleTemplate, { game: profile.displayName, part: profile.state.nextPartNumber, now: preparedAt })
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
        body: JSON.stringify({ snippet: { title: renderedTitle, description: profile.youtube.description, scheduledStartTime: new Date(Date.now() + 60_000).toISOString() }, status: { privacyStatus: profile.youtube.privacy, selfDeclaredMadeForKids: false }, contentDetails: { enableAutoStart: true, enableAutoStop: true, monitorStream: { enableMonitorStream: false, broadcastStreamDelayMs: 0 }, latencyPreference: 'low' } }),
      })
      const latest = await this.store.getConfig()
      await this.store.saveConfig({ ...latest, youtube: { ...latest.youtube, broadcastId: broadcast.id } })
    } else {
      const update = new URL('https://www.googleapis.com/youtube/v3/liveBroadcasts')
      update.search = new URLSearchParams({ part: 'snippet,status' }).toString()
      const updateBody: Record<string, unknown> = {
        id: broadcast.id,
        snippet: { title: renderedTitle, description: profile.youtube.description, scheduledStartTime: broadcast.snippet.scheduledStartTime },
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
    await apiJson(videoUrl.toString(), { method: 'PUT', headers, body: JSON.stringify({ id: broadcast.id, snippet: { title: renderedTitle, description: profile.youtube.description, categoryId: profile.youtube.categoryId } }) })
    const lifeCycle = String(broadcast.status.lifeCycleStatus ?? '')
    const streamId = typeof broadcast.contentDetails.boundStreamId === 'string' ? broadcast.contentDetails.boundStreamId : ''
    let stream: YouTubeStream | undefined
    const loadStream = async (id: string): Promise<YouTubeStream | undefined> => {
      const streamsUrl = new URL('https://www.googleapis.com/youtube/v3/liveStreams')
      streamsUrl.search = new URLSearchParams({ part: 'id,cdn,status', id }).toString()
      const streams = await apiJson<{ items: YouTubeStream[] }>(streamsUrl.toString(), { headers })
      return streams.items[0]
    }
    const createManagedStream = async (): Promise<YouTubeStream> => {
      const streamsUrl = new URL('https://www.googleapis.com/youtube/v3/liveStreams')
      streamsUrl.search = new URLSearchParams({ part: 'id,snippet,cdn,status,contentDetails', mine: 'true', maxResults: '50' }).toString()
      const streams = await apiJson<{ items: YouTubeStream[] }>(streamsUrl.toString(), { headers })
      const reusable = streams.items.find((candidate) => isManagedYouTubeStream(candidate)
        && candidate.snippet?.title === youtubeManagedStreamTitle
        && candidate.contentDetails?.isReusable === true
        && candidate.status?.streamStatus !== 'active')
      if (reusable) return reusable

      const createStreamUrl = new URL('https://www.googleapis.com/youtube/v3/liveStreams')
      createStreamUrl.search = new URLSearchParams({ part: 'id,snippet,cdn,contentDetails' }).toString()
      return apiJson<YouTubeStream>(createStreamUrl.toString(), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          snippet: { title: youtubeManagedStreamTitle },
          cdn: { ingestionType: 'rtmp', resolution: youtubeManagedResolution, frameRate: youtubeManagedFrameRate },
          contentDetails: { isReusable: true },
        }),
      })
    }
    const bindStream = async (next: YouTubeStream): Promise<void> => {
      const bindUrl = new URL('https://www.googleapis.com/youtube/v3/liveBroadcasts/bind')
      bindUrl.search = new URLSearchParams({ id: broadcast.id, streamId: next.id, part: 'id,contentDetails' }).toString()
      await apiJson(bindUrl.toString(), { method: 'POST', headers })
      stream = next
    }

    if (streamId) stream = await loadStream(streamId)
    if (!isManagedYouTubeStream(stream)) {
      if (!['created', 'ready'].includes(lifeCycle) || stream?.status?.streamStatus === 'active') {
        const actual = `${stream?.cdn?.resolution ?? 'unknown'}/${stream?.cdn?.frameRate ?? 'unknown'}`
        throw new Error(`YouTube配信枠が${actual}です。配信中の枠は変更しません。配信終了後、現在のゲーム設定のまま次回の配信開始時に1080p60枠へ更新します`)
      }
      await bindStream(await createManagedStream())
    }
    const streamKey = stream?.cdn?.ingestionInfo?.streamName
    if (!streamKey) throw new Error('YouTube 配信キーを取得できませんでした。YouTube Studio のストリーム設定を確認してください')
    const streamServer = stream?.cdn?.ingestionInfo?.rtmpsIngestionAddress
    if (!streamServer) throw new Error('YouTubeの暗号化されたRTMPS配信サーバーを取得できませんでした。YouTube Studioのストリーム設定を確認してください')
    this.secrets.set('youtube-stream-key', streamKey)
    this.secrets.set('youtube-stream-server', streamServer)
    return this.applyYouTubeThumbnail(accessToken, broadcast.id, profile)
  }

  private async prepareTwitch(config: AppConfig, profile: GameProfile, preparedAt: Date): Promise<void> {
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
      method: 'PATCH', headers, body: JSON.stringify({ title: renderTitleTemplate(profile.twitch.titleTemplate, { game: profile.displayName, part: profile.state.nextPartNumber, now: preparedAt }), game_id: gameId, tags: profile.twitch.tags.slice(0, 10) }),
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
        if (!response.ok || !token.access_token) {
          if (response.status === 400 || response.status === 401) this.secrets.set('twitch-oauth-health', 'reconnect_required')
          throw new Error(token.message ?? 'Twitch token refresh failed')
        }
        const nextRefreshToken = token.refresh_token ?? refreshToken
        this.secrets.set('twitch-access-token', token.access_token)
        if (token.refresh_token) this.secrets.set('twitch-refresh-token', token.refresh_token)
        this.secrets.set('twitch-oauth-health', '')
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
    const preparedAt = new Date()
    const results = await Promise.all(([
      ['youtube', () => this.prepareYouTube(config, profile, preparedAt)],
      ['twitch', () => this.prepareTwitch(config, profile, preparedAt)],
    ] as const).map(async ([service, operation]) => {
      try {
        const result = await operation()
        return { service, ok: true, message: '適用済み', ...(service === 'youtube' ? { thumbnail: result as ThumbnailPreparation } : {}) }
      } catch (error) {
        if (service === 'youtube' && (isYouTubeApiLimitError(error) || isYouTubeApiCooldownError(error))) {
          if (isYouTubeApiLimitError(error)) this.deferYouTubeApiAfterLimit(error)
          const dailyLimit = isYouTubeApiLimitError(error)
            ? isDailyYouTubeQuotaError(error)
            : this.youtubeApiLimitPersisted
          if (dailyLimit) {
            return { service, ok: false, message: 'YouTube APIの本日利用上限に達しています。OBS・録画・Twitchの設定は適用済みです。現在のゲーム設定は保持され、上限リセット後の配信開始時にYouTube設定を更新します' }
          }
          const retryAfterMs = isYouTubeApiCooldownError(error) ? error.retryAfterMs : youtubeApiLimitBackoffMs(error)
          const retryMinutes = Math.max(1, Math.ceil(retryAfterMs / 60_000))
          return { service, ok: false, message: `YouTube APIの一時的なリクエスト制限中です。OBS・録画・Twitchの設定は適用済みです。現在のゲーム設定は保持され、約${retryMinutes}分後の配信開始時にYouTube設定を更新します` }
        }
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
    throw new Error('YouTubeの配信枠が見つかりません。現在のゲーム設定は保持されます。配信開始をもう一度実行して自動再準備してください')
  }

  private async getYouTubeStream(accessToken: string, streamId: string): Promise<YouTubeStream> {
    const url = new URL('https://www.googleapis.com/youtube/v3/liveStreams')
    url.search = new URLSearchParams({ part: 'id,status', id: streamId }).toString()
    const result = await apiJson<{ items: YouTubeStream[] }>(url.toString(), { headers: { authorization: `Bearer ${accessToken}` } })
    const stream = result.items[0]
    if (!stream) throw new Error('YouTubeの配信ストリームが見つかりません。現在のゲーム設定は保持されます。配信開始をもう一度実行して自動再準備してください')
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
    const cooldownRemaining = this.youtubeApiCooldownRemaining()
    if (cooldownRemaining > 0) {
      if (this.youtubeApiLimitPersisted) {
        throw new Error('YouTube APIの本日利用上限中です。OBSへ触れず、上限リセット後に開始してください')
      }
      const retryMinutes = Math.max(1, Math.ceil(cooldownRemaining / 60_000))
      throw new Error(`YouTube APIの一時的なリクエスト制限中です。OBSへ触れず、約${retryMinutes}分後に開始してください`)
    }
    const broadcastId = config.youtube.broadcastId
    if (!broadcastId) throw new Error('YouTubeの配信枠が未設定です。現在のゲーム設定は保持されます。配信開始をもう一度実行して自動再準備してください')
    if (this.youtubeLocallyStopped?.broadcastId === broadcastId) this.youtubeLocallyStopped = null
    try {
      const accessToken = await this.youtubeAccessToken(config)
      let broadcast = await this.getYouTubeBroadcast(accessToken, broadcastId)
      let lifeCycleStatus = String(broadcast.status.lifeCycleStatus ?? '')
      if (lifeCycleStatus === 'live') {
        if (this.youtubePendingCompletionId === broadcastId) this.setPendingYouTubeCompletion(null)
        return
      }
      if (lifeCycleStatus === 'complete') throw new Error('YouTubeの配信枠は既に終了しています。現在のゲーム設定は保持されます。配信開始をもう一度実行して新しい配信枠を自動準備してください')
      const streamId = typeof broadcast.contentDetails.boundStreamId === 'string' ? broadcast.contentDetails.boundStreamId : ''
      if (!streamId) throw new Error('YouTubeの配信枠にストリームが接続されていません。現在のゲーム設定は保持されます。配信開始をもう一度実行して自動再準備してください')

      await this.waitForYouTubeState(
        () => this.getYouTubeStream(accessToken, streamId),
        (stream) => stream.status?.streamStatus === 'active',
        this.youtubeLifecyclePolling.streamActiveTimeoutMs,
        (stream) => `YouTubeがOBSの映像を受信できませんでした（streamStatus: ${stream.status?.streamStatus ?? 'unknown'}）`,
      )

      broadcast = await this.getYouTubeBroadcast(accessToken, broadcastId)
      lifeCycleStatus = String(broadcast.status.lifeCycleStatus ?? '')
      if (broadcast.contentDetails.enableAutoStart === true) {
        if (lifeCycleStatus === 'complete') throw new Error('YouTubeの配信枠は既に終了しています。現在のゲーム設定は保持されます。配信開始をもう一度実行して新しい配信枠を自動準備してください')
        if (lifeCycleStatus === 'revoked') throw new Error('YouTubeの配信枠が取り消されています。現在のゲーム設定は保持されます。配信開始をもう一度実行して新しい配信枠を自動準備してください')
        if (!['created', 'ready', 'testStarting', 'testing', 'liveStarting', 'live'].includes(lifeCycleStatus)) {
          throw new Error(`YouTubeの自動配信開始を待機できない状態です（lifeCycleStatus: ${lifeCycleStatus || 'unknown'}）`)
        }
        if (this.youtubePendingCompletionId === broadcastId) this.setPendingYouTubeCompletion(null)
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
      if (lifeCycleStatus === 'complete') throw new Error('YouTubeの配信枠は既に終了しています。現在のゲーム設定は保持されます。配信開始をもう一度実行して新しい配信枠を自動準備してください')
      if (lifeCycleStatus !== 'live' && lifeCycleStatus !== 'liveStarting') {
        await this.transitionYouTubeBroadcast(accessToken, broadcastId, 'live')
      }
      await this.waitForYouTubeState(
        () => this.getYouTubeBroadcast(accessToken, broadcastId),
        (current) => current.status.lifeCycleStatus === 'live',
        this.youtubeLifecyclePolling.transitionTimeoutMs,
        (current) => `YouTube配信を開始状態にできませんでした（lifeCycleStatus: ${String(current.status.lifeCycleStatus ?? 'unknown')}）`,
      )
      if (this.youtubePendingCompletionId === broadcastId) this.setPendingYouTubeCompletion(null)
      this.invalidateLiveStatus()
    } catch (error) {
      if (!isYouTubeApiLimitError(error)) throw error
      const dailyLimit = isDailyYouTubeQuotaError(error)
      const retryMinutes = Math.max(1, Math.ceil(youtubeApiLimitBackoffMs(error) / 60_000))
      this.deferYouTubeApiAfterLimit(error)
      throw new Error(dailyLimit
        ? 'YouTube APIの本日利用上限に達したため公開開始を確認できません。OBS出力は安全にロールバックします'
        : `YouTube APIの一時的なリクエスト制限により公開開始を確認できません。OBS出力は安全にロールバックします。約${retryMinutes}分後に再試行してください`)
    }
  }

  async completeYouTubeBroadcast(config: AppConfig, profile: GameProfile | null): Promise<void> {
    // `profile === null` is intentional for a manual OBS stop after an app restart.
    // Only a genuinely live lifecycle is completed below; stale ready/created IDs remain untouched.
    if (!config.features.youtube || profile?.youtube.enabled === false || !config.youtube.broadcastId) return
    const broadcastId = config.youtube.broadcastId
    // OBS has already been confirmed stopped by every caller. Reflect that
    // immediately instead of showing the cached/public YouTube "live" state
    // for another 30-60 seconds and inviting duplicate Stop operations.
    this.youtubeLocallyStopped = { broadcastId, expiresAt: Date.now() + 60_000 }
    this.invalidateLiveStatus()
    const clearPendingCompletion = () => {
      if (this.youtubePendingCompletionId === broadcastId) this.setPendingYouTubeCompletion(null)
    }
    if (this.youtubeApiCooldownRemaining() > 0) {
      this.setPendingYouTubeCompletion(broadcastId)
      this.invalidateLiveStatus()
      return
    }
    try {
      const accessToken = await this.youtubeAccessToken(config)
      let broadcast = await this.getYouTubeBroadcast(accessToken, broadcastId)
      let lifeCycleStatus = String(broadcast.status.lifeCycleStatus ?? '')
      if (lifeCycleStatus === 'complete' || lifeCycleStatus === 'ready' || lifeCycleStatus === 'created') {
        clearPendingCompletion()
        return
      }
      if (broadcast.contentDetails.enableAutoStop === true) {
        clearPendingCompletion()
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
      if (lifeCycleStatus === 'complete' || lifeCycleStatus === 'ready' || lifeCycleStatus === 'testing') {
        clearPendingCompletion()
        return
      }
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
    } catch (error) {
      if (!isYouTubeApiLimitError(error)) {
        this.setPendingYouTubeCompletion(broadcastId)
        this.invalidateLiveStatus()
        throw error
      }
      this.deferYouTubeApiAfterLimit(error)
      this.setPendingYouTubeCompletion(broadcastId)
      // OBS has already stopped before this method is called. Managed YouTube
      // broadcasts are created with enableAutoStop, so a quota error only means
      // the API lifecycle cannot be queried/transitioned. The public status
      // fallback will confirm the eventual end without turning a successful OBS
      // stop into a raw 403 failure.
      this.invalidateLiveStatus()
      return
    }
    clearPendingCompletion()
    this.invalidateLiveStatus()
  }

  async retryPendingYouTubeCompletion(config: AppConfig): Promise<boolean> {
    void config
    const pendingId = this.youtubePendingCompletionId
    if (!pendingId) return false
    if (this.youtubeApiCooldownRemaining() > 0) return false
    if (this.youtubePendingCompletionRetry?.broadcastId === pendingId) return this.youtubePendingCompletionRetry.promise
    const promise = (async () => {
      // A persisted completion marker proves that OBS stopped once, but the same
      // not-yet-completed broadcast can receive a new OBS session after an app
      // restart. Never turn a transient websocket disconnect into an irreversible
      // public-stream termination. Retry only after the public watch page itself
      // positively confirms that the live session has ended.
      const publicPage = await this.youtubePublicLivePage(pendingId)
      if (!publicPage?.ended) return false
      // The public watch page is the authoritative, credential-free proof that
      // this live session has ended. Do not refresh OAuth or call the completion
      // API from an idle status poll: an expired grant must not surface as a
      // stream-stop failure when the user has not attempted a new broadcast.
      this.setPendingYouTubeCompletion(null)
      this.youtubeLocallyStopped = { broadcastId: pendingId, expiresAt: Date.now() + 60_000 }
      this.invalidateLiveStatus()
      return true
    })()
    this.youtubePendingCompletionRetry = { broadcastId: pendingId, promise }
    try {
      return await promise
    } finally {
      if (this.youtubePendingCompletionRetry?.promise === promise) this.youtubePendingCompletionRetry = null
    }
  }

  async steamInstalledGames(config: AppConfig): Promise<SteamLibraryScan> {
    return scanSteamLibraries(config.steam.installPath)
  }

  async steamAccountLibrary(config: AppConfig, knownGames: SteamOwnedGame[]): Promise<SteamAccountLibraryScan> {
    return scanSteamAccountLibrary(config.steam.installPath, { knownGames, storeLanguage: config.ui.language === 'en' ? 'english' : 'japanese' })
  }

  private addComment(message: ChatMessage): void {
    const isNew = !this.comments.has(message.id)
    this.comments.set(message.id, message)
    while (this.comments.size > 200) this.comments.delete(this.comments.keys().next().value as string)
    if (isNew && this.diagnostics.active) {
      const diagnostics = this.diagnostics.comments[message.service]
      diagnostics.received += 1
      diagnostics.lastReceivedAt = message.publishedAt
      this.persistDiagnostics()
    }
  }

  getComments(): ChatMessage[] {
    return [...this.comments.values()].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt))
  }

  private async pollYouTubeComments(config: AppConfig, generation: number): Promise<number> {
    if (!config.features.youtube || !config.youtube.clientId || !config.youtube.refreshTokenStored) return 5000
    if (this.diagnostics.active && this.commentsGeneration === generation) {
      this.diagnostics.comments.youtube.pollAttempts += 1
      this.persistDiagnostics()
    }
    const cooldownRemaining = this.youtubeApiCooldownRemaining()
    if (cooldownRemaining > 0) throw new YouTubeApiCooldownError(cooldownRemaining)
    const token = await this.youtubeAccessToken(config)
    if (this.commentsGeneration !== generation) return 5000
    const headers = { authorization: `Bearer ${token}` }
    if (!this.youtubeChatId) {
      const broadcastsUrl = new URL('https://www.googleapis.com/youtube/v3/liveBroadcasts')
      broadcastsUrl.search = new URLSearchParams({ part: 'snippet', broadcastStatus: 'active', maxResults: '1' }).toString()
      const broadcasts = await apiJson<{ items: Array<{ snippet: { liveChatId?: string } }> }>(broadcastsUrl.toString(), { headers })
      if (this.commentsGeneration !== generation) return 5000
      this.youtubeChatId = broadcasts.items[0]?.snippet.liveChatId ?? null
      this.youtubePageToken = undefined
    }
    const liveChatId = this.youtubeChatId
    if (!liveChatId) {
      this.recordCommentSuccess('youtube')
      return 60_000
    }
    const messagesUrl = new URL('https://www.googleapis.com/youtube/v3/liveChat/messages')
    messagesUrl.search = new URLSearchParams({ part: 'id,snippet,authorDetails', liveChatId, maxResults: '200', ...(this.youtubePageToken ? { pageToken: this.youtubePageToken } : {}) }).toString()
    const messages = await apiJson<{ nextPageToken?: string; pollingIntervalMillis?: number; items: Array<{ id: string; snippet: { displayMessage: string; publishedAt: string }; authorDetails: { displayName: string; isChatModerator?: boolean } }> }>(messagesUrl.toString(), { headers })
    if (this.commentsGeneration !== generation) return 5000
    this.youtubePageToken = messages.nextPageToken
    for (const item of messages.items) this.addComment({ id: `youtube:${item.id}`, service: 'youtube', author: item.authorDetails.displayName, body: item.snippet.displayMessage, publishedAt: item.snippet.publishedAt, moderator: Boolean(item.authorDetails.isChatModerator), mention: item.snippet.displayMessage.includes('@') })
    this.recordCommentSuccess('youtube')
    // The API recommends streamList to reduce polling and avoid quota
    // exhaustion. Until the Node runtime has a supported streaming transport,
    // keep this fallback well above the server's minimum and never repeat
    // liveBroadcasts.list after the chat id is known.
    return Math.max(messages.pollingIntervalMillis ?? 20_000, 20_000)
  }

  private scheduleTwitchReconnect(config: AppConfig, generation: number): void {
    if (this.commentsGeneration !== generation) return
    if (this.twitchReconnectTimer) clearTimeout(this.twitchReconnectTimer)
    const delay = Math.min(60_000, 3_000 * (2 ** Math.min(this.twitchReconnectFailures, 5)))
    this.twitchReconnectFailures += 1
    this.twitchReconnectTimer = setTimeout(() => {
      this.twitchReconnectTimer = null
      void this.connectTwitchComments(config, generation).catch((error) => {
        this.recordCommentFailure('twitch', error)
        this.scheduleTwitchReconnect(config, generation)
      })
    }, delay)
  }

  private async connectTwitchComments(config: AppConfig, generation: number): Promise<void> {
    if (!config.features.twitch || !config.twitch.clientId || this.twitchSocket) return
    if (this.diagnostics.active && this.commentsGeneration === generation) {
      this.diagnostics.comments.twitch.pollAttempts += 1
      this.persistDiagnostics()
    }
    const token = await this.twitchAccessToken(config)
    if (this.commentsGeneration !== generation) return
    const users = await apiJson<{ data: Array<{ login: string }> }>('https://api.twitch.tv/helix/users', { headers: { authorization: `Bearer ${token}`, 'client-id': config.twitch.clientId } })
    if (this.commentsGeneration !== generation) return
    const login = users.data[0]?.login
    if (!login) return
    const socket = new WebSocket('wss://irc-ws.chat.twitch.tv:443')
    this.twitchSocket = socket
    socket.addEventListener('open', () => {
      socket.send(`CAP REQ :twitch.tv/tags twitch.tv/commands\r\nPASS oauth:${token}\r\nNICK ${login}\r\nJOIN #${login}\r\n`)
    })
    socket.addEventListener('message', (event) => {
      if (this.commentsGeneration !== generation || this.twitchSocket !== socket) return
      const payload = String(event.data)
      if (payload.startsWith('PING')) { socket.send(payload.replace('PING', 'PONG')); return }
      for (const line of payload.split('\r\n')) {
        if (/\s(?:001|GLOBALUSERSTATE)\s/.test(line)) {
          this.twitchReconnectFailures = 0
          if (!this.diagnostics.comments.twitch.connected) this.recordCommentSuccess('twitch')
          this.diagnostics.comments.twitch.connected = true
          this.persistDiagnostics()
        }
        const match = line.match(/^@([^ ]+) :[^!]+![^ ]+ PRIVMSG #[^ ]+ :(.+)$/)
        if (!match) continue
        const tags = Object.fromEntries(match[1].split(';').map((tag) => { const [key, ...value] = tag.split('='); return [key, value.join('=')] }))
        const body = match[2]
        this.addComment({ id: `twitch:${tags.id ?? crypto.randomUUID()}`, service: 'twitch', author: (tags['display-name'] || 'Twitch user').replaceAll('\\s', ' '), body, publishedAt: new Date().toISOString(), moderator: tags.mod === '1', mention: body.toLowerCase().includes(`@${login.toLowerCase()}`) })
      }
    })
    socket.addEventListener('close', () => {
      if (this.twitchSocket === socket) this.twitchSocket = null
      if (this.commentsGeneration !== generation) return
      this.diagnostics.comments.twitch.connected = false
      this.diagnostics.comments.twitch.reconnects += 1
      this.recordCommentFailure('twitch', new Error('socket closed'))
      this.scheduleTwitchReconnect(config, generation)
    })
  }

  async startComments(config: AppConfig): Promise<void> {
    await this.stopComments()
    this.comments.clear()
    this.archiveCurrentDiagnostics()
    this.diagnostics = createPlatformSessionDiagnostics()
    this.diagnostics.active = true
    this.diagnostics.startedAt = new Date().toISOString()
    this.persistDiagnostics()
    const generation = ++this.commentsGeneration
    await this.connectTwitchComments(config, generation).catch((error) => {
      this.recordCommentFailure('twitch', error)
      this.scheduleTwitchReconnect(config, generation)
    })
    const poll = async () => {
      let delay: number
      try {
        delay = await this.pollYouTubeComments(config, generation)
        this.youtubeCommentFailures = 0
      } catch (error) {
        this.youtubeCommentFailures += 1
        this.recordCommentFailure('youtube', error)
        if (isYouTubeApiLimitError(error)) this.deferYouTubeApiAfterLimit(error)
        delay = youtubeCommentRetryDelay(error, this.youtubeCommentFailures)
        if (!isYouTubeApiLimitError(error) && !isYouTubeApiCooldownError(error)) {
          this.youtubeChatId = null
          this.youtubePageToken = undefined
        }
      }
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
    this.youtubeCommentFailures = 0
    this.twitchReconnectFailures = 0
    this.twitchSocket?.close()
    this.twitchSocket = null
    if (this.diagnostics.active) {
      this.diagnostics.active = false
      this.diagnostics.endedAt = new Date().toISOString()
      this.diagnostics.comments.twitch.connected = false
      this.persistDiagnostics()
    }
    await this.flushDiagnosticsPersistence()
  }
}
