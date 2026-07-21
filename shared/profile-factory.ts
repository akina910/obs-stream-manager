import type { CaptureMethod, GameProfile, PlatformGroup } from './contracts.js'

function defaultCapture(group: PlatformGroup): CaptureMethod {
  if (group === 'switch') return 'elgato'
  if (group === 'exception') return 'window'
  return 'auto'
}

export function createGameProfile(id: string, displayName: string, platformGroup: PlatformGroup = 'pc'): GameProfile {
  const capture = defaultCapture(platformGroup)
  return {
    id,
    displayName,
    platformGroup,
    favorite: false,
    hidden: false,
    presentation: { templateLabel: '' },
    library: { gamePass: false, exception: platformGroup === 'exception', installed: false },
    capture: {
      preferred: capture,
      executableNames: [],
      localSourceName: platformGroup === 'switch' ? 'Elgato Game Capture' : 'PC Game Capture',
      geforceNowEnabled: false,
      geforceNowSourceName: 'GFN Capture',
      ...(platformGroup === 'exception' ? { windowSourceName: 'PC Window Capture' } : {}),
      displaySourceName: 'Display Capture',
      allowDisplayFallback: false,
    },
    obs: {
      sceneName: platformGroup === 'switch' ? '11_GAME_SWITCH' : '10_GAME_PC',
      startingScene: '00_STARTING',
      endingScene: '90_ENDING',
    },
    youtube: { enabled: true, titleTemplate: '{game}｜ゲーム配信', description: '', privacy: 'public', categoryId: '20' },
    twitch: { enabled: true, titleTemplate: '{game}｜ゲーム配信', categoryName: displayName, tags: ['日本語'] },
    audio: { microphoneDb: -3, gameDb: -15, discordDb: -18, bgmDb: -25, duckingDb: -6 },
    recording: { enabled: true, directory: '', replayBufferSeconds: 180, sourceRecord: false, verticalRecording: false },
    state: { lastUsedAt: null, thumbnailAutoApply: true, thumbnailApplyStatus: 'not_registered', thumbnailLastAppliedAt: null, nextPartNumber: 1 },
  }
}
