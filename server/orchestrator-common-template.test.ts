import { describe, expect, it, vi } from 'vitest'
import type { CaptureDetector } from './capture.js'
import type { CommonTemplateService } from './common-template.js'
import { defaultConfig, starterProfiles } from './defaults.js'
import type { AppLogger } from './logger.js'
import type { ObsController } from './obs.js'
import { StreamOrchestrator } from './orchestrator.js'
import type { PlatformServices } from './platforms.js'
import type { DataStore } from './storage.js'

function dependencies(templateResult: object | Error) {
  const config = structuredClone(defaultConfig)
  const profile = structuredClone(starterProfiles[0])
  const store = {
    getProfile: vi.fn().mockResolvedValue(profile),
    getConfig: vi.fn().mockResolvedValue(config),
    saveProfile: vi.fn(async (value) => value),
    saveConfig: vi.fn(async (value) => value),
  } as unknown as DataStore
  const obs = {
    applyProfile: vi.fn().mockResolvedValue([]),
    applyCommonTemplate: vi.fn().mockResolvedValue(undefined),
    preparePrimaryStream: vi.fn().mockResolvedValue(undefined),
  } as unknown as ObsController
  const platforms = {
    prepare: vi.fn().mockResolvedValue([
      { service: 'youtube', ok: true, message: 'ready' },
      { service: 'twitch', ok: true, message: 'ready' },
    ]),
    invalidateLiveStatus: vi.fn(),
  } as unknown as PlatformServices
  const commonTemplates = {
    renderProfile: templateResult instanceof Error ? vi.fn().mockRejectedValue(templateResult) : vi.fn().mockResolvedValue(templateResult),
  } as unknown as CommonTemplateService
  const logger = { write: vi.fn().mockResolvedValue(undefined) } as unknown as AppLogger
  return { profile, store, obs, platforms, commonTemplates, logger }
}

describe('StreamOrchestrator common templates', () => {
  it('renders and assigns the shared image whenever a game profile is selected', async () => {
    const deps = dependencies({ profileId: 'ark_survival_ascended', sourceName: 'COMMON_STREAM_TEMPLATE', filename: 'C:\\templates\\ark.png', text: 'ARK' })
    const orchestrator = new StreamOrchestrator(deps.store, deps.obs, {} as CaptureDetector, deps.platforms, deps.logger, deps.commonTemplates)

    await orchestrator.select(deps.profile.id, 'local')

    expect(deps.commonTemplates.renderProfile).toHaveBeenCalledWith(deps.profile)
    expect(deps.obs.applyCommonTemplate).toHaveBeenCalledWith(expect.objectContaining({ commonTemplate: expect.any(Object) }), expect.objectContaining({ text: 'ARK' }))
  })

  it('keeps profile selection usable and reports a warning when the OBS image source is missing', async () => {
    const deps = dependencies(new Error('共通テンプレート用OBS画像ソースがありません'))
    const orchestrator = new StreamOrchestrator(deps.store, deps.obs, {} as CaptureDetector, deps.platforms, deps.logger, deps.commonTemplates)

    const result = await orchestrator.select(deps.profile.id, 'local')

    expect(result.warnings).toContain('共通テンプレート用OBS画像ソースがありません')
    expect(result.profile.id).toBe(deps.profile.id)
  })
})
