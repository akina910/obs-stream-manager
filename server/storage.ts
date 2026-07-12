import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import YAML from 'yaml'
import { AppConfigSchema, GameProfileSchema, type AppConfig, type GameProfile, type PlatformGroup } from '../shared/contracts.js'
import { createPcProfile, defaultConfig, starterProfiles } from './defaults.js'
import { runtimeDirectories } from './paths.js'

const thumbnailFormats: Record<string, { ext: string; signature: (data: Uint8Array) => boolean }> = {
  'image/png': { ext: 'png', signature: (data) => data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 },
  'image/jpeg': { ext: 'jpg', signature: (data) => data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff },
  'image/webp': { ext: 'webp', signature: (data) => Buffer.from(data.subarray(0, 4)).toString() === 'RIFF' && Buffer.from(data.subarray(8, 12)).toString() === 'WEBP' },
}

async function validateThumbnail(bytes: Uint8Array, mime: string): Promise<{ ext: string }> {
  if (bytes.byteLength > 4 * 1024 * 1024) throw new Error('Thumbnail must be 4 MB or smaller')
  const format = thumbnailFormats[mime]
  if (!format || !format.signature(bytes)) throw new Error('Only valid PNG, JPEG and WEBP images are accepted')
  await sharp(bytes, { limitInputPixels: 16_000_000 }).raw().toBuffer()
  return format
}

async function exists(filename: string): Promise<boolean> {
  try { await stat(filename); return true } catch { return false }
}

async function atomicWrite(filename: string, contents: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true })
  const temporary = `${filename}.${process.pid}.tmp`
  await writeFile(temporary, contents)
  await rename(temporary, filename)
}

export class DataStore {
  constructor(readonly dataDir: string) {}

  async initialize(): Promise<void> {
    await Promise.all(runtimeDirectories.map((directory) => mkdir(path.join(this.dataDir, directory), { recursive: true })))
    const configFile = path.join(this.dataDir, 'config', 'app.json')
    if (!(await exists(configFile))) await atomicWrite(configFile, JSON.stringify(defaultConfig, null, 2))

    const initializedMarker = path.join(this.dataDir, 'database', 'initialized')
    if (!(await exists(initializedMarker))) {
      const profiles = await this.listProfiles()
      if (profiles.length === 0) await Promise.all(starterProfiles.map((profile) => this.saveProfile(profile)))
      await atomicWrite(initializedMarker, new Date().toISOString())
    }
  }

  async getConfig(): Promise<AppConfig> {
    const raw = JSON.parse(await readFile(path.join(this.dataDir, 'config', 'app.json'), 'utf8')) as unknown
    return AppConfigSchema.parse(raw)
  }

  async saveConfig(value: unknown): Promise<AppConfig> {
    const parsed = AppConfigSchema.parse(value)
    await atomicWrite(path.join(this.dataDir, 'config', 'app.json'), JSON.stringify(parsed, null, 2))
    return parsed
  }

  async listProfiles(): Promise<GameProfile[]> {
    const groups: PlatformGroup[] = ['pc', 'switch', 'exception']
    const profiles: GameProfile[] = []
    for (const group of groups) {
      const directory = path.join(this.dataDir, 'profiles', group)
      await mkdir(directory, { recursive: true })
      const files = (await readdir(directory)).filter((file) => file.endsWith('.yaml') || file.endsWith('.yml'))
      for (const file of files) {
        const parsed = YAML.parse(await readFile(path.join(directory, file), 'utf8')) as unknown
        const profile = GameProfileSchema.parse(parsed)
        if (profile.platformGroup !== group) throw new Error(`Profile ${profile.id} is stored in the wrong platform directory`)
        profiles.push(profile)
      }
    }
    return profiles.sort((a, b) => Number(b.favorite) - Number(a.favorite) || (b.state.lastUsedAt ?? '').localeCompare(a.state.lastUsedAt ?? '') || a.displayName.localeCompare(b.displayName, 'ja'))
  }

  async getProfile(id: string): Promise<GameProfile | null> {
    return (await this.listProfiles()).find((profile) => profile.id === id) ?? null
  }

  async saveProfile(value: unknown): Promise<GameProfile> {
    const profile = GameProfileSchema.parse(value)
    for (const group of ['pc', 'switch', 'exception'] as const) {
      if (group === profile.platformGroup) continue
      const oldProfile = path.join(this.dataDir, 'profiles', group, `${profile.id}.yaml`)
      if (await exists(oldProfile)) {
        await rm(oldProfile, { force: true })
        const oldThumbnails = path.join(this.dataDir, 'thumbnails', group, profile.id)
        const newThumbnails = path.join(this.dataDir, 'thumbnails', profile.platformGroup, profile.id)
        if (await exists(oldThumbnails)) {
          await mkdir(path.dirname(newThumbnails), { recursive: true })
          await rm(newThumbnails, { recursive: true, force: true })
          await rename(oldThumbnails, newThumbnails)
        }
      }
    }
    const filename = path.join(this.dataDir, 'profiles', profile.platformGroup, `${profile.id}.yaml`)
    await atomicWrite(filename, YAML.stringify(profile, { lineWidth: 0 }))
    return profile
  }

  async removeProfile(id: string): Promise<boolean> {
    const profile = await this.getProfile(id)
    if (!profile) return false
    await rm(path.join(this.dataDir, 'profiles', profile.platformGroup, `${profile.id}.yaml`), { force: true })
    await rm(path.join(this.dataDir, 'thumbnails', profile.platformGroup, profile.id), { recursive: true, force: true })
    return true
  }

  async saveThumbnail(profile: GameProfile, bytes: Uint8Array, mime: string): Promise<GameProfile> {
    const format = await validateThumbnail(bytes, mime)
    const directory = path.join(this.dataDir, 'thumbnails', profile.platformGroup, profile.id)
    await mkdir(directory, { recursive: true })
    for (const old of ['default.png', 'default.jpg', 'default.webp']) await rm(path.join(directory, old), { force: true })
    const filename = `default.${format.ext}`
    await atomicWrite(path.join(directory, filename), bytes)
    return this.saveProfile({
      ...profile,
      state: {
        ...profile.state,
        thumbnailFilename: filename,
        thumbnailApplyStatus: profile.state.thumbnailAutoApply ? 'pending' : 'disabled',
        thumbnailLastError: undefined,
      },
    })
  }

  async removeThumbnail(profile: GameProfile): Promise<GameProfile> {
    await rm(path.join(this.dataDir, 'thumbnails', profile.platformGroup, profile.id), { recursive: true, force: true })
    return this.saveProfile({
      ...profile,
      state: {
        ...profile.state,
        thumbnailFilename: undefined,
        thumbnailApplyStatus: 'not_registered',
        thumbnailLastAppliedAt: null,
        thumbnailLastError: undefined,
      },
    })
  }

  async syncSteamLibrary(
    owned: Array<{ appId: number; name: string }>,
    installed: Array<{ appId: number; name: string; installDir: string }>,
  ): Promise<{ profiles: GameProfile[]; created: number; updated: number }> {
    const installedById = new Map(installed.map((game) => [game.appId, game]))
    const games = new Map<number, { appId: number; name: string }>()
    for (const game of owned) games.set(game.appId, game)
    for (const game of installed) games.set(game.appId, game)
    const existing = await this.listProfiles()
    let created = 0
    let updated = 0
    for (const game of games.values()) {
      const normalized = game.name.trim().toLocaleLowerCase()
      const match = existing.find((profile) => profile.library.steamAppId === game.appId || profile.displayName.trim().toLocaleLowerCase() === normalized)
      const base = match ?? createPcProfile(`steam_${game.appId}`, game.name)
      const local = installedById.get(game.appId)
      await this.saveProfile({
        ...base,
        coverUrl: base.coverUrl ?? `https://cdn.cloudflare.steamstatic.com/steam/apps/${game.appId}/header.jpg`,
        library: {
          ...base.library,
          steamAppId: game.appId,
          installed: Boolean(local),
          installDirectory: local?.installDir,
        },
      })
      if (match) updated += 1
      else created += 1
    }
    return { profiles: await this.listProfiles(), created, updated }
  }

  getThumbnailPath(profile: GameProfile): string | null {
    if (!profile.state.thumbnailFilename) return null
    return path.join(this.dataDir, 'thumbnails', profile.platformGroup, profile.id, path.basename(profile.state.thumbnailFilename))
  }

  async exportBackup(): Promise<{ version: 1; exportedAt: string; config: AppConfig; profiles: GameProfile[]; thumbnails: Record<string, { mime: string; data: string }> }> {
    const profiles = await this.listProfiles()
    const currentConfig = await this.getConfig()
    const config: AppConfig = {
      ...currentConfig,
      obs: { ...currentConfig.obs, passwordStored: false },
      steam: { ...currentConfig.steam, apiKeyStored: false },
      youtube: { ...currentConfig.youtube, clientSecretStored: false, refreshTokenStored: false },
      twitch: { ...currentConfig.twitch, clientSecretStored: false, accessTokenStored: false, refreshTokenStored: false },
    }
    const thumbnails: Record<string, { mime: string; data: string }> = {}
    for (const profile of profiles) {
      const filename = this.getThumbnailPath(profile)
      if (!filename || !(await exists(filename))) continue
      const extension = path.extname(filename).toLowerCase()
      thumbnails[profile.id] = { mime: extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg', data: (await readFile(filename)).toString('base64') }
    }
    const backup = { version: 1 as const, exportedAt: new Date().toISOString(), config, profiles, thumbnails }
    await atomicWrite(path.join(this.dataDir, 'backups', `backup-${backup.exportedAt.replaceAll(':', '-')}.json`), JSON.stringify(backup, null, 2))
    return backup
  }

  async importBackup(value: unknown): Promise<void> {
    if (!value || typeof value !== 'object') throw new Error('Invalid backup')
    const backup = value as Record<string, unknown>
    if (backup.version !== 1 || !Array.isArray(backup.profiles)) throw new Error('Unsupported backup version')
    const config = AppConfigSchema.parse(backup.config)
    const profiles = backup.profiles.map((profile) => GameProfileSchema.parse(profile))
    const rawThumbnails = backup.thumbnails && typeof backup.thumbnails === 'object' ? backup.thumbnails as Record<string, unknown> : {}
    const thumbnails = new Map<string, { mime: string; bytes: Buffer }>()
    for (const profile of profiles) {
      const raw = rawThumbnails[profile.id]
      if (!raw || typeof raw !== 'object') continue
      const { mime, data } = raw as Record<string, unknown>
      if (typeof mime !== 'string' || typeof data !== 'string') throw new Error(`Invalid thumbnail backup for ${profile.id}`)
      const bytes = Buffer.from(data, 'base64')
      await validateThumbnail(bytes, mime)
      thumbnails.set(profile.id, { mime, bytes })
    }

    await Promise.all(['pc', 'switch', 'exception'].map(async (group) => {
      const directory = path.join(this.dataDir, 'profiles', group)
      await rm(directory, { recursive: true, force: true })
      await mkdir(directory, { recursive: true })
    }))
    await rm(path.join(this.dataDir, 'thumbnails'), { recursive: true, force: true })
    await mkdir(path.join(this.dataDir, 'thumbnails'), { recursive: true })
    await this.saveConfig(config)
    for (const profile of profiles) {
      const thumbnail = thumbnails.get(profile.id)
      const cleanProfile = thumbnail ? profile : { ...profile, state: { ...profile.state, thumbnailFilename: undefined } }
      const saved = await this.saveProfile(cleanProfile)
      if (thumbnail) await this.saveThumbnail(saved, thumbnail.bytes, thumbnail.mime)
    }
  }

  async copyThumbnail(source: string, profile: GameProfile): Promise<GameProfile> {
    const extension = path.extname(source).toLowerCase()
    const mime = extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg'
    const bytes = await readFile(source)
    return this.saveThumbnail(profile, bytes, mime)
  }

  async cloneDescription(source: string, profileId: string): Promise<string> {
    const destination = path.join(this.dataDir, 'descriptions', `${profileId}.txt`)
    await copyFile(source, destination)
    return destination
  }
}
