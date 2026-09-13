import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'

afterEach(() => vi.unstubAllGlobals())

describe('API request headers', () => {
  it('does not declare an empty DELETE request as JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ version: 1, tracks: [], selectedTrackId: null, playback: { state: 'stopped', cursorMs: null, durationMs: null } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await api.deleteBgm('00000000-0000-4000-8000-000000000000')

    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.method).toBe('DELETE')
    expect(new Headers(init.headers).has('content-type')).toBe(false)
  })

  it('keeps JSON content type for requests with JSON bodies', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await api.controlBgm('pause')

    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(new Headers(init.headers).get('content-type')).toBe('application/json')
  })

  it('requests automatic profile audio setup without user input', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, applied: true, warnings: [] }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await api.ensureAudio()

    expect(fetchMock).toHaveBeenCalledWith('/api/audio/ensure', expect.objectContaining({ method: 'POST', body: '{}' }))
  })

  it('can reapply a selected game without updating external platform metadata', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      profile: {},
      captureMethod: 'geforce_now',
      warnings: [],
      services: [],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await api.select('steam_3357650', 'geforce_now', false)

    expect(fetchMock).toHaveBeenCalledWith('/api/select', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        gameId: 'steam_3357650',
        captureMethod: 'geforce_now',
        preparePlatforms: false,
      }),
    }))
  })

  it('uses independent endpoints for recording-only start and stop', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, warnings: [] }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, warnings: [], outputPath: 'capture.mkv', remuxedPath: 'capture.mp4' }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await api.startRecordingOnly()
    await api.stopRecordingOnly()

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/recording/start', expect.objectContaining({ method: 'POST', body: '{}' }))
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/recording/stop', expect.objectContaining({ method: 'POST', body: '{}' }))
    expect(fetchMock.mock.calls.map(([url]) => url)).not.toContain('/api/stream/start')
    expect(fetchMock.mock.calls.map(([url]) => url)).not.toContain('/api/stream/stop')
  })
})
