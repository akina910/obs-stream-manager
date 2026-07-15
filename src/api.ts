import type { AppConfig, CaptureMethod, ChatMessage, GameProfile, RuntimeStatus } from '../shared/contracts'

export type Bootstrap = { config: AppConfig; profiles: GameProfile[]; status: RuntimeStatus }
export type SteamSyncResult = { profiles: GameProfile[]; owned: number; installed: number; created: number; updated: number; libraries: string[]; warnings: string[]; skipped?: boolean }
export type OAuthProvider = 'youtube' | 'twitch'
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
export type OAuthStartResult =
  | { mode: 'redirect'; url: string }
  | { mode: 'device'; url: string; userCode: string; requestId: string; intervalMs: number; expiresAt: number }
export type TwitchIngestTestResult = { ok: true; durationMs: number; bytesSent: number; totalFrames: number; skippedFrames: number; congestion: number }

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } })
  const body = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
  return body as T
}

export const api = {
  bootstrap: () => request<Bootstrap>('/api/bootstrap'),
  status: () => request<RuntimeStatus>('/api/status'),
  comments: () => request<ChatMessage[]>('/api/comments'),
  oauthStatus: () => request<OAuthConnectionStatuses>('/api/oauth/status'),
  oauthStart: (provider: OAuthProvider, openerOrigin: string) => request<OAuthStartResult>(`/api/oauth/${provider}/start`, { method: 'POST', body: JSON.stringify({ openerOrigin }) }),
  oauthPollTwitch: (requestId: string) => request<{ status: 'pending' | 'complete' }>(`/api/oauth/twitch/device/${encodeURIComponent(requestId)}`),
  profiles: () => request<GameProfile[]>('/api/profiles'),
  saveProfile: (profile: GameProfile) => request<GameProfile>('/api/profiles', { method: 'POST', body: JSON.stringify(profile) }),
  deleteProfile: (id: string) => request<{ ok: true }>(`/api/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  uploadThumbnail: (id: string, mime: string, data: string, filename: string) => request<GameProfile>(`/api/profiles/${encodeURIComponent(id)}/thumbnail`, { method: 'POST', body: JSON.stringify({ mime, data, filename }) }),
  deleteThumbnail: (id: string) => request<GameProfile>(`/api/profiles/${encodeURIComponent(id)}/thumbnail`, { method: 'DELETE' }),
  select: (gameId: string, captureMethod?: CaptureMethod) => request<{ profile: GameProfile; captureMethod: CaptureMethod; warnings: string[]; services: Array<{ service: OAuthProvider; ok: boolean; message: string }> }>('/api/select', { method: 'POST', body: JSON.stringify({ gameId, captureMethod }) }),
  start: (allowServiceFailures = false) => request<{ ok: true; warnings: string[] }>('/api/stream/start', { method: 'POST', body: JSON.stringify({ allowServiceFailures }) }),
  stop: () => request<{ ok: true; warnings: string[] }>('/api/stream/stop', { method: 'POST', body: '{}' }),
  testTwitchOutput: () => request<TwitchIngestTestResult>('/api/twitch/output-test', { method: 'POST', body: '{}' }),
  replay: () => request<{ ok: true }>('/api/replay/save', { method: 'POST', body: '{}' }),
  scene: (sceneName: string) => request<{ ok: true }>('/api/scene', { method: 'POST', body: JSON.stringify({ sceneName }) }),
  selectFolder: (initialPath: string) => request<{ path: string | null }>('/api/folders/select', { method: 'POST', body: JSON.stringify({ initialPath }) }),
  steamScan: () => request<SteamSyncResult>('/api/steam/scan', { method: 'POST', body: '{}' }),
  steamSync: () => request<SteamSyncResult>('/api/steam/sync', { method: 'POST', body: '{}' }),
  saveConfig: (config: AppConfig, secrets: Record<string, string>) => request<AppConfig>('/api/config', { method: 'PUT', body: JSON.stringify({ config, secrets }) }),
  backup: () => request<unknown>('/api/backup/export', { method: 'POST', body: '{}' }),
  restore: (backup: unknown) => request<{ ok: true }>('/api/backup/import', { method: 'POST', body: JSON.stringify(backup) }),
}
