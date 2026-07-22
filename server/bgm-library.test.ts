import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BgmLibraryStore, maxBgmTrackBytes } from './bgm-library.js'

const directories: string[] = []

async function createLibrary(): Promise<BgmLibraryStore> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'obs-stream-manager-bgm-'))
  directories.push(directory)
  const library = new BgmLibraryStore(directory)
  await library.initialize()
  return library
}

function mp3(contents = 'track'): Buffer {
  return Buffer.concat([Buffer.from('ID3'), Buffer.from(contents)])
}

afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))))

describe('BgmLibraryStore', () => {
  it('stores valid audio under a generated filename and preserves it across restarts', async () => {
    const library = await createLibrary()
    const saved = await library.addTrack('..\\配信BGM.mp3', mp3())
    const track = saved.tracks[0]

    expect(track).toMatchObject({ name: '配信BGM', originalName: '配信BGM.mp3', mime: 'audio/mpeg', size: 8 })
    expect(track.filename).toMatch(/^[0-9a-f-]+\.mp3$/)
    expect(await readFile(library.trackPath(track))).toEqual(mp3())

    const restarted = new BgmLibraryStore(library.dataDir)
    await restarted.initialize()
    expect(await restarted.getLibrary()).toEqual(saved)
  })

  it('selects and removes a track without touching other stock entries', async () => {
    const library = await createLibrary()
    const first = (await library.addTrack('first.mp3', mp3('first'))).tracks[0]
    const second = (await library.addTrack('second.mp3', mp3('second'))).tracks[1]

    expect((await library.selectTrack(second.id)).selectedTrackId).toBe(second.id)
    const removed = await library.removeTrack(second.id)

    expect(removed.wasSelected).toBe(true)
    expect(removed.library.selectedTrackId).toBeNull()
    expect(removed.library.tracks).toEqual([first])
    await expect(readFile(library.trackPath(second))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects unsupported, empty, and oversized files', async () => {
    const library = await createLibrary()

    await expect(library.addTrack('empty.mp3', Buffer.alloc(0))).rejects.toThrow('空')
    await expect(library.addTrack('fake.mp3', Buffer.from('not audio'))).rejects.toThrow('有効な音声')
    await expect(library.addTrack('huge.mp3', Buffer.alloc(maxBgmTrackBytes + 1))).rejects.toThrow('50 MB')
  })

  it('cleans generated orphan media files left by an interrupted removal', async () => {
    const library = await createLibrary()
    const orphan = path.join(library.dataDir, 'media', 'bgm', '00000000-0000-4000-8000-000000000000.wav')
    await writeFile(orphan, Buffer.from('orphan'))

    await new BgmLibraryStore(library.dataDir).initialize()

    await expect(readFile(orphan)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('exports and restores track files and the selected track', async () => {
    const source = await createLibrary()
    const first = (await source.addTrack('first.mp3', mp3('first'))).tracks[0]
    const second = (await source.addTrack('second.mp3', mp3('second'))).tracks[1]
    await source.selectTrack(second.id)
    const backup = await source.exportBackup()

    const destination = await createLibrary()
    await destination.addTrack('old.mp3', mp3('old'))
    const restored = await destination.importPreparedBackup(destination.prepareBackupImport(backup))

    expect(restored.tracks.map(({ name }) => name)).toEqual(['first', 'second'])
    expect(restored.tracks.find(({ id }) => id === restored.selectedTrackId)?.name).toBe('second')
    expect(restored.tracks.map(({ id }) => id)).not.toContain(first.id)
    await expect(readFile(destination.trackPath(restored.tracks[0]))).resolves.toEqual(mp3('first'))
    await expect(readFile(destination.trackPath(restored.tracks[1]))).resolves.toEqual(mp3('second'))
  })

  it('rejects corrupt backup audio before replacing the current library', async () => {
    const source = await createLibrary()
    const track = (await source.addTrack('first.mp3', mp3('first'))).tracks[0]
    const backup = await source.exportBackup()
    backup.tracks[track.id].data = Buffer.from('not audio').toString('base64')
    backup.library.tracks[0].size = Buffer.byteLength('not audio')

    const destination = await createLibrary()
    const before = await destination.addTrack('keep.mp3', mp3('keep'))

    expect(() => destination.prepareBackupImport(backup)).toThrow('有効な音声')
    expect(await destination.getLibrary()).toEqual(before)
  })

  it('keeps the previous library and files when a prepared import is rolled back', async () => {
    const source = await createLibrary()
    await source.addTrack('incoming.mp3', mp3('incoming'))
    const prepared = source.prepareBackupImport(await source.exportBackup())

    const destination = await createLibrary()
    const previous = await destination.addTrack('keep.mp3', mp3('keep'))
    const previousTrack = previous.tracks[0]
    const transaction = await destination.beginPreparedBackupImport(prepared)
    expect(transaction.library.tracks[0]?.name).toBe('incoming')

    await transaction.rollback()

    expect(await destination.getLibrary()).toEqual(previous)
    await expect(readFile(destination.trackPath(previousTrack))).resolves.toEqual(mp3('keep'))
    await expect(readFile(destination.trackPath(transaction.library.tracks[0]))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retains previous files across restart until new playback can safely release them', async () => {
    const source = await createLibrary()
    await source.addTrack('incoming.mp3', mp3('incoming'))
    const prepared = source.prepareBackupImport(await source.exportBackup())

    const destination = await createLibrary()
    const previous = await destination.addTrack('keep.mp3', mp3('keep'))
    const previousPath = destination.trackPath(previous.tracks[0])
    const transaction = await destination.beginPreparedBackupImport(prepared)
    await transaction.commit({ removePreviousFiles: false })

    await expect(readFile(previousPath)).resolves.toEqual(mp3('keep'))
    const restarted = new BgmLibraryStore(destination.dataDir)
    await restarted.initialize()
    await expect(readFile(previousPath)).resolves.toEqual(mp3('keep'))

    await restarted.releaseRetainedFiles()
    await expect(readFile(previousPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retains a deleted selected track until OBS can switch to another file', async () => {
    const library = await createLibrary()
    const track = (await library.addTrack('playing.mp3', mp3('playing'))).tracks[0]
    await library.selectTrack(track.id)
    const filename = library.trackPath(track)

    const removed = await library.removeTrack(track.id, { retainFile: true })

    expect(removed.library.tracks).toEqual([])
    expect(removed.library.selectedTrackId).toBeNull()
    await expect(readFile(filename)).resolves.toEqual(mp3('playing'))
    await library.releaseRetainedFiles()
    await expect(readFile(filename)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
