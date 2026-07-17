import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const releaseExtensions = new Set(['.exe', '.zip', '.blockmap'])

function isReleaseArtifact(name, version) {
  if (name === 'latest.yml') return true
  if (!releaseExtensions.has(path.extname(name).toLowerCase())) return false
  if (!version) return true
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|-)${escapedVersion}(?:-|\\.)`).test(name)
}

function sha256File(filename) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filename)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

export async function generateReleaseChecksums(directory, outputName = 'SHA256SUMS.txt', version) {
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name !== outputName && isReleaseArtifact(entry.name, version))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, 'en'))
  if (files.length === 0) throw new Error(`No release artifacts found in ${directory}`)

  const entries = []
  for (const name of files) {
    entries.push({ name, sha256: await sha256File(path.join(directory, name)) })
  }
  const output = `${entries.map(({ name, sha256 }) => `${sha256}  ${name}`).join('\n')}\n`
  await writeFile(path.join(directory, outputName), output, 'utf8')
  return entries
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const directory = path.resolve(process.argv[2] || 'release')
  const packageJson = JSON.parse(await readFile(path.resolve('package.json'), 'utf8'))
  const version = process.env.npm_package_version || packageJson.version
  const entries = await generateReleaseChecksums(directory, 'SHA256SUMS.txt', version)
  process.stdout.write(`Wrote ${entries.length} checksums to ${path.join(directory, 'SHA256SUMS.txt')}\n`)
}
