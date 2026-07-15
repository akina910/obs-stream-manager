import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  hasStartupListenRetried,
  StartupListenTimeoutError,
  startupListenRetryArgument,
  startupListenRetryArgs,
  withStartupListenTimeout,
} from './startup.js'

afterEach(() => vi.useRealTimers())

describe('desktop startup recovery', () => {
  it('returns a local server result before the deadline', async () => {
    await expect(withStartupListenTimeout(Promise.resolve({ url: 'http://127.0.0.1:4317' }), 1_000)).resolves.toEqual({ url: 'http://127.0.0.1:4317' })
  })

  it('fails a stuck local server startup with a visible timeout error', async () => {
    vi.useFakeTimers()
    const result = withStartupListenTimeout(new Promise<never>(() => undefined), 10_000)
    const assertion = expect(result).rejects.toBeInstanceOf(StartupListenTimeoutError)
    await vi.advanceTimersByTimeAsync(10_000)
    await assertion
  })

  it('handles a listen rejection that arrives after the timeout', async () => {
    vi.useFakeTimers()
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    const delayedFailure = new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('late listen failure')), 20_000))
    try {
      const result = withStartupListenTimeout(delayedFailure, 10_000)
      const assertion = expect(result).rejects.toBeInstanceOf(StartupListenTimeoutError)
      await vi.advanceTimersByTimeAsync(10_000)
      await assertion
      await vi.advanceTimersByTimeAsync(10_000)
      await Promise.resolve()
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('adds at most one automatic retry argument', () => {
    const first = startupListenRetryArgs(['app.exe'])
    const second = startupListenRetryArgs(first)
    expect(first).toEqual(['app.exe', startupListenRetryArgument])
    expect(second).toEqual(first)
    expect(hasStartupListenRetried(second)).toBe(true)
  })
})
