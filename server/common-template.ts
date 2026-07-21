import crypto from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { renderCommonTemplateText, type CommonTemplateConfig } from '../shared/common-template.js'
import type { GameProfile } from '../shared/contracts.js'
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
  constructor(private readonly store: DataStore) {}

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
    await writeFile(temporary, bytes)
    await rename(temporary, filename)
    return { profileId: profile.id, sourceName: template.obsSourceName, filename, text }
  }

  async renderProfile(profile: GameProfile, now?: Date): Promise<CommonTemplateRender | null> {
    const config = await this.store.getConfig()
    const template = config.commonTemplate
    if (!template.enabled) return null
    const background = this.store.getCommonTemplateImagePath(config)
    if (!background) throw new Error('共通テンプレート画像が登録されていません')
    const backgroundBytes = await readFile(background)
    const metadata = await sharp(backgroundBytes).metadata()
    return this.renderWith(template, backgroundBytes, metadata.width ?? 1920, metadata.height ?? 1080, profile, now)
  }

  async renderAll(now?: Date): Promise<CommonTemplateRender[]> {
    const config = await this.store.getConfig()
    const template = config.commonTemplate
    if (!template.enabled) return []
    const background = this.store.getCommonTemplateImagePath(config)
    if (!background) throw new Error('共通テンプレート画像が登録されていません')
    const backgroundBytes = await readFile(background)
    const metadata = await sharp(backgroundBytes).metadata()
    const width = metadata.width ?? 1920
    const height = metadata.height ?? 1080
    const profiles = await this.store.listProfiles()
    const rendered: CommonTemplateRender[] = []
    for (let index = 0; index < profiles.length; index += 4) {
      rendered.push(...await Promise.all(profiles.slice(index, index + 4).map((profile) => this.renderWith(template, backgroundBytes, width, height, profile, now))))
    }
    return rendered
  }

  async readBackground(): Promise<{ bytes: Buffer; mime: string } | null> {
    const config = await this.store.getConfig()
    const filename = this.store.getCommonTemplateImagePath(config)
    if (!filename) return null
    const extension = path.extname(filename).toLowerCase()
    const mime = extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg'
    return { bytes: await readFile(filename), mime }
  }
}
