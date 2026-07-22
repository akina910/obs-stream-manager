import type { CaptureMethod, GameProfile } from './contracts.js'

export const AUDIO_CALIBRATION_ROLES = ['microphone', 'game', 'discord', 'bgm'] as const
export type AudioCalibrationRole = (typeof AUDIO_CALIBRATION_ROLES)[number]

export type AudioCalibrationTarget = {
  referenceDb: number
  peakCeilingDb: number
  toleranceDb: number
  required: boolean
}

export const AUDIO_CALIBRATION_TARGETS: Record<AudioCalibrationRole, AudioCalibrationTarget> = {
  microphone: { referenceDb: -18, peakCeilingDb: -6, toleranceDb: 2.5, required: true },
  game: { referenceDb: -24, peakCeilingDb: -10, toleranceDb: 3, required: true },
  discord: { referenceDb: -21, peakCeilingDb: -8, toleranceDb: 3, required: false },
  bgm: { referenceDb: -30, peakCeilingDb: -14, toleranceDb: 3, required: false },
}

export type AudioMeterSample = {
  magnitudeDb: number
  peakDb: number
}

export type AudioMeasurement = {
  sampleCount: number
  activeSampleCount: number
  referenceDb: number
  peakDb: number
}

export type AudioGainRecommendation = {
  appliedDb: number
  adjustmentDb: number
  constrainedByPeak: boolean
  constrainedByFader: boolean
  withinTarget: boolean
}

export type AudioMicrophoneGainRecommendation = AudioGainRecommendation & {
  appliedBoostDb: number
  faderAdjustmentDb: number
  boostAdjustmentDb: number
  constrainedByBoost: boolean
}

export type AudioCalibrationReadingStatus = 'adjusted' | 'within_target' | 'limited' | 'no_signal' | 'muted' | 'missing'

export type AudioCalibrationReading = {
  role: AudioCalibrationRole
  sourceName: string
  required: boolean
  status: AudioCalibrationReadingStatus
  targetDb: number
  peakCeilingDb: number
  previousDb?: number
  previousBoostDb?: number
  appliedDb?: number
  appliedBoostDb?: number
  adjustmentDb?: number
  boostAdjustmentDb?: number
  measuredDb?: number
  measuredPeakDb?: number
  verifiedDb?: number
  verifiedPeakDb?: number
  sampleCount?: number
  message: string
}

export type AudioManagedFilterResult = {
  sourceName: string
  filterName: string
  filterKind: string
  status: 'created' | 'updated' | 'reused' | 'disabled'
  message: string
}

export type AudioCalibrationResult = {
  profile: GameProfile
  captureMethod: CaptureMethod
  startedAt: string
  completedAt: string
  durationMs: number
  readings: AudioCalibrationReading[]
  filters: AudioManagedFilterResult[]
  warnings: string[]
}

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value))
const roundHalfDb = (value: number) => Math.round(value * 2) / 2

export function percentile(values: number[], ratio: number): number {
  if (!values.length) throw new Error('percentile requires at least one value')
  const sorted = [...values].sort((left, right) => left - right)
  const index = clamp((sorted.length - 1) * ratio, 0, sorted.length - 1)
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower)
}

export function analyzeAudioSamples(samples: AudioMeterSample[], minimumActiveSamples = 8): AudioMeasurement | null {
  const usable = samples.filter(({ magnitudeDb, peakDb }) => Number.isFinite(magnitudeDb) && Number.isFinite(peakDb))
  const active = usable.filter(({ magnitudeDb, peakDb }) => magnitudeDb > -60 || peakDb > -55)
  if (active.length < minimumActiveSamples) return null
  return {
    sampleCount: usable.length,
    activeSampleCount: active.length,
    referenceDb: roundHalfDb(percentile(active.map(({ magnitudeDb }) => magnitudeDb), 0.75)),
    peakDb: roundHalfDb(percentile(active.map(({ peakDb }) => peakDb), 0.95)),
  }
}

export function recommendInputVolume(
  currentDb: number,
  measurement: AudioMeasurement,
  target: AudioCalibrationTarget,
  maximumAdjustmentDb = 12,
): AudioGainRecommendation {
  const levelDifference = target.referenceDb - measurement.referenceDb
  const peakHeadroom = target.peakCeilingDb - measurement.peakDb
  const alreadyWithinTarget = Math.abs(levelDifference) <= target.toleranceDb && peakHeadroom >= -1
  if (alreadyWithinTarget) {
    return {
      appliedDb: roundHalfDb(currentDb),
      adjustmentDb: 0,
      constrainedByPeak: false,
      constrainedByFader: false,
      withinTarget: true,
    }
  }

  const peakSafeDifference = Math.min(levelDifference, peakHeadroom)
  const boundedDifference = clamp(peakSafeDifference, -maximumAdjustmentDb, maximumAdjustmentDb)
  const unclampedFader = roundHalfDb(currentDb + boundedDifference)
  // OBS supports substantially more than +6 dB. Quiet interfaces such as the
  // current Focusrite input can otherwise hit the artificial ceiling while
  // remaining inaudible after noise suppression and compression.
  const appliedDb = clamp(unclampedFader, -30, 20)
  const adjustmentDb = roundHalfDb(appliedDb - currentDb)
  return {
    appliedDb,
    adjustmentDb,
    constrainedByPeak: peakSafeDifference < levelDifference,
    constrainedByFader: appliedDb !== unclampedFader,
    withinTarget: false,
  }
}

export function recommendMicrophoneGain(
  currentDb: number,
  currentBoostDb: number,
  measurement: AudioMeasurement,
  target: AudioCalibrationTarget,
  maximumAdjustmentDb = 30,
): AudioMicrophoneGainRecommendation {
  const levelDifference = target.referenceDb - measurement.referenceDb
  const peakHeadroom = target.peakCeilingDb - measurement.peakDb
  const alreadyWithinTarget = Math.abs(levelDifference) <= target.toleranceDb && peakHeadroom >= -1
  const roundedCurrentDb = roundHalfDb(currentDb)
  const roundedCurrentBoostDb = roundHalfDb(currentBoostDb)
  const normalizedDb = roundHalfDb(clamp(roundedCurrentDb, -30, 20))
  const faderOverflowDb = roundHalfDb(roundedCurrentDb - normalizedDb)
  const requestedNormalizedBoostDb = roundedCurrentBoostDb + faderOverflowDb
  const normalizedBoostDb = roundHalfDb(clamp(requestedNormalizedBoostDb, 0, 24))
  const normalizationFaderAdjustmentDb = roundHalfDb(normalizedDb - roundedCurrentDb)
  const normalizationBoostAdjustmentDb = roundHalfDb(normalizedBoostDb - roundedCurrentBoostDb)
  if (alreadyWithinTarget) {
    return {
      appliedDb: normalizedDb,
      appliedBoostDb: normalizedBoostDb,
      adjustmentDb: roundHalfDb(normalizationFaderAdjustmentDb + normalizationBoostAdjustmentDb),
      faderAdjustmentDb: normalizationFaderAdjustmentDb,
      boostAdjustmentDb: normalizationBoostAdjustmentDb,
      constrainedByPeak: false,
      constrainedByFader: normalizationFaderAdjustmentDb !== 0,
      constrainedByBoost: requestedNormalizedBoostDb !== normalizedBoostDb,
      withinTarget: true,
    }
  }

  const peakSafeDifference = Math.min(levelDifference, peakHeadroom)
  const requestedAdjustment = roundHalfDb(clamp(peakSafeDifference, -maximumAdjustmentDb, maximumAdjustmentDb))
  let nextDb = normalizedDb
  let nextBoostDb = normalizedBoostDb
  let constrainedByFader = normalizationFaderAdjustmentDb !== 0
  let constrainedByBoost = requestedNormalizedBoostDb !== normalizedBoostDb

  if (requestedAdjustment > 0) {
    const faderIncrease = Math.min(requestedAdjustment, Math.max(0, 20 - nextDb))
    nextDb = roundHalfDb(nextDb + faderIncrease)
    const remaining = roundHalfDb(requestedAdjustment - faderIncrease)
    constrainedByFader ||= remaining > 0
    const requestedBoostDb = nextBoostDb + remaining
    constrainedByBoost ||= requestedBoostDb > 24
    nextBoostDb = roundHalfDb(Math.min(24, requestedBoostDb))
  } else if (requestedAdjustment < 0) {
    const boostReduction = Math.max(requestedAdjustment, -nextBoostDb)
    nextBoostDb = roundHalfDb(nextBoostDb + boostReduction)
    const remaining = roundHalfDb(requestedAdjustment - boostReduction)
    const requestedFaderDb = nextDb + remaining
    constrainedByFader ||= requestedFaderDb < -30
    nextDb = roundHalfDb(clamp(requestedFaderDb, -30, 20))
  }

  const faderAdjustmentDb = roundHalfDb(nextDb - roundedCurrentDb)
  const boostAdjustmentDb = roundHalfDb(nextBoostDb - roundedCurrentBoostDb)
  const adjustmentDb = roundHalfDb(faderAdjustmentDb + boostAdjustmentDb)
  return {
    appliedDb: nextDb,
    appliedBoostDb: nextBoostDb,
    adjustmentDb,
    faderAdjustmentDb,
    boostAdjustmentDb,
    constrainedByPeak: peakSafeDifference < levelDifference,
    constrainedByFader,
    constrainedByBoost,
    withinTarget: false,
  }
}

export function audioFieldForRole(role: AudioCalibrationRole): keyof GameProfile['audio'] {
  if (role === 'microphone') return 'microphoneDb'
  if (role === 'game') return 'gameDb'
  if (role === 'discord') return 'discordDb'
  return 'bgmDb'
}
