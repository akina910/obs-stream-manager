import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

const source = path.resolve('public/favicon.svg')
const output = path.resolve('build/icon.ico')
const png = await sharp(await readFile(source)).resize(256, 256).png().toBuffer()

// ICO supports PNG-compressed 256x256 entries on every supported Windows version.
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(1, 4)
const entry = Buffer.alloc(16)
entry.writeUInt8(0, 0) // 0 represents 256 pixels in the ICO directory.
entry.writeUInt8(0, 1)
entry.writeUInt8(0, 2)
entry.writeUInt8(0, 3)
entry.writeUInt16LE(1, 4)
entry.writeUInt16LE(32, 6)
entry.writeUInt32LE(png.length, 8)
entry.writeUInt32LE(header.length + entry.length, 12)

await mkdir(path.dirname(output), { recursive: true })
await writeFile(output, Buffer.concat([header, entry, png]))
console.log(`Generated ${output}`)
