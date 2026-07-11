import { describe, expect, it } from 'vitest'
import { redact } from './logger.js'

describe('redact', () => {
  it('redacts secrets recursively without altering normal diagnostics', () => {
    expect(redact({ token: 'abc', nested: { apiKey: 'def', status: 'failed' }, rows: [{ password: 'ghi' }] })).toEqual({
      token: '[REDACTED]', nested: { apiKey: '[REDACTED]', status: 'failed' }, rows: [{ password: '[REDACTED]' }],
    })
  })
})
