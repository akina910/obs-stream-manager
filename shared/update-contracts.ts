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
  blockReason?: UpdateBlockReason
  portable: boolean
  installSupported: boolean
}
