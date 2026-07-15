import { describe, expect, it } from 'vitest'
import { redactSensitiveText } from '../shared/redaction.js'
import { redact } from './logger.js'

describe('redact', () => {
  it('redacts secrets recursively without altering normal diagnostics', () => {
    expect(redact({ token: 'abc', nested: { apiKey: 'def', status: 'failed' }, rows: [{ password: 'ghi', stream_key: 'jkl', device_code: 'mno' }] })).toEqual({
      token: '[REDACTED]', nested: { apiKey: '[REDACTED]', status: 'failed' }, rows: [{ password: '[REDACTED]', stream_key: '[REDACTED]', device_code: '[REDACTED]' }],
    })
  })

  it('redacts credentials embedded inside error strings', () => {
    const error = 'request failed: {"access_token":"abc","refresh_token":"def","client_secret":"ghi","stream_key":"jkl"} authorization=Bearer mno code=pqr status=400'
    const result = redactSensitiveText(error)
    expect(result).not.toContain('abc')
    expect(result).not.toContain('def')
    expect(result).not.toContain('ghi')
    expect(result).not.toContain('jkl')
    expect(result).not.toContain('mno')
    expect(result).not.toContain('pqr')
    expect(result).toContain('status=400')
    expect(result.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(6)
  })
})
