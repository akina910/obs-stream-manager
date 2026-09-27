import { describe, expect, it } from 'vitest'
import { createGameProfile } from '../shared/profile-factory'
import { orderProfiles, recentProfiles, replaceOrderedProfile } from './profile-order'

function profile(id: string, name: string, lastUsedAt: string | null, favorite = false) {
  const created = createGameProfile(id, name)
  return {
    ...created,
    favorite,
    state: { ...created.state, lastUsedAt },
  }
}

describe('profile ordering', () => {
  it('keeps the most recently used games at the front even when older games are favorites', () => {
    const recent = profile('recent', 'PRAGMATA', '2026-07-23T12:11:58.000Z')
    const olderFavorite = profile('favorite', 'ARK', '2026-07-20T12:00:00.000Z', true)
    const unused = profile('unused', 'Unused', null)

    expect(orderProfiles([unused, olderFavorite, recent]).map(({ id }) => id))
      .toEqual(['recent', 'favorite', 'unused'])
  })

  it('reorders an updated selected profile instead of appending it to the end', () => {
    const older = profile('older', 'Older', '2026-07-20T12:00:00.000Z')
    const updated = profile('updated', 'Updated', '2026-07-23T12:00:00.000Z')

    expect(replaceOrderedProfile([updated, older], { ...older, state: { ...older.state, lastUsedAt: '2026-07-24T12:00:00.000Z' } }).map(({ id }) => id))
      .toEqual(['older', 'updated'])
  })

  it('builds a bounded recent-games row and excludes games that were never used', () => {
    const games = [
      profile('third', 'Third', '2026-07-21T12:00:00.000Z'),
      profile('unused', 'Unused', null),
      profile('first', 'First', '2026-07-23T12:00:00.000Z'),
      profile('second', 'Second', '2026-07-22T12:00:00.000Z'),
    ]

    expect(recentProfiles(games, 2).map(({ id }) => id)).toEqual(['first', 'second'])
  })
})
