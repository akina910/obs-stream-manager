import type { AppConfig, CaptureMethod, ChatMessage, GameProfile, RuntimeStatus } from '../shared/contracts'

export type Bootstrap = { config: AppConfig; profiles: GameProfile[]; status: RuntimeStatus }
export type OAuthProvider = 'youtube' | 'twitch'
export type OAuthStartResult =
  | { mode: 'redirect'; url: string }
  | { mode: 'device'; url: string; userCode: string; requestId: string; intervalMs: number; expiresAt: number }

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
  oauthStart: (provider: OAuthProvider, openerOrigin: string) => request<OAuthStartResult>(`/api/oauth/${provider}/start`, { method: 'POST', body: JSON.stringify({ openerOrigin }) }),
  oauthPollTwitch: (requestId: string) => request<{ status: 'pending' | 'complete' }>(`/api/oauth/twitch/device/${encodeURIComponent(requestId)}`),
  profiles: () => request<GameProfile[]>('/api/profiles'),
  saveProfile: (profile: GameProfile) => request<GameProfile>('/api/profiles', { method: 'POST', body: JSON.stringify(profile) }),
  deleteProfile: (id: string) => request<{ ok: true }>(`/api/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  uploadThumbnail: (id: string, mime: string, data: string, filename: string) => request<GameProfile>(`/api/profiles/${encodeURIComponent(id)}/thumbnail`, { method: 'POST', body: JSON.stringify({ mime, data, filename }) }),
  deleteThumbnail: (id: string) => request<GameProfile>(`/api/profiles/${encodeURIComponent(id)}/thumbnail`, { method: 'DELETE' }),
  select: (gameId: string, captureMethod?: CaptureMethod) => request<{ profile: GameProfile; captureMethod: CaptureMethod; warnings: string[]; services: Array<{ service: string; ok: boolean; message: string }> }>('/api/select', { method: 'POST', body: JSON.stringify({ gameId, captureMethod }) }),
  start: (allowServiceFailures = false) => request<{ ok: true; warnings: string[] }>('/api/stream/start', { method: 'POST', body: JSON.stringify({ allowServiceFailures }) }),
  stop: () => request<{ ok: true; warnings: string[] }>('/api/stream/stop', { method: 'POST', body: '{}' }),
  replay: () => request<{ ok: true }>('/api/replay/save', { method: 'POST', body: '{}' }),
  scene: (sceneName: string) => request<{ ok: true }>('/api/scene', { method: 'POST', body: JSON.stringify({ sceneName }) }),
  steamSync: () => request<{ profiles: GameProfile[]; owned: number; installed: number; created: number; updated: number; warnings: string[] }>('/api/steam/sync', { method: 'POST', body: '{}' }),
  saveConfig: (config: AppConfig, secrets: Record<string, string>) => request<AppConfig>('/api/config', { method: 'PUT', body: JSON.stringify({ config, secrets }) }),
  backup: () => request<unknown>('/api/backup/export', { method: 'POST', body: '{}' }),
  restore: (backup: unknown) => request<{ ok: true }>('/api/backup/import', { method: 'POST', body: JSON.stringify(backup) }),
}
