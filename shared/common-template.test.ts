import { describe, expect, it } from 'vitest'
import { CommonTemplateConfigSchema, commonTemplateGameName, renderCommonTemplateText } from './common-template.js'

const profile = {
  displayName: 'ARK: Survival Ascended',
  presentation: { templateLabel: '' },
  state: { nextPartNumber: 7 },
}

describe('common template text', () => {
  it('uses the profile display name and shared title variables', () => {
    const config = CommonTemplateConfigSchema.parse({ textTemplate: '{game} / Part {part} / {date}' })
    expect(renderCommonTemplateText(config, profile, new Date(2026, 6, 21, 20, 30))).toBe('ARK: Survival Ascended / Part 7 / 2026-07-21')
  })

  it('lets a profile replace only the game label', () => {
    const customized = { ...profile, presentation: { templateLabel: 'ARK' } }
    expect(commonTemplateGameName(customized)).toBe('ARK')
    expect(renderCommonTemplateText(CommonTemplateConfigSchema.parse({ textTemplate: '{game}' }), customized)).toBe('ARK')
  })
})
