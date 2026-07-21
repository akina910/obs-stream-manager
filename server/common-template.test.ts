import { mkdtemp, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { createGameProfile } from '../shared/profile-factory.js'
import { CommonTemplateService } from './common-template.js'
import { DataStore } from './storage.js'

const directories: string[] = []

async function templateStore(): Promise<DataStore> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'obs-common-template-'))
  directories.push(directory)
  const store = new DataStore(directory)
  await store.initialize()
  return store
}

afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))))

describe('CommonTemplateService', () => {
  it('renders one personalized PNG for every profile from one background', async () => {
    const store = await templateStore()
    const ark = createGameProfile('ark', 'ARK: Survival Ascended')
    ark.presentation.templateLabel = 'ARK'
    const minecraft = createGameProfile('minecraft', 'Minecraft')
    await store.saveProfile(ark)
    await store.saveProfile(minecraft)
    const background = await sharp({ create: { width: 640, height: 360, channels: 4, background: '#112233' } }).png().toBuffer()
    await store.saveCommonTemplateImage(background, 'image/png', 'stream-screen.png')
    const current = await store.getConfig()
    await store.saveConfig({ ...current, commonTemplate: { ...current.commonTemplate, enabled: true, textTemplate: '{game} / Part {part}' } })

    const rendered = await new CommonTemplateService(store).renderAll(new Date(2026, 6, 21))

    expect(rendered.map((item) => item.text).sort()).toEqual(['ARK / Part 1', 'Minecraft / Part 1'])
    for (const item of rendered) {
      await expect(stat(item.filename)).resolves.toMatchObject({ size: expect.any(Number) })
      await expect(sharp(item.filename).metadata()).resolves.toMatchObject({ width: 640, height: 360, format: 'png' })
    }
  })

  it('safely renders profile labels containing XML characters', async () => {
    const store = await templateStore()
    const profile = createGameProfile('special', 'Game')
    profile.presentation.templateLabel = '<ARK & "Friends">'
    await store.saveProfile(profile)
    const background = await sharp({ create: { width: 320, height: 180, channels: 4, background: '#000000' } }).png().toBuffer()
    await store.saveCommonTemplateImage(background, 'image/png')
    const current = await store.getConfig()
    await store.saveConfig({ ...current, commonTemplate: { ...current.commonTemplate, enabled: true } })

    await expect(new CommonTemplateService(store).renderProfile(profile)).resolves.toMatchObject({ text: '<ARK & "Friends">' })
  })
})
