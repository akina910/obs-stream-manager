import { describe, expect, it } from 'vitest'
import { clientBuildFromHtml, clientKindFromUserAgent } from './client-build.js'

it('does not mistake the OBS Stream Manager Electron app for the OBS dock', () => {
  expect(clientKindFromUserAgent('Mozilla/5.0 obs-stream-manager/0.2.20 Chrome/148 Electron/43.1.0 Safari/537.36')).toBe('desktop')
  expect(clientKindFromUserAgent('Mozilla/5.0 Chrome/144 Safari/537.36 OBS/32.2.2')).toBe('obs-dock')
  expect(clientKindFromUserAgent('Mozilla/5.0 Chrome/144 Safari/537.36')).toBe('browser')
})

describe('served client build identity', () => {
  it('identifies the content-hashed Vite entry and changes when its bundle changes', () => {
    const html = '<script type="module" crossorigin src="/assets/index-abc123.js"></script>'
    expect(clientBuildFromHtml(html)).toEqual({ entryScript: '/assets/index-abc123.js' })
    expect(clientBuildFromHtml(html.replace('abc123', 'def456'))).not.toEqual(clientBuildFromHtml(html))
  })

  it('supports generated attribute order and ignores development or unrelated scripts', () => {
    expect(clientBuildFromHtml("<script src='/assets/index-def456.js' crossorigin type='module'></script>"))
      .toEqual({ entryScript: '/assets/index-def456.js' })
    for (const html of [
      '',
      '<script type="module" src="/src/main.tsx"></script>',
      '<script src="/assets/legacy.js"></script>',
      '<script type="module" src="https://example.com/assets/index-abc123.js"></script>',
    ]) expect(clientBuildFromHtml(html)).toEqual({ entryScript: null })
  })
})
