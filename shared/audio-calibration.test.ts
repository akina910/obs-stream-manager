import { describe, expect, it } from 'vitest'
import {
  AUDIO_CALIBRATION_TARGETS,
  analyzeAudioSamples,
  percentile,
  recommendInputVolume,
  type AudioMeterSample,
} from './audio-calibration.js'

describe('audio calibration math', () => {
  it('uses robust percentiles instead of a single transient sample', () => {
    expect(percentile([-30, -20, -10, 0], 0.75)).toBe(-7.5)
    const samples: AudioMeterSample[] = [
      ...Array.from({ length: 8 }, () => ({ magnitudeDb: -20, peakDb: -8 })),
      { magnitudeDb: -58, peakDb: -50 },
      { magnitudeDb: -4, peakDb: -0.5 },
    ]
    expect(analyzeAudioSamples(samples, 8)).toEqual({
      sampleCount: 10,
      activeSampleCount: 10,
      referenceDb: -20,
      peakDb: -4,
    })
  })

  it('rejects silence instead of applying maximum gain', () => {
    const samples = Array.from({ length: 40 }, () => ({ magnitudeDb: -100, peakDb: -100 }))
    expect(analyzeAudioSamples(samples)).toBeNull()
  })

  it('limits gain when peaks would exceed the role ceiling', () => {
    const recommendation = recommendInputVolume(-15, {
      sampleCount: 80,
      activeSampleCount: 72,
      referenceDb: -30,
      peakDb: -12,
    }, AUDIO_CALIBRATION_TARGETS.game)
    expect(recommendation).toEqual({
      appliedDb: -13,
      adjustmentDb: 2,
      constrainedByPeak: true,
      constrainedByFader: false,
      withinTarget: false,
    })
  })

  it('keeps an already-correct source unchanged', () => {
    const recommendation = recommendInputVolume(-3, {
      sampleCount: 80,
      activeSampleCount: 72,
      referenceDb: -17,
      peakDb: -7,
    }, AUDIO_CALIBRATION_TARGETS.microphone)
    expect(recommendation.adjustmentDb).toBe(0)
    expect(recommendation.withinTarget).toBe(true)
  })

  it('never exceeds the UI-safe fader range', () => {
    const recommendation = recommendInputVolume(5, {
      sampleCount: 80,
      activeSampleCount: 72,
      referenceDb: -40,
      peakDb: -30,
    }, AUDIO_CALIBRATION_TARGETS.microphone)
    expect(recommendation.appliedDb).toBe(6)
    expect(recommendation.constrainedByFader).toBe(true)
  })
})
