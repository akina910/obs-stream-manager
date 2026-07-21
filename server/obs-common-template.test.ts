import { describe, expect, it, vi } from 'vitest'
import { defaultConfig } from './defaults.js'
import { ObsController } from './obs.js'
import type { SecretStore } from './secrets.js'

describe('ObsController common template', () => {
  it('updates the configured OBS image source with the rendered profile PNG', async () => {
    const call = vi.fn().mockResolvedValue({})
    const fake = { connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn(), on: vi.fn(), call }
    const controller = new ObsController({ get: vi.fn().mockReturnValue(null), set: vi.fn() } as unknown as SecretStore)
    ;(controller as unknown as { obs: typeof fake }).obs = fake

    await controller.applyCommonTemplate(structuredClone(defaultConfig), {
      profileId: 'ark', sourceName: 'COMMON_STREAM_TEMPLATE', filename: 'C:\\templates\\ark.png', text: 'ARK',
    })

    expect(call).toHaveBeenCalledWith('SetInputSettings', {
      inputName: 'COMMON_STREAM_TEMPLATE', inputSettings: { file: 'C:\\templates\\ark.png' }, overlay: true,
    })
  })

  it('returns an actionable error when the OBS image source does not exist', async () => {
    const fake = { connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn(), on: vi.fn(), call: vi.fn().mockRejectedValue(new Error('No input was found')) }
    const controller = new ObsController({ get: vi.fn().mockReturnValue(null), set: vi.fn() } as unknown as SecretStore)
    ;(controller as unknown as { obs: typeof fake }).obs = fake

    await expect(controller.applyCommonTemplate(structuredClone(defaultConfig), {
      profileId: 'ark', sourceName: 'COMMON_STREAM_TEMPLATE', filename: 'C:\\templates\\ark.png', text: 'ARK',
    })).rejects.toThrow('共通テンプレート用OBS画像ソース「COMMON_STREAM_TEMPLATE」')
  })

  it('clears the previous OBS image source when the template is disabled or renamed', async () => {
    const call = vi.fn().mockResolvedValue({})
    const fake = { connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn(), on: vi.fn(), call }
    const controller = new ObsController({ get: vi.fn().mockReturnValue(null), set: vi.fn() } as unknown as SecretStore)
    ;(controller as unknown as { obs: typeof fake }).obs = fake

    await controller.clearCommonTemplate(structuredClone(defaultConfig), 'OLD_COMMON_TEMPLATE')

    expect(call).toHaveBeenCalledWith('SetInputSettings', {
      inputName: 'OLD_COMMON_TEMPLATE', inputSettings: { file: '' }, overlay: true,
    })
  })

  it('returns an actionable error when the old OBS image source cannot be cleared', async () => {
    const fake = { connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn(), on: vi.fn(), call: vi.fn().mockRejectedValue(new Error('No input was found')) }
    const controller = new ObsController({ get: vi.fn().mockReturnValue(null), set: vi.fn() } as unknown as SecretStore)
    ;(controller as unknown as { obs: typeof fake }).obs = fake

    await expect(controller.clearCommonTemplate(structuredClone(defaultConfig), 'OLD_COMMON_TEMPLATE'))
      .rejects.toThrow('共通テンプレート用OBS画像ソース「OLD_COMMON_TEMPLATE」をクリアできませんでした')
  })
})
