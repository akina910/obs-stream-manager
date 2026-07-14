import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseSteamAppManifest, parseSteamLibraryPaths, scanSteamLibraries } from './steam-library.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('Steam library auto-detection', () => {
  it('parses escaped library paths and app manifests', () => {
    expect(parseSteamLibraryPaths('"path" "D:\\\\SteamLibrary"')).toEqual([path.normalize('D:\\SteamLibrary')])
    expect(parseSteamLibraryPaths('"path" ""')).toEqual([])
    expect(parseSteamAppManifest('"appid" "123"\n"name" "Test Game"\n"installdir" "Test Game"', 'D:\\SteamLibrary')).toEqual({
      appId: 123,
      name: 'Test Game',
      installDir: path.join('D:\\SteamLibrary', 'steamapps', 'common', 'Test Game'),
    })
    expect(parseSteamAppManifest('"appid" "228980"\n"name" "Steamworks Common Redistributables"\n"installdir" "Steamworks Shared"', 'D:\\SteamLibrary')).toBeNull()
  })

  it('discovers every configured Steam library and skips missing installs', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'steam-root-'))
    const secondary = await mkdtemp(path.join(os.tmpdir(), 'steam-library-'))
    temporaryDirectories.push(root, secondary)
    await Promise.all([
      mkdir(path.join(root, 'steamapps', 'common', 'Root Game'), { recursive: true }),
      mkdir(path.join(secondary, 'steamapps', 'common', 'Second Game'), { recursive: true }),
    ])
    const escapedSecondary = secondary.replaceAll('\\', '\\\\')
    await Promise.all([
      writeFile(path.join(root, 'steamapps', 'libraryfolders.vdf'), `"libraryfolders" { "1" { "path" "${escapedSecondary}" } }`),
      writeFile(path.join(root, 'steamapps', 'appmanifest_100.acf'), '"AppState" { "appid" "100" "name" "Root Game" "installdir" "Root Game" }'),
      writeFile(path.join(root, 'steamapps', 'appmanifest_999.acf'), '"AppState" { "appid" "999" "name" "Missing Game" "installdir" "Missing Game" }'),
      writeFile(path.join(secondary, 'steamapps', 'appmanifest_200.acf'), '"AppState" { "appid" "200" "name" "Second Game" "installdir" "Second Game" }'),
    ])

    const result = await scanSteamLibraries(root, { includeRegistry: false })

    expect(result.libraries).toEqual(expect.arrayContaining([path.normalize(root), path.normalize(secondary)]))
    expect(result.games.map((game) => game.appId).sort()).toEqual([100, 200])
    expect(result.warnings).toEqual([])
  })
})
