import { describe, expect, it } from 'vitest'
import { GameExitMonitor, type GameExitTarget } from './game-exit-monitor.js'

const target: GameExitTarget = { key: 'session-1', gameId: 'minecraft', gameName: 'Minecraft', kind: 'recording', automaticStopAllowed: true }

describe('GameExitMonitor', () => {
  it('requires 15 seconds and multiple confirmed missing observations, including after app startup', () => {
    let now = 0
    const monitor = new GameExitMonitor(15_000, () => now)
    expect(monitor.observe(target, 'stopped')).toBeNull()
    now = 14_999
    expect(monitor.observe(target, 'stopped')).toBeNull()
    now = 15_000
    const prompt = monitor.observe(target, 'stopped')
    expect(prompt).toMatchObject({ gameId: 'minecraft', kind: 'recording', autoStopAt: null })
    now = 60_000
    expect(monitor.observe(target, 'stopped')).toEqual(prompt)
  })

  it('starts a 60-second recording countdown only after observing running in the same owned session', () => {
    let now = 0
    const monitor = new GameExitMonitor(15_000, () => now)
    monitor.observe(target, 'running')
    monitor.observe(target, 'stopped')
    now = 15_000
    const prompt = monitor.observe(target, 'stopped')!
    expect(prompt.autoStopAt).toBe(75_000)
    now = 74_999
    expect(monitor.automaticStopDue(prompt.id)).toBe(false)
    now = 75_000
    expect(monitor.automaticStopDue(prompt.id)).toBe(true)
    expect(monitor.automaticStopDue('stale-id')).toBe(false)
  })

  it.each(['stream', 'stream-and-recording'] as const)('never schedules an unattended stop for %s', (kind) => {
    let now = 0
    const monitor = new GameExitMonitor(15_000, () => now)
    monitor.observe({ ...target, kind }, 'running')
    monitor.observe({ ...target, kind }, 'stopped')
    now = 15_000
    const prompt = monitor.observe({ ...target, kind }, 'stopped')!
    expect(prompt.autoStopAt).toBeNull()
    now = 10_000_000
    expect(monitor.automaticStopDue(prompt.id)).toBe(false)
  })

  it('never schedules an unowned manual OBS output even when its stale game was running', () => {
    let now = 0
    const monitor = new GameExitMonitor(15_000, () => now)
    const unowned = { ...target, automaticStopAllowed: false }
    monitor.observe(unowned, 'running')
    monitor.observe(unowned, 'stopped')
    now = 15_000
    expect(monitor.observe(unowned, 'stopped')?.autoStopAt).toBeNull()
  })

  it('keeps the same prompt id when retrying failures with capped exponential backoff', () => {
    let now = 0
    const monitor = new GameExitMonitor(15_000, () => now)
    monitor.observe(target, 'running')
    monitor.observe(target, 'stopped')
    now = 15_000
    const first = monitor.observe(target, 'stopped')!
    now = 75_000
    for (const delay of [15_000, 30_000, 60_000, 60_000]) {
      const retry = monitor.retryAutomaticStop(first.id)!
      expect(retry.prompt).toMatchObject({ id: first.id, autoStopAt: now + delay })
      expect(monitor.automaticStopDue(first.id)).toBe(false)
      now += delay
    }
    monitor.suppress(first.id)
    expect(monitor.retryAutomaticStop(first.id)).toBeNull()
  })

  it('discards uncertain time and invalidates an existing prompt', () => {
    let now = 0
    const monitor = new GameExitMonitor(15_000, () => now)
    monitor.observe(target, 'stopped')
    now = 15_000
    const prompt = monitor.observe(target, 'stopped')!
    expect(monitor.observe(target, 'unknown')).toBeNull()
    expect(monitor.getPending(prompt.id)).toBeNull()
    now = 60_000
    expect(monitor.observe(target, 'stopped')).toBeNull()
    now = 75_000
    expect(monitor.observe(target, 'stopped')?.id).not.toBe(prompt.id)
  })

  it('does not repeat a declined exit until running is observed again', () => {
    let now = 0
    const monitor = new GameExitMonitor(15_000, () => now)
    monitor.observe(target, 'stopped')
    now = 15_000
    const first = monitor.observe(target, 'stopped')!
    expect(monitor.suppress(first.id)).toBe(true)
    monitor.invalidate()
    monitor.observe(target, 'unknown')
    now = 90_000
    expect(monitor.observe(target, 'stopped')).toBeNull()
    monitor.observe(target, 'running')
    monitor.observe(target, 'stopped')
    now = 105_000
    expect(monitor.observe(target, 'stopped')?.id).not.toBe(first.id)
  })

  it('invalidates old prompts and starts a fresh grace period for another output session', () => {
    let now = 0
    const monitor = new GameExitMonitor(15_000, () => now)
    monitor.observe(target, 'stopped')
    now = 15_000
    const first = monitor.observe(target, 'stopped')!
    expect(monitor.observe({ ...target, key: 'session-2' }, 'stopped')).toBeNull()
    expect(monitor.suppress(first.id)).toBe(false)
    now = 30_000
    expect(monitor.observe({ ...target, key: 'session-2' }, 'stopped')?.id).not.toBe(first.id)
  })
})
