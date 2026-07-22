import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CaptureDetector } from './capture.js'
import { starterProfiles } from './defaults.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('CaptureDetector', () => {
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
})
