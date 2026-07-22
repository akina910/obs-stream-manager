import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import OBSWebSocket from 'obs-websocket-js'
import { SecretStore } from '../server/secrets.js'

const diagnosticScene = '__OSM_FPS_DIAGNOSTIC__'
const diagnosticInput = '__OSM_FPS_MOTION__'
const durationMs = Math.max(5_000, Math.min(60_000, Number(process.argv[2] ?? 20_000)))
const warmupMs = 2_000
const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fps-motion-test.html')

type Bootstrap = {
  config: { obs: { url: string }; sources: { microphone: string; pcGame: string } }
  status: { selectedGameId: string | null }
  profiles: Array<{ id: string; recording: { directory: string } }>
}

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const numeric = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0
const counterDelta = (current: unknown, baseline: unknown) => {
  const currentValue = numeric(current)
  const baselineValue = numeric(baseline)
  // OBS resets output counters when an output starts. Treat the post-reset
  // value as the delta instead of reporting a negative diagnostic result.
  return currentValue >= baselineValue ? currentValue - baselineValue : currentValue
}
const percentile = (values: number[], ratio: number) => {
  if (!values.length) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))]
}

function command(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
}

function analyzeRecording(filename: string) {
  const probe = JSON.parse(command('ffprobe', [
    '-v', 'error', '-count_frames', '-show_entries',
    'stream=index,codec_name,codec_type,width,height,r_frame_rate,avg_frame_rate,nb_read_frames:format=duration,size,bit_rate',
    '-of', 'json', filename,
  ])) as { streams: Array<Record<string, string | number>>; format: Record<string, string> }
  const timestamps = command('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'csv=p=0', filename,
  ]).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map(Number).filter(Number.isFinite)
  const intervals = timestamps.slice(1).map((value, index) => (value - timestamps[index]) * 1000)
  const frameHashes = command('ffmpeg', [
    '-v', 'error', '-i', filename, '-map', '0:v:0', '-an', '-f', 'framemd5', '-',
  ]).split(/\r?\n/).filter((line) => /^\d/.test(line)).map((line) => line.split(',').at(-1)?.trim() ?? '')
  const duplicateFrames = frameHashes.slice(1).filter((hash, index) => hash === frameHashes[index]).length
  const video = probe.streams.find(({ codec_type }) => codec_type === 'video')
  const medianIntervalMs = percentile(intervals, 0.5)
  const probedDurationSeconds = Number(probe.format.duration)
  const timestampDurationSeconds = timestamps.length > 1
    ? timestamps.at(-1)! - timestamps[0] + medianIntervalMs / 1_000
    : 0
  const durationSeconds = Number.isFinite(probedDurationSeconds) && probedDurationSeconds > 0
    ? probedDurationSeconds
    : timestampDurationSeconds
  const frameCount = Number(video?.nb_read_frames ?? timestamps.length)
  const sizeBytes = Number(probe.format.size)
  const probedBitRate = Number(probe.format.bit_rate)
  return {
    filename,
    width: Number(video?.width ?? 0),
    height: Number(video?.height ?? 0),
    nominalFps: String(video?.avg_frame_rate ?? video?.r_frame_rate ?? ''),
    durationSeconds,
    frameCount,
    measuredFps: durationSeconds > 0 ? frameCount / durationSeconds : 0,
    frameIntervalMs: {
      median: medianIntervalMs,
      p99: percentile(intervals, 0.99),
      maximum: Math.max(0, ...intervals),
      over25ms: intervals.filter((value) => value > 25).length,
      over40ms: intervals.filter((value) => value > 40).length,
    },
    duplicateFrames,
    duplicateRatio: frameCount ? duplicateFrames / frameCount : 0,
    audioTracks: probe.streams.filter(({ codec_type }) => codec_type === 'audio').length,
    sizeBytes,
    bitRate: Number.isFinite(probedBitRate) && probedBitRate > 0
      ? probedBitRate
      : durationSeconds > 0 ? Math.round(sizeBytes * 8 / durationSeconds) : 0,
  }
}

async function main() {
  const bootstrap = await fetch('http://127.0.0.1:4317/api/bootstrap').then((response) => {
    if (!response.ok) throw new Error(`OBS Stream Manager bootstrap failed: ${response.status}`)
    return response.json() as Promise<Bootstrap>
  })
  const selected = bootstrap.profiles.find(({ id }) => id === bootstrap.status.selectedGameId)
  if (!selected?.recording.directory) throw new Error('The selected profile does not have a recording directory')

  const obs = new OBSWebSocket()
  const password = new SecretStore().get('obs-password') ?? undefined
  let previousScene = ''
  let recordingStarted = false
  let outputPath = ''
  try {
    await obs.connect(bootstrap.config.obs.url, password)
    const [stream, record, replay, sceneList, inputList] = await Promise.all([
      obs.call('GetStreamStatus'),
      obs.call('GetRecordStatus'),
      obs.call('GetReplayBufferStatus').catch(() => ({ outputActive: false })),
      obs.call('GetSceneList'),
      obs.call('GetInputList'),
    ])
    if (stream.outputActive || record.outputActive || replay.outputActive) throw new Error('Stop streaming, recording, and replay buffer before the diagnostic')
    previousScene = sceneList.currentProgramSceneName
    if (previousScene === diagnosticScene) throw new Error(`OBS is already on the diagnostic scene: ${diagnosticScene}`)
    if (inputList.inputs.some(({ inputName }) => inputName === diagnosticInput)) await obs.call('RemoveInput', { inputName: diagnosticInput })
    if (sceneList.scenes.some(({ sceneName }) => sceneName === diagnosticScene)) await obs.call('RemoveScene', { sceneName: diagnosticScene })

    await obs.call('CreateScene', { sceneName: diagnosticScene })
    await obs.call('CreateInput', {
      sceneName: diagnosticScene,
      inputName: diagnosticInput,
      inputKind: 'browser_source',
      inputSettings: {
        is_local_file: true,
        local_file: fixture,
        width: 1920,
        height: 1080,
        fps: 60,
        shutdown: false,
        restart_when_active: true,
      },
      sceneItemEnabled: true,
    })
    const availableInputs = new Set(inputList.inputs.map(({ inputName }) => inputName))
    for (const sourceName of [bootstrap.config.sources.microphone, bootstrap.config.sources.pcGame]) {
      if (availableInputs.has(sourceName)) await obs.call('CreateSceneItem', { sceneName: diagnosticScene, sourceName, sceneItemEnabled: true })
    }

    await obs.call('SetCurrentProgramScene', { sceneName: diagnosticScene })
    await wait(2_000)
    await obs.call('StartRecord')
    recordingStarted = true
    const startedDeadline = Date.now() + 15_000
    while (!(await obs.call('GetRecordStatus')).outputActive) {
      if (Date.now() > startedDeadline) throw new Error('OBS recording did not start within 15 seconds')
      await wait(250)
    }
    // Encoder initialization can legitimately reset or increment OBS's lifetime
    // counters. Measure sustained output only after it has reached steady state;
    // the file-level frame-gap/duplicate analysis below still covers the warmup.
    await wait(warmupMs)
    const baseline = await obs.call('GetStats')
    await wait(durationMs)
    const activeStatus = await obs.call('GetRecordStatus')
    const finalStats = await obs.call('GetStats')
    const stopped = await obs.call('StopRecord')
    outputPath = stopped.outputPath
    const stoppedDeadline = Date.now() + 15_000
    while ((await obs.call('GetRecordStatus')).outputActive) {
      if (Date.now() > stoppedDeadline) throw new Error('OBS recording did not stop within 15 seconds')
      await wait(250)
    }
    recordingStarted = false
    const analysis = analyzeRecording(outputPath)
    const obsMetrics = {
      activeFps: numeric(finalStats.activeFps),
      renderTotalFrames: counterDelta(finalStats.renderTotalFrames, baseline.renderTotalFrames),
      renderSkippedFrames: counterDelta(finalStats.renderSkippedFrames, baseline.renderSkippedFrames),
      outputTotalFrames: counterDelta(finalStats.outputTotalFrames, baseline.outputTotalFrames),
      outputSkippedFrames: counterDelta(finalStats.outputSkippedFrames, baseline.outputSkippedFrames),
    }
    const failures = [
      analysis.width === 1920 && analysis.height === 1080 ? null : `unexpected resolution ${analysis.width}x${analysis.height}`,
      analysis.measuredFps >= 59 && analysis.measuredFps <= 61 ? null : `measured FPS ${analysis.measuredFps.toFixed(2)}`,
      analysis.frameIntervalMs.over40ms === 0 ? null : `${analysis.frameIntervalMs.over40ms} frame gaps exceeded 40ms`,
      analysis.duplicateRatio <= 0.001 ? null : `${(analysis.duplicateRatio * 100).toFixed(3)}% consecutive duplicate frames`,
      obsMetrics.activeFps >= 59 ? null : `OBS active FPS ${obsMetrics.activeFps.toFixed(2)}`,
      obsMetrics.renderSkippedFrames === 0 ? null : `${obsMetrics.renderSkippedFrames} render frames skipped`,
      obsMetrics.outputSkippedFrames === 0 ? null : `${obsMetrics.outputSkippedFrames} output frames skipped`,
      analysis.audioTracks >= 5 ? null : `only ${analysis.audioTracks} separated audio tracks`,
    ].filter((failure): failure is string => failure !== null)
    console.log(JSON.stringify({
      ok: failures.length === 0,
      failures,
      requestedDurationMs: durationMs,
      warmupMs,
      outputDurationMs: activeStatus.outputDuration,
      outputBytes: activeStatus.outputBytes,
      obs: obsMetrics,
      recording: analysis,
    }, null, 2))
    if (failures.length) throw new Error(`Live OBS output verification failed: ${failures.join('; ')}`)
  } finally {
    if (recordingStarted) await obs.call('StopRecord').catch(() => undefined)
    if (previousScene) await obs.call('SetCurrentProgramScene', { sceneName: previousScene }).catch(() => undefined)
    await obs.call('RemoveInput', { inputName: diagnosticInput }).catch(() => undefined)
    await obs.call('RemoveScene', { sceneName: diagnosticScene }).catch(() => undefined)
    await obs.disconnect().catch(() => undefined)
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
