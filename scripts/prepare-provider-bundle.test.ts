import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('./prepare-provider-bundle.mjs', import.meta.url))
const directories: string[] = []

function releaseEnvironment(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OBS_STREAM_MANAGER_PROVIDER_OAUTH_FILE: '',
    OBS_STREAM_MANAGER_YOUTUBE_CLIENT_ID: '',
    OBS_STREAM_MANAGER_YOUTUBE_CLIENT_TYPE: '',
    OBS_STREAM_MANAGER_YOUTUBE_CLIENT_SECRET: '',
    OBS_STREAM_MANAGER_TWITCH_CLIENT_ID: '',
    ...overrides,
  }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('OAuth provider distribution bundle', () => {
  it('refuses to create a distribution package without both providers', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'osm-provider-bundle-missing-'))
    directories.push(directory)
    const result = spawnSync(process.execPath, [script, '--require-all'], {
      cwd: directory,
      encoding: 'utf8',
      env: releaseEnvironment(),
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Distribution build requires YouTube Desktop app credentials and Twitch public client ID')
  })

  it('creates a complete distribution bundle when both provider credentials are supplied', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'osm-provider-bundle-complete-'))
    directories.push(directory)
    const result = spawnSync(process.execPath, [script, '--require-all'], {
      cwd: directory,
      encoding: 'utf8',
      env: releaseEnvironment({
        OBS_STREAM_MANAGER_YOUTUBE_CLIENT_ID: 'youtube-client',
        OBS_STREAM_MANAGER_YOUTUBE_CLIENT_TYPE: 'desktop',
        OBS_STREAM_MANAGER_YOUTUBE_CLIENT_SECRET: 'youtube-credential',
        OBS_STREAM_MANAGER_TWITCH_CLIENT_ID: 'twitch-client',
      }),
    })

    expect(result.status).toBe(0)
    await expect(readFile(path.join(directory, 'build', 'provider-oauth.json'), 'utf8'))
      .resolves.toContain('"clientType": "desktop"')
  })
})
