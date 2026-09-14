import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createTranslator } from '../src/i18n.js'
import { getBroadcastStatus } from '../src/runtime-status.js'
import type { GameProfile, RuntimeStatus } from '../shared/contracts.js'
import type { AudioCalibrationService } from './audio-calibration.js'
import { CaptureDetector } from './capture.js'
import { defaultConfig, starterProfiles } from './defaults.js'
import type { AppLogger } from './logger.js'
import { ObsController, recordingOnlyPreset } from './obs.js'
import { StreamOrchestrator } from './orchestrator.js'
import type { PlatformServices } from './platforms.js'
import type { SecretStore } from './secrets.js'
import type { DataStore } from './storage.js'

describe('recording game identity integration', () => {
  it.each(['Minecraft.Windows.exe', 'java.exe'])('records and labels the detected %s game instead of the previous ASA selection', async (executableName) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'obs-recording-identity-'))
    try {
      let config = structuredClone(defaultConfig)
      const profiles = structuredClone(starterProfiles)
      const minecraft = profiles.find(({ id }) => id === 'minecraft')!
      minecraft.recording.directory = directory
      minecraft.presentation.templateLabel = 'ASA'
      const previous = profiles.find(({ id }) => id === 'ark_survival_ascended')!
      const store = {
        getConfig: vi.fn(async () => config),
        saveConfig: vi.fn(async (value) => { config = value; return value }),
        listProfiles: vi.fn(async () => profiles),
        getProfile: vi.fn(async (id: string) => profiles.find((profile) => profile.id === id) ?? null),
        saveProfile: vi.fn(async (profile: GameProfile) => {
          const index = profiles.findIndex(({ id }) => id === profile.id)
          if (index < 0) profiles.push(profile)
          else profiles[index] = profile
          return profile
        }),
      }
      const capture = new CaptureDetector({ attempts: 1 })
      vi.spyOn(capture, 'runningProcesses').mockResolvedValue([executableName])
      vi.spyOn(capture, 'runningJavaGameWindows').mockResolvedValue([
        { executableName: executableName.toLowerCase(), windowTitle: 'Minecraft 1.21.1' },
      ])

      let recording = false
      let currentProfile = 'MAIN_YOUTUBE_TWITCH'
      const obsProfiles = [currentProfile]
      const parameters = new Map<string, string>()
      let inputSettings: Record<string, unknown> = { capture_mode: 'window', window: 'ARK:UnrealWindow:ArkAscended.exe' }
      const minecraftWindow = `Minecraft 1.21.1:GLFW30:${executableName}`
      const call = vi.fn(async (request: string, data: Record<string, unknown> = {}) => {
        if (request === 'GetStreamStatus' || request === 'GetReplayBufferStatus') return { outputActive: false }
        if (request === 'GetRecordStatus') return { outputActive: recording }
        if (request === 'GetCurrentProgramScene') return { currentProgramSceneName: '10_GAME_PC' }
        if (request === 'GetProfileList') return { currentProfileName: currentProfile, profiles: [...obsProfiles] }
        if (request === 'GetInputSettings') return { inputKind: 'game_capture', inputSettings: { ...inputSettings } }
        if (request === 'GetInputPropertiesListPropertyItems') return { propertyItems: [
          { itemEnabled: true, itemName: 'ARK', itemValue: 'ARK:UnrealWindow:ArkAscended.exe' },
          { itemEnabled: true, itemName: 'Other Java', itemValue: 'Other Java:SunAwtFrame:java.exe' },
          { itemEnabled: true, itemName: 'Minecraft 1.21.1', itemValue: minecraftWindow },
        ] }
        if (request === 'SetInputSettings') { inputSettings = { ...inputSettings, ...data.inputSettings as Record<string, unknown> }; return {} }
        if (request === 'GetSourceActive') return { videoActive: true }
        if (request === 'GetSceneItemId') return { sceneItemId: 1 }
        if (request === 'SetProfileParameter') { parameters.set(`${data.parameterCategory}/${data.parameterName}`, String(data.parameterValue)); return {} }
        if (request === 'GetProfileParameter') return { parameterValue: parameters.get(`${data.parameterCategory}/${data.parameterName}`) ?? '' }
        if (request === 'CreateProfile') { currentProfile = String(data.profileName); obsProfiles.push(currentProfile); return {} }
        if (request === 'SetCurrentProfile') { currentProfile = String(data.profileName); return {} }
        if (request === 'GetVideoSettings') return { baseWidth: 2560, baseHeight: 1440, outputWidth: 2560, outputHeight: 1440, fpsNumerator: 60, fpsDenominator: 1 }
        if (request === 'CallVendorRequest') return { responseData: { success: true, apiVersion: 4, outputActive: false, rateControl: 'VBR', videoBitrateKbps: 8000, maxVideoBitrateKbps: 10000 } }
        if (request === 'StartRecord') {
          expect(inputSettings.window).toBe(minecraftWindow)
          expect(parameters.get('OBSStreamManager/RecordingGameId')).toBe('minecraft')
          expect(parameters.get('Output/FilenameFormatting')).toBe('Minecraft_%CCYY-%MM-%DD_%hh-%mm-%ss')
          recording = true
          return {}
        }
        if (['SetCurrentProgramScene', 'SetSceneItemEnabled', 'SetInputVolume', 'SetInputMute'].includes(request)) return {}
        throw new Error(`Unexpected OBS request: ${request}`)
      })
      const secrets = new Map<string, string>()
      const obs = new ObsController({
        get: (name: string) => secrets.get(name) ?? null,
        set: (name: string, value: string) => { secrets.set(name, value) },
      } as unknown as SecretStore, 50, 50, {
        applyManagedMicrophoneFilters: vi.fn().mockResolvedValue({ warnings: [] }),
        applyManagedGameFilters: vi.fn().mockResolvedValue({ warnings: [] }),
      } as unknown as AudioCalibrationService)
      Object.assign(obs, {
        obs: { connect: vi.fn().mockResolvedValue(undefined), call },
        ensureDiscordApplicationAudio: vi.fn().mockResolvedValue(undefined),
        configureSeparatedAudioTracks: vi.fn().mockResolvedValue(undefined),
        reconcileMicrophoneSceneItems: vi.fn().mockResolvedValue(undefined),
        waitForRecordActive: vi.fn().mockResolvedValue(true),
        waitForRecordFrameProgress: vi.fn().mockResolvedValue(true),
      })
      const platforms = {
        getLiveStatus: vi.fn(), prepare: vi.fn(), startYouTubeBroadcast: vi.fn(), completeYouTubeBroadcast: vi.fn(),
        startComments: vi.fn(), stopComments: vi.fn(), invalidateLiveStatus: vi.fn(),
      }
      const orchestrator = new StreamOrchestrator(store as unknown as DataStore, obs, capture,
        platforms as unknown as PlatformServices, { write: vi.fn().mockResolvedValue(undefined) } as unknown as AppLogger)
      Object.assign(orchestrator, { selected: previous, method: 'local' })

      await expect(orchestrator.startRecordingOnly()).resolves.toEqual([])

      expect(config.ui.lastSelectedGameId).toBe('minecraft')
      expect(currentProfile).toBe(recordingOnlyPreset.profileName)
      expect(call.mock.calls.filter(([request]) => request === 'StartRecord')).toHaveLength(1)
      expect(call.mock.calls.some(([request]) => request === 'SetStreamServiceSettings')).toBe(false)
      for (const method of Object.values(platforms)) expect(method).not.toHaveBeenCalled()
      // An old selection and thumbnail label cannot override the OBS recording identity.
      const status: RuntimeStatus = {
        ...await obs.status(config, previous.id, 'local', false, null),
        platforms: {
          youtube: { state: 'offline', detail: '', checkedAt: null },
          twitch: { state: 'offline', detail: '', checkedAt: null },
        },
      }
      expect(status).toMatchObject({ recordingOnly: true, recording: true, recordingGameId: 'minecraft', recordingGameName: 'Minecraft' })
      const broadcast = getBroadcastStatus(status, 'ASA')
      expect(createTranslator('ja')(broadcast.detail, broadcast.detailValues)).toBe('配信停止・Minecraft録画中')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
