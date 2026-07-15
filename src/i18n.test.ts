import { describe, expect, it } from 'vitest'
import { AppConfigSchema } from '../shared/contracts'
import { defaultConfig } from '../server/defaults'
import { createTranslator, englishTranslations } from './i18n'

describe('UI translations', () => {
  it('keeps Japanese text unchanged', () => {
    expect(createTranslator('ja')('配信開始')).toBe('配信開始')
  })

  it('translates English text and interpolates values', () => {
    expect(createTranslator('en')('Steamライブラリを{count}か所検出', { count: 2 })).toBe('2 Steam libraries detected')
  })

  it('contains the language selector and core broadcast actions', () => {
    for (const key of ['言語', '日本語', '英語', '配信開始', '配信終了', '設定', '配信するゲームを選んでください', 'タイトルテンプレートの変数ヘルプ', '使用できる変数', '次回のPart番号', 'ゲーム適用時の日付と時刻']) {
      expect(englishTranslations[key]).toBeTruthy()
    }
  })

  it('defaults legacy configs to Japanese and accepts persisted English', () => {
    const legacyConfig: Partial<typeof defaultConfig> = structuredClone(defaultConfig)
    delete legacyConfig.ui
    expect(AppConfigSchema.parse(legacyConfig).ui.language).toBe('ja')
    expect(AppConfigSchema.parse({ ...defaultConfig, ui: { language: 'en' } }).ui.language).toBe('en')
  })
})
