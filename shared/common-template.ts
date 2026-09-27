import { z } from 'zod'
import { renderTitleTemplate } from './title-template.js'

const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a six-digit hex color such as #ffffff')

export const CommonTemplateConfigSchema = z.object({
  enabled: z.boolean().default(false),
  obsSourceName: z.string().trim().min(1).max(256).default('COMMON_STREAM_TEMPLATE'),
  textTemplate: z.string().max(100).default('{game}'),
  fontFamily: z.string().trim().min(1).max(100).default('Yu Gothic UI'),
  fontSize: z.number().int().min(12).max(400).default(96),
  textColor: colorSchema.default('#ffffff'),
  outlineColor: colorSchema.default('#000000'),
  outlineWidth: z.number().int().min(0).max(20).default(4),
  horizontalAlign: z.enum(['left', 'center', 'right']).default('center'),
  verticalAlign: z.enum(['top', 'center', 'bottom']).default('center'),
  positionX: z.number().int().min(0).max(100).default(50),
  positionY: z.number().int().min(0).max(100).default(50),
  imageFilename: z.string().trim().min(1).max(255).optional(),
  imageOriginalName: z.string().trim().min(1).max(255).optional(),
  imageUpdatedAt: z.string().datetime().optional(),
})

export const CommonTemplateSettingsSchema = CommonTemplateConfigSchema.omit({
  imageFilename: true,
  imageOriginalName: true,
  imageUpdatedAt: true,
})

export type CommonTemplateConfig = z.infer<typeof CommonTemplateConfigSchema>
export type CommonTemplateSettings = z.infer<typeof CommonTemplateSettingsSchema>

export const defaultCommonTemplateConfig: CommonTemplateConfig = CommonTemplateConfigSchema.parse({})

export type CommonTemplateProfile = {
  displayName: string
  presentation: { templateLabel: string }
  state: { nextPartNumber: number }
}

export function commonTemplateGameName(profile: CommonTemplateProfile): string {
  return profile.presentation.templateLabel.trim() || profile.displayName
}

export function renderCommonTemplateText(config: CommonTemplateConfig, profile: CommonTemplateProfile, now?: Date): string {
  return renderTitleTemplate(config.textTemplate, {
    game: commonTemplateGameName(profile),
    part: profile.state.nextPartNumber,
    now,
  })
}
