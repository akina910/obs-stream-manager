import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const hook = require('./electron-builder-hooks.cjs') as {
  (context: { packager: { projectDir: string } }): Promise<void>
  assertCompleteProviderBundle: (value: unknown) => void
}
const { assertCompleteProviderBundle } = hook
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('electron-builder distribution hook', () => {
  it('rejects a provider-less bundle even when electron-builder is invoked directly', () => {
    expect(() => assertCompleteProviderBundle({ version: 3 }))
      .toThrow('Distribution package requires complete YouTube Desktop app credentials')
  })

  it('rejects forbidden tokens and Twitch client secrets from a hand-authored bundle', () => {
    const base = {
      version: 3,
      youtube: { clientId: 'youtube-client', clientType: 'desktop', clientSecret: 'youtube-credential' },
      twitch: { clientId: 'twitch-client' },
    }
    expect(() => assertCompleteProviderBundle({ ...base, accessToken: 'must-not-package' }))
      .toThrow('forbidden API key, token, or Twitch client secret')
    expect(() => assertCompleteProviderBundle({ ...base, twitch: { ...base.twitch, clientSecret: 'must-not-package' } }))
      .toThrow('forbidden API key, token, or Twitch client secret')
  })

  it('accepts only a complete YouTube Desktop and Twitch public-client bundle', () => {
    expect(() => assertCompleteProviderBundle({
      version: 3,
      youtube: { clientId: 'youtube-client', clientType: 'desktop', clientSecret: 'youtube-credential' },
      twitch: { clientId: 'twitch-client' },
    })).not.toThrow()
  })

  it('validates the project directory supplied by a real beforePack context', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'osm-electron-builder-hook-'))
    directories.push(directory)
    await mkdir(path.join(directory, 'build'))
    await writeFile(path.join(directory, 'build', 'provider-oauth.json'), JSON.stringify({
      version: 3,
      youtube: { clientId: 'youtube-client', clientType: 'desktop', clientSecret: 'youtube-credential' },
      twitch: { clientId: 'twitch-client' },
    }))

    await expect(hook({ packager: { projectDir: directory } })).resolves.toBeUndefined()
  })
})
