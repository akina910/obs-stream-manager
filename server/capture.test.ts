import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
