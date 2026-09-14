export type RecordingOutputAnalysis = {
  videoCodec: string
  width: number
  height: number
  container: string
  durationSeconds: number
  measuredFps: number
  frameIntervalMs: { over40ms: number }
  duplicateRatio: number
  bitRate: number
  audioTracks: Array<{ title: string }>
}

export const expectedRecordingTrackTitles = ['GAME', 'DISCORD', 'MIC', 'BGM', 'AUX CAPTURE', 'STREAM MIX']

export function validateRecordingOutput(
  analysis: RecordingOutputAnalysis,
  expectedDurationMs?: number | null,
): string[] {
  const actualTrackTitles = analysis.audioTracks.map(({ title }) => title)
  const actualDurationMs = analysis.durationSeconds * 1_000
  const durationToleranceMs = expectedDurationMs
    ? Math.max(1_000, expectedDurationMs * 0.1)
    : 0
  return [
    analysis.width === 1920 && analysis.height === 1080 ? null : `unexpected resolution ${analysis.width}x${analysis.height}`,
    analysis.container.includes('matroska') ? null : `recording container must be MKV to verify separated track names (actual: ${analysis.container || 'unknown'})`,
    !expectedDurationMs || Math.abs(actualDurationMs - expectedDurationMs) <= durationToleranceMs
      ? null
      : `recording contains ${(actualDurationMs / 1_000).toFixed(2)}s for ${(expectedDurationMs / 1_000).toFixed(2)}s of elapsed capture time`,
    analysis.measuredFps >= 59 && analysis.measuredFps <= 61 ? null : `measured FPS ${analysis.measuredFps.toFixed(2)}`,
    analysis.frameIntervalMs.over40ms <= 2 ? null : `${analysis.frameIntervalMs.over40ms} frame gaps exceeded 40ms`,
    analysis.duplicateRatio <= 0.01 ? null : `${(analysis.duplicateRatio * 100).toFixed(3)}% consecutive duplicate frames`,
    analysis.bitRate >= 7_500_000 && analysis.bitRate <= 10_500_000
      ? null
      : `recording bitrate ${(analysis.bitRate / 1_000_000).toFixed(2)} Mbps is outside the expected 7.5-10.5 Mbps aggregate range`,
    JSON.stringify(actualTrackTitles) === JSON.stringify(expectedRecordingTrackTitles)
      ? null
      : `unexpected separated audio tracks ${JSON.stringify(actualTrackTitles)}`,
  ].filter((failure): failure is string => failure !== null)
}

export function validateRecordingOnlyOutput(
  analysis: RecordingOutputAnalysis,
  expectedDurationMs?: number | null,
): string[] {
  const actualTrackTitles = analysis.audioTracks.map(({ title }) => title)
  const actualDurationMs = analysis.durationSeconds * 1_000
  const durationToleranceMs = expectedDurationMs ? Math.max(1_000, expectedDurationMs * 0.02) : 0
  return [
    analysis.videoCodec === 'h264' ? null : `recording-only codec must be H.264 (actual: ${analysis.videoCodec || 'unknown'})`,
    analysis.width === 2560 && analysis.height === 1440 ? null : `recording-only resolution must be 2560x1440 (actual: ${analysis.width}x${analysis.height})`,
    analysis.container.includes('matroska') ? null : `recording-only source must be MKV before remux (actual: ${analysis.container || 'unknown'})`,
    !expectedDurationMs || Math.abs(actualDurationMs - expectedDurationMs) <= durationToleranceMs
      ? null
      : `recording-only output contains ${(actualDurationMs / 1_000).toFixed(2)}s for ${(expectedDurationMs / 1_000).toFixed(2)}s of elapsed capture time`,
    analysis.measuredFps >= 59 && analysis.measuredFps <= 61 ? null : `recording-only measured FPS ${analysis.measuredFps.toFixed(2)}`,
    analysis.frameIntervalMs.over40ms === 0 ? null : `${analysis.frameIntervalMs.over40ms} recording-only frame gaps exceeded 40ms`,
    analysis.duplicateRatio <= 0.01 ? null : `${(analysis.duplicateRatio * 100).toFixed(3)}% consecutive duplicate recording-only frames`,
    // Allow six 160 kbps AAC tracks and mux overhead above the 10 Mbps video cap.
    // Low-motion VBR is allowed to undershoot the 8 Mbps target.
    Number.isFinite(analysis.bitRate) && analysis.bitRate > 0 && analysis.bitRate <= 11_500_000
      ? null
      : `recording-only aggregate bitrate exceeds the 11.5 Mbps cap or is unavailable (actual: ${analysis.bitRate})`,
    JSON.stringify(actualTrackTitles) === JSON.stringify(expectedRecordingTrackTitles)
      ? null
      : `unexpected recording-only audio tracks ${JSON.stringify(actualTrackTitles)}`,
  ].filter((failure): failure is string => failure !== null)
}
