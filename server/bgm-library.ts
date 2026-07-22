import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { BgmLibrarySchema, type BgmBackup, type BgmLibrary, type BgmTrack } from '../shared/contracts.js'

export const maxBgmTrackBytes = 50 * 1024 * 1024
export const maxBgmBackupBytes = 150 * 1024 * 1024
export const maxBackupRequestBytes = Math.ceil(maxBgmBackupBytes / 3) * 4 + 32 * 1024 * 1024

type PreparedBgmBackup = {
  library: BgmLibrary
  files: Map<string, Buffer>
}

export type BgmImportTransaction = {
  library: BgmLibrary
  commit: (options?: { removePreviousFiles?: boolean }) => Promise<void>
  rollback: () => Promise<void>
}

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
  private readonly retainedFilesFile: string
  private mutationTail = Promise.resolve()

  constructor(readonly dataDir: string) {
    this.libraryFile = path.join(dataDir, 'database', 'bgm-library.json')
    this.mediaDirectory = path.join(dataDir, 'media', 'bgm')
    this.retainedFilesFile = path.join(dataDir, 'database', 'bgm-retained-files.json')
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
    const retainedFiles = await this.readRetainedFiles()
    const trackedFiles = new Set([...tracks.map((track) => track.filename), ...retainedFiles])
    for (const filename of await readdir(this.mediaDirectory)) {
      if (/^[0-9a-f-]+\.(mp3|wav|ogg|flac|m4a)$/.test(filename) && !trackedFiles.has(filename)) {
        await removeFileWithRetry(path.join(this.mediaDirectory, filename)).catch(() => undefined)
      }
    }
    const retainedExisting: string[] = []
    for (const filename of retainedFiles) {
      if (tracks.every((track) => track.filename !== filename) && await exists(path.join(this.mediaDirectory, filename))) retainedExisting.push(filename)
    }
    await this.writeRetainedFiles(retainedExisting)
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

  async removeTrack(id: string, { retainFile = false }: { retainFile?: boolean } = {}): Promise<{ library: BgmLibrary; removed: BgmTrack; wasSelected: boolean }> {
    let removed: BgmTrack | null = null
    let wasSelected = false
    const library = await this.mutate(async (latest) => {
      removed = latest.tracks.find((track) => track.id === id) ?? null
      if (!removed) throw Object.assign(new Error('BGMが見つかりません'), { statusCode: 404 })
      wasSelected = latest.selectedTrackId === id
      if (retainFile) await this.retainFiles([removed.filename])
      else await removeFileWithRetry(this.trackPath(removed))
      return {
        version: 1,
        tracks: latest.tracks.filter((track) => track.id !== id),
        selectedTrackId: wasSelected ? null : latest.selectedTrackId,
      }
    })
    if (!removed) throw Object.assign(new Error('BGMが見つかりません'), { statusCode: 404 })
    return { library, removed, wasSelected }
  }

  async releaseRetainedFiles(): Promise<void> {
    await this.withMutationLock(async () => this.releaseRetainedFilesUnlocked())
  }

  async exportBackup(): Promise<BgmBackup> {
    return this.withMutationLock(async () => {
      const library = await this.read()
      const tracks: BgmBackup['tracks'] = {}
      let totalBytes = 0
      for (const track of library.tracks) {
        const bytes = await readFile(this.trackPath(track))
        if (bytes.byteLength !== track.size) throw new Error(`BGM「${track.name}」のファイルサイズが保存情報と一致しません`)
        totalBytes += bytes.byteLength
        if (totalBytes > maxBgmBackupBytes) throw new Error('BGMの合計容量が150 MBを超えているため、バックアップを書き出せません。曲を減らしてから再実行してください')
        tracks[track.id] = { data: bytes.toString('base64') }
      }
      return { version: 1, library, tracks }
    })
  }

  prepareBackupImport(value: unknown): PreparedBgmBackup {
    if (!value || typeof value !== 'object') throw new Error('Invalid BGM backup')
    const raw = value as Record<string, unknown>
    if (raw.version !== 1 || !raw.tracks || typeof raw.tracks !== 'object' || Array.isArray(raw.tracks)) throw new Error('Unsupported BGM backup version')
    const library = BgmLibrarySchema.parse(raw.library)
    if (library.selectedTrackId && !library.tracks.some(({ id }) => id === library.selectedTrackId)) throw new Error('Invalid selected BGM track in backup')
    const rawTracks = raw.tracks as Record<string, unknown>
    const expectedIds = new Set(library.tracks.map(({ id }) => id))
    if (Object.keys(rawTracks).some((id) => !expectedIds.has(id))) throw new Error('Unexpected BGM file in backup')
    const files = new Map<string, Buffer>()
    let totalBytes = 0
    for (const track of library.tracks) {
      const rawFile = rawTracks[track.id]
      if (!rawFile || typeof rawFile !== 'object' || Array.isArray(rawFile)) throw new Error(`Missing BGM file in backup: ${track.name}`)
      const data = (rawFile as Record<string, unknown>).data
      if (typeof data !== 'string' || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error(`Invalid BGM data in backup: ${track.name}`)
      const bytes = Buffer.from(data, 'base64')
      if (bytes.byteLength === 0 || bytes.byteLength > maxBgmTrackBytes || bytes.byteLength !== track.size) throw new Error(`Invalid BGM size in backup: ${track.name}`)
      const format = detectAudioFormat(bytes)
      if (format.mime !== track.mime || path.extname(track.filename).toLowerCase() !== `.${format.ext}`) throw new Error(`BGM format does not match backup metadata: ${track.name}`)
      totalBytes += bytes.byteLength
      if (totalBytes > maxBgmBackupBytes) throw new Error('BGMの合計容量が150 MBを超えているため、バックアップを復元できません')
      files.set(track.id, bytes)
    }
    return { library, files }
  }

  async importPreparedBackup(prepared: PreparedBgmBackup): Promise<BgmLibrary> {
    const transaction = await this.beginPreparedBackupImport(prepared)
    await transaction.commit()
    return transaction.library
  }

  async beginPreparedBackupImport(prepared: PreparedBgmBackup): Promise<BgmImportTransaction> {
    const release = await this.acquireMutationLock()
    const importedFiles: string[] = []
    try {
      const previous = await this.read()
      const idMap = new Map<string, string>()
      const tracks: BgmTrack[] = []
      for (const track of prepared.library.tracks) {
        const bytes = prepared.files.get(track.id)
        if (!bytes) throw new Error(`Missing prepared BGM file: ${track.name}`)
        const id = randomUUID()
        const filename = `${id}${path.extname(track.filename).toLowerCase()}`
        const imported = { ...track, id, filename }
        await atomicWrite(this.trackPath(imported), bytes)
        importedFiles.push(this.trackPath(imported))
        idMap.set(track.id, id)
        tracks.push(imported)
      }
      const selectedTrackId = prepared.library.selectedTrackId ? idMap.get(prepared.library.selectedTrackId) ?? null : null
      const saved = await this.write({ version: 1, tracks, selectedTrackId })
      let finished = false
      return {
        library: saved,
        commit: async ({ removePreviousFiles = true } = {}) => {
          if (finished) return
          if (!removePreviousFiles) await this.retainFiles(previous.tracks.map(({ filename }) => filename))
          if (removePreviousFiles) {
            try {
              const activeFiles = new Set(saved.tracks.map(({ filename }) => filename))
              for (const track of previous.tracks) {
                if (!activeFiles.has(track.filename)) await removeFileWithRetry(this.trackPath(track)).catch(() => undefined)
              }
              await this.releaseRetainedFilesUnlocked()
            } catch {
              // The new library is already committed. Cleanup remains best-effort
              // and retained files can be released after the next successful play.
            }
          }
          finished = true
          release()
        },
        rollback: async () => {
          if (finished) return
          finished = true
          let restored = false
          try {
            await this.write(previous)
            restored = true
            for (const filename of importedFiles) await removeFileWithRetry(filename).catch(() => undefined)
          } finally {
            release()
          }
          if (!restored) throw new Error('BGMライブラリのロールバックに失敗しました')
        },
      }
    } catch (error) {
      for (const filename of importedFiles) await removeFileWithRetry(filename).catch(() => undefined)
      release()
      throw error
    }
  }

  private async read(): Promise<BgmLibrary> {
    return BgmLibrarySchema.parse(JSON.parse(await readFile(this.libraryFile, 'utf8')))
  }

  private async readRetainedFiles(): Promise<string[]> {
    if (!await exists(this.retainedFilesFile)) return []
    try {
      const value = JSON.parse(await readFile(this.retainedFilesFile, 'utf8')) as unknown
      if (!Array.isArray(value)) return []
      return [...new Set(value.filter((filename): filename is string => typeof filename === 'string' && /^[0-9a-f-]+\.(mp3|wav|ogg|flac|m4a)$/.test(filename)))]
    } catch {
      return []
    }
  }

  private async writeRetainedFiles(filenames: string[]): Promise<void> {
    await atomicWrite(this.retainedFilesFile, JSON.stringify([...new Set(filenames)].sort(), null, 2))
  }

  private async retainFiles(filenames: string[]): Promise<void> {
    await this.writeRetainedFiles([...(await this.readRetainedFiles()), ...filenames])
  }

  private async releaseRetainedFilesUnlocked(): Promise<void> {
    const remaining: string[] = []
    for (const filename of await this.readRetainedFiles()) {
      try {
        await removeFileWithRetry(path.join(this.mediaDirectory, filename))
      } catch {
        remaining.push(filename)
      }
    }
    await this.writeRetainedFiles(remaining)
  }

  private async write(library: BgmLibrary): Promise<BgmLibrary> {
    const parsed = BgmLibrarySchema.parse(library)
    await atomicWrite(this.libraryFile, JSON.stringify(parsed, null, 2))
    return parsed
  }

  private async mutate(operation: (library: BgmLibrary) => Promise<BgmLibrary>): Promise<BgmLibrary> {
    return this.withMutationLock(async () => this.write(await operation(await this.read())))
  }

  private async withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.acquireMutationLock()
    try {
      return await operation()
    } finally {
      release()
    }
  }

  private async acquireMutationLock(): Promise<() => void> {
    const previous = this.mutationTail
    let release!: () => void
    this.mutationTail = new Promise<void>((resolve) => { release = resolve })
    await previous
    let released = false
    return () => {
      if (released) return
      released = true
      release()
    }
  }
}
