import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BgmLibrarySection } from './BgmLibrarySection'

describe('BgmLibrarySection', () => {
  it('renders stock upload and safe disabled playback controls before the library loads', () => {
    const html = renderToStaticMarkup(<BgmLibrarySection obsConnected />)

    expect(html).toContain('BGMストック')
    expect(html).toContain('BGMを追加')
    expect(html).toContain('BGMストックを読み込んでいます')
    expect(html).toContain('accept=".mp3,.wav,.ogg,.flac,.m4a')
    expect(html).toContain('disabled=""')
  })
})
