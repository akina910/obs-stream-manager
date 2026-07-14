import { execFile } from 'node:child_process'
import { access, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type InstalledSteamGame = { appId: number; name: string; installDir: string }
export type SteamLibraryScan = { games: InstalledSteamGame[]; libraries: string[]; warnings: string[] }

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
