import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { createPcProfile, starterProfiles } from './defaults.js'
import { DataStore } from './storage.js'

const directories: string[] = []

async function createStore(withFixtures = true): Promise<DataStore> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'obs-stream-manager-'))
  directories.push(directory)
  const store = new DataStore(directory)
  await store.initialize()
  if (withFixtures) await Promise.all(starterProfiles.map((profile) => store.saveProfile(profile)))
  return store
}

afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))))

describe('DataStore', () => {
  it('initializes an empty library and first-run setup without credentials', async () => {
    const store = await createStore(false)
    const profiles = await store.listProfiles()
    expect(profiles).toHaveLength(0)
    expect((await store.getConfig()).setup.completed).toBe(false)
    const configText = await readFile(path.join(store.dataDir, 'config', 'app.json'), 'utf8')
    expect(Object.keys(JSON.parse(configText) as object)).not.toContain('secrets')
    expect(configText).not.toContain('refresh_token')
  })

  it('treats an existing pre-setup config as already completed', async () => {
    const store = await createStore(false)
    const filename = path.join(store.dataDir, 'config', 'app.json')
    const legacy = JSON.parse(await readFile(filename, 'utf8')) as Record<string, unknown>
    delete legacy.setup
    await writeFile(filename, JSON.stringify(legacy))

    expect((await store.getConfig()).setup.completed).toBe(true)
  })

  it('removes only untouched legacy starter profiles during the one-time migration', async () => {
    const store = await createStore()
    const asa = (await store.getProfile('ark_survival_ascended'))!
    const diablo = (await store.getProfile('diablo_iv'))!
    await store.saveProfile({ ...asa, library: { ...asa.library, installed: true, installDirectory: 'D:\\Games\\ASA' } })
    await store.saveProfile({ ...diablo, youtube: { ...diablo.youtube, titleTemplate: 'custom title' } })
    await rm(path.join(store.dataDir, 'database', 'legacy-starter-profiles-v1-removed'), { force: true })

    await new DataStore(store.dataDir).initialize()

    expect(await store.getProfile('minecraft')).toBeNull()
    expect(await store.getProfile('zelda_botw')).toBeNull()
    expect((await store.getProfile('ark_survival_ascended'))?.library.installed).toBe(true)
    expect((await store.getProfile('diablo_iv'))?.youtube.titleTemplate).toBe('custom title')
  })

  it('round-trips profile state and validates profile ids', async () => {
    const store = await createStore()
    const profile = (await store.listProfiles())[0]
    const saved = await store.saveProfile({ ...profile, favorite: !profile.favorite, state: { ...profile.state, lastUsedAt: new Date().toISOString() } })
    expect((await store.getProfile(saved.id))?.favorite).toBe(saved.favorite)
    await expect(store.saveProfile({ ...profile, id: '../escape' })).rejects.toThrow()
    await expect(store.saveProfile({ ...profile, id: `a${'b'.repeat(128)}` })).rejects.toThrow()
  })

  it('moves a profile instead of duplicating it when its platform group changes', async () => {
    const store = await createStore()
    const profile = (await store.listProfiles()).find((item) => item.id === 'diablo_iv')!
    await store.saveProfile({ ...profile, platformGroup: 'exception', library: { ...profile.library, exception: true } })
    const matches = (await store.listProfiles()).filter((item) => item.id === profile.id)
    expect(matches).toHaveLength(1)
    expect(matches[0].platformGroup).toBe('exception')
  })

  it('does not recreate starter profiles after the user intentionally empties the library', async () => {
    const store = await createStore()
    for (const profile of await store.listProfiles()) await store.removeProfile(profile.id)
    await new DataStore(store.dataDir).initialize()
    expect(await store.listProfiles()).toHaveLength(0)
  })

  it('rejects a file whose bytes do not match its declared image type', async () => {
    const store = await createStore()
    const profile = (await store.listProfiles())[0]
    await expect(store.saveThumbnail(profile, Buffer.from('not an image'), 'image/png')).rejects.toThrow(/valid PNG/)
    await expect(store.saveThumbnail(profile, Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png')).rejects.toThrow()
  })

  it('exports and restores a credential-free backup', async () => {
    const store = await createStore()
    const profile = (await store.listProfiles())[0]
    const thumbnail = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#123456' } }).png().toBuffer()
    await store.saveThumbnail(profile, thumbnail, 'image/png')
    const backup = await store.exportBackup()
    expect(backup.version).toBe(1)
    expect(backup.config.youtube.refreshTokenStored).toBe(false)
    expect(backup).not.toHaveProperty('secrets')
    expect(backup.thumbnails[profile.id]?.mime).toBe('image/png')
    await store.saveProfile({ ...profile, id: 'temporary_game', displayName: 'Temporary' })
    await expect(store.importBackup(backup)).resolves.toBeUndefined()
    expect(await store.getProfile('temporary_game')).toBeNull()
    expect((await store.getProfile(profile.id))?.state.thumbnailFilename).toBe('default.png')
  })

  it('removes untouched legacy starters restored from an old backup', async () => {
    const store = await createStore()
    const diablo = (await store.getProfile('diablo_iv'))!
    await store.saveProfile({ ...diablo, twitch: { ...diablo.twitch, titleTemplate: 'custom backup title' } })
    const backup = await store.exportBackup()

    await store.importBackup(backup)

    expect(await store.getProfile('minecraft')).toBeNull()
    expect(await store.getProfile('zelda_botw')).toBeNull()
    expect((await store.getProfile('diablo_iv'))?.twitch.titleTemplate).toBe('custom backup title')
  })

  it('removes a saved thumbnail and resets its automatic-application state', async () => {
    const store = await createStore()
    const profile = (await store.listProfiles())[0]
    const thumbnail = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#123456' } }).png().toBuffer()
    const saved = await store.saveThumbnail(profile, thumbnail, 'image/png', 'my-thumbnail.png')
    expect(saved.state.thumbnailApplyStatus).toBe('pending')
    expect(saved.state.thumbnailOriginalName).toBe('my-thumbnail.png')
    expect(saved.state.thumbnailUpdatedAt).toEqual(expect.any(String))
    const replacedWithoutName = await store.saveThumbnail(saved, thumbnail, 'image/png')
    expect(replacedWithoutName.state.thumbnailOriginalName).toBeUndefined()
    const removed = await store.removeThumbnail(replacedWithoutName)
    expect(removed.state.thumbnailFilename).toBeUndefined()
    expect(removed.state.thumbnailOriginalName).toBeUndefined()
    expect(removed.state.thumbnailUpdatedAt).toBeUndefined()
    expect(removed.state.thumbnailApplyStatus).toBe('not_registered')
  })

  it('keeps complete app and game settings with thumbnail metadata across a restart', async () => {
    const store = await createStore()
    const config = await store.getConfig()
    await store.saveConfig({
      ...config,
      obs: { ...config.obs, startDelaySeconds: 17, endDelaySeconds: 23 },
      sources: { ...config.sources, microphone: 'MY_MIC', bgm: 'MY_BGM' },
      features: { ...config.features, verticalRecording: false },
    })
    const profile = (await store.listProfiles()).find((item) => item.id === 'ark_survival_ascended')!
    const customized = await store.saveProfile({
      ...profile,
      capture: { ...profile.capture, localSourceName: 'Persistent Game Capture', allowDisplayFallback: true },
      obs: { ...profile.obs, sceneName: 'Persistent Scene' },
      audio: { ...profile.audio, gameDb: -21, duckingDb: 0 },
      recording: { ...profile.recording, directory: 'D:\\Persistent Recordings', replayBufferSeconds: 240, verticalRecording: false },
      state: { ...profile.state, thumbnailAutoApply: false },
    })
    const thumbnail = await sharp({ create: { width: 16, height: 9, channels: 3, background: '#456789' } }).png().toBuffer()
    const withThumbnail = await store.saveThumbnail(customized, thumbnail, 'image/png', 'persistent-choice.png')
    const afterProfileSave = await store.saveProfile({ ...withThumbnail, displayName: 'ARK Persistent Profile' })
    expect(afterProfileSave.state.thumbnailUpdatedAt).toBe(withThumbnail.state.thumbnailUpdatedAt)
    expect(afterProfileSave.state.thumbnailOriginalName).toBe('persistent-choice.png')

    const restarted = new DataStore(store.dataDir)
    await restarted.initialize()
    const reloadedConfig = await restarted.getConfig()
    const reloaded = await restarted.getProfile(profile.id)

    expect(reloadedConfig).toMatchObject({
      obs: { startDelaySeconds: 17, endDelaySeconds: 23 },
      sources: { microphone: 'MY_MIC', bgm: 'MY_BGM' },
      features: { verticalRecording: false },
    })
    expect(reloaded).toMatchObject({
      displayName: 'ARK Persistent Profile',
      capture: { localSourceName: 'Persistent Game Capture', allowDisplayFallback: true },
      obs: { sceneName: 'Persistent Scene' },
      audio: { gameDb: -21, duckingDb: 0 },
      recording: { directory: 'D:\\Persistent Recordings', replayBufferSeconds: 240, verticalRecording: false },
      state: {
        thumbnailFilename: withThumbnail.state.thumbnailFilename,
        thumbnailOriginalName: 'persistent-choice.png',
        thumbnailUpdatedAt: withThumbnail.state.thumbnailUpdatedAt,
        thumbnailAutoApply: false,
        thumbnailApplyStatus: 'disabled',
      },
    })
    expect(reloaded).not.toBeNull()
    if (!reloaded) throw new Error('Reloaded profile is missing')
    expect(restarted.getThumbnailPath(reloaded)).not.toBeNull()
  })

  it('merges Steam games by App ID or name without duplicating existing profiles', async () => {
    const store = await createStore()
    const result = await store.syncSteamLibrary(
      [{ appId: 2399830, name: 'ARK: Survival Ascended' }, { appId: 1234, name: 'New Steam Game' }],
      [{ appId: 1234, name: 'New Steam Game', installDir: 'D:\\SteamLibrary\\steamapps\\common\\New Steam Game' }],
    )
    expect(result.created).toBe(1)
    expect(result.updated).toBe(1)
    expect(result.profiles.filter((profile) => profile.library.steamAppId === 2399830)).toHaveLength(1)
    expect(result.profiles.find((profile) => profile.library.steamAppId === 1234)?.library).toMatchObject({ installed: true, installDirectory: 'D:\\SteamLibrary\\steamapps\\common\\New Steam Game' })
  })

  it('defaults uninstalled Steam games to GeForce NOW without changing existing choices', async () => {
    const store = await createStore()
    const first = await store.syncSteamLibrary([{ appId: 8888, name: 'Cloud Game' }], [])
    const cloudGame = first.profiles.find((profile) => profile.library.steamAppId === 8888)!
    expect(cloudGame.capture).toMatchObject({ preferred: 'geforce_now', geforceNowEnabled: true })
    await store.saveProfile({ ...cloudGame, capture: { ...cloudGame.capture, preferred: 'display', allowDisplayFallback: true } })

    const second = await store.syncSteamLibrary([{ appId: 8888, name: 'Cloud Game' }], [])

    expect(second.profiles.find((profile) => profile.library.steamAppId === 8888)?.capture).toMatchObject({ preferred: 'display', allowDisplayFallback: true })
  })

  it('replaces a temporary App ID name when Steam metadata becomes available', async () => {
    const store = await createStore()
    await store.syncSteamLibrary([{ appId: 9998, name: 'Steam App 9998' }], [])

    const result = await store.syncSteamLibrary([{ appId: 9998, name: 'Resolved Game' }], [])

    expect(result.updated).toBe(1)
    expect(result.profiles.find((profile) => profile.library.steamAppId === 9998)).toMatchObject({
      displayName: 'Resolved Game',
      twitch: { categoryName: 'Resolved Game' },
    })
  })

  it('keeps automatic Steam scans idempotent and clears removed installs', async () => {
    const store = await createStore()
    const installed = [{ appId: 1234, name: 'Auto-detected Game', installDir: 'D:\\SteamLibrary\\steamapps\\common\\Auto-detected Game' }]

    const first = await store.syncSteamLibrary([], installed)
    const second = await store.syncSteamLibrary([], installed)
    const removed = await store.syncSteamLibrary([], [])

    expect(first).toMatchObject({ created: 1, updated: 0 })
    expect(second).toMatchObject({ created: 0, updated: 0 })
    expect(second.profiles.filter((profile) => profile.library.steamAppId === 1234)).toHaveLength(1)
    expect(removed.updated).toBe(1)
    expect(removed.profiles.find((profile) => profile.library.steamAppId === 1234)?.library).toMatchObject({ installed: false })
    expect(removed.profiles.find((profile) => profile.library.steamAppId === 1234)?.library.installDirectory).toBeUndefined()
  })

  it('serializes concurrent Steam scans without creating duplicate profiles', async () => {
    const store = await createStore()
    const installed = [{ appId: 4321, name: 'Concurrent Game', installDir: 'D:\\SteamLibrary\\steamapps\\common\\Concurrent Game' }]

    const results = await Promise.all([
      store.syncSteamLibrary([], installed),
      store.syncSteamLibrary([], installed),
    ])

    const profiles = await store.listProfiles()
    expect(results.reduce((total, result) => total + result.created, 0)).toBe(1)
    expect(profiles.filter((profile) => profile.library.steamAppId === 4321)).toHaveLength(1)
  })

  it('does not overwrite an existing Steam link when distinct App IDs share a display name', async () => {
    const store = await createStore()
    const ark = (await store.listProfiles()).find((profile) => profile.id === 'ark_survival_ascended')!
    const result = await store.syncSteamLibrary(
      [{ appId: ark.library.steamAppId!, name: ark.displayName }, { appId: 999999, name: ark.displayName }],
      [],
    )
    expect(result.profiles.filter((profile) => profile.displayName === ark.displayName)).toHaveLength(2)
    expect(result.profiles.filter((profile) => [ark.library.steamAppId, 999999].includes(profile.library.steamAppId))).toHaveLength(2)
  })

  it('does not link a Steam App ID to an arbitrary profile when unlinked names are ambiguous', async () => {
    const store = await createStore()
    await store.saveProfile(createPcProfile('duplicate_one', 'Duplicate Game'))
    await store.saveProfile(createPcProfile('duplicate_two', 'Duplicate Game'))

    const result = await store.syncSteamLibrary([{ appId: 777777, name: 'Duplicate Game' }], [])

    expect(result.created).toBe(1)
    expect(result.updated).toBe(0)
    expect(result.profiles.find((profile) => profile.library.steamAppId === 777777)?.id).toBe('steam_777777')
    expect(result.profiles.filter((profile) => profile.displayName === 'Duplicate Game' && profile.library.steamAppId === undefined)).toHaveLength(2)
  })

  it('backs up and restores the shared stream template image and settings', async () => {
    const store = await createStore()
    const image = await sharp({ create: { width: 640, height: 360, channels: 4, background: '#334455' } }).png().toBuffer()
    await store.saveCommonTemplateImage(image, 'image/png', 'shared-screen.png')
    const current = await store.getConfig()
    await store.saveConfig({ ...current, commonTemplate: { ...current.commonTemplate, enabled: true, textTemplate: 'LIVE: {game}' } })

    const backup = await store.exportBackup()
    expect(backup.commonTemplateImage).toMatchObject({ mime: 'image/png', originalName: 'shared-screen.png' })
    await store.removeCommonTemplateImage()
    await store.importBackup(backup)

    const restored = await store.getConfig()
    expect(restored.commonTemplate).toMatchObject({ enabled: true, textTemplate: 'LIVE: {game}', imageOriginalName: 'shared-screen.png' })
    const filename = store.getCommonTemplateImagePath(restored)
    expect(filename).not.toBeNull()
    await expect(readFile(filename!)).resolves.toEqual(image)
  })
})
