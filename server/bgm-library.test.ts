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
})
