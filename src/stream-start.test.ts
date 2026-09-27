import { describe, expect, it, vi } from 'vitest'
import { ApiRequestError, type ServicePreparationResult } from './api'
import { startStreamWithFallback } from './stream-start'

const twitchFailure: ServicePreparationResult[] = [{ service: 'twitch', ok: false, message: 'Twitch authorization expired' }]
const youtubeFailure: ServicePreparationResult[] = [{ service: 'youtube', ok: false, message: 'YouTube invalid_grant' }]
const success = { ok: true as const, warnings: [] as string[] }
function harness(services: ServicePreparationResult[] = []) {
  return { services, start: vi.fn<(allow: boolean) => Promise<typeof success>>().mockResolvedValue(success), onServices: vi.fn(), confirmYouTubeOnly: vi.fn<(message: string) => boolean>().mockReturnValue(true) }
}

describe('deferred streaming preparation fallback', () => {
  it('updates preparation results and offers a single explicit YouTube-only retry after first-start Twitch failure', async () => {
    const h = harness()
    h.start.mockRejectedValueOnce(new ApiRequestError('Preparation failed', twitchFailure))
    expect(await startStreamWithFallback(h)).toEqual(success)
    expect(h.onServices).toHaveBeenCalledExactlyOnceWith(twitchFailure)
    expect(h.confirmYouTubeOnly).toHaveBeenCalledExactlyOnceWith(twitchFailure[0].message)
    expect(h.start.mock.calls).toEqual([[false], [true]])
    expect(h.onServices.mock.invocationCallOrder[0]).toBeLessThan(h.confirmYouTubeOnly.mock.invocationCallOrder[0])
  })

  it('does not start again when the user declines the fallback', async () => {
    const h = harness()
    h.start.mockRejectedValueOnce(new ApiRequestError('Preparation failed', twitchFailure))
    h.confirmYouTubeOnly.mockReturnValue(false)
    expect(await startStreamWithFallback(h)).toBeNull()
    expect(h.start).toHaveBeenCalledExactlyOnceWith(false)
    expect(h.onServices).toHaveBeenCalledWith(twitchFailure)
  })

  it('does not offer fallback for YouTube failures, mixed failures, or an unstructured OBS failure', async () => {
    for (const error of [new ApiRequestError('YouTube failed', youtubeFailure), new ApiRequestError('Both failed', [...twitchFailure, ...youtubeFailure]), new ApiRequestError('Twitch OBS output failed')]) {
      const h = harness()
      h.start.mockRejectedValue(error)
      await expect(startStreamWithFallback(h)).rejects.toBe(error)
      expect(h.start).toHaveBeenCalledExactlyOnceWith(false)
      expect(h.confirmYouTubeOnly).not.toHaveBeenCalled()
    }
  })

  it('rechecks normal readiness after an earlier Twitch-only failure instead of bypassing a repaired connection', async () => {
    const h = harness(twitchFailure)
    expect(await startStreamWithFallback(h)).toEqual(success)
    expect(h.start).toHaveBeenCalledExactlyOnceWith(false)
    expect(h.confirmYouTubeOnly).not.toHaveBeenCalled()
  })

  it('keeps a second failure visible, updates its services, and never loops or bypasses YouTube', async () => {
    const h = harness()
    const failure = new ApiRequestError('YouTube failed after fallback', youtubeFailure)
    h.start.mockRejectedValueOnce(new ApiRequestError('Twitch failed', twitchFailure)).mockRejectedValueOnce(failure)
    await expect(startStreamWithFallback(h)).rejects.toBe(failure)
    expect(h.start.mock.calls).toEqual([[false], [true]])
    expect(h.confirmYouTubeOnly).toHaveBeenCalledTimes(1)
    expect(h.onServices).toHaveBeenLastCalledWith(youtubeFailure)
  })

  it('does not confirm or retry after a successful normal start', async () => {
    const h = harness()
    expect(await startStreamWithFallback(h)).toEqual(success)
    expect(h.start).toHaveBeenCalledExactlyOnceWith(false)
    expect(h.confirmYouTubeOnly).not.toHaveBeenCalled()
  })
})
