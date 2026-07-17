export type ReleaseChecksumEntry = { name: string; sha256: string }
export function generateReleaseChecksums(directory: string, outputName?: string, version?: string): Promise<ReleaseChecksumEntry[]>
