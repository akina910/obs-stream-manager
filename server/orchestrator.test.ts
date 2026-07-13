import { describe, expect, it, vi } from 'vitest'
import type { CaptureDetector } from './capture.js'
import { defaultConfig } from './defaults.js'
import type { AppLogger } from './logger.js'
import type { ObsController } from './obs.js'
import { StreamOrchestrator } from './orchestrator.js'
import type { PlatformServices } from './platforms.js'
import type { DataStore } from './storage.js'

describe('StreamOrchestrator operation exclusion', () => {
  it('rejects scene changes while a replay save is still running', async () => {
    let releaseReplay!: () => void
    const replayBlocked = new Promise<void>((resolve) => { releaseReplay = resolve })
    const saveReplay = vi.fn(() => replayBlocked)
    const switchScene = vi.fn().mockResolvedValue(undefined)
    const store = { getConfig: vi.fn().mockResolvedValue(structuredClone(defaultConfig)) } as unknown as DataStore
    const obs = { saveReplay, switchScene } as unknown as ObsController
    const logger = { write: vi.fn().mockResolvedValue(undefined) } as unknown as AppLogger
    const orchestrator = new StreamOrchestrator(store, obs, {} as CaptureDetector, {} as PlatformServices, logger)

    const pendingReplay = orchestrator.saveReplay()
    await vi.waitFor(() => expect(saveReplay).toHaveBeenCalledOnce())
    await expect(orchestrator.switchScene('20_TALK')).rejects.toThrow('別の配信操作を処理中です')
    expect(switchScene).not.toHaveBeenCalled()

    releaseReplay()
    await expect(pendingReplay).resolves.toBeUndefined()
  })
})
