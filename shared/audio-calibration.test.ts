import { describe, expect, it } from 'vitest'
import {
  AUDIO_CALIBRATION_TARGETS,
  analyzeAudioSamples,
  percentile,
  recommendInputVolume,
  recommendMicrophoneGain,
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

  it('moves microphone makeup into the managed boost after the fader reaches +20 dB', () => {
    const recommendation = recommendMicrophoneGain(18, 0, {
      sampleCount: 80,
      activeSampleCount: 72,
      referenceDb: -34,
      peakDb: -22,
    }, AUDIO_CALIBRATION_TARGETS.microphone)
    expect(recommendation).toMatchObject({
      appliedDb: 20,
      appliedBoostDb: 14,
      adjustmentDb: 16,
      faderAdjustmentDb: 2,
      boostAdjustmentDb: 14,
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
      appliedDb: 5,
      appliedBoostDb: 0,
      adjustmentDb: -8,
      faderAdjustmentDb: -5,
      boostAdjustmentDb: -3,
      constrainedByPeak: false,
    })
  })

  it('reports the managed boost ceiling separately from the fader ceiling', () => {
    const recommendation = recommendMicrophoneGain(20, 22, {
      sampleCount: 80,
      activeSampleCount: 72,
      referenceDb: -40,
      peakDb: -30,
    }, AUDIO_CALIBRATION_TARGETS.microphone)
    expect(recommendation).toMatchObject({
      appliedDb: 20,
      appliedBoostDb: 24,
      adjustmentDb: 2,
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
      appliedDb: 1,
      appliedBoostDb: 0,
      adjustmentDb: 1,
      constrainedByPeak: true,
    })
  })

  it('moves a legacy fader value above +20 dB into managed boost without changing total gain', () => {
    const recommendation = recommendMicrophoneGain(25, 0, {
      sampleCount: 80,
      activeSampleCount: 72,
      referenceDb: -18,
      peakDb: -6,
    }, AUDIO_CALIBRATION_TARGETS.microphone)
    expect(recommendation).toMatchObject({
      appliedDb: 20,
      appliedBoostDb: 5,
      adjustmentDb: 0,
      faderAdjustmentDb: -5,
      boostAdjustmentDb: 5,
      constrainedByFader: true,
      withinTarget: true,
    })
  })

  it('reports normalization from an out-of-range existing boost against its actual value', () => {
    const recommendation = recommendMicrophoneGain(20, 26, {
      sampleCount: 80,
      activeSampleCount: 72,
      referenceDb: -18,
      peakDb: -6,
    }, AUDIO_CALIBRATION_TARGETS.microphone)
    expect(recommendation).toMatchObject({
      appliedDb: 20,
      appliedBoostDb: 24,
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
      peakDb: -6.2,
    }, AUDIO_CALIBRATION_TARGETS.microphone)
    expect(recommendation).toMatchObject({
      adjustmentDb: 0,
      constrainedByPeak: true,
      withinTarget: false,
    })
  })
})
