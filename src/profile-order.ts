import type { GameProfile } from '../shared/contracts'

function usedAt(profile: GameProfile): string {
  return profile.state.lastUsedAt ?? ''
}

export function orderProfiles(profiles: GameProfile[]): GameProfile[] {
  return [...profiles].sort((left, right) =>
    usedAt(right).localeCompare(usedAt(left))
    || Number(right.favorite) - Number(left.favorite)
    || left.displayName.localeCompare(right.displayName, 'ja'))
}

export function replaceOrderedProfile(profiles: GameProfile[], saved: GameProfile): GameProfile[] {
  return orderProfiles([...profiles.filter((profile) => profile.id !== saved.id), saved])
}

export function recentProfiles(profiles: GameProfile[], limit = 6): GameProfile[] {
  return orderProfiles(profiles.filter((profile) => Boolean(profile.state.lastUsedAt))).slice(0, Math.max(0, limit))
}
