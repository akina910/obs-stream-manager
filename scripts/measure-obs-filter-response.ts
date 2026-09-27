import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import OBSWebSocket, { EventSubscription } from 'obs-websocket-js'
import { SecretStore } from '../server/secrets.js'

const diagnosticScene = '__OSM_AUDIO_DIAGNOSTIC__'
const diagnosticInput = '__OSM_AUDIO_STEPS__'
const testFile = path.join(os.tmpdir(), `obs-stream-manager-audio-steps-${process.pid}.wav`)
const stepSeconds = 3
const inputLevelsDb = [-70, -60, -50, -40, -30, -20]
const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

const multiplierToDb = (value: number) => value > 0 ? 20 * Math.log10(value) : -100
const percentile = (values: number[], ratio: number) => {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))] ?? -100
}

type MeterSample = { elapsedMs: number; magnitudeDb: number; peakDb: number }
type ResponseStep = { inputDb: number; samples: number; magnitudeP75Db: number; peakP95Db: number }
type ResponsePass = { label: string; steps: ResponseStep[] }

function sampleFromEvent(entry: unknown, elapsedMs: number): MeterSample | null {
  if (!entry || typeof entry !== 'object') return null
  const candidate = entry as Record<string, unknown>
  if (candidate.inputName !== diagnosticInput) return null
  const rawChannels = Array.isArray(candidate.inputLevelsDb) && candidate.inputLevelsDb.length
    ? candidate.inputLevelsDb
    : candidate.inputLevelsMul
  if (!Array.isArray(rawChannels)) return null
  const isDb = rawChannels === candidate.inputLevelsDb
  const channels = rawChannels.filter((channel): channel is number[] => Array.isArray(channel))
  const toDb = (value: number) => isDb ? value : multiplierToDb(value)
  const magnitudes = channels.map((channel) => toDb(channel[0])).filter(Number.isFinite)
  const peaks = channels.flatMap((channel) => [toDb(channel[1]), toDb(channel[2])]).filter(Number.isFinite)
  if (!magnitudes.length) return null
  return { elapsedMs, magnitudeDb: Math.max(...magnitudes), peakDb: Math.max(...(peaks.length ? peaks : magnitudes)) }
}

async function measurePass(obs: OBSWebSocket, label: string): Promise<ResponsePass> {
  const samples: MeterSample[] = []
  let startedAt = 0
  const listener = ({ inputs }: { inputs: unknown[] }) => {
    const elapsedMs = Date.now() - startedAt
    for (const input of inputs) {
      const sample = sampleFromEvent(input, elapsedMs)
      if (sample) samples.push(sample)
    }
  }
  obs.on('InputVolumeMeters', listener)
  try {
    startedAt = Date.now()
    await obs.call('TriggerMediaInputAction', { inputName: diagnosticInput, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART' })
    await wait(inputLevelsDb.length * stepSeconds * 1_000 + 800)
  } finally {
    obs.off('InputVolumeMeters', listener)
  }
  return {
    label,
    steps: inputLevelsDb.map((inputDb, index) => {
      const startMs = index * stepSeconds * 1_000 + 750
      const endMs = (index + 1) * stepSeconds * 1_000 - 250
      const window = samples.filter(({ elapsedMs }) => elapsedMs >= startMs && elapsedMs <= endMs)
      return {
        inputDb,
        samples: window.length,
        magnitudeP75Db: Math.round(percentile(window.map(({ magnitudeDb }) => magnitudeDb), 0.75) * 10) / 10,
        peakP95Db: Math.round(percentile(window.map(({ peakDb }) => peakDb), 0.95) * 10) / 10,
      }
    }),
  }
}

async function main() {
  const steppedAmplitude = inputLevelsDb.reduceRight((next, inputDb, index) => {
    const amplitude = 10 ** (inputDb / 20)
    return index === inputLevelsDb.length - 1 ? String(amplitude) : `if(lt(t,${(index + 1) * stepSeconds}),${amplitude},${next})`
  }, '')
  execFileSync('ffmpeg', [
    '-v', 'error', '-y', '-f', 'lavfi',
    '-i', `aevalsrc='${steppedAmplitude}*sin(2*PI*1000*t)':s=48000:d=${inputLevelsDb.length * stepSeconds}`,
    '-c:a', 'pcm_s16le', testFile,
  ])

  const bootstrap = await fetch('http://127.0.0.1:4317/api/bootstrap').then((response) => response.json()) as { config: { obs: { url: string } } }
  const obs = new OBSWebSocket()
  const password = new SecretStore().get('obs-password') ?? undefined
  let previousScene = ''
  try {
    await obs.connect(bootstrap.config.obs.url, password, { eventSubscriptions: EventSubscription.InputVolumeMeters })
    const [stream, record, replay, scenes, inputs] = await Promise.all([
      obs.call('GetStreamStatus'),
      obs.call('GetRecordStatus'),
      obs.call('GetReplayBufferStatus').catch(() => ({ outputActive: false })),
      obs.call('GetSceneList'),
      obs.call('GetInputList'),
    ])
    if (stream.outputActive || record.outputActive || replay.outputActive) throw new Error('Stop all OBS outputs before the audio diagnostic')
    previousScene = scenes.currentProgramSceneName
    if (inputs.inputs.some(({ inputName }) => inputName === diagnosticInput)) await obs.call('RemoveInput', { inputName: diagnosticInput })
    if (scenes.scenes.some(({ sceneName }) => sceneName === diagnosticScene)) await obs.call('RemoveScene', { sceneName: diagnosticScene })
    await obs.call('CreateScene', { sceneName: diagnosticScene })
    await obs.call('CreateInput', {
      sceneName: diagnosticScene,
      inputName: diagnosticInput,
      inputKind: 'ffmpeg_source',
      inputSettings: { local_file: testFile, looping: false, restart_on_activate: true },
      sceneItemEnabled: true,
    })
    await obs.call('SetCurrentProgramScene', { sceneName: diagnosticScene })
    await wait(500)
    const baseline = await measurePass(obs, 'no filter')
    await obs.call('CreateSourceFilter', {
      sourceName: diagnosticInput,
      filterName: 'Calibration Gain Test',
      filterKind: 'gain_filter',
      filterSettings: { db: 12 },
    })
    const gainOnly = await measurePass(obs, 'calibration gain +12 dB')
    await obs.call('RemoveSourceFilter', { sourceName: diagnosticInput, filterName: 'Calibration Gain Test' })
    await obs.call('CreateSourceFilter', {
      sourceName: diagnosticInput,
      filterName: 'Upward Compressor Test',
      filterKind: 'upward_compressor_filter',
      filterSettings: { attack_time: 10, detector: 'RMS', knee_width: 10, output_gain: 0, ratio: 0.25, release_time: 100, threshold: -20 },
    })
    const upwardQuarter = await measurePass(obs, 'upward compressor threshold=-20 ratio=0.25')
    await obs.call('CreateSourceFilter', {
      sourceName: diagnosticInput,
      filterName: 'Compressor Test',
      filterKind: 'compressor_filter',
      filterSettings: { attack_time: 6, output_gain: 6, ratio: 3, release_time: 60, sidechain_source: 'none', threshold: -18 },
    })
    await obs.call('CreateSourceFilter', {
      sourceName: diagnosticInput,
      filterName: 'Expander Test',
      filterKind: 'expander_filter',
      filterSettings: { attack_time: 10, detector: 'RMS', output_gain: 0, presets: 'expander', ratio: 2, release_time: 120, threshold: -45 },
    })
    await obs.call('CreateSourceFilter', {
      sourceName: diagnosticInput,
      filterName: 'Limiter Test',
      filterKind: 'limiter_filter',
      filterSettings: { release_time: 60, threshold: -2 },
    })
    const managedDynamics = await measurePass(obs, 'upward + compressor + expander + limiter')
    const step = (pass: ResponsePass, inputDb: number) => pass.steps.find((candidate) => candidate.inputDb === inputDb)
    const baselineMinus70 = step(baseline, -70)
    const baselineMinus60 = step(baseline, -60)
    const baselineMinus50 = step(baseline, -50)
    const gainMinus50 = step(gainOnly, -50)
    const managedMinus70 = step(managedDynamics, -70)
    const managedMinus60 = step(managedDynamics, -60)
    const managedMinus50 = step(managedDynamics, -50)
    const managedMinus20 = step(managedDynamics, -20)
    const evaluatedSteps = [
      ['baseline -70 dB', baselineMinus70],
      ['baseline -60 dB', baselineMinus60],
      ['baseline -50 dB', baselineMinus50],
      ['gain -50 dB', gainMinus50],
      ['managed -70 dB', managedMinus70],
      ['managed -60 dB', managedMinus60],
      ['managed -50 dB', managedMinus50],
      ['managed -20 dB', managedMinus20],
    ] as const
    const valid = (responseStep: ResponseStep | undefined) => responseStep !== undefined && responseStep.samples >= 8
    const failures = [
      ...evaluatedSteps.flatMap(([label, responseStep]) => valid(responseStep) ? [] : [`${label} had fewer than 8 meter samples`]),
      valid(baselineMinus70) && valid(managedMinus70) && managedMinus70!.magnitudeP75Db <= baselineMinus70!.magnitudeP75Db - 6
        ? null : 'the managed chain did not suppress the -70 dB noise floor by at least 6 dB',
      valid(baselineMinus60) && valid(managedMinus60) && managedMinus60!.magnitudeP75Db <= baselineMinus60!.magnitudeP75Db - 3
        ? null : 'the managed chain did not suppress the -60 dB noise floor by at least 3 dB',
      valid(baselineMinus50) && valid(managedMinus50) && managedMinus50!.magnitudeP75Db >= baselineMinus50!.magnitudeP75Db + 8
        ? null : 'the managed chain did not raise the -50 dB quiet-speech step by at least 8 dB',
      valid(baselineMinus50) && valid(gainMinus50) && gainMinus50!.magnitudeP75Db >= baselineMinus50!.magnitudeP75Db + 10
        ? null : 'the managed calibration gain did not raise the -50 dB step by at least 10 dB',
      valid(managedMinus20) && managedMinus20!.peakP95Db <= -6
        ? null : 'the managed chain exceeded the -6 dB peak safety ceiling',
    ].filter((failure): failure is string => failure !== null)
    console.log(JSON.stringify({ ok: failures.length === 0, failures, baseline, gainOnly, upwardQuarter, managedDynamics }, null, 2))
    if (failures.length) throw new Error(`OBS audio filter response verification failed: ${failures.join('; ')}`)
  } finally {
    if (previousScene) await obs.call('SetCurrentProgramScene', { sceneName: previousScene }).catch(() => undefined)
    await obs.call('RemoveInput', { inputName: diagnosticInput }).catch(() => undefined)
    await obs.call('RemoveScene', { sceneName: diagnosticScene }).catch(() => undefined)
    await obs.disconnect().catch(() => undefined)
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        rmSync(testFile, { force: true })
        break
      } catch {
        await wait(250)
      }
    }
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
