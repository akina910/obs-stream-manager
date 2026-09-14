import { execFileSync, spawnSync } from 'node:child_process'
import OBSWebSocket from 'obs-websocket-js'
import { STOCK_BGM_INPUT_NAME } from '../shared/bgm.js'
import { OBS_OUTPUT_PLUGIN_VENDOR } from '../shared/obs-output-plugin.js'
import { SecretStore } from '../server/secrets.js'
import { validateRecordingOnlyOutput, validateRecordingOutput } from './recording-output-validation.js'

const diagnosticScene = '__OSM_FPS_DIAGNOSTIC__'
const diagnosticInput = '__OSM_FPS_MOTION__'
const offlineFileArgumentIndex = process.argv.indexOf('--file')
const offlineFile = offlineFileArgumentIndex >= 0 ? process.argv[offlineFileArgumentIndex + 1]?.trim() : ''
const recordingOnlyFile = process.argv.includes('--recording-only')
const expectedDurationArgumentIndex = process.argv.indexOf('--expected-duration-ms')
const offlineExpectedDurationMs = expectedDurationArgumentIndex >= 0
  ? Number(process.argv[expectedDurationArgumentIndex + 1])
  : null
const requestedDuration = Number(offlineFileArgumentIndex >= 0 ? 20_000 : process.argv[2] ?? 20_000)
const durationMs = Number.isFinite(requestedDuration)
  ? Math.max(5_000, Math.min(60_000, requestedDuration))
  : 20_000
const warmupMs = 2_000
const managerOrigin = 'http://127.0.0.1:4317'
const fixtureUrl = `${managerOrigin}/api/diagnostics/fps-motion`

type Bootstrap = {
  config: {
    obs: { url: string }
    sources: { microphone: string; pcGame: string; geforceNow: string; switchGame: string; discord: string; bgm: string }
  }
  status: { selectedGameId: string | null; captureMethod: string | null }
  profiles: Array<{
    id: string
    platformGroup: string
    capture: {
      localSourceName: string
      geforceNowSourceName: string
      windowSourceName?: string
      displaySourceName: string
    }
    recording: { directory: string }
  }>
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

function commandOutput(commandName: string, args: string[]): string {
  const result = spawnSync(commandName, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${commandName} failed: ${result.stderr || result.stdout}`)
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`
}

function audioLevel(filename: string, streamIndex: number) {
  const output = commandOutput('ffmpeg', [
    '-hide_banner', '-nostats', '-i', filename, '-map', `0:${streamIndex}`, '-vn',
    '-af', 'volumedetect', '-f', 'null', '-',
  ])
  const mean = /mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i.exec(output)
  const maximum = /max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i.exec(output)
  return {
    meanDb: mean ? Number(mean[1]) : null,
    maxDb: maximum ? Number(maximum[1]) : null,
  }
}

function createContactSheet(filename: string, durationSeconds: number): string {
  const output = `${filename}.contact-sheet.jpg`
  const interval = Math.max(0.1, durationSeconds / 9)
  commandOutput('ffmpeg', [
    '-v', 'error', '-y', '-i', filename, '-an',
    '-vf', `fps=1/${interval},scale=640:-2,tile=3x3:padding=2:margin=2`,
    '-frames:v', '1', output,
  ])
  return output
}

function analyzeRecording(filename: string) {
  const probe = JSON.parse(command('ffprobe', [
    '-v', 'error', '-count_frames', '-show_entries',
    'stream=index,codec_name,codec_type,width,height,r_frame_rate,avg_frame_rate,nb_read_frames,channels,channel_layout,bit_rate:stream_tags=title:format=format_name,duration,size,bit_rate',
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
  const audioTracks = probe.streams
    .filter(({ codec_type }) => codec_type === 'audio')
    .map((stream) => ({
      index: Number(stream.index),
      title: typeof (stream.tags as { title?: unknown } | undefined)?.title === 'string'
        ? String((stream.tags as { title: string }).title)
        : '',
      codec: String(stream.codec_name ?? ''),
      channels: Number(stream.channels ?? 0),
      ...audioLevel(filename, Number(stream.index)),
    }))
  return {
    filename,
    videoCodec: String(video?.codec_name ?? ''),
    container: String(probe.format.format_name ?? ''),
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
    videoBitRate: Number.isFinite(Number(video?.bit_rate)) && Number(video?.bit_rate) > 0
      ? Number(video?.bit_rate)
      : null,
    audioTracks,
    sizeBytes,
    bitRate: Number.isFinite(probedBitRate) && probedBitRate > 0
      ? probedBitRate
      : durationSeconds > 0 ? Math.round(sizeBytes * 8 / durationSeconds) : 0,
  }
}

async function main() {
  if (offlineFileArgumentIndex >= 0) {
    if (!offlineFile) throw new Error('Pass an MKV diagnostic recording after --file')
    if (expectedDurationArgumentIndex >= 0 && (!Number.isFinite(offlineExpectedDurationMs) || Number(offlineExpectedDurationMs) <= 0)) {
      throw new Error('Pass a positive number of milliseconds after --expected-duration-ms')
    }
    const analysis = analyzeRecording(offlineFile)
    let contactSheetPath: string | null = null
    let contactSheetError: string | null = null
    try {
      contactSheetPath = createContactSheet(offlineFile, analysis.durationSeconds)
    } catch (error) {
      contactSheetError = error instanceof Error ? error.message : String(error)
    }
    const failures = [
      ...(recordingOnlyFile
        ? validateRecordingOnlyOutput(analysis, offlineExpectedDurationMs)
        : validateRecordingOutput(analysis, offlineExpectedDurationMs)),
      contactSheetError ? `contact sheet could not be created: ${contactSheetError}` : null,
    ].filter((failure): failure is string => failure !== null)
    console.log(JSON.stringify({
      ok: failures.length === 0,
      mode: recordingOnlyFile ? 'recording-only-offline' : 'offline',
      failures,
      expectedDurationMs: offlineExpectedDurationMs,
      recording: analysis,
      contactSheetPath,
      contactSheetError,
      visualReviewRequired: true,
    }, null, 2))
    if (failures.length) throw new Error(`Recorded output verification failed: ${failures.join('; ')}`)
    return
  }

  const bootstrap = await fetch(`${managerOrigin}/api/bootstrap`).then((response) => {
    if (!response.ok) throw new Error(`OBS Stream Manager bootstrap failed: ${response.status}`)
    return response.json() as Promise<Bootstrap>
  })
  const selected = bootstrap.profiles.find(({ id }) => id === bootstrap.status.selectedGameId)
  if (!selected) throw new Error('The selected game profile could not be resolved')
  const selectedCaptureSource = (bootstrap.status.captureMethod === 'geforce_now'
    ? selected.capture.geforceNowSourceName
    : bootstrap.status.captureMethod === 'window'
      ? selected.capture.windowSourceName ?? selected.capture.localSourceName
      : bootstrap.status.captureMethod === 'display'
        ? selected.capture.displaySourceName
        : selected.capture.localSourceName).trim()
  const microphoneSource = bootstrap.config.sources.microphone.trim()
  if (!selectedCaptureSource || !microphoneSource) throw new Error('The selected capture or microphone input name is empty')

  const obs = new OBSWebSocket()
  const password = new SecretStore().get('obs-password') ?? undefined
  let previousScene = ''
  let recordingStarted = false
  let outputPath = ''
  try {
    await obs.connect(bootstrap.config.obs.url, password)
    const [stream, record, replay, virtualCamera, sceneList, inputList] = await Promise.all([
      obs.call('GetStreamStatus'),
      obs.call('GetRecordStatus'),
      obs.call('GetReplayBufferStatus').catch(() => ({ outputActive: false })),
      obs.call('GetVirtualCamStatus').catch(() => ({ outputActive: false })),
      obs.call('GetSceneList'),
      obs.call('GetInputList'),
    ])
    let twitchSecondaryActive = false
    try {
      const secondary = await obs.call('CallVendorRequest', {
        vendorName: OBS_OUTPUT_PLUGIN_VENDOR,
        requestType: 'twitch_status',
        requestData: {},
      })
      twitchSecondaryActive = (secondary.responseData as Record<string, unknown>).outputActive === true
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (!/no vendor was found|vendor.+not found/i.test(detail)) {
        throw new Error(`The Twitch secondary output state could not be verified: ${detail}`)
      }
    }
    if (stream.outputActive || record.outputActive || replay.outputActive || virtualCamera.outputActive || twitchSecondaryActive) {
      throw new Error('Stop streaming, recording, replay buffer, virtual camera, and Twitch secondary output before the diagnostic')
    }
    const [recordFormat, autoRemux] = await Promise.all([
      obs.call('GetProfileParameter', { parameterCategory: 'AdvOut', parameterName: 'RecFormat2' }),
      obs.call('GetProfileParameter', { parameterCategory: 'General', parameterName: 'AutoRemux' }),
    ])
    if (recordFormat.parameterValue.trim().toLowerCase() !== 'mkv') {
      throw new Error(`Set OBS recording format to MKV before the diagnostic (current: ${recordFormat.parameterValue || 'unknown'})`)
    }
    if (autoRemux.parameterValue.trim().toLowerCase() === 'true') {
      throw new Error('Disable OBS automatic remux before the diagnostic so the original multi-track MKV can be verified')
    }
    const availableInputs = new Set(inputList.inputs.map(({ inputName }) => inputName))
    const inputKinds = new Map(inputList.inputs.map(({ inputName, inputKind }) => [inputName, inputKind]))
    const selectedCaptureInput = await obs.call('GetInputSettings', { inputName: selectedCaptureSource }).catch(() => null)
    const selectedCaptureKind = selectedCaptureInput?.inputKind ?? inputKinds.get(selectedCaptureSource) ?? ''
    const selectedCaptureSettings = (selectedCaptureInput?.inputSettings ?? {}) as Record<string, unknown>
    const selectedCaptureProvidesAudio = selectedCaptureKind === 'game_capture' || selectedCaptureKind === 'window_capture'
      ? selectedCaptureSettings.capture_audio === true
      : ['dshow_input', 'decklink-input', 'wasapi_process_output_capture'].includes(selectedCaptureKind)
    const legacyGameAudioSource = (selectedCaptureSource === selected.capture.geforceNowSourceName
      ? bootstrap.config.sources.geforceNow
      : selected.platformGroup === 'switch' || selectedCaptureSource === 'Elgato Game Capture'
        ? bootstrap.config.sources.switchGame
        : bootstrap.config.sources.pcGame).trim()
    const effectiveGameAudioSource = selectedCaptureProvidesAudio ? selectedCaptureSource : legacyGameAudioSource
    if (!effectiveGameAudioSource) {
      throw new Error(`No game-audio source can be resolved for capture input ${selectedCaptureSource}`)
    }
    previousScene = sceneList.currentProgramSceneName
    if (previousScene === diagnosticScene) {
      const fallbackScene = sceneList.scenes.map(({ sceneName }) => sceneName).find((sceneName) => sceneName !== diagnosticScene)
      if (!fallbackScene) throw new Error(`OBS has no scene available to recover from the leftover diagnostic scene: ${diagnosticScene}`)
      await obs.call('SetCurrentProgramScene', { sceneName: fallbackScene })
      previousScene = fallbackScene
    }
    if (inputList.inputs.some(({ inputName }) => inputName === diagnosticInput)) await obs.call('RemoveInput', { inputName: diagnosticInput })
    if (sceneList.scenes.some(({ sceneName }) => sceneName === diagnosticScene)) await obs.call('RemoveScene', { sceneName: diagnosticScene })

    await obs.call('CreateScene', { sceneName: diagnosticScene })
    const routeExpectations = new Map<string, number[]>()
    for (const inputName of new Set([
      bootstrap.config.sources.pcGame.trim(),
      bootstrap.config.sources.geforceNow.trim(),
      bootstrap.config.sources.switchGame.trim(),
    ])) {
      if (inputName) routeExpectations.set(inputName, [])
    }
    routeExpectations.set(effectiveGameAudioSource, [1, 6])
    routeExpectations.set(microphoneSource, [3, 6])
    const discordSource = bootstrap.config.sources.discord.trim()
    if (discordSource) {
      routeExpectations.set(discordSource, inputKinds.get(discordSource) === 'wasapi_process_output_capture' ? [2, 6] : [])
    }
    const bgmSource = bootstrap.config.sources.bgm.trim()
    if (bgmSource) {
      routeExpectations.set(bgmSource, inputKinds.get(bgmSource) === 'wasapi_output_capture' ? [] : [4, 6])
    }
    routeExpectations.set(STOCK_BGM_INPUT_NAME, [4, 6])
    const audioRoutes: Array<{ inputName: string; expected: number[]; actual: number[]; muted: boolean | null; volumeMul: number | null; error?: string }> = []
    const skippedAudioInputs: string[] = []
    for (const [inputName, expected] of routeExpectations) {
      if (!inputName || !availableInputs.has(inputName)) {
        if (inputName) skippedAudioInputs.push(inputName)
        continue
      }
      try {
        const [response, mute, volume] = await Promise.all([
          obs.call('GetInputAudioTracks', { inputName }),
          obs.call('GetInputMute', { inputName }),
          obs.call('GetInputVolume', { inputName }),
        ])
        const actual = Object.entries(response.inputAudioTracks)
          .filter(([, enabled]) => enabled)
          .map(([track]) => Number(track))
          .filter(Number.isFinite)
          .sort((left, right) => left - right)
        audioRoutes.push({ inputName, expected, actual, muted: mute.inputMuted, volumeMul: numeric(volume.inputVolumeMul) })
      } catch (error) {
        audioRoutes.push({ inputName, expected, actual: [], muted: null, volumeMul: null, error: error instanceof Error ? error.message : String(error) })
      }
    }
    const auxiliaryKinds = new Set([
      'game_capture',
      'window_capture',
      'display_capture',
      'dshow_input',
      'wasapi_output_capture',
      'wasapi_input_capture',
      'wasapi_process_output_capture',
    ])
    for (const { inputName, inputKind } of inputList.inputs) {
      if (routeExpectations.has(inputName)) continue
      const expected = auxiliaryKinds.has(inputKind) ? [5] : [5, 6]
      try {
        const [response, mute, volume] = await Promise.all([
          obs.call('GetInputAudioTracks', { inputName }),
          obs.call('GetInputMute', { inputName }),
          obs.call('GetInputVolume', { inputName }),
        ])
        const actual = Object.entries(response.inputAudioTracks)
          .filter(([, enabled]) => enabled)
          .map(([track]) => Number(track))
          .filter(Number.isFinite)
          .sort((left, right) => left - right)
        audioRoutes.push({ inputName, expected, actual, muted: mute.inputMuted, volumeMul: numeric(volume.inputVolumeMul) })
      } catch {
        // configureSeparatedAudioTracks uses the same capability probe. A
        // video-only source is not an A5 candidate and is reported as skipped.
        skippedAudioInputs.push(inputName)
      }
    }
    const requiredAudioSources = [effectiveGameAudioSource, microphoneSource]
    const missingAudioSources = requiredAudioSources.filter((sourceName) => !availableInputs.has(sourceName))
    for (const sourceName of requiredAudioSources) {
      if (availableInputs.has(sourceName)) await obs.call('CreateSceneItem', { sceneName: diagnosticScene, sourceName, sceneItemEnabled: true })
    }
    // Create the motion fixture after video-capable audio sources so it is the
    // top scene item and the decoded recording always proves this known motion.
    await obs.call('CreateInput', {
      sceneName: diagnosticScene,
      inputName: diagnosticInput,
      inputKind: 'browser_source',
      inputSettings: {
        is_local_file: false,
        url: fixtureUrl,
        width: 1920,
        height: 1080,
        fps: 60,
        shutdown: false,
        restart_when_active: true,
      },
      sceneItemEnabled: true,
    })

    await obs.call('SetCurrentProgramScene', { sceneName: diagnosticScene })
    await wait(2_000)
    await obs.call('StartRecord')
    recordingStarted = true
    const startedDeadline = Date.now() + 15_000
    while (!(await obs.call('GetRecordStatus')).outputActive) {
      if (Date.now() > startedDeadline) throw new Error('OBS recording did not start within 15 seconds')
      await wait(250)
    }
    const recordingStartedAt = Date.now()
    // Encoder initialization can legitimately reset or increment OBS's lifetime
    // counters. Measure sustained output only after it has reached steady state;
    // the file-level frame-gap/duplicate analysis below still covers the warmup.
    await wait(warmupMs)
    const baseline = await obs.call('GetStats')
    await wait(durationMs)
    const activeStatus = await obs.call('GetRecordStatus')
    const finalStats = await obs.call('GetStats')
    const recordingElapsedMs = Date.now() - recordingStartedAt
    const stopped = await obs.call('StopRecord')
    outputPath = stopped.outputPath
    const stoppedDeadline = Date.now() + 15_000
    while ((await obs.call('GetRecordStatus')).outputActive) {
      if (Date.now() > stoppedDeadline) throw new Error('OBS recording did not stop within 15 seconds')
      await wait(250)
    }
    recordingStarted = false
    const analysis = analyzeRecording(outputPath)
    let contactSheetPath: string | null = null
    let contactSheetError: string | null = null
    try {
      contactSheetPath = createContactSheet(outputPath, analysis.durationSeconds)
    } catch (error) {
      contactSheetError = error instanceof Error ? error.message : String(error)
    }
    const obsMetrics = {
      activeFps: numeric(finalStats.activeFps),
      renderTotalFrames: counterDelta(finalStats.renderTotalFrames, baseline.renderTotalFrames),
      renderSkippedFrames: counterDelta(finalStats.renderSkippedFrames, baseline.renderSkippedFrames),
      outputTotalFrames: counterDelta(finalStats.outputTotalFrames, baseline.outputTotalFrames),
      outputSkippedFrames: counterDelta(finalStats.outputSkippedFrames, baseline.outputSkippedFrames),
    }
    const routeFailures = audioRoutes.filter(({ expected, actual, error }) => error || expected.join(',') !== actual.join(','))
    const mutedRequiredSources = audioRoutes.filter(({ inputName, muted }) => requiredAudioSources.includes(inputName) && muted === true)
    const zeroVolumeRequiredSources = audioRoutes.filter(({ inputName, volumeMul }) => requiredAudioSources.includes(inputName) && volumeMul !== null && volumeMul <= 0.0001)
    const failures = [
      ...validateRecordingOutput(analysis, recordingElapsedMs),
      obsMetrics.activeFps >= 59 ? null : `OBS active FPS ${obsMetrics.activeFps.toFixed(2)}`,
      obsMetrics.renderSkippedFrames === 0 ? null : `${obsMetrics.renderSkippedFrames} render frames skipped`,
      obsMetrics.outputSkippedFrames === 0 ? null : `${obsMetrics.outputSkippedFrames} output frames skipped`,
      contactSheetError ? `contact sheet could not be created: ${contactSheetError}` : null,
      ...missingAudioSources.map((sourceName) => `required OBS audio input is missing: ${sourceName}`),
      ...mutedRequiredSources.map(({ inputName }) => `required OBS audio input is muted: ${inputName}`),
      ...zeroVolumeRequiredSources.map(({ inputName }) => `required OBS audio input volume is zero: ${inputName}`),
      ...routeFailures.map(({ inputName, expected, actual, error }) => error
        ? `${inputName} audio routing could not be read: ${error}`
        : `${inputName} is routed to A${actual.join('/A')} instead of A${expected.join('/A')}`),
    ].filter((failure): failure is string => failure !== null)
    console.log(JSON.stringify({
      ok: failures.length === 0,
      failures,
      requestedDurationMs: durationMs,
      warmupMs,
      recordingElapsedMs,
      outputDurationMs: activeStatus.outputDuration,
      outputBytes: activeStatus.outputBytes,
      obs: obsMetrics,
      audioRoutes,
      skippedAudioInputs,
      selectedCaptureSource,
      effectiveGameAudioSource,
      recording: analysis,
      contactSheetPath,
      contactSheetError,
      visualReviewRequired: true,
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
