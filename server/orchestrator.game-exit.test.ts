import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GameExitAction, GameExitPrompt } from '../shared/game-exit.js'
import { GameExitDialogController } from '../desktop/game-exit-dialog.js'
import type { CaptureMethod } from '../shared/contracts.js'
import type { CaptureDetector } from './capture.js'
import { defaultConfig, starterProfiles } from './defaults.js'
import type { AppLogger } from './logger.js'
import { ObsController } from './obs.js'
import { StreamOrchestrator } from './orchestrator.js'
import type { PlatformServices } from './platforms.js'
import type { SecretStore } from './secrets.js'
import type { DataStore } from './storage.js'

describe('game exit confirmation orchestration', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0) })
  afterEach(() => { vi.useRealTimers() })

  function harness() {
    const profiles = structuredClone(starterProfiles)
    for (const profile of profiles) profile.state.lastCaptureMethod = 'local'
    const selected = profiles.find(({ id }) => id === 'ark_survival_ascended')!
    let revision = 1
    let startGeneration = 1
    const state = {
      obsConnected: true, streaming: false, recording: true, recordingOnly: true,
      recordingGameId: 'minecraft', recordingGameName: 'Minecraft', replayBuffer: false,
      sourceRecord: false, verticalRecording: false, twitchOutputPlugin: { outputActive: false },
    }
    const stopRecordingOnly = vi.fn(async (_config?: unknown, _revision?: number, beforeStop?: () => void, onStopCommitted?: () => void) => {
      beforeStop?.()
      onStopCommitted?.()
      state.recording = false
      state.recordingOnly = false
      revision += 1
      return { warnings: [], outputPath: 'capture.mkv', remuxedPath: 'capture.mp4' }
    })
    const stopRecordingOutputs = vi.fn(async (_config?: unknown, _revision?: number, beforeStop?: () => void, onStopCommitted?: () => void) => {
      beforeStop?.()
      onStopCommitted?.()
      state.recording = false
      state.sourceRecord = false
      state.verticalRecording = false
      revision += 1
      return []
    })
    const obs = {
      status: vi.fn(async () => ({ ...state, twitchOutputPlugin: { ...state.twitchOutputPlugin } })),
      getOutputSessionRevision: vi.fn(() => revision),
      createOutputStopGuard: vi.fn().mockReturnValue(() => undefined),
      stopRecordingOnly,
      stopRecordingOutputs,
      stop: vi.fn(async () => {
        state.streaming = false
        state.recording = false
        state.sourceRecord = false
        state.verticalRecording = false
        state.twitchOutputPlugin.outputActive = false
        revision += 1
        return []
      }),
      isStreaming: vi.fn(async () => state.streaming),
    }
    const store = {
      getConfig: vi.fn(async () => structuredClone(defaultConfig)),
      getProfile: vi.fn(async (id: string) => profiles.find((profile) => profile.id === id) ?? null),
    }
    const probe = vi.fn<() => Promise<'running' | 'stopped' | 'unknown'>>().mockResolvedValue('stopped')
    const capture = { probeRunningGame: probe }
    const platforms = {
      getLiveStatus: vi.fn(), prepare: vi.fn(), completeYouTubeBroadcast: vi.fn().mockResolvedValue(undefined),
      stopComments: vi.fn().mockResolvedValue(undefined), invalidateLiveStatus: vi.fn(),
    }
    const logger = { write: vi.fn().mockResolvedValue(undefined) }
    const orchestrator = new StreamOrchestrator(store as unknown as DataStore, obs as unknown as ObsController,
      capture as unknown as CaptureDetector, platforms as unknown as PlatformServices,
      logger as unknown as AppLogger)
    Object.assign(orchestrator, { selected, method: 'local' })
    return { profiles, state, obs, store, probe, platforms, logger, orchestrator,
      nextSession: () => { revision += 1; startGeneration += 1 },
      ownStopTransition: () => { revision += 1 },
      createOwnershipGuard: () => {
        const generation = startGeneration
        return () => { if (generation !== startGeneration) throw new Error('new output session') }
      },
    }
  }

  async function promptFor(orchestrator: StreamOrchestrator): Promise<GameExitPrompt> {
    expect(await orchestrator.pollGameExitPrompt()).toBeNull()
    vi.setSystemTime(Date.now() + 15_000)
    const prompt = await orchestrator.pollGameExitPrompt()
    expect(prompt).not.toBeNull()
    return prompt!
  }

  async function observeOwnedRunning(context: ReturnType<typeof harness>): Promise<void> {
    Object.assign(context.orchestrator, { managedGameExitSession: {
      gameId: context.state.recordingOnly ? 'minecraft' : 'ark_survival_ascended', method: 'local',
      guard: context.createOwnershipGuard(),
    } })
    context.probe.mockResolvedValueOnce('running')
    expect(await context.orchestrator.pollGameExitPrompt()).toBeNull()
  }

  it('observes the actual recording game and allows an explicit stop during the grace countdown', async () => {
    const { orchestrator, probe, obs, platforms } = harness()
    const prompt = await promptFor(orchestrator)

    expect(prompt).toMatchObject({ gameId: 'minecraft', gameName: 'Minecraft', kind: 'recording' })
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ id: 'minecraft' }), 'local')
    expect(obs.stopRecordingOnly).not.toHaveBeenCalled()
    expect(obs.stop).not.toHaveBeenCalled()
    await expect(orchestrator.respondToGameExitPrompt(prompt.id, 'stop')).resolves.toEqual({ stopped: true, warnings: [] })
    expect(obs.stopRecordingOnly).toHaveBeenCalledOnce()
    for (const method of Object.values(platforms)) expect(method).not.toHaveBeenCalled()
  })

  it.each(['unanswered', 'dismissed'] as const)('automatically stops an %s owned recording after 15 + 60 seconds, without platform calls', async (answer) => {
    const context = harness()
    const { orchestrator, obs, platforms, logger } = context
    await observeOwnedRunning(context)
    const prompt = await promptFor(orchestrator)
    expect(prompt.autoStopAt).toBe(75_000)
    if (answer === 'dismissed') await orchestrator.respondToGameExitPrompt(prompt.id, 'dismiss')
    vi.setSystemTime(74_999)
    expect(await orchestrator.pollGameExitPrompt()).toMatchObject({ id: prompt.id })
    expect(obs.stopRecordingOnly).not.toHaveBeenCalled()
    vi.setSystemTime(75_000)
    expect(await orchestrator.pollGameExitPrompt()).toBeNull()
    expect(obs.stopRecordingOnly).toHaveBeenCalledOnce()
    for (const method of Object.values(platforms)) expect(method).not.toHaveBeenCalled()
    expect(logger.write).toHaveBeenCalledWith('game_exit.deadline_scheduled', expect.objectContaining({ autoStopAt: 75_000 }))
    expect(logger.write).toHaveBeenCalledWith('game_exit.responded', expect.objectContaining({ reason: 'countdown-expired', stopped: true }))
    if (answer === 'dismissed') expect(logger.write).toHaveBeenCalledWith('game_exit.dismissed', expect.objectContaining({ reason: 'dialog-dismissed-countdown-unchanged' }))
  })

  it('explicit Continue cancels an owned recording countdown for that exit event', async () => {
    const context = harness()
    await observeOwnedRunning(context)
    const prompt = await promptFor(context.orchestrator)
    await context.orchestrator.respondToGameExitPrompt(prompt.id, 'continue')
    vi.setSystemTime(1_000_000)
    expect(await context.orchestrator.pollGameExitPrompt()).toBeNull()
    expect(context.obs.stopRecordingOnly).not.toHaveBeenCalled()
  })

  it.each(['running', 'unknown', 'new-session'] as const)('cancels an unattended deadline on %s', async (reason) => {
    const context = harness()
    await observeOwnedRunning(context)
    const prompt = await promptFor(context.orchestrator)
    if (reason === 'new-session') context.nextSession()
    else context.probe.mockResolvedValueOnce(reason)
    vi.setSystemTime(75_000)
    expect(await context.orchestrator.pollGameExitPrompt()).toBeNull()
    expect(context.obs.stopRecordingOnly).not.toHaveBeenCalled()
    expect(await context.orchestrator.respondToGameExitPrompt(prompt.id, 'stop')).toMatchObject({ stopped: false })
  })

  it.each(['primary', 'secondary'] as const)('never automatically stops a %s stream that begins during a recording countdown', async (output) => {
    const context = harness()
    await observeOwnedRunning(context)
    await promptFor(context.orchestrator)
    context.state.streaming = output === 'primary'
    context.state.twitchOutputPlugin.outputActive = output === 'secondary'
    context.nextSession()
    vi.setSystemTime(75_000)
    expect(await context.orchestrator.pollGameExitPrompt()).toBeNull()
    vi.setSystemTime(90_000)
    expect(await context.orchestrator.pollGameExitPrompt()).toMatchObject({ kind: 'stream-and-recording', autoStopAt: null })
    vi.setSystemTime(1_000_000)
    await context.orchestrator.pollGameExitPrompt()
    expect(context.obs.stop).not.toHaveBeenCalled()
    expect(context.obs.stopRecordingOnly).not.toHaveBeenCalled()
    for (const method of Object.values(context.platforms)) expect(method).not.toHaveBeenCalled()
  })

  it('does not auto-stop a manually started OBS recording based on stale game metadata, even if that game was also running', async () => {
    const { orchestrator, probe, state, obs } = harness()
    state.recordingGameId = 'ark_survival_ascended'
    state.recordingGameName = 'ASA'
    probe.mockResolvedValueOnce('running')
    await orchestrator.pollGameExitPrompt()
    const prompt = await promptFor(orchestrator)
    expect(prompt.autoStopAt).toBeNull()
    vi.setSystemTime(1_000_000)
    await orchestrator.pollGameExitPrompt()
    expect(obs.stopRecordingOnly).not.toHaveBeenCalled()
    expect(obs.stop).not.toHaveBeenCalled()
  })

  it('backend lifecycle stops an unattended recording without any desktop polling or native dialog', async () => {
    const context = harness()
    await observeOwnedRunning(context)
    context.orchestrator.startGameExitMonitoring()
    try {
      await vi.advanceTimersByTimeAsync(74_999)
      expect(context.obs.stopRecordingOnly).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(context.obs.stopRecordingOnly).toHaveBeenCalledOnce()
    } finally {
      await context.orchestrator.stopGameExitMonitoring()
    }
    await vi.advanceTimersByTimeAsync(60_000)
    expect(context.obs.stopRecordingOnly).toHaveBeenCalledOnce()
  })

  it.each(['error', 'still-recording'] as const)('retries an automatic stop after %s without changing prompt id', async (failure) => {
    const context = harness()
    await observeOwnedRunning(context)
    const prompt = await promptFor(context.orchestrator)
    if (failure === 'error') context.obs.stopRecordingOnly.mockRejectedValueOnce(new Error('temporary OBS error'))
    else context.obs.stopRecordingOnly.mockResolvedValueOnce({ warnings: [], outputPath: '', remuxedPath: '' })
    vi.setSystemTime(75_000)
    expect(await context.orchestrator.pollGameExitPrompt()).toMatchObject({ id: prompt.id, autoStopAt: 90_000 })
    vi.setSystemTime(89_999)
    await context.orchestrator.pollGameExitPrompt()
    expect(context.obs.stopRecordingOnly).toHaveBeenCalledOnce()
    vi.setSystemTime(90_000)
    expect(await context.orchestrator.pollGameExitPrompt()).toBeNull()
    expect(context.obs.stopRecordingOnly).toHaveBeenCalledTimes(2)
    expect(context.logger.write).toHaveBeenCalledWith('game_exit.retry_scheduled', expect.objectContaining({ attempt: 1, autoStopAt: 90_000 }))
  })

  it('waits for an automatic stop already in progress before completing backend shutdown', async () => {
    const context = harness()
    await observeOwnedRunning(context)
    await promptFor(context.orchestrator)
    let release!: () => void
    context.obs.stopRecordingOnly.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => { context.state.recording = false; resolve({ warnings: [], outputPath: '', remuxedPath: '' }) }
    }))
    vi.setSystemTime(75_000)
    const polling = context.orchestrator.pollGameExitPrompt()
    await vi.waitFor(() => expect(release).toBeDefined())
    let shutdownCompleted = false
    const shutdown = context.orchestrator.stopGameExitMonitoring().then(() => { shutdownCompleted = true })
    await Promise.resolve()
    expect(shutdownCompleted).toBe(false)
    release()
    await Promise.all([polling, shutdown])
    expect(shutdownCompleted).toBe(true)
    expect(context.obs.stopRecordingOnly).toHaveBeenCalledOnce()
  })

  it('honors Continue during the stop-request log await before issuing any stop', async () => {
    const context = harness()
    await observeOwnedRunning(context)
    const prompt = await promptFor(context.orchestrator)
    let release!: () => void
    context.logger.write.mockImplementation((event: string) => event === 'game_exit.stop_requested'
      ? new Promise<void>((resolve) => { release = resolve }) : Promise.resolve())
    vi.setSystemTime(75_000)
    const polling = context.orchestrator.pollGameExitPrompt()
    await vi.waitFor(() => expect(release).toBeDefined())
    expect(await context.orchestrator.respondToGameExitPrompt(prompt.id, 'continue')).toEqual({ stopped: false, warnings: [] })
    release()
    expect(await polling).toBeNull()
    expect(context.obs.stopRecordingOnly).not.toHaveBeenCalled()
    expect(context.logger.write).toHaveBeenCalledWith('game_exit.stop_cancelled', expect.objectContaining({ reason: 'countdown-cancelled-before-stop' }))
  })

  it('does not claim cancellation or abandon cleanup if Continue arrives after the stop command', async () => {
    const context = harness()
    await observeOwnedRunning(context)
    const prompt = await promptFor(context.orchestrator)
    let release!: () => void
    const cleanup = vi.fn()
    context.obs.stopRecordingOnly.mockImplementationOnce(async (_config, _revision, beforeStop, onStopCommitted) => {
      beforeStop?.()
      onStopCommitted?.()
      context.state.recording = false
      await new Promise<void>((resolve) => { release = resolve })
      beforeStop?.()
      cleanup()
      return { warnings: [], outputPath: 'capture.mkv', remuxedPath: 'capture.mp4' }
    })
    vi.setSystemTime(75_000)
    const polling = context.orchestrator.pollGameExitPrompt()
    await vi.waitFor(() => expect(release).toBeDefined())
    expect(await context.orchestrator.respondToGameExitPrompt(prompt.id, 'continue')).toMatchObject({ warnings: [expect.stringContaining('すでに始まっています')] })
    release()
    expect(await polling).toBeNull()
    expect(cleanup).toHaveBeenCalledOnce()
    expect(context.logger.write).toHaveBeenCalledWith('game_exit.responded', expect.objectContaining({ stopped: true }))
    expect(context.logger.write.mock.calls.some(([event]) => event === 'game_exit.stop_cancelled')).toBe(false)
  })

  it('continues automatic retries for optional recordings after its own normal recording has stopped', async () => {
    const context = harness()
    context.state.recordingOnly = false
    context.state.sourceRecord = true
    await observeOwnedRunning(context)
    const prompt = await promptFor(context.orchestrator)
    context.obs.stopRecordingOutputs.mockImplementationOnce(async () => {
      context.state.recording = false
      context.ownStopTransition()
      return ['Source Record temporarily unavailable']
    })
    vi.setSystemTime(75_000)
    expect(await context.orchestrator.pollGameExitPrompt()).toMatchObject({ id: prompt.id, autoStopAt: 90_000 })
    vi.setSystemTime(90_000)
    expect(await context.orchestrator.pollGameExitPrompt()).toBeNull()
    expect(context.obs.stopRecordingOutputs).toHaveBeenCalledTimes(2)
    expect(context.state.sourceRecord).toBe(false)
  })

  it('automatically stops owned ordinary and optional recordings without platform mutations', async () => {
    const context = harness()
    context.state.recordingOnly = false
    context.state.sourceRecord = true
    context.state.verticalRecording = true
    await observeOwnedRunning(context)
    await promptFor(context.orchestrator)
    vi.setSystemTime(75_000)
    expect(await context.orchestrator.pollGameExitPrompt()).toBeNull()
    expect(context.obs.stopRecordingOutputs).toHaveBeenCalledOnce()
    expect(context.obs.stopRecordingOnly).not.toHaveBeenCalled()
    for (const method of Object.values(context.platforms)) expect(method).not.toHaveBeenCalled()
  })

  it('continues the current exit event without repeated dialogs and rearms after the game returns', async () => {
    const { orchestrator, probe, obs } = harness()
    const prompt = await promptFor(orchestrator)
    await expect(orchestrator.respondToGameExitPrompt(prompt.id, 'continue')).resolves.toEqual({ stopped: false, warnings: [] })
    vi.setSystemTime(90_000)
    expect(await orchestrator.pollGameExitPrompt()).toBeNull()
    probe.mockResolvedValueOnce('running')
    expect(await orchestrator.pollGameExitPrompt()).toBeNull()
    const next = await promptFor(orchestrator)
    expect(next.id).not.toBe(prompt.id)
    expect(obs.stopRecordingOnly).not.toHaveBeenCalled()
  })

  it.each(['busy', 'externalSyncing', 'backgroundAudioEnsure'] as const)('invalidates the timer and old prompt while %s', async (field) => {
    const { orchestrator, obs } = harness()
    const prompt = await promptFor(orchestrator)
    Object.assign(orchestrator, { [field]: field === 'backgroundAudioEnsure' ? Promise.resolve({ applied: false, warnings: [] }) : true })
    expect(await orchestrator.pollGameExitPrompt()).toBeNull()
    Object.assign(orchestrator, { [field]: field === 'backgroundAudioEnsure' ? null : false })
    await expect(orchestrator.respondToGameExitPrompt(prompt.id, 'stop')).resolves.toEqual({ stopped: false, warnings: [] })
    expect(obs.stopRecordingOnly).not.toHaveBeenCalled()
    expect(await orchestrator.pollGameExitPrompt()).toBeNull()
  })

  it.each(['unknown', 'disconnect', 'failure'] as const)('never treats %s as proof that the game ended', async (failure) => {
    const { orchestrator, state, probe, obs } = harness()
    await orchestrator.pollGameExitPrompt()
    vi.setSystemTime(15_000)
    if (failure === 'unknown') probe.mockResolvedValueOnce('unknown')
    if (failure === 'disconnect') state.obsConnected = false
    if (failure === 'failure') probe.mockRejectedValueOnce(new Error('tasklist unavailable'))
    expect(await orchestrator.pollGameExitPrompt()).toBeNull()
    state.obsConnected = true
    expect(await orchestrator.pollGameExitPrompt()).toBeNull()
    expect(obs.stopRecordingOnly).not.toHaveBeenCalled()
  })

  it.each(['elgato', 'display'] as CaptureMethod[])('does not watch manually selected %s capture', async (method) => {
    const { orchestrator, profiles, probe } = harness()
    profiles.find(({ id }) => id === 'minecraft')!.state.lastCaptureMethod = method
    await orchestrator.pollGameExitPrompt()
    vi.setSystemTime(60_000)
    expect(await orchestrator.pollGameExitPrompt()).toBeNull()
    expect(probe).not.toHaveBeenCalled()
  })

  it('rejects an old confirmation after the same game started another recording session', async () => {
    const { orchestrator, nextSession, obs } = harness()
    const prompt = await promptFor(orchestrator)
    nextSession()
    await expect(orchestrator.respondToGameExitPrompt(prompt.id, 'stop')).resolves.toEqual({ stopped: false, warnings: [] })
    expect(obs.stopRecordingOnly).not.toHaveBeenCalled()
  })

  it('rechecks the output session after the game process probe finishes', async () => {
    const { orchestrator, nextSession, probe, obs } = harness()
    const prompt = await promptFor(orchestrator)
    probe.mockImplementationOnce(async () => { nextSession(); return 'stopped' })
    await expect(orchestrator.respondToGameExitPrompt(prompt.id, 'stop')).resolves.toEqual({ stopped: false, warnings: [] })
    expect(obs.stopRecordingOnly).not.toHaveBeenCalled()
  })

  it.each(['running', 'unknown'] as const)('cancels the stop if the final process probe is %s', async (presence) => {
    const { orchestrator, probe, obs } = harness()
    const prompt = await promptFor(orchestrator)
    probe.mockResolvedValueOnce(presence)
    await expect(orchestrator.respondToGameExitPrompt(prompt.id, 'stop')).resolves.toEqual({ stopped: false, warnings: [] })
    expect(obs.stopRecordingOnly).not.toHaveBeenCalled()
  })

  it('keeps the valid confirmation during a concurrent poll while answering', async () => {
    const { orchestrator, probe, obs } = harness()
    const prompt = await promptFor(orchestrator)
    let release!: (value: 'stopped') => void
    probe.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const response = orchestrator.respondToGameExitPrompt(prompt.id, 'stop')
    for (let index = 0; index < 8 && !release; index += 1) await Promise.resolve()
    expect(release).toBeDefined()
    expect(await orchestrator.pollGameExitPrompt()).toEqual(prompt)
    release('stopped')
    await expect(response).resolves.toEqual({ stopped: true, warnings: [] })
    expect(obs.stopRecordingOnly).toHaveBeenCalledOnce()
  })

  it('reports a stop failure once without reopening the same exit prompt', async () => {
    const { orchestrator, obs } = harness()
    const prompt = await promptFor(orchestrator)
    obs.stopRecordingOnly.mockRejectedValueOnce(new Error('OBS unavailable'))
    expect(await orchestrator.respondToGameExitPrompt(prompt.id, 'stop')).toMatchObject({ stopped: false, warnings: [expect.stringContaining('OBS unavailable')] })
    vi.setSystemTime(60_000)
    expect(await orchestrator.pollGameExitPrompt()).toBeNull()
    expect(obs.stopRecordingOnly).toHaveBeenCalledOnce()
  })

  it.each(['primary', 'secondary'] as const)('stops active %s streaming and recording through the existing stream teardown', async (output) => {
    const { orchestrator, state, obs, platforms } = harness()
    state.streaming = output === 'primary'
    state.twitchOutputPlugin.outputActive = output === 'secondary'
    state.recordingOnly = false
    const prompt = await promptFor(orchestrator)
    expect(prompt).toMatchObject({ gameId: 'ark_survival_ascended', kind: 'stream-and-recording' })
    await expect(orchestrator.respondToGameExitPrompt(prompt.id, 'stop')).resolves.toEqual({ stopped: true, warnings: [] })
    expect(obs.stop).toHaveBeenCalledOnce()
    expect(platforms.completeYouTubeBroadcast).toHaveBeenCalledOnce()
    expect(obs.stopRecordingOnly).not.toHaveBeenCalled()
  })

  it.each(['before-completion', 'during-completion'] as const)('does not complete a new broadcast or stop its comments when a new output starts %s', async (timing) => {
    const { orchestrator, state, obs, platforms } = harness()
    state.streaming = true
    state.recordingOnly = false
    const prompt = await promptFor(orchestrator)
    let newOutput = false
    const guard = () => { if (newOutput) throw new Error('new output session') }
    obs.createOutputStopGuard.mockReturnValue(guard)
    if (timing === 'before-completion') obs.isStreaming.mockImplementationOnce(async () => { newOutput = true; return false })
    else platforms.completeYouTubeBroadcast.mockImplementationOnce(async (...args: unknown[]) => {
      newOutput = true
      ;(args[2] as () => void)()
    })

    expect(await orchestrator.respondToGameExitPrompt(prompt.id, 'stop')).toMatchObject({ stopped: false, warnings: [expect.stringContaining('new output session')] })

    if (timing === 'before-completion') expect(platforms.completeYouTubeBroadcast).not.toHaveBeenCalled()
    else expect(platforms.completeYouTubeBroadcast).toHaveBeenCalledWith(expect.anything(), expect.anything(), guard)
    expect(platforms.stopComments).not.toHaveBeenCalled()
  })

  it('stops normal and optional recordings without a platform call or recording-only profile restoration', async () => {
    const { orchestrator, state, obs, platforms } = harness()
    state.recordingOnly = false
    state.sourceRecord = true
    state.verticalRecording = true
    const prompt = await promptFor(orchestrator)
    await expect(orchestrator.respondToGameExitPrompt(prompt.id, 'stop')).resolves.toEqual({ stopped: true, warnings: [] })
    expect(obs.stopRecordingOutputs).toHaveBeenCalledOnce()
    expect(obs.stopRecordingOnly).not.toHaveBeenCalled()
    expect(obs.stop).not.toHaveBeenCalled()
    for (const method of Object.values(platforms)) expect(method).not.toHaveBeenCalled()
  })

  it('connects the native confirmation controller to the real monitor and stop decision', async () => {
    const { orchestrator, probe, obs } = harness()
    let answer!: (action: GameExitAction) => void
    const show = vi.fn<(prompt: GameExitPrompt, signal: AbortSignal) => Promise<GameExitAction>>()
      .mockImplementation(() => new Promise<GameExitAction>((resolve) => { answer = resolve }))
    const completed = vi.fn()
    const failed = vi.fn()
    const dialog = new GameExitDialogController({
      poll: () => orchestrator.pollGameExitPrompt(),
      respond: (id, action) => orchestrator.respondToGameExitPrompt(id, action),
      show, completed, failed,
    })
    try {
      await dialog.check()
      expect(show).not.toHaveBeenCalled()
      vi.setSystemTime(15_000)
      await dialog.check()
      expect(show).toHaveBeenCalledWith(expect.objectContaining({ gameId: 'minecraft', kind: 'recording' }), expect.any(AbortSignal))
      expect(obs.stopRecordingOnly).not.toHaveBeenCalled()
      answer('continue')
      await vi.waitFor(() => expect(completed).toHaveBeenCalledWith({ stopped: false, warnings: [] }))
      await dialog.check()
      expect(show).toHaveBeenCalledTimes(1)
      expect(obs.stopRecordingOnly).not.toHaveBeenCalled()

      probe.mockResolvedValueOnce('running')
      await dialog.check()
      await dialog.check()
      vi.setSystemTime(Date.now() + 15_000)
      await dialog.check()
      expect(show).toHaveBeenCalledTimes(2)
      answer('stop')
      await vi.waitFor(() => expect(completed).toHaveBeenCalledWith({ stopped: true, warnings: [] }))
      expect(obs.stopRecordingOnly).toHaveBeenCalledOnce()
      expect(failed).not.toHaveBeenCalled()
    } finally {
      await dialog.stop()
    }
  })
})

describe('OBS output session revision', () => {
  function guardedController() {
    const controller = new ObsController({ get: () => null, set: () => undefined } as unknown as SecretStore)
    const original = (controller as unknown as { obs: { emit(event: string, data?: unknown): void } }).obs
    const transition = (kind: 'Record' | 'Stream', active: boolean) => original.emit(`${kind}StateChanged`, {
      outputActive: active, outputState: active ? 'OBS_WEBSOCKET_OUTPUT_STARTED' : 'OBS_WEBSOCKET_OUTPUT_STOPPED',
    })
    const starting = (kind: 'Record' | 'Stream') => original.emit(`${kind}StateChanged`, {
      outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTING',
    })
    return { controller, transition, starting }
  }

  it('changes for completed stream/record transitions and disconnect, not reconnecting or duplicate events', () => {
    const controller = new ObsController({ get: () => null } as unknown as SecretStore)
    const transport = (controller as unknown as { obs: { emit(event: string, data?: unknown): void } }).obs
    const initial = controller.getOutputSessionRevision()
    transport.emit('RecordStateChanged', { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED' })
    const recording = controller.getOutputSessionRevision()
    expect(recording).toBeGreaterThan(initial)
    transport.emit('RecordStateChanged', { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED' })
    expect(controller.getOutputSessionRevision()).toBe(recording)
    transport.emit('StreamStateChanged', { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_RECONNECTING' })
    expect(controller.getOutputSessionRevision()).toBe(recording)
    transport.emit('RecordStateChanged', { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED' })
    expect(controller.getOutputSessionRevision()).toBeGreaterThan(recording)
    const stopped = controller.getOutputSessionRevision()
    transport.emit('ConnectionClosed')
    expect(controller.getOutputSessionRevision()).toBeGreaterThan(stopped)
  })

  it.each([false, true])('stops normal recordings without stream/profile operations and handles missing optional plugins (owned: %s)', async (owned) => {
    let recording = true
    const controller = new ObsController({ get: () => null } as unknown as SecretStore)
    const call = vi.fn(async (request: string, data?: { vendorName?: string }) => {
      if (request === 'GetStreamStatus') return { outputActive: false }
      if (request === 'GetRecordStatus') return { outputActive: recording }
      if (request === 'StopRecord') { recording = false; return {} }
      if (request === 'CallVendorRequest' && data?.vendorName === 'obs-stream-manager-output-v2') return { responseData: { success: true, apiVersion: 4, outputActive: false } }
      if (request === 'CallVendorRequest') throw new Error('No vendor was found by that name.')
      if (request === 'TriggerHotkeyByName') throw new Error('No hotkeys were found by that name.')
      throw new Error(`Unexpected OBS mutation: ${request}`)
    })
    const privateState = controller as unknown as { obs: unknown; started: { sourceRecord: boolean; vertical: boolean } }
    privateState.obs = { connect: vi.fn().mockResolvedValue(undefined), call }
    privateState.started.sourceRecord = owned
    privateState.started.vertical = owned
    const warnings = await controller.stopRecordingOutputs(structuredClone(defaultConfig))
    expect(recording).toBe(false)
    if (owned) {
      expect(warnings).toHaveLength(2)
      expect(privateState.started).toMatchObject({ sourceRecord: true, vertical: true })
    } else expect(warnings).toEqual([])
    expect(call.mock.calls.some(([request]) => ['StopStream', 'SetStreamServiceSettings', 'SetCurrentProfile'].includes(request))).toBe(false)
  })

  it('does not stop a new stream that began during the ending-scene delay', async () => {
    vi.useFakeTimers()
    try {
      const { controller, transition } = guardedController()
      transition('Stream', true)
      const expected = controller.getOutputSessionRevision()
      const call = vi.fn().mockResolvedValue({})
      Object.assign(controller, { obs: { connect: vi.fn().mockResolvedValue(undefined), call } })
      const config = structuredClone(defaultConfig)
      config.obs.endDelaySeconds = 5
      const result = controller.stop(config, structuredClone(starterProfiles[0]), expected).catch((error: Error) => error.message)
      await vi.advanceTimersByTimeAsync(1_000)
      transition('Stream', false)
      transition('Stream', true)
      await vi.advanceTimersByTimeAsync(4_000)
      expect(await result).toContain('新しい出力が開始された')
      expect(call.mock.calls.some(([request]) => request === 'StopStream')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['dedicated', 'normal'] as const)('checks a Continue cancellation after awaiting OBS status and before stopping %s recording', async (mode) => {
    const { controller, transition } = guardedController()
    transition('Record', true)
    const expected = controller.getOutputSessionRevision()
    let cancelled = false
    const call = vi.fn(async (request: string) => {
      if (request === 'GetRecordStatus') { cancelled = true; return { outputActive: true } }
      if (request === 'GetStreamStatus') return { outputActive: false }
      if (request === 'CallVendorRequest') return { responseData: { success: true, apiVersion: 4, outputActive: false } }
      return {}
    })
    Object.assign(controller, { obs: { connect: vi.fn().mockResolvedValue(undefined), call } })
    const beforeStop = () => { if (cancelled) throw new Error('Continue chosen') }
    const result = mode === 'dedicated'
      ? controller.stopRecordingOnly(structuredClone(defaultConfig), expected, beforeStop)
      : controller.stopRecordingOutputs(structuredClone(defaultConfig), expected, beforeStop)
    await expect(result).rejects.toThrow('Continue chosen')
    expect(call.mock.calls.some(([request]) => request === 'StopRecord')).toBe(false)
  })

  it('preserves recording ownership and profile when a StopRecord request fails', async () => {
    const { controller, transition } = guardedController()
    transition('Record', true)
    const restore = vi.fn().mockResolvedValue(undefined)
    const call = vi.fn(async (request: string) => {
      if (request === 'GetRecordStatus') return { outputActive: true }
      if (request === 'StopRecord') throw new Error('temporary stop error')
      throw new Error(`Unexpected request: ${request}`)
    })
    Object.assign(controller, {
      obs: { connect: vi.fn().mockResolvedValue(undefined), call },
      recordingOnlyActive: true, recordingGame: { id: 'minecraft', name: 'Minecraft' },
      restorePreviousRecordingProfile: restore,
    })
    expect(await controller.stopRecordingOnly(structuredClone(defaultConfig), controller.getOutputSessionRevision())).toMatchObject({ warnings: [expect.stringContaining('temporary stop error')] })
    expect(controller).toMatchObject({ recordingOnlyActive: true, recordingGame: { id: 'minecraft' } })
    expect(restore).not.toHaveBeenCalled()
  })

  it('does not send an Aitum fallback stop hotkey after another output starts during the vendor request', async () => {
    const { controller, transition } = guardedController()
    const call = vi.fn(async (request: string, data?: { vendorName?: string }) => {
      if (request === 'GetRecordStatus' || request === 'GetStreamStatus') return { outputActive: false }
      if (request === 'CallVendorRequest' && data?.vendorName === 'obs-stream-manager-output-v2') return { responseData: { success: true, apiVersion: 4, outputActive: false } }
      if (request === 'CallVendorRequest' && data?.vendorName === 'aitum-vertical-canvas') {
        transition('Stream', true)
        throw new Error('No vendor was found by that name.')
      }
      return { responseData: { success: true } }
    })
    Object.assign(controller, { obs: { connect: vi.fn().mockResolvedValue(undefined), call } })
    const warnings = await controller.stopRecordingOutputs(structuredClone(defaultConfig), controller.getOutputSessionRevision())
    expect(warnings).toEqual([expect.stringContaining('新しい出力が開始された')])
    expect(call.mock.calls.some(([request]) => request === 'TriggerHotkeyByName')).toBe(false)
  })

  it('finishes remux/profile restoration when cancellation arrives after the stop command commit point', async () => {
    const { controller, transition } = guardedController()
    transition('Record', true)
    let cancelled = false
    let committed = false
    const restore = vi.fn().mockResolvedValue(undefined)
    const call = vi.fn(async (request: string) => {
      if (request === 'GetRecordStatus') return { outputActive: true }
      if (request === 'StopRecord') { transition('Record', false); return { outputPath: 'capture.mkv' } }
      throw new Error(`Unexpected request: ${request}`)
    })
    Object.assign(controller, {
      obs: { connect: vi.fn().mockResolvedValue(undefined), call },
      waitForRecordInactive: vi.fn().mockResolvedValue(true),
      waitForRemuxedMp4: vi.fn(async () => { cancelled = true; return 'capture.mp4' }),
      restorePreviousRecordingProfile: restore,
    })
    const beforeStop = () => { if (cancelled && !committed) throw new Error('Continue chosen') }
    expect(await controller.stopRecordingOnly(structuredClone(defaultConfig), controller.getOutputSessionRevision(), beforeStop, () => { committed = true })).toEqual({ warnings: [], outputPath: 'capture.mkv', remuxedPath: 'capture.mp4' })
    expect(restore).toHaveBeenCalledOnce()
  })

  it.each(['dedicated', 'normal'] as const)('does not stop a new %s recording that began during the final status request', async (mode) => {
    const { controller, transition } = guardedController()
    transition('Record', true)
    const expected = controller.getOutputSessionRevision()
    const call = vi.fn(async (request: string) => {
      if (request === 'GetRecordStatus') { transition('Record', false); transition('Record', true); return { outputActive: true } }
      if (request === 'GetStreamStatus') return { outputActive: false }
      if (request === 'CallVendorRequest') return { responseData: { success: true, apiVersion: 4, outputActive: false } }
      return {}
    })
    Object.assign(controller, { obs: { connect: vi.fn().mockResolvedValue(undefined), call } })
    const result = mode === 'dedicated'
      ? controller.stopRecordingOnly(structuredClone(defaultConfig), expected)
      : controller.stopRecordingOutputs(structuredClone(defaultConfig), expected)
    await expect(result).rejects.toThrow('新しい出力が開始された')
    expect(call.mock.calls.some(([request]) => request === 'StopRecord')).toBe(false)
  })

  it.each(['Stream', 'Record'] as const)('rejects a stale stop as soon as a new %s output is STARTING', async (kind) => {
    const { controller, transition, starting } = guardedController()
    transition(kind, true)
    const listener = vi.fn()
    controller.onStreamStateChanged(listener)
    const expected = controller.getOutputSessionRevision()
    const call = vi.fn(async (request: string) => {
      if ((kind === 'Stream' && request === 'SetCurrentProgramScene') || (kind === 'Record' && request === 'GetRecordStatus')) {
        starting(kind)
      }
      if (request === 'GetRecordStatus') return { outputActive: true }
      return {}
    })
    Object.assign(controller, { obs: { connect: vi.fn().mockResolvedValue(undefined), call } })
    const config = structuredClone(defaultConfig)
    config.obs.endDelaySeconds = 0
    const result = kind === 'Stream'
      ? controller.stop(config, structuredClone(starterProfiles[0]), expected)
      : controller.stopRecordingOnly(config, expected)
    await expect(result).rejects.toThrow('新しい出力が開始された')
    expect(call.mock.calls.some(([request]) => request === `Stop${kind}`)).toBe(false)
    expect(listener).not.toHaveBeenCalled()
  })

  it('allows its own recording stop transition before stopping the same stream session', async () => {
    const { controller, transition } = guardedController()
    transition('Stream', true)
    transition('Record', true)
    const expected = controller.getOutputSessionRevision()
    let streaming = true
    let recording = true
    const call = vi.fn(async (request: string) => {
      if (request === 'GetStreamStatus') return { outputActive: streaming }
      if (request === 'GetRecordStatus') return { outputActive: recording }
      if (request === 'GetReplayBufferStatus') return { outputActive: false }
      if (request === 'StopRecord') { recording = false; transition('Record', false); return {} }
      if (request === 'StopStream') { streaming = false; transition('Stream', false); return {} }
      if (request === 'CallVendorRequest') return { responseData: { success: true } }
      return {}
    })
    Object.assign(controller, { obs: { connect: vi.fn().mockResolvedValue(undefined), call } })
    const config = structuredClone(defaultConfig)
    config.obs.endDelaySeconds = 0
    await expect(controller.stop(config, structuredClone(starterProfiles[0]), expected)).resolves.toEqual([])
    expect(call.mock.calls.filter(([request]) => request === 'StopRecord')).toHaveLength(1)
    expect(call.mock.calls.filter(([request]) => request === 'StopStream')).toHaveLength(1)
  })
})
