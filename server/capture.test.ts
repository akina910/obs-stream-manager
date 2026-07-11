import { describe, expect, it, vi } from 'vitest'
import { CaptureDetector } from './capture.js'
import { starterProfiles } from './defaults.js'

describe('CaptureDetector', () => {
  it('uses display capture only when the profile explicitly allows the fallback', async () => {
    const detector = new CaptureDetector()
    vi.spyOn(detector, 'runningProcesses').mockResolvedValue([])
    const profile = structuredClone(starterProfiles.find((item) => item.id === 'ark_survival_ascended')!)
    profile.capture.allowDisplayFallback = true
    await expect(detector.detect(profile)).resolves.toMatchObject({ method: 'display' })
  })
})
