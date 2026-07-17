export type DesktopUpdatePhase =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error'
  | 'unsupported'

export type UpdateBlockReason = 'streaming' | 'recording' | 'replay-buffer' | 'busy' | 'external-live' | 'status-unavailable'

export type DesktopUpdateState = {
  phase: DesktopUpdatePhase
  currentVersion: string
  availableVersion?: string
  releaseName?: string
  releaseNotes?: string
  progressPercent?: number
  errorMessage?: string
  errorKind?: 'no-release' | 'failed'
  blockReason?: UpdateBlockReason
  portable: boolean
  installSupported: boolean
}

const activeExternalStates = new Set(['starting', 'live', 'stopping'])

export function getUpdateBlockReason(status: RuntimeStatus): UpdateBlockReason | null {
  if (status.streaming) return 'streaming'
  if (status.recording || status.sourceRecord || status.verticalRecording) return 'recording'
  if (status.replayBuffer) return 'replay-buffer'
  if (status.busy) return 'busy'
  if (status.twitchOutputPlugin?.outputActive) return 'external-live'
  if (activeExternalStates.has(status.platforms.youtube.state) || activeExternalStates.has(status.platforms.twitch.state)) {
    return 'external-live'
  }
  return null
}
import type { RuntimeStatus } from './contracts.js'
