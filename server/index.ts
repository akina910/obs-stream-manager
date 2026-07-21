import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import cors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import Fastify from 'fastify'
import { z, ZodError } from 'zod'
import { CommonTemplateSettingsSchema } from '../shared/common-template.js'
import { AppConfigSchema, CaptureMethodSchema, GameIdSchema, GameProfileSchema, ObsSceneNameSchema } from '../shared/contracts.js'
import { BgmLibraryStore, maxBgmTrackBytes } from './bgm-library.js'
import { CaptureDetector } from './capture.js'
import { CommonTemplateService } from './common-template.js'
import { selectFolder } from './folder-picker.js'
import { AppLogger } from './logger.js'
import { ObsController } from './obs.js'
import { OAuthManager } from './oauth.js'
import { youtubeOAuthCallbackHtml } from './oauth-callback.js'
import { StreamOrchestrator } from './orchestrator.js'
import { PlatformServices } from './platforms.js'
import { getDataDirectory } from './paths.js'
import { clearYouTubeStreamSecrets, provisionDistributorOAuth } from './provider-provisioning.js'
import { isUnsafeCrossOriginRequest } from './request-security.js'
import { reconcileImportedConfig } from './secret-flags.js'
import { SecretStore, type SecretName } from './secrets.js'
import { DataStore } from './storage.js'

const dataDir = getDataDirectory()
const store = new DataStore(dataDir)
await store.initialize()
const bgm = new BgmLibraryStore(dataDir)
await bgm.initialize()
const secrets = new SecretStore()
await provisionDistributorOAuth(store, secrets)
const logger = new AppLogger(dataDir)
const obs = new ObsController(secrets, 8_000, 45_000)
const platforms = new PlatformServices(secrets, store)
const commonTemplates = new CommonTemplateService(store)
const orchestrator = new StreamOrchestrator(store, obs, new CaptureDetector(), platforms, logger, commonTemplates)
await orchestrator.restoreSelection()
obs.onStreamStateChanged((active) => orchestrator.handleObsStreamStateChanged(active))
const listenPort = Number(process.env.PORT ?? 4317)
const callbackOrigin = `http://127.0.0.1:${listenPort}`
const allowedOAuthOpenerOrigins = new Set([
  callbackOrigin,
  `http://localhost:${listenPort}`,
  'http://127.0.0.1:4318',
  'http://localhost:4318',
])
const allowedMutationOrigins = new Set(allowedOAuthOpenerOrigins)
const oauth = new OAuthManager(store, secrets, callbackOrigin, allowedOAuthOpenerOrigins)

export const app = Fastify({ logger: { redact: ['req.headers.authorization', 'req.headers.cookie', 'body.secrets'] }, bodyLimit: 18 * 1024 * 1024 })
await app.register(cors, { origin: ['http://127.0.0.1:4318', 'http://localhost:4318'] })

app.addHook('onRequest', async (request, reply) => {
  const origin = typeof request.headers.origin === 'string' ? request.headers.origin : undefined
  const fetchSite = typeof request.headers['sec-fetch-site'] === 'string' ? request.headers['sec-fetch-site'] : undefined
  if (isUnsafeCrossOriginRequest(request.method, request.url, origin, fetchSite, allowedMutationOrigins)) {
    return reply.status(403).send({ error: 'Cross-origin request is not allowed' })
  }
})

app.addHook('onSend', async (request, reply, payload) => {
  reply.header('X-Content-Type-Options', 'nosniff')
  reply.header('Referrer-Policy', 'no-referrer')
  if (!request.url.startsWith('/api/')) {
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self'",
    )
  }
  return payload
})

app.setErrorHandler((error, _request, reply) => {
  const normalized = error instanceof Error ? error : new Error(String(error))
  const statusCode = 'statusCode' in normalized && typeof normalized.statusCode === 'number' ? normalized.statusCode : 500
  const status = error instanceof ZodError ? 400 : statusCode >= 400 ? statusCode : 500
  void logger.write('api.error', { message: normalized.message, status })
  return reply.status(status).send({ error: error instanceof ZodError ? '入力内容が正しくありません' : normalized.message, details: error instanceof ZodError ? error.issues : undefined })
})

app.get('/api/health', async () => ({ ok: true, dataDirectory: dataDir }))
app.get('/api/bootstrap', async () => ({ config: await store.getConfig(), profiles: await store.listProfiles(), status: await orchestrator.getStatus() }))
app.get('/api/status', async () => orchestrator.getStatus())
app.get('/api/comments', async () => platforms.getComments())
app.get('/api/bgm', async () => ({ ...(await bgm.getLibrary()), playback: await obs.bgmPlaybackStatus(await store.getConfig()) }))
app.post<{ Body: { filename?: string; data?: string } }>('/api/bgm', { bodyLimit: 70 * 1024 * 1024 }, async (request, reply) => {
  const filename = typeof request.body?.filename === 'string' ? request.body.filename : ''
  const encoded = typeof request.body?.data === 'string' ? request.body.data.replace(/\s/g, '') : ''
  if (!filename || !encoded) return reply.status(400).send({ error: 'BGMファイルがありません' })
  if (encoded.length > Math.ceil(maxBgmTrackBytes / 3) * 4 + 4) return reply.status(413).send({ error: 'BGMは50 MB以下にしてください' })
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return reply.status(400).send({ error: 'BGMファイルを読み込めませんでした' })
  const bytes = Buffer.from(encoded, 'base64')
  const library = await bgm.addTrack(filename, bytes)
  await logger.write('bgm.added', { filename: path.basename(filename), size: bytes.byteLength })
  return { ...library, playback: await obs.bgmPlaybackStatus(await store.getConfig()) }
})
app.post<{ Params: { id: string } }>('/api/bgm/:id/play', async (request) => {
  const track = await bgm.getTrack(request.params.id)
  if (!track) throw Object.assign(new Error('BGMが見つかりません'), { statusCode: 404 })
  const config = await store.getConfig()
  const runtime = await orchestrator.getStatus()
  const profile = runtime.selectedGameId ? await store.getProfile(runtime.selectedGameId) : null
  await obs.playBgm(config, bgm.trackPath(track), profile?.audio.bgmDb ?? -25)
  const library = await bgm.selectTrack(track.id)
  await logger.write('bgm.played', { trackId: track.id, filename: track.originalName })
  return { ...library, playback: await obs.bgmPlaybackStatus(config) }
})
app.post<{ Body: { action?: string } }>('/api/bgm/control', async (request) => {
  const action = z.enum(['play', 'pause', 'stop', 'restart']).parse(request.body?.action)
  const config = await store.getConfig()
  const library = await bgm.getLibrary()
  if (action === 'play' || action === 'restart') {
    const track = library.tracks.find((item) => item.id === library.selectedTrackId)
    if (!track) throw Object.assign(new Error('再生するBGMを選択してください'), { statusCode: 409 })
    const runtime = await orchestrator.getStatus()
    const profile = runtime.selectedGameId ? await store.getProfile(runtime.selectedGameId) : null
    await obs.playBgm(config, bgm.trackPath(track), profile?.audio.bgmDb ?? -25, action === 'restart')
  } else {
    await obs.controlBgm(config, action)
  }
  return { ...library, playback: await obs.bgmPlaybackStatus(config) }
})
app.delete<{ Params: { id: string } }>('/api/bgm/:id', async (request) => {
  const config = await store.getConfig()
  const library = await bgm.getLibrary()
  if (library.selectedTrackId === request.params.id) await obs.clearBgm(config).catch(() => undefined)
  const removed = await bgm.removeTrack(request.params.id)
  await logger.write('bgm.removed', { trackId: removed.removed.id, filename: removed.removed.originalName })
  return { ...removed.library, playback: await obs.bgmPlaybackStatus(config) }
})
app.get('/api/templates/common', async () => (await store.getConfig()).commonTemplate)
app.put<{ Body: unknown }>('/api/templates/common', async (request) => {
  await orchestrator.assertNotStreaming()
  const current = await store.getConfig()
  const settings = CommonTemplateSettingsSchema.parse(request.body)
  if (settings.enabled && !current.commonTemplate.imageFilename) throw Object.assign(new Error('有効化する前に共通テンプレート画像を登録してください'), { statusCode: 400 })
  const saved = await store.saveConfig({
    ...current,
    commonTemplate: {
      ...settings,
      imageFilename: current.commonTemplate.imageFilename,
      imageOriginalName: current.commonTemplate.imageOriginalName,
      imageUpdatedAt: current.commonTemplate.imageUpdatedAt,
    },
  })
  if (saved.commonTemplate.enabled) await commonTemplates.renderAll()
  else if (current.commonTemplate.enabled) await obs.clearCommonTemplate(saved, current.commonTemplate.obsSourceName).catch(() => undefined)
  return saved.commonTemplate
})
app.get('/api/templates/common/image', async (_request, reply) => {
  const image = await commonTemplates.readBackground()
  if (!image) return reply.status(404).send({ error: '共通テンプレート画像が登録されていません' })
  reply.header('cache-control', 'no-store')
  reply.type(image.mime)
  return reply.send(image.bytes)
})
app.post<{ Body: { mime: string; data: string; filename?: string } }>('/api/templates/common/image', async (request) => {
  await orchestrator.assertNotStreaming()
  const template = await store.saveCommonTemplateImage(Buffer.from(request.body.data, 'base64'), request.body.mime, request.body.filename)
  if (template.enabled) await commonTemplates.renderAll()
  return template
})
app.delete('/api/templates/common/image', async () => {
  await orchestrator.assertNotStreaming()
  const current = await store.getConfig()
  const removed = await store.removeCommonTemplateImage()
  if (current.commonTemplate.enabled) await obs.clearCommonTemplate(current, current.commonTemplate.obsSourceName).catch(() => undefined)
  return removed
})
app.post('/api/templates/common/apply', async () => {
  await orchestrator.assertNotStreaming()
  const rendered = await commonTemplates.renderAll()
  return { ok: true, rendered: rendered.length }
})
app.get('/api/oauth/status', async () => oauth.status())
app.post<{ Params: { provider: 'youtube' | 'twitch' }; Body: { openerOrigin?: string } }>('/api/oauth/:provider/start', async (request, reply) => {
  if (!['youtube', 'twitch'].includes(request.params.provider)) return reply.status(404).send({ error: 'Unknown OAuth provider' })
  const openerOrigin = request.body?.openerOrigin ?? callbackOrigin
  if (!allowedOAuthOpenerOrigins.has(openerOrigin)) throw Object.assign(new Error('OAuth opener origin is not allowed'), { statusCode: 400 })
  return oauth.start(request.params.provider, openerOrigin)
})
app.get<{ Querystring: { openerOrigin?: string } }>('/api/oauth/youtube/start', async (request, reply) => {
  const openerOrigin = request.query.openerOrigin ?? callbackOrigin
  if (!allowedOAuthOpenerOrigins.has(openerOrigin)) throw Object.assign(new Error('OAuth opener origin is not allowed'), { statusCode: 400 })
  return reply.redirect(await oauth.authorizationUrl('youtube', openerOrigin))
})
app.get<{ Querystring: { code?: string; state?: string; error?: string } }>('/api/oauth/youtube/callback', async (request, reply) => {
  if (request.query.error) throw new Error(`OAuth authorization failed: ${request.query.error}`)
  if (!request.query.code || !request.query.state) throw new Error('OAuth callback is incomplete')
  const openerOrigin = await oauth.exchange('youtube', request.query.code, request.query.state)
  return reply.type('text/html; charset=utf-8').send(youtubeOAuthCallbackHtml(openerOrigin))
})
app.get<{ Params: { requestId: string } }>('/api/oauth/twitch/device/:requestId', async (request) => oauth.pollTwitch(request.params.requestId))
app.get('/api/profiles', async () => store.listProfiles())
app.post('/api/profiles', async (request) => {
  await orchestrator.assertNotStreaming()
  const profile = await store.saveProfile(GameProfileSchema.parse(request.body))
  await orchestrator.invalidateProfile(profile.id)
  return profile
})
app.delete<{ Params: { id: string } }>('/api/profiles/:id', async (request, reply) => {
  await orchestrator.assertNotStreaming()
  if (!(await store.removeProfile(request.params.id))) return reply.status(404).send({ error: 'Profile not found' })
  await orchestrator.invalidateProfile(request.params.id)
  return { ok: true }
})

app.post<{ Params: { id: string }; Body: { mime: string; data: string; filename?: string } }>('/api/profiles/:id/thumbnail', async (request) => {
  await orchestrator.assertNotStreaming()
  const profile = await store.getProfile(request.params.id)
  if (!profile) throw Object.assign(new Error('ゲームプロファイルが見つかりません'), { statusCode: 404 })
  if (!request.body?.data || !request.body?.mime) throw Object.assign(new Error('画像がありません'), { statusCode: 400 })
  const originalName = typeof request.body.filename === 'string' ? path.basename(request.body.filename).trim().slice(0, 255) || undefined : undefined
  const saved = await store.saveThumbnail(profile, Buffer.from(request.body.data, 'base64'), request.body.mime, originalName)
  await orchestrator.invalidateProfile(profile.id)
  await logger.write('thumbnail.saved', { gameId: profile.id, filename: saved.state.thumbnailFilename })
  return saved
})

app.delete<{ Params: { id: string } }>('/api/profiles/:id/thumbnail', async (request, reply) => {
  await orchestrator.assertNotStreaming()
  const profile = await store.getProfile(request.params.id)
  if (!profile) return reply.status(404).send({ error: 'Profile not found' })
  const saved = await store.removeThumbnail(profile)
  await orchestrator.invalidateProfile(profile.id)
  await logger.write('thumbnail.removed', { gameId: profile.id })
  return saved
})

app.get<{ Params: { id: string } }>('/api/profiles/:id/thumbnail', async (request, reply) => {
  const profile = await store.getProfile(request.params.id)
  const filename = profile && store.getThumbnailPath(profile)
  if (!filename) return reply.status(404).send({ error: 'Thumbnail not found' })
  const extension = path.extname(filename)
  return reply.type(extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg').send(await readFile(filename))
})

app.post<{ Body: { gameId: string; captureMethod?: string } }>('/api/select', async (request) => {
  await orchestrator.assertNotStreaming()
  const override = request.body.captureMethod ? CaptureMethodSchema.parse(request.body.captureMethod) : undefined
  return orchestrator.select(GameIdSchema.parse(request.body.gameId), override)
})
app.post<{ Body: { allowServiceFailures?: boolean } }>('/api/stream/start', async (request) => ({ ok: true, warnings: await orchestrator.start(Boolean(request.body?.allowServiceFailures)) }))
app.post('/api/stream/stop', async () => ({ ok: true, warnings: await orchestrator.stop() }))
app.post('/api/twitch/output-test', async () => {
  const result = await orchestrator.testTwitchOutput()
  await logger.write('twitch.output_test.completed', {
    durationMs: result.durationMs,
    bytesSent: result.bytesSent,
    totalFrames: result.totalFrames,
    skippedFrames: result.skippedFrames,
    congestion: result.congestion,
  })
  return result
})
app.post('/api/replay/save', async () => { await orchestrator.saveReplay(); return { ok: true } })
app.post<{ Body: { sceneName: string } }>('/api/scene', async (request) => { await orchestrator.switchScene(ObsSceneNameSchema.parse(request.body.sceneName)); return { ok: true } })
app.post<{ Body: { initialPath?: string } }>('/api/folders/select', async (request) => ({ path: await selectFolder(typeof request.body?.initialPath === 'string' ? request.body.initialPath : '') }))

const secretNames: SecretName[] = ['obs-password', 'steam-api-key', 'youtube-refresh-token', 'twitch-access-token', 'twitch-refresh-token']
app.put<{ Body: { config: unknown; secrets?: Partial<Record<SecretName, string>> } }>('/api/config', async (request) => {
  await orchestrator.assertNotStreaming()
  const current = await store.getConfig()
  let next = AppConfigSchema.parse(request.body.config)
  const youtubeCredentialsChanged = next.youtube.clientId !== current.youtube.clientId
  for (const [name, value] of Object.entries(request.body.secrets ?? {})) {
    if (secretNames.includes(name as SecretName) && typeof value === 'string') {
      secrets.set(name as SecretName, value)
      if (name === 'obs-password') next = { ...next, obs: { ...next.obs, passwordStored: Boolean(value) } }
      if (name === 'steam-api-key') next = { ...next, steam: { ...next.steam, apiKeyStored: Boolean(value) } }
      if (name === 'youtube-refresh-token') {
        if (!value) clearYouTubeStreamSecrets(secrets)
        next = { ...next, youtube: { ...next.youtube, refreshTokenStored: Boolean(value), broadcastId: value ? next.youtube.broadcastId : '' } }
      }
      if (name === 'twitch-access-token') next = { ...next, twitch: { ...next.twitch, accessTokenStored: Boolean(value) } }
      if (name === 'twitch-refresh-token') next = { ...next, twitch: { ...next.twitch, refreshTokenStored: Boolean(value) } }
    }
  }
  if (youtubeCredentialsChanged) {
    secrets.set('youtube-client-secret', '')
    secrets.set('youtube-refresh-token', '')
    clearYouTubeStreamSecrets(secrets)
    next = {
      ...next,
      youtube: {
        ...next.youtube,
        clientSecretStored: false,
        refreshTokenStored: false,
        broadcastId: '',
      },
    }
  }
  const config = await store.saveConfig(next)
  await obs.disconnect()
  await orchestrator.resetSelection()
  await logger.write('config.updated')
  return config
})

async function scanSteamAccount() {
  const config = await store.getConfig()
  const knownGames = (await store.listProfiles()).flatMap((profile) => profile.library.steamAppId === undefined
    ? []
    : [{ appId: profile.library.steamAppId, name: profile.displayName }])
  return platforms.steamAccountLibrary(config, knownGames)
}

async function syncSteamProfiles(trigger: 'automatic' | 'manual') {
  const steam = await scanSteamAccount()
  const result = await store.syncSteamLibrary(steam.ownedGames, steam.games)
  await logger.write('steam.synced', {
    trigger,
    owned: steam.ownedGames.length,
    installed: steam.games.length,
    libraries: steam.libraries,
    created: result.created,
    updated: result.updated,
    warnings: steam.warnings,
  })
  return { ...result, owned: steam.ownedGames.length, installed: steam.games.length, libraries: steam.libraries, warnings: steam.warnings }
}

app.get('/api/steam/sync', async () => {
  const steam = await scanSteamAccount()
  return { owned: steam.ownedGames, installed: steam.games, libraries: steam.libraries, warnings: steam.warnings }
})
app.post('/api/steam/scan', async () => {
  try { await orchestrator.assertNotStreaming() } catch (error) {
    const statusCode = error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined
    if (statusCode !== 409) throw error
    return { profiles: await store.listProfiles(), owned: 0, installed: 0, created: 0, updated: 0, libraries: [], warnings: [], skipped: true }
  }
  return syncSteamProfiles('automatic')
})
app.post('/api/steam/sync', async () => {
  await orchestrator.assertNotStreaming()
  return syncSteamProfiles('manual')
})
app.post('/api/backup/export', async () => store.exportBackup())
app.post<{ Body: unknown }>('/api/backup/import', async (request) => {
  await orchestrator.assertNotStreaming()
  const providerConfig = await store.getConfig()
  await store.importBackup(request.body)
  const importedConfig = await store.getConfig()
  await store.saveConfig(reconcileImportedConfig(importedConfig, providerConfig, (name) => Boolean(secrets.get(name))))
  await obs.disconnect()
  await orchestrator.resetSelection('バックアップを復元しました。配信前にゲームを選び直してください')
  return { ok: true }
})

const here = path.dirname(fileURLToPath(import.meta.url))
const clientRoot = path.resolve(here, '../client')
try {
  if ((await stat(clientRoot)).isDirectory()) {
    await app.register(fastifyStatic, { root: clientRoot, wildcard: false })
    app.get('/*', (_request, reply) => reply.sendFile('index.html'))
  }
} catch { /* Vite serves the client during development */ }

let started = false

export async function startServer(): Promise<{ host: string; port: number; url: string }> {
  const host = '127.0.0.1'
  if (!started) {
    await app.listen({ port: listenPort, host })
    started = true
  }
  return { host, port: listenPort, url: `http://${host}:${listenPort}` }
}

export async function stopServer(): Promise<void> {
  await platforms.stopComments().catch(() => undefined)
  await obs.disconnect().catch(() => undefined)
  if (started) {
    await app.close()
    started = false
  }
}

if (process.env.NODE_ENV !== 'test' && process.env.OBS_STREAM_MANAGER_EMBEDDED !== '1') {
  const server = await startServer()
  console.log(`OBS Stream Manager: ${server.url}`)
}
