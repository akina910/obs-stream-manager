import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiRequestError } from './api'

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

  it('selects a game locally by default before recording without requesting streaming or OAuth preparation', async () => {
    const warnings = ['ゲーム音声の入力を確認してください']
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ profile: {}, captureMethod: 'local', warnings, services: [] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, warnings }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }))
    vi.stubGlobal('fetch', fetchMock)

    const selected = await api.select('minecraft', 'local')
    const recording = await api.startRecordingOnly()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/select', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ gameId: 'minecraft', captureMethod: 'local', preparePlatforms: false }),
    }))
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/recording/start', expect.objectContaining({ method: 'POST', body: '{}' }))
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/select', '/api/recording/start'])
    expect(selected.warnings).toEqual(warnings)
    expect(recording.warnings).toEqual(warnings)
  })

  it('preserves explicitly requested platform preparation and its service errors', async () => {
    const warning = 'youtube: 400 invalid_grant Bad Request'
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      profile: {}, captureMethod: 'local', warnings: [warning], services: [{ service: 'youtube', ok: false, message: warning }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await api.select('minecraft', undefined, true)

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/api/select', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ gameId: 'minecraft', preparePlatforms: true }),
    }))
    expect(result.warnings).toEqual([warning])
    expect(result.services).toEqual([{ service: 'youtube', ok: false, message: warning }])
  })

  it('does not suppress a recording capture error', async () => {
    const error = '録画するゲームを検出できませんでした'
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error }), {
      status: 400, headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.startRecordingOnly()).rejects.toThrow(error)
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/api/recording/start', expect.objectContaining({ method: 'POST', body: '{}' }))
  })

  it('preserves validated service results on a rejected stream start for the confirmation flow', async () => {
    const services = [{ service: 'youtube', ok: true, message: 'Ready' }, { service: 'twitch', ok: false, message: 'Reauthorization needed' }]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Preparation failed', services }), { status: 400 })))
    const error = await api.start().catch((error: unknown) => error)
    expect(error).toBeInstanceOf(ApiRequestError)
    expect(error).toMatchObject({ message: 'Preparation failed', services })
  })

  it('does not use malformed service results to authorize a fallback', async () => {
    for (const services of [[{ service: 'twitch', message: 'Failed' }], [{ service: 'other', ok: false, message: 'Failed' }], 'twitch', []]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Preparation failed', services }), { status: 400 })))
      const error = await api.start().catch((error: unknown) => error)
      expect(error).toBeInstanceOf(ApiRequestError)
      expect(error).toMatchObject({ message: 'Preparation failed', services: undefined })
    }
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
