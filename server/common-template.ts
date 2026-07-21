import crypto from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { renderCommonTemplateText, type CommonTemplateConfig, type CommonTemplateSettings } from '../shared/common-template.js'
import type { AppConfig, GameProfile } from '../shared/contracts.js'
import type { DataStore } from './storage.js'

export type CommonTemplateRender = {
  profileId: string
  sourceName: string
  filename: string
  text: string
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function textPosition(config: CommonTemplateConfig, width: number, height: number): { x: number; y: number; anchor: string; baseline: string } {
  const anchor = config.horizontalAlign === 'left' ? 'start' : config.horizontalAlign === 'right' ? 'end' : 'middle'
  const baseline = config.verticalAlign === 'top' ? 'hanging' : config.verticalAlign === 'bottom' ? 'auto' : 'middle'
  return {
    x: Math.round(width * config.positionX / 100),
    y: Math.round(height * config.positionY / 100),
    anchor,
    baseline,
  }
}

export class CommonTemplateService {
  private operationQueue: Promise<void> = Promise.resolve()

  constructor(private readonly store: DataStore) {}

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationQueue.then(operation, operation)
    this.operationQueue = run.then(() => undefined, () => undefined)
    return run
  }

  withExclusiveAccess<T>(operation: () => Promise<T>): Promise<T> {
    return this.exclusive(operation)
  }

  private async renderWith(
    template: CommonTemplateConfig,
    backgroundBytes: Buffer,
    width: number,
    height: number,
    profile: GameProfile,
    now?: Date,
  ): Promise<CommonTemplateRender> {
    const text = renderCommonTemplateText(template, profile, now)
    const position = textPosition(template, width, height)
    const svg = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <text x="${position.x}" y="${position.y}" text-anchor="${position.anchor}" dominant-baseline="${position.baseline}"
        fill="${template.textColor}" stroke="${template.outlineColor}" stroke-width="${template.outlineWidth}"
        paint-order="stroke fill" stroke-linejoin="round" font-family="${escapeXml(template.fontFamily)}"
        font-size="${template.fontSize}" font-weight="700">${escapeXml(text)}</text>
    </svg>`)
    const bytes = await sharp(backgroundBytes).composite([{ input: svg, blend: 'over' }]).png().toBuffer()
    const directory = path.join(this.store.dataDir, 'templates', 'common', 'rendered')
    await mkdir(directory, { recursive: true })
    const filename = path.join(directory, `${profile.id}.png`)
    const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      await writeFile(temporary, bytes)
      await rename(temporary, filename)
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
    return { profileId: profile.id, sourceName: template.obsSourceName, filename, text }
  }

  private async renderProfileUnlocked(profile: GameProfile, now?: Date): Promise<CommonTemplateRender | null> {
    const config = await this.store.getConfig()
    const template = config.commonTemplate
    if (!template.enabled) return null
    const background = this.store.getCommonTemplateImagePath(config)
    const backgroundBytes = background
      ? await readFile(background)
      : await sharp({ create: { width: 1920, height: 1080, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer()
    const metadata = await sharp(backgroundBytes).metadata()
    return this.renderWith(template, backgroundBytes, metadata.width ?? 1920, metadata.height ?? 1080, profile, now)
  }

  private async renderAllUnlocked(now?: Date): Promise<CommonTemplateRender[]> {
    const config = await this.store.getConfig()
    const template = config.commonTemplate
    if (!template.enabled) return []
    const background = this.store.getCommonTemplateImagePath(config)
    const backgroundBytes = background
      ? await readFile(background)
      : await sharp({ create: { width: 1920, height: 1080, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer()
    const metadata = await sharp(backgroundBytes).metadata()
    const width = metadata.width ?? 1920
    const height = metadata.height ?? 1080
    const profiles = await this.store.listProfiles()
    const rendered: CommonTemplateRender[] = []
    const failedProfiles: GameProfile[] = []
    for (let index = 0; index < profiles.length; index += 4) {
      const batch = profiles.slice(index, index + 4)
      const settled = await Promise.allSettled(batch.map((profile) => this.renderWith(template, backgroundBytes, width, height, profile, now)))
      settled.forEach((result, resultIndex) => {
        const profile = batch[resultIndex]
        if (result.status === 'fulfilled') rendered.push(result.value)
        else if (profile) failedProfiles.push(profile)
      })
    }
    if (failedProfiles.length > 0) {
      const visibleNames = failedProfiles.slice(0, 10).map((profile) => profile.displayName)
      const remaining = failedProfiles.length - visibleNames.length
      throw Object.assign(new Error(`共通テンプレートを反映できなかったゲーム: ${visibleNames.join('、')}${remaining > 0 ? `、ほか${remaining}件` : ''}`), { statusCode: 500 })
    }
    return rendered
  }

  private async readBackgroundUnlocked(): Promise<{ bytes: Buffer; mime: string } | null> {
    const config = await this.store.getConfig()
    const filename = this.store.getCommonTemplateImagePath(config)
    if (!filename) return null
    const extension = path.extname(filename).toLowerCase()
    const mime = extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg'
    return { bytes: await readFile(filename), mime }
  }

  renderProfile(profile: GameProfile, now?: Date): Promise<CommonTemplateRender | null> {
    return this.exclusive(() => this.renderProfileUnlocked(profile, now))
  }

  renderAll(now?: Date): Promise<CommonTemplateRender[]> {
    return this.exclusive(() => this.renderAllUnlocked(now))
  }

  readBackground(): Promise<{ bytes: Buffer; mime: string } | null> {
    return this.exclusive(() => this.readBackgroundUnlocked())
  }

  saveSettings(settings: CommonTemplateSettings, beforeSave?: (previousConfig: AppConfig, nextConfig: AppConfig) => Promise<void>): Promise<{ previousConfig: AppConfig; savedConfig: AppConfig }> {
    return this.exclusive(async () => {
      const previousConfig = await this.store.getConfig()
      const nextConfig: AppConfig = {
        ...previousConfig,
        commonTemplate: {
          ...settings,
          imageFilename: previousConfig.commonTemplate.imageFilename,
          imageOriginalName: previousConfig.commonTemplate.imageOriginalName,
          imageUpdatedAt: previousConfig.commonTemplate.imageUpdatedAt,
        },
      }
      if (beforeSave) await beforeSave(previousConfig, nextConfig)
      const savedConfig = await this.store.saveConfig(nextConfig)
      return { previousConfig, savedConfig }
    })
  }

  saveBackground(bytes: Uint8Array, mime: string, originalName?: string): Promise<CommonTemplateConfig> {
    return this.exclusive(async () => {
      const template = await this.store.saveCommonTemplateImage(bytes, mime, originalName)
      return template
    })
  }

  removeBackground(beforeRemove?: (previousConfig: AppConfig) => Promise<void>): Promise<{ previousConfig: AppConfig; template: CommonTemplateConfig }> {
    return this.exclusive(async () => {
      const previousConfig = await this.store.getConfig()
      if (beforeRemove) await beforeRemove(previousConfig)
      const template = await this.store.removeCommonTemplateImage()
      return { previousConfig, template }
    })
  }
}
