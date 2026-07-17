import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { generateReleaseChecksums } from './write-release-checksums.mjs'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('release checksum writer', () => {
  it('writes deterministic SHA-256 lines for supported artifacts only', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'obs-stream-manager-checksums-'))
    directories.push(directory)
    await writeFile(path.join(directory, 'z-portable-0.2.4.exe'), 'portable')
    await writeFile(path.join(directory, 'a-installer-0.2.4.exe'), 'installer')
    await writeFile(path.join(directory, 'old-installer-0.2.3.exe'), 'stale')
    await writeFile(path.join(directory, 'future-installer-0.2.40.exe'), 'future')
    await writeFile(path.join(directory, 'foreign-installer-10.2.4.exe'), 'foreign')
    await writeFile(path.join(directory, 'latest.yml'), 'version: 0.2.4')
    await writeFile(path.join(directory, 'builder-debug.yml'), 'debug only')
    await writeFile(path.join(directory, 'notes.txt'), 'not a release artifact')
    await writeFile(path.join(directory, 'SHA256SUMS.txt'), 'stale')

    const entries = await generateReleaseChecksums(directory, 'SHA256SUMS.txt', '0.2.4')
    const output = await readFile(path.join(directory, 'SHA256SUMS.txt'), 'utf8')

    expect(entries.map(({ name }) => name)).toEqual(['a-installer-0.2.4.exe', 'latest.yml', 'z-portable-0.2.4.exe'])
    expect(output.trim().split(/\r?\n/)).toHaveLength(3)
    for (const line of output.trim().split(/\r?\n/)) {
      expect(line).toMatch(/^[a-f0-9]{64} {2}(a-installer-0\.2\.4\.exe|latest\.yml|z-portable-0\.2\.4\.exe)$/)
    }
  })

  it('rejects an empty release directory instead of publishing an empty checksum file', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'obs-stream-manager-checksums-'))
    directories.push(directory)
    await writeFile(path.join(directory, 'README.txt'), 'no artifacts')

    await expect(generateReleaseChecksums(directory)).rejects.toThrow('No release artifacts')
  })
})
