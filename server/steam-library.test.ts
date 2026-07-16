import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  parseSteamAppManifest,
  parseSteamAppInfo,
  parseSteamLibraryPaths,
  parseSteamLocalConfigAppIds,
  parseSteamLoginUserAccountIds,
  scanSteamAccountLibrary,
  scanSteamLibraries,
} from './steam-library.js'

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

  it('finds cached apps for the most recently signed-in Steam account', () => {
    expect(parseSteamLoginUserAccountIds(`"users" { "76561198339385884" { "MostRecent" "1" } "76561198000000001" { "MostRecent" "0" } }`)).toEqual(['379120156', '39734273'])
    expect(parseSteamLocalConfigAppIds(`"UserLocalConfigStore" { "Software" { "Valve" { "Steam" { "apps" { "100" { "LastPlayed" "1" } "200" { } "228980" { } } } } } }`)).toEqual([100, 200])
  })

  it('reads names and types from the current Steam appinfo format', () => {
    const strings = ['appinfo', 'common', 'name', 'type']
    const stringCount = Buffer.alloc(4)
    stringCount.writeUInt32LE(strings.length)
    const stringTable = Buffer.concat([
      stringCount,
      ...strings.map((value) => Buffer.from(`${value}\0`)),
    ])
    const key = (type: number, index: number) => {
      const value = Buffer.alloc(5)
      value.writeUInt8(type, 0)
      value.writeInt32LE(index, 1)
      return value
    }
    const data = Buffer.concat([
      key(0, 0),
      key(0, 1),
      key(1, 2), Buffer.from('Fixture Game\0'),
      key(1, 3), Buffer.from('Game\0'),
      Buffer.from([8, 8, 8]),
    ])
    const metadata = Buffer.alloc(60)
    const entry = Buffer.alloc(8)
    entry.writeUInt32LE(1234, 0)
    entry.writeUInt32LE(metadata.length + data.length, 4)
    const prefix = Buffer.alloc(16)
    prefix.writeUInt32LE(0x07564429, 0)
    prefix.writeUInt32LE(1, 4)
    prefix.writeBigInt64LE(BigInt(prefix.length + entry.length + metadata.length + data.length + 4), 8)
    const contents = Buffer.concat([prefix, entry, metadata, data, Buffer.alloc(4), stringTable])

    expect(parseSteamAppInfo(contents).get(1234)).toEqual({ appId: 1234, name: 'Fixture Game', type: 'Game' })
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

  it('imports installed and uninstalled games from the signed-in Steam client cache', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'steam-account-'))
    temporaryDirectories.push(root)
    const accountConfig = path.join(root, 'userdata', '379120156', 'config')
    await Promise.all([
      mkdir(path.join(root, 'steamapps', 'common', 'Installed Game'), { recursive: true }),
      mkdir(path.join(root, 'config'), { recursive: true }),
      mkdir(path.join(accountConfig, 'librarycache'), { recursive: true }),
    ])
    await Promise.all([
      writeFile(path.join(root, 'config', 'loginusers.vdf'), `"users" { "76561198339385884" { "MostRecent" "1" } }`),
      writeFile(path.join(accountConfig, 'librarycache', '100.json'), '{}'),
      writeFile(path.join(accountConfig, 'librarycache', '200.json'), '{}'),
      writeFile(path.join(accountConfig, 'librarycache', '500.json'), '{}'),
      writeFile(path.join(accountConfig, 'localconfig.vdf'), `"UserLocalConfigStore" { "Software" { "Valve" { "Steam" { "apps" { "300" { } } } } } }`),
      writeFile(path.join(root, 'steamapps', 'appmanifest_400.acf'), '"AppState" { "appid" "400" "name" "Installed Game" "installdir" "Installed Game" }'),
    ])
    const requestedLanguages: string[] = []
    const fetchImpl = async (input: string | URL | Request) => {
      const requestUrl = new URL(String(input))
      const appId = Number(requestUrl.searchParams.get('appids'))
      requestedLanguages.push(requestUrl.searchParams.get('l') ?? '')
      const metadata: Record<number, { success: boolean; data?: { type: string; name: string } }> = {
        100: { success: true, data: { type: 'game', name: 'Cloud Game' } },
        200: { success: true, data: { type: 'dlc', name: 'Cloud DLC' } },
        300: { success: true, data: { type: 'game', name: 'Another Cloud Game' } },
        500: { success: false },
      }
      return new Response(JSON.stringify({ [appId]: metadata[appId] }), { headers: { 'content-type': 'application/json' } })
    }

    const result = await scanSteamAccountLibrary(root, { includeRegistry: false, fetchImpl, storeLanguage: 'english' })

    expect(result.cachedAppIds).toEqual([100, 200, 300, 400, 500])
    expect(result.games.map((game) => game.appId)).toEqual([400])
    expect(result.ownedGames).toEqual(expect.arrayContaining([
      { appId: 100, name: 'Cloud Game' },
      { appId: 300, name: 'Another Cloud Game' },
      { appId: 400, name: 'Installed Game' },
      { appId: 500, name: 'Steam App 500' },
    ]))
    expect(result.ownedGames.some((game) => game.appId === 200)).toBe(false)
    expect(requestedLanguages).toEqual(['english', 'english', 'english', 'english'])
    expect(result.warnings).toContain('Steamからゲーム名を取得できなかった1件はApp IDで追加しました。再スキャン時に再取得します。')
  })
})
