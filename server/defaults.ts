import type { AppConfig, GameProfile } from '../shared/contracts.js'
import { createGameProfile } from '../shared/profile-factory.js'

export const defaultConfig: AppConfig = {
  setup: { completed: false },
  ui: { language: 'ja', lastSelectedGameId: null },
  obs: { url: 'ws://127.0.0.1:4455', passwordStored: false, startDelaySeconds: 5, endDelaySeconds: 5 },
  sources: {
    microphone: 'MIC', pcGame: 'GAME_PC', geforceNow: 'GAME_GFN', switchGame: 'GAME_SWITCH', discord: 'DISCORD', bgm: 'BGM',
  },
  features: { youtube: true, twitch: true, recording: true, replayBuffer: true, sourceRecord: true, verticalRecording: true },
  steam: { steamId64: '', apiKeyStored: false, installPath: '' },
  youtube: { clientId: '', clientSecretStored: false, refreshTokenStored: false, broadcastId: '' },
  twitch: { clientId: '', clientSecretStored: false, accessTokenStored: false, refreshTokenStored: false, broadcasterId: '' },
}

const pcBase = {
  favorite: false,
  hidden: false,
  library: { gamePass: false, exception: false, installed: false },
  obs: { sceneName: '10_GAME_PC', startingScene: '00_STARTING', endingScene: '90_ENDING' },
  youtube: { enabled: true, titleTemplate: '{game}｜ゲーム配信', description: '', privacy: 'public' as const, categoryId: '20' },
  twitch: { enabled: true, titleTemplate: '{game}｜ゲーム配信', categoryName: '', tags: ['日本語'] },
  audio: { microphoneDb: -3, gameDb: -15, discordDb: -18, bgmDb: -25, duckingDb: -6 },
  recording: { enabled: true, directory: '', replayBufferSeconds: 180, sourceRecord: true, verticalRecording: true },
  state: { lastUsedAt: null, thumbnailAutoApply: true, thumbnailApplyStatus: 'not_registered' as const, thumbnailLastAppliedAt: null, nextPartNumber: 1 },
}

export function createPcProfile(id: string, displayName: string): GameProfile {
  return createGameProfile(id, displayName)
}

export const starterProfiles: GameProfile[] = [
  {
    ...pcBase,
    id: 'ark_survival_ascended', displayName: 'ARK: Survival Ascended', platformGroup: 'pc', favorite: true,
    library: { steamAppId: 2399830, gamePass: false, exception: false, installed: false },
    capture: { preferred: 'auto', executableNames: ['ArkAscended.exe'], localSourceName: 'PC Game Capture', geforceNowEnabled: true, geforceNowSourceName: 'GFN Capture', displaySourceName: 'Display Capture', allowDisplayFallback: false },
    twitch: { ...pcBase.twitch, categoryName: 'ARK: Survival Ascended' },
  },
  {
    ...pcBase,
    id: 'minecraft', displayName: 'Minecraft', platformGroup: 'pc', favorite: true,
    library: { gamePass: true, exception: false, installed: false },
    capture: { preferred: 'auto', executableNames: ['Minecraft.Windows.exe', 'javaw.exe'], localSourceName: 'PC Game Capture', geforceNowEnabled: false, geforceNowSourceName: 'GFN Capture', displaySourceName: 'Display Capture', allowDisplayFallback: false },
    twitch: { ...pcBase.twitch, categoryName: 'Minecraft' },
  },
  {
    ...pcBase,
    id: 'diablo_iv', displayName: 'Diablo IV', platformGroup: 'pc',
    library: { gamePass: true, exception: false, installed: false },
    capture: { preferred: 'auto', executableNames: ['Diablo IV.exe'], localSourceName: 'PC Game Capture', geforceNowEnabled: true, geforceNowSourceName: 'GFN Capture', displaySourceName: 'Display Capture', allowDisplayFallback: false },
    twitch: { ...pcBase.twitch, categoryName: 'Diablo IV' },
  },
  {
    ...pcBase,
    id: 'zelda_botw', displayName: 'ゼルダの伝説 ブレス オブ ザ ワイルド', platformGroup: 'switch',
    capture: { preferred: 'elgato', executableNames: [], localSourceName: 'Elgato Game Capture', geforceNowEnabled: false, geforceNowSourceName: 'GFN Capture', displaySourceName: 'Display Capture', allowDisplayFallback: false },
    obs: { sceneName: '11_GAME_SWITCH', startingScene: '00_STARTING', endingScene: '90_ENDING' },
    twitch: { ...pcBase.twitch, categoryName: 'The Legend of Zelda: Breath of the Wild' },
  },
  ...['VALORANT', 'Roblox'].map((name): GameProfile => ({
    ...pcBase,
    id: name.toLowerCase(), displayName: name, platformGroup: 'exception',
    library: { gamePass: false, exception: true, installed: false },
    capture: { preferred: 'window', executableNames: name === 'VALORANT' ? ['VALORANT-Win64-Shipping.exe'] : ['RobloxPlayerBeta.exe'], localSourceName: 'PC Game Capture', geforceNowEnabled: false, geforceNowSourceName: 'GFN Capture', windowSourceName: 'PC Window Capture', displaySourceName: 'Display Capture', allowDisplayFallback: false },
    twitch: { ...pcBase.twitch, categoryName: name },
  })),
]
