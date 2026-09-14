import { spawn, type ChildProcess } from 'node:child_process'
import OBSWebSocket, { type EventSubscription } from 'obs-websocket-js'
import { OBS_OUTPUT_PLUGIN_VENDOR } from '../shared/obs-output-plugin.js'
import { getDataDirectory } from '../server/paths.js'
import { SecretStore } from '../server/secrets.js'
import { DataStore } from '../server/storage.js'

const ffmpeg = process.env.OBS_STREAM_MANAGER_FFMPEG?.trim() || 'J:\\ffmpeg\\bin\\ffmpeg.exe'
const primaryPort = 19_350
const secondaryPort = 19_351
const primaryServer = `rtmp://127.0.0.1:${primaryPort}/live`
const secondaryServer = `rtmp://127.0.0.1:${secondaryPort}/live`
const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function waitFor(
  check: () => Promise<boolean>,
  description: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await wait(200)
  }
  throw new Error(`Timed out waiting for ${description}`)
}

function startRtmpReceiver(port: number, streamName: string): ChildProcess {
  const receiver = spawn(ffmpeg, [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-listen',
    '1',
    '-i',
    `rtmp://127.0.0.1:${port}/live/${streamName}`,
    '-map',
    '0',
    '-c',
    'copy',
    '-f',
    'null',
    'NUL',
  ], {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let errorOutput = ''
  receiver.stderr?.on('data', (chunk) => {
    if (errorOutput.length < 8_000) errorOutput += String(chunk)
  })
  receiver.once('error', (error) => {
    errorOutput += `\n${error.message}`
  })
  Object.assign(receiver, { errorOutput: () => errorOutput })
  return receiver
}

async function stopReceiver(receiver: ChildProcess | null): Promise<void> {
  if (!receiver || receiver.exitCode !== null) return
  receiver.kill()
  await Promise.race([
    new Promise<void>((resolve) => receiver.once('exit', () => resolve())),
    wait(3_000),
  ])
  if (receiver.exitCode === null) receiver.kill('SIGKILL')
}

async function main(): Promise<void> {
  const store = new DataStore(getDataDirectory())
  await store.initialize()
  const config = await store.getConfig()
  const secrets = new SecretStore()
  const obs = new OBSWebSocket()
  const streamStates: string[] = []
  let primaryReceiver: ChildProcess | null = null
  let secondaryReceiver: ChildProcess | null = null
  let previousService: Awaited<ReturnType<typeof obs.call<'GetStreamServiceSettings'>>> | null = null
  let streamStarted = false
  let secondaryStarted = false

  obs.on('StreamStateChanged', ({ outputState }) => {
    streamStates.push(outputState)
  })

  try {
    await obs.connect(
      config.obs.url,
      secrets.get('obs-password') ?? undefined,
      { eventSubscriptions: (1 << 6) as EventSubscription },
    )
    const initial = await obs.call('GetStreamStatus')
    if (initial.outputActive || initial.outputReconnecting) {
      throw new Error('OBS output is active; refusing to run the local reconnect verifier')
    }
    previousService = await obs.call('GetStreamServiceSettings')
    primaryReceiver = startRtmpReceiver(primaryPort, 'primary')
    secondaryReceiver = startRtmpReceiver(secondaryPort, 'secondary')
    await wait(750)

    await obs.call('SetStreamServiceSettings', {
      streamServiceType: 'rtmp_custom',
      streamServiceSettings: {
        server: primaryServer,
        key: 'primary',
        use_auth: false,
      },
    })
    await obs.call('StartStream')
    streamStarted = true
    await waitFor(async () => {
      const status = await obs.call('GetStreamStatus')
      return status.outputActive && (status.outputTotalFrames ?? 0) > 30
    }, 'the primary local RTMP output to advance')

    const secondaryStart = await obs.call('CallVendorRequest', {
      vendorName: OBS_OUTPUT_PLUGIN_VENDOR,
      requestType: 'start_twitch',
      requestData: { server: secondaryServer, key: 'secondary' },
    })
    if (secondaryStart.responseData.success !== true) {
      throw new Error(`Local secondary output failed: ${String(secondaryStart.responseData.error ?? 'unknown error')}`)
    }
    secondaryStarted = true
    await waitFor(async () => {
      const response = await obs.call('CallVendorRequest', {
        vendorName: OBS_OUTPUT_PLUGIN_VENDOR,
        requestType: 'twitch_status',
        requestData: {},
      })
      return response.responseData.outputActive === true
        && Number(response.responseData.totalFrames ?? 0) > 30
    }, 'the secondary local RTMP output to advance')

    const framesBeforeReconnect = await obs.call('CallVendorRequest', {
      vendorName: OBS_OUTPUT_PLUGIN_VENDOR,
      requestType: 'twitch_status',
      requestData: {},
    }).then(({ responseData }) => Number(responseData.totalFrames ?? 0))

    await stopReceiver(primaryReceiver)
    primaryReceiver = null
    await waitFor(async () => {
      const status = await obs.call('GetStreamStatus')
      return status.outputReconnecting === true
        || streamStates.includes('OBS_WEBSOCKET_OUTPUT_RECONNECTING')
    }, 'OBS to enter reconnecting state')

    const secondaryDuringReconnect = await obs.call('CallVendorRequest', {
      vendorName: OBS_OUTPUT_PLUGIN_VENDOR,
      requestType: 'twitch_status',
      requestData: {},
    }).then(({ responseData }) => responseData)
    if (secondaryDuringReconnect.outputActive !== true) {
      throw new Error('The secondary output stopped while the primary output was reconnecting')
    }

    primaryReceiver = startRtmpReceiver(primaryPort, 'primary')
    await waitFor(async () => {
      const status = await obs.call('GetStreamStatus')
      return status.outputActive === true && status.outputReconnecting !== true
    }, 'the primary local RTMP output to reconnect', 20_000)
    await wait(1_000)

    const secondaryAfterReconnect = await obs.call('CallVendorRequest', {
      vendorName: OBS_OUTPUT_PLUGIN_VENDOR,
      requestType: 'twitch_status',
      requestData: {},
    }).then(({ responseData }) => responseData)
    const framesAfterReconnect = Number(secondaryAfterReconnect.totalFrames ?? 0)
    if (secondaryAfterReconnect.outputActive !== true || framesAfterReconnect <= framesBeforeReconnect) {
      throw new Error('The secondary output did not continue advancing across the primary reconnect')
    }
    if (streamStates.includes('OBS_WEBSOCKET_OUTPUT_STOPPED')) {
      throw new Error('OBS emitted a final STOPPED state during a successful reconnect')
    }

    console.log(JSON.stringify({
      ok: true,
      streamStates,
      secondaryActiveDuringReconnect: true,
      secondaryFramesBeforeReconnect: framesBeforeReconnect,
      secondaryFramesAfterReconnect: framesAfterReconnect,
    }, null, 2))
  } finally {
    if (secondaryStarted) {
      await obs.call('CallVendorRequest', {
        vendorName: OBS_OUTPUT_PLUGIN_VENDOR,
        requestType: 'stop_twitch',
        requestData: {},
      }).catch(() => undefined)
    }
    if (streamStarted) {
      await obs.call('StopStream').catch(() => undefined)
      await waitFor(async () => {
        const status = await obs.call('GetStreamStatus')
        return !status.outputActive && !status.outputReconnecting
      }, 'the local primary output to stop').catch(() => undefined)
    }
    if (previousService) {
      await obs.call('SetStreamServiceSettings', previousService).catch(() => undefined)
    }
    await stopReceiver(primaryReceiver)
    await stopReceiver(secondaryReceiver)
    await obs.disconnect().catch(() => undefined)
  }
}

await main()
