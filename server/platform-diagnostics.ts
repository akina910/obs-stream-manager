import crypto from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { PlatformRuntimeStatus } from '../shared/contracts.js'

export type PlatformViewerDiagnostics = {
  statusSamples: number
  liveSamples: number
  availableSamples: number
  hiddenSamples: number
  unavailableSamples: number
  lastCount: number | null
  peakCount: number | null
  lastState: PlatformRuntimeStatus['state'] | null
  lastDetail: string | null
  lastCheckedAt: string | null
}

export type PlatformCommentDiagnostics = {
  received: number
  pollAttempts: number
  successfulPolls: number
  failures: number
  reconnects: number
  connected: boolean
  lastReceivedAt: string | null
  lastSuccessAt: string | null
  lastFailureAt: string | null
  lastErrorCategory: string | null
}

export type PlatformSessionDiagnostics = {
  sessionId: string
  active: boolean
  interrupted: boolean
  startedAt: string | null
  endedAt: string | null
  viewers: Record<'youtube' | 'twitch', PlatformViewerDiagnostics>
  comments: Record<'youtube' | 'twitch', PlatformCommentDiagnostics>
}

export type PlatformDiagnosticsArchive = {
  version: 1
  current: PlatformSessionDiagnostics
  history: PlatformSessionDiagnostics[]
}

const nullableTimestampSchema = z.string().datetime().nullable()
const nonNegativeIntegerSchema = z.number().int().nonnegative()
const platformStateSchema = z.enum(['disabled', 'unprepared', 'ready', 'starting', 'live', 'stopping', 'offline', 'error'])

const viewerDiagnosticsSchema = z.object({
  statusSamples: nonNegativeIntegerSchema,
  liveSamples: nonNegativeIntegerSchema,
  availableSamples: nonNegativeIntegerSchema,
  hiddenSamples: nonNegativeIntegerSchema,
  unavailableSamples: nonNegativeIntegerSchema,
  lastCount: nonNegativeIntegerSchema.nullable(),
  peakCount: nonNegativeIntegerSchema.nullable(),
  lastState: platformStateSchema.nullable(),
  lastDetail: z.string().max(2_000).nullable(),
  lastCheckedAt: nullableTimestampSchema,
}).strict()

const commentDiagnosticsSchema = z.object({
  received: nonNegativeIntegerSchema,
  pollAttempts: nonNegativeIntegerSchema,
  successfulPolls: nonNegativeIntegerSchema,
  failures: nonNegativeIntegerSchema,
  reconnects: nonNegativeIntegerSchema,
  connected: z.boolean(),
  lastReceivedAt: nullableTimestampSchema,
  lastSuccessAt: nullableTimestampSchema,
  lastFailureAt: nullableTimestampSchema,
  lastErrorCategory: z.string().max(100).nullable(),
}).strict()

export const PlatformSessionDiagnosticsSchema = z.object({
  sessionId: z.string().uuid(),
  active: z.boolean(),
  interrupted: z.boolean(),
  startedAt: nullableTimestampSchema,
  endedAt: nullableTimestampSchema,
  viewers: z.object({
    youtube: viewerDiagnosticsSchema,
    twitch: viewerDiagnosticsSchema,
  }).strict(),
  comments: z.object({
    youtube: commentDiagnosticsSchema,
    twitch: commentDiagnosticsSchema,
  }).strict(),
}).strict()

export const PlatformDiagnosticsArchiveSchema = z.object({
  version: z.literal(1),
  current: PlatformSessionDiagnosticsSchema,
  history: z.array(PlatformSessionDiagnosticsSchema).max(19),
}).strict()

function createViewerDiagnostics(): PlatformViewerDiagnostics {
  return {
    statusSamples: 0,
    liveSamples: 0,
    availableSamples: 0,
    hiddenSamples: 0,
    unavailableSamples: 0,
    lastCount: null,
    peakCount: null,
    lastState: null,
    lastDetail: null,
    lastCheckedAt: null,
  }
}

function createCommentDiagnostics(): PlatformCommentDiagnostics {
  return {
    received: 0,
    pollAttempts: 0,
    successfulPolls: 0,
    failures: 0,
    reconnects: 0,
    connected: false,
    lastReceivedAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastErrorCategory: null,
  }
}

export function createPlatformSessionDiagnostics(): PlatformSessionDiagnostics {
  return {
    sessionId: crypto.randomUUID(),
    active: false,
    interrupted: false,
    startedAt: null,
    endedAt: null,
    viewers: { youtube: createViewerDiagnostics(), twitch: createViewerDiagnostics() },
    comments: { youtube: createCommentDiagnostics(), twitch: createCommentDiagnostics() },
  }
}

async function atomicWrite(filename: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true })
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`
  await writeFile(temporary, contents, 'utf8')
  await rename(temporary, filename)
}

export class PlatformDiagnosticsStore {
  private readonly filename: string

  constructor(dataDir: string) {
    this.filename = path.join(dataDir, 'database', 'platform-diagnostics.json')
  }

  async load(): Promise<PlatformDiagnosticsArchive | null> {
    try {
      const raw = JSON.parse(await readFile(this.filename, 'utf8')) as unknown
      return PlatformDiagnosticsArchiveSchema.parse(raw)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      return null
    }
  }

  async save(value: PlatformDiagnosticsArchive): Promise<void> {
    const parsed = PlatformDiagnosticsArchiveSchema.parse(value)
    await atomicWrite(this.filename, JSON.stringify(parsed, null, 2))
  }
}
