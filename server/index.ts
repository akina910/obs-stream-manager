import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import cors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import Fastify from 'fastify'
import { ZodError } from 'zod'
import { AppConfigSchema, CaptureMethodSchema, GameIdSchema, GameProfileSchema, ObsSceneNameSchema } from '../shared/contracts.js'
import { CaptureDetector } from './capture.js'
import { AppLogger } from './logger.js'
import { ObsController } from './obs.js'
import { OAuthManager } from './oauth.js'
import { StreamOrchestrator } from './orchestrator.js'
import { PlatformServices } from './platforms.js'
import { getDataDirectory } from './paths.js'
import { SecretStore, type SecretName } from './secrets.js'
import { DataStore } from './storage.js'

const dataDir = getDataDirectory()
const store = new DataStore(dataDir)
await store.initialize()
const secrets = new SecretStore()
const logger = new AppLogger(dataDir)
const obs = new ObsController(secrets)
const platforms = new PlatformServices(secrets, store)
const orchestrator = new StreamOrchestrator(store, obs, new CaptureDetector(), platforms, logger)
const listenPort = Number(process.env.PORT ?? 4317)
const callbackOrigin = `http://127.0.0.1:${listenPort}`
const allowedOAuthOpenerOrigins = new Set([
  callbackOrigin,
  `http://localhost:${listenPort}`,
  'http://127.0.0.1:4318',
  'http://localhost:4318',
])
const oauth = new OAuthManager(store, secrets, callbackOrigin, allowedOAuthOpenerOrigins)

export const app = Fastify({ logger: { redact: ['req.headers.authorization', 'req.headers.cookie', 'body.secrets'] }, bodyLimit: 8 * 1024 * 1024 })
await app.register(cors, { origin: ['http://127.0.0.1:4318', 'http://localhost:4318'] })

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
  return reply.type('text/html').send(`<!doctype html><meta charset="utf-8"><title>認証完了</title><body style="background:#0b0d12;color:#fff;font-family:sans-serif;padding:40px"><h1>YouTube 接続が完了しました</h1><p>このウィンドウは自動で閉じます。</p><script>window.opener?.postMessage({type:"oauth-complete",provider:"youtube"},${JSON.stringify(openerOrigin)});setTimeout(()=>window.close(),800)</script></body>`)
})
app.get<{ Params: { requestId: string } }>('/api/oauth/twitch/device/:requestId', async (request) => oauth.pollTwitch(request.params.requestId))
app.get('/api/profiles', async () => store.listProfiles())
app.post('/api/profiles', async (request) => {
  await orchestrator.assertNotStreaming()
  const profile = await store.saveProfile(GameProfileSchema.parse(request.body))
  orchestrator.invalidateProfile(profile.id)
  return profile
})
app.delete<{ Params: { id: string } }>('/api/profiles/:id', async (request, reply) => {
  await orchestrator.assertNotStreaming()
  if (!(await store.removeProfile(request.params.id))) return reply.status(404).send({ error: 'Profile not found' })
  orchestrator.invalidateProfile(request.params.id)
  return { ok: true }
})

app.post<{ Params: { id: string }; Body: { mime: string; data: string; filename?: string } }>('/api/profiles/:id/thumbnail', async (request) => {
  await orchestrator.assertNotStreaming()
  const profile = await store.getProfile(request.params.id)
  if (!profile) throw Object.assign(new Error('ゲームプロファイルが見つかりません'), { statusCode: 404 })
  if (!request.body?.data || !request.body?.mime) throw Object.assign(new Error('画像がありません'), { statusCode: 400 })
  const originalName = typeof request.body.filename === 'string' ? path.basename(request.body.filename).trim().slice(0, 255) || undefined : undefined
  const saved = await store.saveThumbnail(profile, Buffer.from(request.body.data, 'base64'), request.body.mime, originalName)
  orchestrator.invalidateProfile(profile.id)
  await logger.write('thumbnail.saved', { gameId: profile.id, filename: saved.state.thumbnailFilename })
  return saved
})

app.delete<{ Params: { id: string } }>('/api/profiles/:id/thumbnail', async (request, reply) => {
  await orchestrator.assertNotStreaming()
  const profile = await store.getProfile(request.params.id)
  if (!profile) return reply.status(404).send({ error: 'Profile not found' })
  const saved = await store.removeThumbnail(profile)
  orchestrator.invalidateProfile(profile.id)
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
  const override = request.body.captureMethod ? CaptureMethodSchema.parse(request.body.captureMethod) : undefined
  return orchestrator.select(GameIdSchema.parse(request.body.gameId), override)
})
app.post<{ Body: { allowServiceFailures?: boolean } }>('/api/stream/start', async (request) => ({ ok: true, warnings: await orchestrator.start(Boolean(request.body?.allowServiceFailures)) }))
app.post('/api/stream/stop', async () => ({ ok: true, warnings: await orchestrator.stop() }))
app.post('/api/replay/save', async () => { await orchestrator.saveReplay(); return { ok: true } })
app.post<{ Body: { sceneName: string } }>('/api/scene', async (request) => { await orchestrator.switchScene(ObsSceneNameSchema.parse(request.body.sceneName)); return { ok: true } })

const secretNames: SecretName[] = ['obs-password', 'steam-api-key', 'youtube-client-secret', 'youtube-refresh-token', 'twitch-client-secret', 'twitch-access-token', 'twitch-refresh-token']
app.put<{ Body: { config: unknown; secrets?: Partial<Record<SecretName, string>> } }>('/api/config', async (request) => {
  await orchestrator.assertNotStreaming()
  let next = AppConfigSchema.parse(request.body.config)
  for (const [name, value] of Object.entries(request.body.secrets ?? {})) {
    if (secretNames.includes(name as SecretName) && typeof value === 'string') {
      secrets.set(name as SecretName, value)
      if (name === 'obs-password') next = { ...next, obs: { ...next.obs, passwordStored: Boolean(value) } }
      if (name === 'steam-api-key') next = { ...next, steam: { ...next.steam, apiKeyStored: Boolean(value) } }
      if (name === 'youtube-client-secret') next = { ...next, youtube: { ...next.youtube, clientSecretStored: Boolean(value) } }
      if (name === 'youtube-refresh-token') next = { ...next, youtube: { ...next.youtube, refreshTokenStored: Boolean(value) } }
      if (name === 'twitch-client-secret') next = { ...next, twitch: { ...next.twitch, clientSecretStored: Boolean(value) } }
      if (name === 'twitch-access-token') next = { ...next, twitch: { ...next.twitch, accessTokenStored: Boolean(value) } }
      if (name === 'twitch-refresh-token') next = { ...next, twitch: { ...next.twitch, refreshTokenStored: Boolean(value) } }
    }
  }
  const config = await store.saveConfig(next)
  await obs.disconnect()
  orchestrator.resetSelection()
  await logger.write('config.updated')
  return config
})

app.get('/api/steam/sync', async () => {
  const config = await store.getConfig()
  const [owned, installed] = await Promise.all([platforms.steamOwnedGames(config).catch(() => []), platforms.steamInstalledGames(config).catch(() => [])])
  return { owned, installed }
})
app.post('/api/steam/sync', async () => {
  await orchestrator.assertNotStreaming()
  const config = await store.getConfig()
  const [ownedResult, installedResult] = await Promise.allSettled([platforms.steamOwnedGames(config), platforms.steamInstalledGames(config)])
  const owned = ownedResult.status === 'fulfilled' ? ownedResult.value : []
  const installed = installedResult.status === 'fulfilled' ? installedResult.value : []
  const warnings = [
    ...(ownedResult.status === 'rejected' ? [`Steam Web API: ${ownedResult.reason instanceof Error ? ownedResult.reason.message : String(ownedResult.reason)}`] : []),
    ...(installedResult.status === 'rejected' ? [`Steamローカル: ${installedResult.reason instanceof Error ? installedResult.reason.message : String(installedResult.reason)}`] : []),
  ]
  const { profiles, created, updated } = await store.syncSteamLibrary(owned, installed)
  await logger.write('steam.synced', { owned: owned.length, installed: installed.length, created, updated, warnings })
  return { profiles, owned: owned.length, installed: installed.length, created, updated, warnings }
})
app.post('/api/backup/export', async () => store.exportBackup())
app.post<{ Body: unknown }>('/api/backup/import', async (request) => {
  await orchestrator.assertNotStreaming()
  await store.importBackup(request.body)
  await obs.disconnect()
  orchestrator.resetSelection('バックアップを復元しました。配信前にゲームを選び直してください')
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

if (process.env.NODE_ENV !== 'test') {
  const port = listenPort
  const host = process.env.HOST ?? '127.0.0.1'
  await app.listen({ port, host })
  console.log(`OBS Stream Manager: http://${host}:${port}`)
}
