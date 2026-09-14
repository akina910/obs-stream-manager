import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GameProfile } from '../shared/contracts.js'
import { CaptureDetector, windowsTasklistExecutable } from './capture.js'
import { starterProfiles } from './defaults.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('CaptureDetector', () => {
  it('uses the trusted Windows system tasklist path instead of PATH lookup', () => {
    expect(windowsTasklistExecutable('C:\\Windows')).toBe('C:\\Windows\\System32\\tasklist.exe')
    expect(windowsTasklistExecutable('  D:\\Windows  ')).toBe('D:\\Windows\\System32\\tasklist.exe')
    expect(windowsTasklistExecutable('relative-root')).toBe('C:\\Windows\\System32\\tasklist.exe')
  })

  it('fails auto-selection safely when the process inventory is temporarily unavailable', async () => {
    const detector = new CaptureDetector({ attempts: 1 })
    vi.spyOn(detector, 'runningProcesses').mockRejectedValue(new Error('tasklist unavailable'))

    await expect(detector.detectRunningProfile(structuredClone(starterProfiles))).resolves.toBeNull()
    expect(detector.processInventoryWarning()).toContain('ゲームの自動認識を一時停止')
  })

  it('clears the process-inventory warning after tasklist recovers', async () => {
    const detector = new CaptureDetector({ attempts: 1 })
    vi.spyOn(detector, 'runningProcesses')
      .mockRejectedValueOnce(new Error('tasklist unavailable'))
      .mockResolvedValueOnce([])

    await detector.detectRunningProfile(structuredClone(starterProfiles))
    expect(detector.processInventoryWarning()).not.toBeNull()
    await detector.detectRunningProfile(structuredClone(starterProfiles))
    expect(detector.processInventoryWarning()).toBeNull()
  })

  it('uses display capture only when the profile explicitly allows the fallback', async () => {
    const detector = new CaptureDetector({ attempts: 1 })
    vi.spyOn(detector, 'runningProcesses').mockResolvedValue([])
    const profile = structuredClone(starterProfiles.find((item) => item.id === 'ark_survival_ascended')!)
    profile.capture.allowDisplayFallback = true
    await expect(detector.detect(profile)).resolves.toMatchObject({ method: 'display' })
  })

  it('detects a Steam game from a nested executable when the generated profile has no executable names', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'obs-capture-detect-'))
    directories.push(directory)
    const binaries = path.join(directory, 'Game', 'Binaries', 'Win64')
    await mkdir(binaries, { recursive: true })
    await writeFile(path.join(binaries, 'AutoDetectedGame.exe'), '')
    const detector = new CaptureDetector({ attempts: 1, executableCacheMs: 0 })
    vi.spyOn(detector, 'runningProcesses').mockResolvedValue(['autodetectedgame.exe'])
    const profile = structuredClone(starterProfiles[0])
    profile.capture.executableNames = []
    profile.library.installDirectory = directory

    await expect(detector.detect(profile)).resolves.toEqual({ method: 'local', warnings: [] })
  })

  it('does not mistake a bundled Python runtime for a running Steam game', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'obs-capture-detect-runtime-'))
    directories.push(directory)
    const runtime = path.join(directory, 'game', 'python')
    await mkdir(runtime, { recursive: true })
    await writeFile(path.join(runtime, 'python.exe'), '')
    await writeFile(path.join(directory, 'ActualGame.exe'), '')
    const detector = new CaptureDetector({ attempts: 1, executableCacheMs: 0 })
    const processes = vi.spyOn(detector, 'runningProcesses').mockResolvedValue(['python.exe'])
    const profile = structuredClone(starterProfiles[0])
    profile.id = 'steam_runtime_game'
    profile.capture.executableNames = []
    profile.library.installDirectory = directory

    await expect(detector.detectRunningProfile([profile])).resolves.toBeNull()

    processes.mockResolvedValue(['actualgame.exe'])
    await expect(detector.detectRunningProfile([profile])).resolves.toMatchObject({
      profile: { id: 'steam_runtime_game' },
      executableName: 'actualgame.exe',
    })
  })

  it('does not mistake bundled launchers or webview helpers for a running Steam game', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'obs-capture-detect-launcher-'))
    directories.push(directory)
    await writeFile(path.join(directory, 'launcher.exe'), '')
    await writeFile(path.join(directory, 'msedgewebview2.exe'), '')
    await writeFile(path.join(directory, 'ActualGame.exe'), '')
    const detector = new CaptureDetector({ attempts: 1, executableCacheMs: 0 })
    const processes = vi.spyOn(detector, 'runningProcesses').mockResolvedValue(['launcher.exe', 'msedgewebview2.exe'])
    const profile = structuredClone(starterProfiles[0])
    profile.id = 'steam_launcher_game'
    profile.capture.executableNames = []
    profile.library.installDirectory = directory

    await expect(detector.detectRunningProfile([profile])).resolves.toBeNull()

    processes.mockResolvedValue(['actualgame.exe'])
    await expect(detector.detectRunningProfile([profile])).resolves.toMatchObject({
      profile: { id: 'steam_launcher_game' },
      executableName: 'actualgame.exe',
    })
  })

  it('does not mistake bundled OBS and Steam helper binaries for a running game', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'obs-capture-detect-helpers-'))
    directories.push(directory)
    await Promise.all([
      writeFile(path.join(directory, 'obs64.exe'), ''),
      writeFile(path.join(directory, 'obs-browser-page.exe'), ''),
      writeFile(path.join(directory, 'steamservice.exe'), ''),
    ])
    const detector = new CaptureDetector({ attempts: 1, executableCacheMs: 0 })
    vi.spyOn(detector, 'runningProcesses').mockResolvedValue(['obs64.exe', 'obs-browser-page.exe', 'steamservice.exe'])
    const profile = structuredClone(starterProfiles[0])
    profile.id = 'steam_helper_bundle'
    profile.capture.executableNames = []
    profile.library.installDirectory = directory

    await expect(detector.detectRunningProfile([profile])).resolves.toBeNull()
  })

  it('retries process detection while a game is launching', async () => {
    const detector = new CaptureDetector({ attempts: 3, retryDelayMs: 0 })
    const processes = vi.spyOn(detector, 'runningProcesses')
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(['arkascended.exe'])
    const profile = structuredClone(starterProfiles[0])

    await expect(detector.detect(profile)).resolves.toEqual({ method: 'local', warnings: [] })
    expect(processes).toHaveBeenCalledTimes(2)
  })

  it('recognizes a running profile without requiring the user to select its card', async () => {
    const detector = new CaptureDetector({ attempts: 1 })
    vi.spyOn(detector, 'runningProcesses').mockResolvedValue(['arkascended.exe'])

    await expect(detector.detectRunningProfile(structuredClone(starterProfiles))).resolves.toMatchObject({
      profile: { id: 'ark_survival_ascended' },
      method: 'local',
      executableName: 'arkascended.exe',
    })
  })

  it('keeps the currently selected running game when more than one known game is open', async () => {
    const detector = new CaptureDetector({ attempts: 1 })
    vi.spyOn(detector, 'runningProcesses').mockResolvedValue(['arkascended.exe', 'robloxplayerbeta.exe'])
    const profiles = structuredClone(starterProfiles)
    const roblox = profiles.find(({ id }) => id === 'roblox')
    expect(roblox).toBeDefined()

    await expect(detector.detectRunningProfile(profiles, roblox?.id)).resolves.toMatchObject({
      profile: { id: roblox?.id },
      executableName: 'robloxplayerbeta.exe',
    })
  })

  it('recognizes Minecraft Bedrock even when its preset is not saved in the library', async () => {
    const detector = new CaptureDetector({ attempts: 1 })
    vi.spyOn(detector, 'runningProcesses').mockResolvedValue(['minecraft.windows.exe'])
    const profiles = [structuredClone(starterProfiles[0])]

    const match = await detector.detectRunningProfile(profiles, profiles[0].id)
    expect(match).toMatchObject({
      profile: { id: 'minecraft', displayName: 'Minecraft', recording: { enabled: true } },
      method: 'local',
      executableName: 'minecraft.windows.exe',
    })
    expect(profiles).toHaveLength(1)
    expect(match?.profile).not.toBe(starterProfiles.find(({ id }) => id === 'minecraft'))
  })

  it('does not restore a hidden Minecraft preset or register an idle starter game', async () => {
    const detector = new CaptureDetector({ attempts: 1 })
    const processes = vi.spyOn(detector, 'runningProcesses').mockResolvedValue(['minecraft.windows.exe'])
    const minecraft = structuredClone(starterProfiles.find(({ id }) => id === 'minecraft')!)
    minecraft.hidden = true

    await expect(detector.detectRunningProfile([minecraft])).resolves.toBeNull()
    processes.mockResolvedValue(['steam.exe'])
    await expect(detector.detectRunningProfile([])).resolves.toBeNull()
  })

  it.each(['javaw.exe', 'java.exe'])('requires Minecraft window evidence for the shared %s process', async (executableName) => {
    const detector = new CaptureDetector({ attempts: 1 })
    vi.spyOn(detector, 'runningProcesses').mockResolvedValue([executableName])
    const windows = vi.spyOn(detector, 'runningJavaGameWindows').mockResolvedValue([
      { executableName, windowTitle: 'IntelliJ IDEA' },
      { executableName, windowTitle: 'Minecraft server' },
      { executableName, windowTitle: 'Minecraft Launcher' },
    ])

    await expect(detector.detectRunningProfile([])).resolves.toBeNull()
    windows.mockResolvedValue([{ executableName, windowTitle: 'Minecraft* 1.21.1 - Multiplayer (3rd-party Server)' }])
    const match = await detector.detectRunningProfile([])
    expect(match).toMatchObject({
      profile: { id: 'minecraft' },
      method: 'local',
      executableName,
      windowTitle: 'Minecraft* 1.21.1 - Multiplayer (3rd-party Server)',
    })
    expect(match?.profile.capture.executableNames.map((name) => name.toLowerCase())).toContain(executableName)
  })

  it('does not accept another Java application when applying the Minecraft profile', async () => {
    const detector = new CaptureDetector({ attempts: 1 })
    vi.spyOn(detector, 'runningProcesses').mockResolvedValue(['javaw.exe'])
    vi.spyOn(detector, 'runningJavaGameWindows').mockResolvedValue([{ executableName: 'javaw.exe', windowTitle: 'IntelliJ IDEA' }])
    const minecraft = structuredClone(starterProfiles.find(({ id }) => id === 'minecraft')!)

    await expect(detector.detect(minecraft)).rejects.toThrow('ゲームまたは GeForce NOW を検出できません')
  })

  it('checks installed-game matches even when another configured game process is still running', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'obs-capture-detect-concurrent-'))
    directories.push(directory)
    await writeFile(path.join(directory, 'ActualGame.exe'), '')
    const detector = new CaptureDetector({ attempts: 1 })
    vi.spyOn(detector, 'runningProcesses').mockResolvedValue(['arkascended.exe', 'actualgame.exe'])
    const profile = structuredClone(starterProfiles[0])
    profile.id = 'steam_selected_game'
    profile.capture.executableNames = []
    profile.library.installDirectory = directory

    await expect(detector.detectRunningProfile([profile], profile.id)).resolves.toMatchObject({
      profile: { id: profile.id },
      executableName: 'actualgame.exe',
    })
  })

  it('does not scan unrelated game installations when the selected running game is already known', async () => {
    const detector = new CaptureDetector({ attempts: 1, executableCacheMs: 0 })
    vi.spyOn(detector, 'runningProcesses').mockResolvedValue(['arkascended.exe'])
    const scan = vi.spyOn(detector as unknown as {
      installedExecutableNames: (profile: GameProfile) => Promise<string[]>
    }, 'installedExecutableNames').mockResolvedValue([])
    const selected = structuredClone(starterProfiles[0])
    const unrelated = Array.from({ length: 100 }, (_, index) => {
      const profile = structuredClone(selected)
      profile.id = `steam_unrelated_${index}`
      profile.capture.executableNames = []
      profile.library.installDirectory = `J:\\SteamLibrary\\steamapps\\common\\Unrelated${index}`
      return profile
    })

    await expect(detector.detectRunningProfile([selected, ...unrelated], selected.id)).resolves.toMatchObject({
      profile: { id: selected.id },
    })
    expect(scan).not.toHaveBeenCalled()
  })

  it('still checks equal-scoring installed games and selects the more recently used match', async () => {
    const detector = new CaptureDetector({ attempts: 1 })
    vi.spyOn(detector, 'runningProcesses').mockResolvedValue(['older.exe', 'newer.exe'])
    const scan = vi.spyOn(detector as unknown as {
      installedExecutableNames: (profile: GameProfile) => Promise<string[]>
    }, 'installedExecutableNames').mockImplementation(async (profile) => [`${profile.id}.exe`])
    const profiles = ['older', 'newer'].map((id, index) => {
      const profile = structuredClone(starterProfiles[0])
      profile.id = id
      profile.capture.executableNames = []
      profile.library.installDirectory = `J:\\SteamLibrary\\steamapps\\common\\${id}`
      profile.state.lastUsedAt = `2026-09-${12 + index}T00:00:00.000Z`
      return profile
    })

    await expect(detector.detectRunningProfile(profiles)).resolves.toMatchObject({ profile: { id: 'newer' } })
    expect(scan).toHaveBeenCalledTimes(2)
  })

  it('maps a GeForce NOW window title to the matching game profile', async () => {
    const detector = new CaptureDetector({ attempts: 1 })
    vi.spyOn(detector, 'runningProcesses').mockResolvedValue(['geforcenow.exe'])
    vi.spyOn(detector, 'runningGeForceNowWindowTitles').mockResolvedValue([
      'GeForce NOW のPRAGMATA',
    ])
    const profile = structuredClone(starterProfiles[0])
    profile.id = 'steam_3357650'
    profile.displayName = 'PRAGMATA'
    profile.capture.executableNames = []
    profile.capture.geforceNowEnabled = true

    await expect(detector.detectRunningProfile([profile])).resolves.toMatchObject({
      profile: { id: 'steam_3357650' },
      method: 'geforce_now',
      executableName: 'GeForceNOW.exe',
      windowTitle: 'GeForce NOW のPRAGMATA',
    })
  })

  it('does not guess a game from the shared GeForce NOW process alone', async () => {
    const detector = new CaptureDetector({ attempts: 1 })
    vi.spyOn(detector, 'runningProcesses').mockResolvedValue(['geforcenow.exe'])
    vi.spyOn(detector, 'runningGeForceNowWindowTitles').mockResolvedValue([
      'GeForce NOW の別のゲーム',
    ])
    const profile = structuredClone(starterProfiles[0])
    profile.id = 'steam_3357650'
    profile.displayName = 'PRAGMATA'
    profile.capture.executableNames = []
    profile.capture.geforceNowEnabled = true

    await expect(detector.detectRunningProfile([profile])).resolves.toBeNull()
  })

  it('returns the matching GeForce NOW window when applying a profile', async () => {
    const detector = new CaptureDetector({ attempts: 1 })
    vi.spyOn(detector, 'runningProcesses').mockResolvedValue(['geforcenow.exe'])
    vi.spyOn(detector, 'runningGeForceNowWindowTitles').mockResolvedValue([
      'GeForce NOW のPRAGMATA',
    ])
    const profile = structuredClone(starterProfiles[0])
    profile.displayName = 'PRAGMATA'
    profile.capture.preferred = 'geforce_now'
    profile.capture.geforceNowEnabled = true

    await expect(detector.detect(profile)).resolves.toEqual({
      method: 'geforce_now',
      warnings: [],
      windowTitle: 'GeForce NOW のPRAGMATA',
    })
  })
})
