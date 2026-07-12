import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GameProfile } from '../shared/contracts.js'
import { PlatformServices, type ThumbnailPreparation } from './platforms.js'
import { SecretStore } from './secrets.js'
import { DataStore } from './storage.js'

const directories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('PlatformServices thumbnail preparation', () => {
  it('retries a failed upload and returns a non-throwing fallback result', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'obs-stream-manager-platforms-'))
    directories.push(directory)
    const store = new DataStore(directory)
    await store.initialize()
    const profile = (await store.listProfiles())[0]
    const bytes = await sharp({ create: { width: 16, height: 9, channels: 3, background: '#123456' } }).png().toBuffer()
    const saved = await store.saveThumbnail(profile, bytes, 'image/png')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('temporary failure', { status: 500 }))
    const platforms = new PlatformServices(new SecretStore(), store)
    const result = await (platforms as unknown as {
      applyYouTubeThumbnail: (accessToken: string, videoId: string, profile: GameProfile) => Promise<ThumbnailPreparation>
    }).applyYouTubeThumbnail('token', 'video', saved)
    expect(result.status).toBe('failed')
    expect(result.message).toContain('前回画像を維持')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
