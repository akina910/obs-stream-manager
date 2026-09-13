import { describe, expect, it } from 'vitest'
import {
  AUDIO_CALIBRATION_TARGETS,
  analyzeAudioSamples,
  normalizeMicrophoneGain,
  percentile,
  recommendInputVolume,
  recommendMicrophoneGain,
  type AudioMeterSample,
} from './audio-calibration.js'

describe('audio calibration math', () => {
  it('caps unmeasured legacy positive-fader profiles before the managed limiter chain', () => {
    expect(normalizeMicrophoneGain(20, 15)).toEqual({
      appliedDb: 0,
      appliedBoostDb: 24,
      constrainedByFader: false,
      constrainedByBoost: true,
    })
    expect(normalizeMicrophoneGain(0, 30).appliedBoostDb).toBe(30)
  })

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

  it('allows a quiet microphone to go beyond the former +6 dB ceiling', () => {
    const recommendation = recommendInputVolume(5, {
      sampleCount: 80,
      activeSampleCount: 72,
      referenceDb: -40,
      peakDb: -30,
    }, AUDIO_CALIBRATION_TARGETS.microphone)
    expect(recommendation.appliedDb).toBe(17)
    expect(recommendation.constrainedByFader).toBe(false)
  })

  it('recognizes a very quiet microphone from its pre-fader input peak', () => {
    const samples = Array.from({ length: 40 }, () => ({ magnitudeDb: -78, peakDb: -74, inputPeakDb: -52 }))

    expect(analyzeAudioSamples(samples, 8, -75)).toMatchObject({
      activeSampleCount: 40,
      referenceDb: -78,
      peakDb: -74,
    })
  })

  it('still caps the OBS fader at a safe +20 dB', () => {
    const recommendation = recommendInputVolume(15, {
      sampleCount: 80,
      activeSampleCount: 72,
      referenceDb: -40,
      peakDb: -30,
    }, AUDIO_CALIBRATION_TARGETS.microphone)
    expect(recommendation.appliedDb).toBe(20)
    expect(recommendation.constrainedByFader).toBe(true)
  })

  it('moves positive microphone makeup before the limiter and respects the gain-filter ceiling', () => {
    const recommendation = recommendMicrophoneGain(18, 0, {
      sampleCount: 80,
      activeSampleCount: 72,
      referenceDb: -34,
      peakDb: -22,
    }, AUDIO_CALIBRATION_TARGETS.microphone)
    expect(recommendation).toMatchObject({
      appliedDb: 0,
      appliedBoostDb: 30,
      adjustmentDb: 12,
      faderAdjustmentDb: -18,
      boostAdjustmentDb: 30,
      constrainedByFader: true,
      constrainedByBoost: true,
    })
  })

  it('boosts the quiet real-stream microphone reading instead of lowering its +18 dB fader', () => {
    // 2026-07-22 production calibration finished at -34 dB reference / -13 dB
    // peak and the old implementation incorrectly reduced the fader to +3 dB.
    const recommendation = recommendMicrophoneGain(18, 0, {
      sampleCount: 80,
      activeSampleCount: 72,
      referenceDb: -34,
      peakDb: -13,
    }, AUDIO_CALIBRATION_TARGETS.microphone)
    expect(recommendation).toMatchObject({
      appliedDb: 0,
      appliedBoostDb: 28,
      adjustmentDb: 10,
      faderAdjustmentDb: -18,
      boostAdjustmentDb: 28,
      constrainedByPeak: true,
      constrainedByFader: true,
      constrainedByBoost: false,
    })
  })

  it('removes managed boost before lowering the microphone fader', () => {
    const recommendation = recommendMicrophoneGain(10, 3, {
      sampleCount: 80,
      activeSampleCount: 72,
      referenceDb: -10,
      peakDb: -1,
    }, AUDIO_CALIBRATION_TARGETS.microphone)
    expect(recommendation).toMatchObject({
      appliedDb: 0,
      appliedBoostDb: 5,
      adjustmentDb: -8,
      faderAdjustmentDb: -10,
      boostAdjustmentDb: 2,
      constrainedByPeak: false,
    })
  })

  it('reports the managed boost ceiling separately from the fader ceiling', () => {
    const recommendation = recommendMicrophoneGain(0, 29, {
      sampleCount: 80,
      activeSampleCount: 72,
      referenceDb: -40,
      peakDb: -30,
    }, AUDIO_CALIBRATION_TARGETS.microphone)
    expect(recommendation).toMatchObject({
      appliedDb: 0,
      appliedBoostDb: 30,
      adjustmentDb: 1,
      constrainedByFader: true,
      constrainedByBoost: true,
    })
  })

  it('reports the fader floor without mislabeling it as a boost limit', () => {
    const recommendation = recommendMicrophoneGain(-29, 0, {
      sampleCount: 80,
      activeSampleCount: 72,
      referenceDb: -10,
      peakDb: -1,
    }, AUDIO_CALIBRATION_TARGETS.microphone)
    expect(recommendation).toMatchObject({
      appliedDb: -30,
      appliedBoostDb: 0,
      adjustmentDb: -1,
      constrainedByFader: true,
      constrainedByBoost: false,
    })
  })

  it('limits a microphone increase by measured peak headroom', () => {
    const recommendation = recommendMicrophoneGain(0, 0, {
      sampleCount: 80,
      activeSampleCount: 72,
      referenceDb: -30,
      peakDb: -7,
    }, AUDIO_CALIBRATION_TARGETS.microphone)
    expect(recommendation).toMatchObject({
      appliedDb: 0,
      appliedBoostDb: 4,
      adjustmentDb: 4,
      constrainedByPeak: true,
    })
  })

  it('never turns a needed microphone boost into attenuation because of a short peak', () => {
    const recommendation = recommendMicrophoneGain(18, 0, {
      sampleCount: 80,
      activeSampleCount: 72,
      referenceDb: -34,
      peakDb: -1,
    }, AUDIO_CALIBRATION_TARGETS.microphone)

    expect(recommendation).toMatchObject({
      appliedDb: 0,
      appliedBoostDb: 18,
      adjustmentDb: 0,
      constrainedByPeak: true,
      withinTarget: false,
    })
  })

  it('moves a legacy positive fader into managed boost without changing total gain', () => {
    const recommendation = recommendMicrophoneGain(25, 0, {
      sampleCount: 80,
      activeSampleCount: 72,
      referenceDb: -18,
      peakDb: -6,
    }, AUDIO_CALIBRATION_TARGETS.microphone)
    expect(recommendation).toMatchObject({
      appliedDb: 0,
      appliedBoostDb: 25,
      adjustmentDb: 0,
      faderAdjustmentDb: -25,
      boostAdjustmentDb: 25,
      constrainedByFader: true,
      withinTarget: true,
    })
  })

  it('reports normalization from an out-of-range existing boost against its actual value', () => {
    const recommendation = recommendMicrophoneGain(0, 32, {
      sampleCount: 80,
      activeSampleCount: 72,
      referenceDb: -18,
      peakDb: -6,
    }, AUDIO_CALIBRATION_TARGETS.microphone)
    expect(recommendation).toMatchObject({
      appliedDb: 0,
      appliedBoostDb: 30,
      adjustmentDb: -2,
      boostAdjustmentDb: -2,
      constrainedByBoost: true,
      withinTarget: true,
    })
  })

  it('reports a sub-half-decibel peak-limited dead zone explicitly', () => {
    const recommendation = recommendMicrophoneGain(0, 0, {
      sampleCount: 80,
      activeSampleCount: 72,
      referenceDb: -23,
      peakDb: -3.2,
    }, AUDIO_CALIBRATION_TARGETS.microphone)
    expect(recommendation).toMatchObject({
      adjustmentDb: 0,
      constrainedByPeak: true,
      withinTarget: false,
    })
  })
})
