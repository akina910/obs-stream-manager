import { describe, expect, it } from 'vitest'
import { renderTitleTemplate, TITLE_TEMPLATE_VARIABLES } from './title-template'

describe('title templates', () => {
  it('documents every supported variable and preserves literal separators', () => {
    expect(TITLE_TEMPLATE_VARIABLES).toEqual(['{game}', '{part}', '{date}', '{time}', '{datetime}'])
    const now = new Date(2026, 6, 15, 19, 5)
    expect(renderTitleTemplate('{game} | Part {part} | {date} {time} | {datetime}', { game: 'ARK: Survival Ascended', part: 4, now }))
      .toBe('ARK: Survival Ascended | Part 4 | 2026-07-15 19:05 | 2026-07-15 19:05')
  })

  it('uses the platform title length limit', () => {
    expect(renderTitleTemplate('{game}', { game: 'a'.repeat(120), part: 1 })).toHaveLength(100)
  })
})
