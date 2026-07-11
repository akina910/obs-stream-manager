import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { starterProfiles } from './defaults.js'
import { DataStore } from './storage.js'

const directories: string[] = []

async function createStore(): Promise<DataStore> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'obs-stream-manager-'))
  directories.push(directory)
  const store = new DataStore(directory)
  await store.initialize()
  return store
}

afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))))

describe('DataStore', () => {
  it('initializes public starter profiles without credentials', async () => {
    const store = await createStore()
    const profiles = await store.listProfiles()
    expect(profiles).toHaveLength(starterProfiles.length)
    expect(profiles.map((profile) => profile.id)).toContain('valorant')
    const configText = await readFile(path.join(store.dataDir, 'config', 'app.json'), 'utf8')
    expect(Object.keys(JSON.parse(configText) as object)).not.toContain('secrets')
    expect(configText).not.toContain('refresh_token')
  })

  it('round-trips profile state and validates profile ids', async () => {
    const store = await createStore()
    const profile = (await store.listProfiles())[0]
    const saved = await store.saveProfile({ ...profile, favorite: !profile.favorite, state: { ...profile.state, lastUsedAt: new Date().toISOString() } })
    expect((await store.getProfile(saved.id))?.favorite).toBe(saved.favorite)
    await expect(store.saveProfile({ ...profile, id: '../escape' })).rejects.toThrow()
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
})
