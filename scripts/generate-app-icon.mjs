import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

const source = path.resolve('public/favicon.svg')
const output = path.resolve('build/icon.ico')
const verificationOutput = path.resolve('build/icon-32.png')
const sizes = [16, 24, 32, 48, 64, 128, 256]
const sourceSvg = await readFile(source)
const images = await Promise.all(
  sizes.map((size) => sharp(sourceSvg).resize(size, size).png().toBuffer()),
)

// Include the common Windows shell sizes instead of relying on the shell to
// downscale a single 256px frame. PNG-compressed ICO entries are supported by
// every Windows version supported by this application.
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(images.length, 4)
const directorySize = header.length + images.length * 16
let imageOffset = directorySize
const entries = images.map((png, index) => {
  const size = sizes[index]
  const entry = Buffer.alloc(16)
  entry.writeUInt8(size === 256 ? 0 : size, 0)
  entry.writeUInt8(size === 256 ? 0 : size, 1)
  entry.writeUInt8(0, 2)
  entry.writeUInt8(0, 3)
  entry.writeUInt16LE(1, 4)
  entry.writeUInt16LE(32, 6)
  entry.writeUInt32LE(png.length, 8)
  entry.writeUInt32LE(imageOffset, 12)
  imageOffset += png.length
  return entry
})

await mkdir(path.dirname(output), { recursive: true })
await writeFile(output, Buffer.concat([header, ...entries, ...images]))
await writeFile(verificationOutput, images[sizes.indexOf(32)])
console.log(`Generated ${output}`)
