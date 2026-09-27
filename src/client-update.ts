import type { RuntimeStatus } from '../shared/contracts'

export const clientUpdateIntervalMs = 15_000

// A disconnected service account must not permanently strand an old dock when
// OBS has independently confirmed that every local output is stopped.
const inactivePlatformStates = new Set(['disabled', 'unprepared', 'ready', 'offline', 'error'])

export function canReloadClient(status: RuntimeStatus | null, localBusy: boolean): boolean {
  return !!status && !localBusy && status.obsConnected && !status.busy
    && !status.streaming && !status.recording && !status.recordingOnly
    && !status.replayBuffer && !status.sourceRecord && !status.verticalRecording
    && status.twitchOutputPlugin?.outputActive === false
    && inactivePlatformStates.has(status.platforms.youtube.state)
    && inactivePlatformStates.has(status.platforms.twitch.state)
}

type ClientUpdateOptions = {
  loadedEntryScript: string | null
  getBuild: () => Promise<{ entryScript: string | null }>
  getStatus: () => Promise<RuntimeStatus>
  isBlocked: () => boolean
  reload: () => void
}

export function createClientUpdateCheck(options: ClientUpdateOptions): () => Promise<void> {
  let inFlight = false
  let reloaded = false
  return async () => {
    if (!options.loadedEntryScript || inFlight || reloaded || options.isBlocked()) return
    inFlight = true
    try {
      const build = await options.getBuild()
      if (!build.entryScript || !/^\/assets\/[^/?#]+\.js$/.test(build.entryScript)
        || build.entryScript === options.loadedEntryScript || options.isBlocked()) return
      // Fetch output state after discovering an update, not from an earlier UI
      // poll. Recheck local actions after the request to avoid reloading mid-click.
      const status = await options.getStatus()
      if (!canReloadClient(status, options.isBlocked())) return
      reloaded = true
      options.reload()
    } catch { /* Server restarts and offline periods are retried on the next poll. */ }
    finally { inFlight = false }
  }
}
