import { describe, expect, it } from 'vitest'
import { expectedRecordingTrackTitles, validateRecordingOnlyOutput, validateRecordingOutput, type RecordingOutputAnalysis } from './recording-output-validation.js'

const healthyAnalysis: RecordingOutputAnalysis = {
  videoCodec: 'h264',
  width: 1920,
  height: 1080,
  container: 'matroska,webm',
  durationSeconds: 22,
  measuredFps: 60,
  frameIntervalMs: { over40ms: 0 },
  duplicateRatio: 0,
  bitRate: 10_401_000,
  audioTracks: expectedRecordingTrackTitles.map((title) => ({ title })),
}

describe('recorded output validation', () => {
  it('accepts a complete FHD60 recording with five separated stems and the public stream mix', () => {
    expect(validateRecordingOutput(healthyAnalysis, 22_000)).toEqual([])
  })

  it('accepts the aggregate bitrate produced by 10000 kbps video and six 160 kbps audio tracks', () => {
    expect(validateRecordingOutput({
      ...healthyAnalysis,
      bitRate: 10_401_000,
    }, 22_000)).toEqual([])
  })

  it('rejects a nominal 60fps file that contains only part of the elapsed capture time', () => {
    expect(validateRecordingOutput({
      ...healthyAnalysis,
      durationSeconds: 6.384,
    }, 27_216)).toContain('recording contains 6.38s for 27.22s of elapsed capture time')
  })

  it('accepts a complete 1440p60 bounded VBR recording-only file below its target bitrate', () => {
    expect(validateRecordingOnlyOutput({
      ...healthyAnalysis,
      width: 2560,
      height: 1440,
      bitRate: 9_000_000,
    }, 22_000)).toEqual([])
  })

  it.each([103_216_083, 109_924_423, 11_500_001, 0, Number.NaN])('rejects oversized or unmeasurable recording-only bitrate %s', (bitRate) => {
    expect(validateRecordingOnlyOutput({ ...healthyAnalysis, width: 2560, height: 1440, bitRate }, 22_000))
      .toContain(`recording-only aggregate bitrate exceeds the 11.5 Mbps cap or is unavailable (actual: ${bitRate})`)
  })

  it('accepts the cap including all audio tracks and mux overhead', () => {
    expect(validateRecordingOnlyOutput({ ...healthyAnalysis, width: 2560, height: 1440, bitRate: 11_500_000 }, 22_000)).toEqual([])
  })

  it('rejects a different recording codec', () => {
    expect(validateRecordingOnlyOutput({ ...healthyAnalysis, width: 2560, height: 1440, videoCodec: 'hevc' }, 22_000))
      .toContain('recording-only codec must be H.264 (actual: hevc)')
  })

  it('rejects any long frame gap in recording-only acceptance', () => {
    expect(validateRecordingOnlyOutput({
      ...healthyAnalysis,
      width: 2560,
      height: 1440,
      frameIntervalMs: { over40ms: 1 },
    }, 22_000)).toContain('1 recording-only frame gaps exceeded 40ms')
  })
})
