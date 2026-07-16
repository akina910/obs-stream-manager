import { execFile } from 'node:child_process'
import { access, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type InstalledSteamGame = { appId: number; name: string; installDir: string }
export type SteamLibraryScan = { games: InstalledSteamGame[]; libraries: string[]; warnings: string[] }
export type SteamOwnedGame = { appId: number; name: string }
export type SteamAccountLibraryScan = SteamLibraryScan & {
  ownedGames: SteamOwnedGame[]
  cachedAppIds: number[]
}

type VdfObject = { [key: string]: string | number | VdfObject }
type SteamMetadataResult = { kind: 'game'; name: string } | { kind: 'not_game' } | { kind: 'unknown' }
export type SteamAppInfoEntry = { appId: number; name?: string; type?: string }

const ignoredLocalApps = new Set([228980]) // Steamworks Common Redistributables

function uniquePaths(values: string[]): string[] {
  const found = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const cleaned = value.trim().replace(/^"|"$/g, '')
    if (!cleaned) continue
    const normalized = path.normalize(cleaned)
    if (normalized === '.' || found.has(normalized.toLowerCase())) continue
    found.add(normalized.toLowerCase())
    result.push(normalized)
  }
  return result
}

async function directoryExists(filename: string): Promise<boolean> {
  try { await access(filename); return true } catch { return false }
}

async function registryValue(key: string, name: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('reg.exe', ['query', key, '/v', name], { windowsHide: true })
    return stdout.split(/\r?\n/).map((line) => line.match(/\sREG_\w+\s+(.+)$/)?.[1]?.trim()).find(Boolean)
  } catch {
    return undefined
  }
}

async function detectedSteamRoots(configuredPath = '', includeRegistry = true): Promise<string[]> {
  const candidates = [configuredPath]
  if (process.platform === 'win32' && includeRegistry) {
    const registry = await Promise.all([
      registryValue('HKCU\\Software\\Valve\\Steam', 'SteamPath'),
      registryValue('HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath'),
      registryValue('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'),
    ])
    candidates.push(...registry.filter((value): value is string => Boolean(value)))
    candidates.push(
      path.join(process.env['ProgramFiles(x86)'] ?? '', 'Steam'),
      path.join(process.env.ProgramFiles ?? '', 'Steam'),
    )
  }
  const roots = uniquePaths(candidates.filter(Boolean).map((value) => value.replaceAll('/', path.sep)))
  const valid: string[] = []
  for (const root of roots) if (await directoryExists(path.join(root, 'steamapps'))) valid.push(root)
  return valid
}

function parseValveData(contents: string): VdfObject {
  const tokens: string[] = []
  for (const match of contents.matchAll(/"((?:\\.|[^"])*)"|([{}])/g)) {
    tokens.push(match[2] ?? match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'))
  }
  let index = 0
  const parseObject = (stopAtBrace: boolean): VdfObject => {
    const result: VdfObject = {}
    while (index < tokens.length) {
      const key = tokens[index++]
      if (key === '}') break
      if (key === '{') continue
      const value = tokens[index++]
      if (value === '{') result[key] = parseObject(true)
      else if (value !== undefined && value !== '}') result[key] = value
      else if (value === '}' && stopAtBrace) break
    }
    return result
  }
  return parseObject(false)
}

function vdfChild(parent: VdfObject | undefined, key: string): VdfObject | undefined {
  if (!parent) return undefined
  const actual = Object.keys(parent).find((candidate) => candidate.toLowerCase() === key.toLowerCase())
  const value = actual ? parent[actual] : undefined
  return value && typeof value === 'object' ? value : undefined
}

function vdfString(parent: VdfObject | undefined, key: string): string | undefined {
  if (!parent) return undefined
  const actual = Object.keys(parent).find((candidate) => candidate.toLowerCase() === key.toLowerCase())
  const value = actual ? parent[actual] : undefined
  return typeof value === 'string' ? value : undefined
}

export function parseSteamLocalConfigAppIds(contents: string): number[] {
  const root = parseValveData(contents)
  const apps = vdfChild(
    vdfChild(vdfChild(vdfChild(vdfChild(root, 'UserLocalConfigStore'), 'Software'), 'Valve'), 'Steam'),
    'apps',
  )
  if (!apps) return []
  return Object.keys(apps)
    .map(Number)
    .filter((appId) => Number.isSafeInteger(appId) && appId > 0 && appId <= 0x7fff_ffff && !ignoredLocalApps.has(appId))
    .sort((a, b) => a - b)
}

export function parseSteamLoginUserAccountIds(contents: string): string[] {
  const users = vdfChild(parseValveData(contents), 'users')
  if (!users) return []
  const accountIds = Object.entries(users).flatMap(([steamId, value]) => {
    if (!/^\d{17}$/.test(steamId) || typeof value !== 'object') return []
    try {
      const accountId = BigInt(steamId) - 76_561_197_960_265_728n
      if (accountId <= 0n || accountId > 4_294_967_295n) return []
      return [{ accountId: accountId.toString(), mostRecent: vdfString(value, 'MostRecent') === '1' }]
    } catch {
      return []
    }
  })
  return accountIds.sort((a, b) => Number(b.mostRecent) - Number(a.mostRecent)).map((entry) => entry.accountId)
}

function readNullTerminated(buffer: Buffer, cursor: { offset: number }, encoding: BufferEncoding = 'utf8'): string {
  const terminatorSize = encoding === 'utf16le' ? 2 : 1
  let end = cursor.offset
  while (end + terminatorSize <= buffer.length) {
    if (encoding === 'utf16le' ? buffer.readUInt16LE(end) === 0 : buffer[end] === 0) break
    end += terminatorSize
  }
  const value = buffer.toString(encoding, cursor.offset, end)
  cursor.offset = Math.min(buffer.length, end + terminatorSize)
  return value
}

function parseBinaryValveData(buffer: Buffer, offset: number, limit: number, stringTable?: string[]): VdfObject {
  const cursor = { offset }
  const parseObject = (depth: number): VdfObject => {
    if (depth > 64) throw new Error('Steam app metadata is nested too deeply')
    const result: VdfObject = {}
    while (cursor.offset < limit) {
      const type = buffer.readUInt8(cursor.offset++)
      if (type === 8 || type === 11) return result
      const key = stringTable
        ? stringTable[buffer.readInt32LE((cursor.offset += 4) - 4)]
        : readNullTerminated(buffer, cursor)
      if (key === undefined) throw new Error('Steam app metadata contains an invalid string-table reference')
      switch (type) {
        case 0: result[key] = parseObject(depth + 1); break
        case 1: result[key] = readNullTerminated(buffer, cursor); break
        case 2:
        case 4:
        case 6: result[key] = buffer.readInt32LE((cursor.offset += 4) - 4); break
        case 3: result[key] = buffer.readFloatLE((cursor.offset += 4) - 4); break
        case 5: result[key] = readNullTerminated(buffer, cursor, 'utf16le'); break
        case 7: result[key] = buffer.readBigUInt64LE((cursor.offset += 8) - 8).toString(); break
        case 10: result[key] = buffer.readBigInt64LE((cursor.offset += 8) - 8).toString(); break
        default: throw new Error(`Unsupported Steam binary metadata type: ${type}`)
      }
    }
    return result
  }
  return parseObject(0)
}

export function parseSteamAppInfo(contents: Buffer): Map<number, SteamAppInfoEntry> {
  const entries = new Map<number, SteamAppInfoEntry>()
  if (contents.length < 8) return entries
  const magic = contents.readUInt32LE(0)
  const version = magic & 0xff
  if ((magic >>> 8) !== 0x07_56_44 || version < 39 || version > 41) return entries
  let offset = 8
  let stringTable: string[] | undefined
  let entriesLimit = contents.length
  if (version >= 41) {
    const tableOffset = Number(contents.readBigInt64LE(offset))
    offset += 8
    if (!Number.isSafeInteger(tableOffset) || tableOffset < offset || tableOffset + 4 > contents.length) return entries
    entriesLimit = tableOffset
    const cursor = { offset: tableOffset }
    const stringCount = contents.readUInt32LE(cursor.offset)
    cursor.offset += 4
    stringTable = []
    for (let index = 0; index < stringCount && cursor.offset < contents.length; index += 1) stringTable.push(readNullTerminated(contents, cursor))
  }
  while (offset + 8 <= entriesLimit) {
    const appId = contents.readUInt32LE(offset)
    offset += 4
    if (appId === 0) break
    const size = contents.readUInt32LE(offset)
    offset += 4
    const end = offset + size
    const metadataSize = 4 + 4 + 8 + 20 + 4 + (version >= 40 ? 20 : 0)
    if (end > entriesLimit || offset + metadataSize > end) break
    const dataOffset = offset + metadataSize
    try {
      const data = parseBinaryValveData(contents, dataOffset, end, stringTable)
      const appInfo = vdfChild(data, 'appinfo') ?? data
      const common = vdfChild(appInfo, 'common')
      entries.set(appId, { appId, name: vdfString(common, 'name'), type: vdfString(common, 'type') })
    } catch {
      entries.set(appId, { appId })
    }
    offset = end
  }
  return entries
}

export function parseSteamLibraryPaths(contents: string): string[] {
  const paths: string[] = []
  const pattern = /"path"\s+"((?:\\.|[^"])*)"/gi
  for (const match of contents.matchAll(pattern)) paths.push(match[1].replace(/\\\\/g, '\\').replace(/\\"/g, '"'))
  return uniquePaths(paths)
}

export function parseSteamAppManifest(contents: string, libraryRoot: string): InstalledSteamGame | null {
  const value = (key: string) => contents.match(new RegExp(`"${key}"\\s+"([^"]*)"`, 'i'))?.[1]?.trim() ?? ''
  const appId = Number(value('appid'))
  const name = value('name')
  const installDirectory = value('installdir')
  if (!Number.isInteger(appId) || appId <= 0 || !name || !installDirectory || ignoredLocalApps.has(appId)) return null
  return { appId, name, installDir: path.join(libraryRoot, 'steamapps', 'common', installDirectory) }
}

export async function scanSteamLibraries(configuredPath = '', options: { includeRegistry?: boolean; extraRoots?: string[] } = {}): Promise<SteamLibraryScan> {
  const warnings: string[] = []
  const roots = uniquePaths([
    ...await detectedSteamRoots(configuredPath, options.includeRegistry ?? true),
    ...(options.extraRoots ?? []),
  ])
  const libraryCandidates = [...roots]
  for (const root of roots) {
    try {
      libraryCandidates.push(...parseSteamLibraryPaths(await readFile(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8')))
    } catch {
      // A valid Steam root can exist without an additional-library file.
    }
  }
  const libraries: string[] = []
  for (const candidate of uniquePaths(libraryCandidates)) {
    if (await directoryExists(path.join(candidate, 'steamapps'))) libraries.push(candidate)
  }

  const games = new Map<number, InstalledSteamGame>()
  for (const library of libraries) {
    const steamApps = path.join(library, 'steamapps')
    let manifests: string[]
    try {
      manifests = (await readdir(steamApps)).filter((file) => /^appmanifest_\d+\.acf$/i.test(file))
    } catch (error) {
      warnings.push(`${library}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    for (const manifest of manifests) {
      try {
        const game = parseSteamAppManifest(await readFile(path.join(steamApps, manifest), 'utf8'), library)
        if (game && await directoryExists(game.installDir)) games.set(game.appId, game)
      } catch (error) {
        warnings.push(`${manifest}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  return { games: [...games.values()].sort((a, b) => a.name.localeCompare(b.name, 'ja')), libraries, warnings }
}

async function steamUserDataDirectories(root: string): Promise<string[]> {
  const userDataRoot = path.join(root, 'userdata')
  let preferredAccountIds: string[] = []
  try {
    preferredAccountIds = parseSteamLoginUserAccountIds(await readFile(path.join(root, 'config', 'loginusers.vdf'), 'utf8'))
  } catch {
    // Older or portable Steam installations may not have loginusers.vdf.
  }
  for (const accountId of preferredAccountIds) {
    const candidate = path.join(userDataRoot, accountId)
    if (await directoryExists(candidate)) return [candidate]
  }
  try {
    const accountIds = (await readdir(userDataRoot)).filter((name) => /^\d+$/.test(name))
    return accountIds.map((accountId) => path.join(userDataRoot, accountId))
  } catch {
    return []
  }
}

async function cachedSteamAppIds(root: string): Promise<number[]> {
  const appIds = new Set<number>()
  for (const userDirectory of await steamUserDataDirectories(root)) {
    try {
      for (const filename of await readdir(path.join(userDirectory, 'config', 'librarycache'))) {
        const match = filename.match(/^(\d+)\.json$/i)
        const appId = Number(match?.[1])
        if (Number.isSafeInteger(appId) && appId > 0 && appId <= 0x7fff_ffff && !ignoredLocalApps.has(appId)) appIds.add(appId)
      }
    } catch {
      // librarycache is created only after Steam has opened the Library view.
    }
    try {
      for (const appId of parseSteamLocalConfigAppIds(await readFile(path.join(userDirectory, 'config', 'localconfig.vdf'), 'utf8'))) appIds.add(appId)
    } catch {
      // The library cache alone is enough on current Steam versions.
    }
  }
  return [...appIds].sort((a, b) => a - b)
}

async function fetchSteamMetadata(appId: number, fetchImpl: typeof fetch, timeoutMs: number, storeLanguage: 'japanese' | 'english'): Promise<SteamMetadataResult> {
  const url = new URL('https://store.steampowered.com/api/appdetails')
  url.search = new URLSearchParams({ appids: String(appId), l: storeLanguage, cc: 'JP' }).toString()
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(url, { signal: controller.signal, headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload: unknown = await response.json()
      if (!payload || typeof payload !== 'object') return { kind: 'unknown' }
      const entry = (payload as Record<string, unknown>)[String(appId)]
      if (!entry || typeof entry !== 'object') return { kind: 'unknown' }
      const success = (entry as Record<string, unknown>).success
      const data = (entry as Record<string, unknown>).data
      if (success !== true || !data || typeof data !== 'object') return { kind: 'unknown' }
      const type = (data as Record<string, unknown>).type
      if (type !== 'game') return { kind: 'not_game' }
      const name = (data as Record<string, unknown>).name
      return typeof name === 'string' && name.trim() ? { kind: 'game', name: name.trim() } : { kind: 'unknown' }
    } catch {
      if (attempt === 1) return { kind: 'unknown' }
    } finally {
      clearTimeout(timeout)
    }
  }
  return { kind: 'unknown' }
}

export async function scanSteamAccountLibrary(
  configuredPath = '',
  options: {
    includeRegistry?: boolean
    extraRoots?: string[]
    knownGames?: SteamOwnedGame[]
    fetchImpl?: typeof fetch
    metadataConcurrency?: number
    metadataTimeoutMs?: number
    storeLanguage?: 'japanese' | 'english'
  } = {},
): Promise<SteamAccountLibraryScan> {
  const installed = await scanSteamLibraries(configuredPath, options)
  const roots = uniquePaths([
    ...await detectedSteamRoots(configuredPath, options.includeRegistry ?? true),
    ...(options.extraRoots ?? []),
  ])
  const appIds = new Set(installed.games.map((game) => game.appId))
  for (const root of roots) for (const appId of await cachedSteamAppIds(root)) appIds.add(appId)

  const localMetadata = new Map<number, SteamAppInfoEntry>()
  for (const root of roots) {
    try {
      for (const [appId, metadata] of parseSteamAppInfo(await readFile(path.join(root, 'appcache', 'appinfo.vdf')))) localMetadata.set(appId, metadata)
    } catch {
      // Store metadata remains available as a fallback if appinfo.vdf is missing or being replaced by Steam.
    }
  }

  const knownNames = new Map<number, string>()
  for (const game of options.knownGames ?? []) {
    if (!/^Steam App \d+$/i.test(game.name.trim())) knownNames.set(game.appId, game.name.trim())
  }
  for (const game of installed.games) knownNames.set(game.appId, game.name)

  const owned = new Map<number, SteamOwnedGame>()
  const installedIds = new Set(installed.games.map((game) => game.appId))
  const gameAppIds = [...appIds].filter((appId) => {
    const type = localMetadata.get(appId)?.type?.toLowerCase()
    return installedIds.has(appId) || !type || type === 'game'
  })
  for (const appId of gameAppIds) {
    const name = knownNames.get(appId) ?? localMetadata.get(appId)?.name?.trim()
    if (name) owned.set(appId, { appId, name })
  }
  const unresolved = gameAppIds.filter((appId) => !owned.has(appId))
  let fallbackCount = 0
  let nextIndex = 0
  const fetchImpl = options.fetchImpl ?? fetch
  const worker = async () => {
    while (nextIndex < unresolved.length) {
      const appId = unresolved[nextIndex++]
      const metadata = await fetchSteamMetadata(appId, fetchImpl, options.metadataTimeoutMs ?? 10_000, options.storeLanguage ?? 'japanese')
      if (metadata.kind === 'game') owned.set(appId, { appId, name: metadata.name })
      if (metadata.kind === 'unknown') {
        owned.set(appId, { appId, name: `Steam App ${appId}` })
        fallbackCount += 1
      }
    }
  }
  const concurrency = Math.max(1, Math.min(options.metadataConcurrency ?? 6, 12, unresolved.length || 1))
  await Promise.all(Array.from({ length: concurrency }, worker))

  const warnings = [...installed.warnings]
  if (roots.length && appIds.size === installed.games.length) warnings.push('Steamの所有ゲームキャッシュが見つかりません。Steamを起動してライブラリを一度開いてから再スキャンしてください。')
  if (fallbackCount) warnings.push(`Steamからゲーム名を取得できなかった${fallbackCount}件はApp IDで追加しました。再スキャン時に再取得します。`)
  return {
    ...installed,
    ownedGames: [...owned.values()].sort((a, b) => a.name.localeCompare(b.name, 'ja')),
    cachedAppIds: [...appIds].sort((a, b) => a - b),
    warnings,
  }
}
