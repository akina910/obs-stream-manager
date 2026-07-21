import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { BgmLibrarySchema, type BgmLibrary, type BgmTrack } from '../shared/contracts.js'

export const maxBgmTrackBytes = 50 * 1024 * 1024

type AudioFormat = {
  ext: 'mp3' | 'wav' | 'ogg' | 'flac' | 'm4a'
  mime: BgmTrack['mime']
  matches: (bytes: Uint8Array) => boolean
}

const audioFormats: AudioFormat[] = [
  {
    ext: 'mp3',
    mime: 'audio/mpeg',
    matches: (bytes) => Buffer.from(bytes.subarray(0, 3)).toString('ascii') === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0),
  },
  {
    ext: 'wav',
    mime: 'audio/wav',
    matches: (bytes) => Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF' && Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WAVE',
  },
  { ext: 'ogg', mime: 'audio/ogg', matches: (bytes) => Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'OggS' },
  { ext: 'flac', mime: 'audio/flac', matches: (bytes) => Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'fLaC' },
  { ext: 'm4a', mime: 'audio/mp4', matches: (bytes) => Buffer.from(bytes.subarray(4, 8)).toString('ascii') === 'ftyp' },
]

async function exists(filename: string): Promise<boolean> {
  try { await stat(filename); return true } catch { return false }
}

async function atomicWrite(filename: string, contents: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true })
  const temporary = `${filename}.${process.pid}.tmp`
  await writeFile(temporary, contents)
  await rename(temporary, filename)
}

async function removeFileWithRetry(filename: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(filename, { force: true })
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (!['EBUSY', 'EPERM'].includes(code ?? '') || attempt === 19) throw error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
}

function detectAudioFormat(bytes: Uint8Array): AudioFormat {
  const format = audioFormats.find((candidate) => candidate.matches(bytes))
  if (!format) throw new Error('MP3、WAV、OGG、FLAC、M4Aの有効な音声ファイルを選択してください')
  return format
}

function trackName(originalName: string): { name: string; originalName: string } {
  const safeOriginalName = path.basename(originalName.replaceAll('\\', '/')).trim().slice(0, 255)
  if (!safeOriginalName) throw new Error('BGMのファイル名がありません')
  return {
    originalName: safeOriginalName,
    name: path.parse(safeOriginalName).name.trim().slice(0, 180) || 'BGM',
  }
}

export class BgmLibraryStore {
  private readonly libraryFile: string
  private readonly mediaDirectory: string
  private mutationTail = Promise.resolve()

  constructor(readonly dataDir: string) {
    this.libraryFile = path.join(dataDir, 'database', 'bgm-library.json')
    this.mediaDirectory = path.join(dataDir, 'media', 'bgm')
  }

  async initialize(): Promise<void> {
    await mkdir(this.mediaDirectory, { recursive: true })
    if (!await exists(this.libraryFile)) {
      await atomicWrite(this.libraryFile, JSON.stringify(BgmLibrarySchema.parse({}), null, 2))
      return
    }
    const library = await this.read()
    const tracks: BgmTrack[] = []
    for (const track of library.tracks) {
      if (await exists(this.trackPath(track))) tracks.push(track)
    }
    const selectedTrackId = tracks.some((track) => track.id === library.selectedTrackId) ? library.selectedTrackId : null
    if (tracks.length !== library.tracks.length || selectedTrackId !== library.selectedTrackId) {
      await this.write({ version: 1, tracks, selectedTrackId })
    }
    const trackedFiles = new Set(tracks.map((track) => track.filename))
    for (const filename of await readdir(this.mediaDirectory)) {
      if (/^[0-9a-f-]+\.(mp3|wav|ogg|flac|m4a)$/.test(filename) && !trackedFiles.has(filename)) {
        await removeFileWithRetry(path.join(this.mediaDirectory, filename)).catch(() => undefined)
      }
    }
  }

  async getLibrary(): Promise<BgmLibrary> {
    return this.read()
  }

  async getTrack(id: string): Promise<BgmTrack | null> {
    return (await this.read()).tracks.find((track) => track.id === id) ?? null
  }

  trackPath(track: BgmTrack): string {
    return path.join(this.mediaDirectory, path.basename(track.filename))
  }

  async addTrack(originalName: string, bytes: Uint8Array): Promise<BgmLibrary> {
    if (bytes.byteLength === 0) throw new Error('BGMファイルが空です')
    if (bytes.byteLength > maxBgmTrackBytes) throw new Error('BGMは50 MB以下にしてください')
    const format = detectAudioFormat(bytes)
    const names = trackName(originalName)
    return this.mutate(async (library) => {
      const id = randomUUID()
      const track: BgmTrack = {
        id,
        ...names,
        filename: `${id}.${format.ext}`,
        mime: format.mime,
        size: bytes.byteLength,
        addedAt: new Date().toISOString(),
      }
      await atomicWrite(this.trackPath(track), bytes)
      return { version: 1, tracks: [...library.tracks, track], selectedTrackId: library.selectedTrackId }
    })
  }

  async selectTrack(id: string): Promise<BgmLibrary> {
    return this.mutate(async (library) => {
      if (!library.tracks.some((track) => track.id === id)) throw Object.assign(new Error('BGMが見つかりません'), { statusCode: 404 })
      return { ...library, selectedTrackId: id }
    })
  }

  async removeTrack(id: string): Promise<{ library: BgmLibrary; removed: BgmTrack; wasSelected: boolean }> {
    let removed: BgmTrack | null = null
    let wasSelected = false
    const library = await this.mutate(async (latest) => {
      removed = latest.tracks.find((track) => track.id === id) ?? null
      if (!removed) throw Object.assign(new Error('BGMが見つかりません'), { statusCode: 404 })
      wasSelected = latest.selectedTrackId === id
      await removeFileWithRetry(this.trackPath(removed))
      return {
        version: 1,
        tracks: latest.tracks.filter((track) => track.id !== id),
        selectedTrackId: wasSelected ? null : latest.selectedTrackId,
      }
    })
    if (!removed) throw Object.assign(new Error('BGMが見つかりません'), { statusCode: 404 })
    return { library, removed, wasSelected }
  }

  private async read(): Promise<BgmLibrary> {
    return BgmLibrarySchema.parse(JSON.parse(await readFile(this.libraryFile, 'utf8')))
  }

  private async write(library: BgmLibrary): Promise<BgmLibrary> {
    const parsed = BgmLibrarySchema.parse(library)
    await atomicWrite(this.libraryFile, JSON.stringify(parsed, null, 2))
    return parsed
  }

  private async mutate(operation: (library: BgmLibrary) => Promise<BgmLibrary>): Promise<BgmLibrary> {
    const previous = this.mutationTail
    let release!: () => void
    this.mutationTail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      return await this.write(await operation(await this.read()))
    } finally {
      release()
    }
  }
}
