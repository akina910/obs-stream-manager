import { describe, expect, it } from 'vitest'
import { createGameProfile } from './profile-factory.js'

describe('createGameProfile', () => {
  it('creates a Steam-independent PC profile', () => {
    const profile = createGameProfile('manual_game', 'Manual Game')
    expect(profile.library).toEqual({ gamePass: false, exception: false, installed: false })
    expect(profile.capture.preferred).toBe('auto')
    expect(profile.obs.sceneName).toBe('10_GAME_PC')
  })

  it('uses Switch and exception capture defaults without requiring Steam metadata', () => {
    expect(createGameProfile('switch_game', 'Switch Game', 'switch')).toMatchObject({
      library: { installed: false },
      capture: { preferred: 'elgato', localSourceName: 'Elgato Game Capture' },
      obs: { sceneName: '11_GAME_SWITCH' },
    })
    expect(createGameProfile('standalone_game', 'Standalone Game', 'exception')).toMatchObject({
      library: { exception: true, installed: false },
      capture: { preferred: 'window', windowSourceName: 'PC Window Capture' },
    })
  })
})
