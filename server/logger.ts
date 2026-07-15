import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { isSensitiveField, redactSensitiveText } from '../shared/redaction.js'

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, isSensitiveField(key) ? '[REDACTED]' : redact(item)]))
  }
  if (typeof value === 'string') return redactSensitiveText(value)
  return value
}

export class AppLogger {
  constructor(private readonly dataDir: string) {}

  async write(event: string, details: Record<string, unknown> = {}): Promise<void> {
    const logsDir = path.join(this.dataDir, 'logs')
    await mkdir(logsDir, { recursive: true })
    const day = new Date().toISOString().slice(0, 10)
    const line = JSON.stringify({ at: new Date().toISOString(), event, details: redact(details) }) + '\n'
    await appendFile(path.join(logsDir, `${day}.jsonl`), line, 'utf8')
  }
}

