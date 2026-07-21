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
})
