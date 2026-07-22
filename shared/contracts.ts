import { z } from 'zod'
import { CommonTemplateConfigSchema, defaultCommonTemplateConfig } from './common-template.js'

export const PlatformGroupSchema = z.enum(['pc', 'switch', 'exception'])
export type PlatformGroup = z.infer<typeof PlatformGroupSchema>

export const CaptureMethodSchema = z.enum(['auto', 'local', 'geforce_now', 'window', 'display', 'elgato'])
export type CaptureMethod = z.infer<typeof CaptureMethodSchema>

export const ThumbnailApplyStatusSchema = z.enum(['not_registered', 'pending', 'applied', 'failed', 'disabled'])
export type ThumbnailApplyStatus = z.infer<typeof ThumbnailApplyStatusSchema>

export const GameIdSchema = z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9_-]*$/)
export const AudioProfileSchema = z.object({
  microphoneDb: z.number().min(-100).max(26).default(-3),
  microphoneBoostDb: z.number().min(0).max(24).default(0),
  gameDb: z.number().min(-100).max(26).default(-15),
  discordDb: z.number().min(-100).max(26).default(-18),
  bgmDb: z.number().min(-100).max(26).default(-25),
  duckingDb: z.number().min(-30).max(0).default(-6),
})
export type AudioProfile = z.infer<typeof AudioProfileSchema>
export const AudioCalibrationRequestSchema = z.object({
  gameId: GameIdSchema,
  audio: AudioProfileSchema,
  durationMs: z.number().int().min(9_000).max(30_000).default(15_000),
})
export const ObsSceneNameSchema = z.string().trim().min(1).max(256)

const ServiceConfigSchema = z.object({
  enabled: z.boolean().default(true),
  titleTemplate: z.string().default('{game}｜ゲーム配信'),
})

export const GameProfileSchema = z.object({
  id: GameIdSchema,
  displayName: z.string().min(1),
  platformGroup: PlatformGroupSchema,
  favorite: z.boolean().default(false),
  hidden: z.boolean().default(false),
  presentation: z.object({
    templateLabel: z.string().trim().max(100).default(''),
  }).default({ templateLabel: '' }),
  coverUrl: z.string().url().optional(),
  library: z.object({
    steamAppId: z.number().int().positive().optional(),
    gamePass: z.boolean().default(false),
    exception: z.boolean().default(false),
    installed: z.boolean().default(false),
    installDirectory: z.string().optional(),
  }).default({ gamePass: false, exception: false, installed: false }),
  capture: z.object({
    preferred: CaptureMethodSchema.default('auto'),
    executableNames: z.array(z.string()).default([]),
    localSourceName: z.string().default('PC Game Capture'),
    geforceNowEnabled: z.boolean().default(false),
    geforceNowSourceName: z.string().default('GFN Capture'),
    windowSourceName: z.string().optional(),
    displaySourceName: z.string().default('Display Capture'),
    allowDisplayFallback: z.boolean().default(false),
  }),
  obs: z.object({
    sceneName: ObsSceneNameSchema,
    startingScene: ObsSceneNameSchema.default('00_STARTING'),
    endingScene: ObsSceneNameSchema.default('90_ENDING'),
  }),
  youtube: ServiceConfigSchema.extend({
    description: z.string().default(''),
    privacy: z.enum(['public', 'unlisted', 'private']).default('public'),
    categoryId: z.string().default('20'),
  }),
  twitch: ServiceConfigSchema.extend({
    categoryName: z.string().default(''),
    tags: z.array(z.string()).default(['日本語']),
  }),
  audio: AudioProfileSchema,
  recording: z.object({
    enabled: z.boolean().default(true),
    directory: z.string().default(''),
    replayBufferSeconds: z.number().int().min(5).max(1200).default(180),
    sourceRecord: z.boolean().default(false),
    verticalRecording: z.boolean().default(false),
  }),
  state: z.object({
    lastCaptureMethod: CaptureMethodSchema.optional(),
    lastUsedAt: z.string().datetime().nullable().default(null),
    thumbnailFilename: z.string().optional(),
    thumbnailOriginalName: z.string().trim().min(1).max(255).optional(),
    thumbnailUpdatedAt: z.string().datetime().optional(),
    thumbnailAutoApply: z.boolean().default(true),
    thumbnailApplyStatus: ThumbnailApplyStatusSchema.default('not_registered'),
    thumbnailLastAppliedAt: z.string().datetime().nullable().default(null),
    thumbnailLastError: z.string().optional(),
    nextPartNumber: z.number().int().min(1).max(9999).default(1),
  }).default({ lastUsedAt: null, thumbnailAutoApply: true, thumbnailApplyStatus: 'not_registered', thumbnailLastAppliedAt: null, nextPartNumber: 1 }),
})

export type GameProfile = z.infer<typeof GameProfileSchema>

export const AppConfigSchema = z.object({
  setup: z.object({
    completed: z.boolean().default(true),
  }).default({ completed: true }),
  ui: z.object({
    language: z.enum(['ja', 'en']).default('ja'),
    lastSelectedGameId: GameIdSchema.nullable().optional(),
  }).default({ language: 'ja', lastSelectedGameId: null }),
  obs: z.object({
    url: z.string().default('ws://127.0.0.1:4455'),
    passwordStored: z.boolean().default(false),
    startDelaySeconds: z.number().int().min(0).max(60).default(5),
    endDelaySeconds: z.number().int().min(0).max(60).default(5),
  }),
  sources: z.object({
    microphone: z.string().default('MIC'),
    pcGame: z.string().default('GAME_PC'),
    geforceNow: z.string().default('GAME_GFN'),
    switchGame: z.string().default('GAME_SWITCH'),
    discord: z.string().default('DISCORD'),
    bgm: z.string().default('BGM'),
  }),
  features: z.object({
    youtube: z.boolean().default(true),
    twitch: z.boolean().default(true),
    recording: z.boolean().default(true),
    replayBuffer: z.boolean().default(true),
    sourceRecord: z.boolean().default(false),
    verticalRecording: z.boolean().default(false),
  }),
  commonTemplate: CommonTemplateConfigSchema.default(defaultCommonTemplateConfig),
  steam: z.object({
    steamId64: z.string().default(''),
    apiKeyStored: z.boolean().default(false),
    installPath: z.string().default(''),
  }),
  youtube: z.object({
    clientId: z.string().default(''),
    clientSecretStored: z.boolean().default(false),
    refreshTokenStored: z.boolean().default(false),
    broadcastId: z.string().default(''),
  }),
  twitch: z.object({
    clientId: z.string().default(''),
    clientSecretStored: z.boolean().default(false),
    accessTokenStored: z.boolean().default(false),
    refreshTokenStored: z.boolean().default(false),
    broadcasterId: z.string().default(''),
  }),
})

export type AppConfig = z.infer<typeof AppConfigSchema>

export const BgmTrackSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(180),
  originalName: z.string().trim().min(1).max(255),
  filename: z.string().regex(/^[0-9a-f-]+\.(mp3|wav|ogg|flac|m4a)$/),
  mime: z.enum(['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/flac', 'audio/mp4']),
  size: z.number().int().positive(),
  addedAt: z.string().datetime(),
})

export type BgmTrack = z.infer<typeof BgmTrackSchema>

export const BgmLibrarySchema = z.object({
  version: z.literal(1).default(1),
  tracks: z.array(BgmTrackSchema).default([]),
  selectedTrackId: z.string().uuid().nullable().default(null),
})

export type BgmLibrary = z.infer<typeof BgmLibrarySchema>

export type BgmBackup = {
  version: 1
  library: BgmLibrary
  tracks: Record<string, { data: string }>
}

export const BgmPlaybackSchema = z.object({
  state: z.enum(['playing', 'paused', 'stopped', 'unavailable']),
  cursorMs: z.number().nonnegative().nullable(),
  durationMs: z.number().nonnegative().nullable(),
})

export type BgmPlayback = z.infer<typeof BgmPlaybackSchema>
export type BgmLibraryStatus = BgmLibrary & { playback: BgmPlayback }

export const LocalObsSetupStatusSchema = z.object({
  phase: z.enum(['ready', 'waiting_for_obs', 'restart_required', 'error']),
  detail: z.string(),
  dockConfigured: z.boolean(),
  websocketConfigured: z.boolean(),
})

export type LocalObsSetupStatus = z.infer<typeof LocalObsSetupStatusSchema>

const ViewerCountStateSchema = z.enum(['available', 'hidden', 'unavailable'])

export const RuntimeStatusSchema = z.object({
  obsConnected: z.boolean(),
  streaming: z.boolean(),
  streamElapsedMs: z.number().nonnegative().optional(),
  recording: z.boolean(),
  replayBuffer: z.boolean(),
  sourceRecord: z.boolean(),
  verticalRecording: z.boolean(),
  selectedGameId: z.string().nullable(),
  captureMethod: CaptureMethodSchema.nullable(),
  currentScene: z.string().nullable(),
  warning: z.string().nullable(),
  busy: z.boolean(),
  twitchOutputPluginReady: z.boolean().optional(),
  twitchOutputPlugin: z.object({
    state: z.enum(['ready', 'restart_required', 'missing', 'incompatible', 'install_failed']),
    version: z.string().optional(),
    detail: z.string(),
    outputActive: z.boolean(),
  }).optional(),
  platforms: z.object({
    youtube: z.object({
      state: z.enum(['disabled', 'unprepared', 'ready', 'starting', 'live', 'stopping', 'offline', 'error']),
      detail: z.string(),
      checkedAt: z.string().datetime().nullable(),
      viewerCount: z.number().int().nonnegative().nullable().optional(),
      viewerCountState: ViewerCountStateSchema.optional(),
      viewerCountDetail: z.string().optional(),
    }),
    twitch: z.object({
      state: z.enum(['disabled', 'unprepared', 'ready', 'starting', 'live', 'stopping', 'offline', 'error']),
      detail: z.string(),
      checkedAt: z.string().datetime().nullable(),
      viewerCount: z.number().int().nonnegative().nullable().optional(),
      viewerCountState: ViewerCountStateSchema.optional(),
      viewerCountDetail: z.string().optional(),
    }),
  }),
})

export type RuntimeStatus = z.infer<typeof RuntimeStatusSchema>
export type PlatformRuntimeStatus = RuntimeStatus['platforms']['youtube']
export type PlatformRuntimeStatuses = RuntimeStatus['platforms']

export type ApplyResult = {
  profile: GameProfile
  captureMethod: CaptureMethod
  warnings: string[]
}

export type ChatMessage = {
  id: string
  service: 'youtube' | 'twitch'
  author: string
  body: string
  publishedAt: string
  moderator: boolean
  mention: boolean
}
