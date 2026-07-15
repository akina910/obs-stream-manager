import { describe, expect, it } from 'vitest'
import { isUnsafeCrossOriginRequest } from './request-security.js'

const allowed = new Set(['http://127.0.0.1:4317', 'http://localhost:4317', 'http://127.0.0.1:4318'])

describe('local API request security', () => {
  it('blocks state-changing requests from unrelated web pages', () => {
    expect(isUnsafeCrossOriginRequest('POST', '/api/stream/stop', 'https://evil.example', 'cross-site', allowed)).toBe(true)
    expect(isUnsafeCrossOriginRequest('PUT', '/api/config', 'https://evil.example', undefined, allowed)).toBe(true)
    expect(isUnsafeCrossOriginRequest('POST', '/api/backup/import', 'null', undefined, allowed)).toBe(true)
  })

  it('allows same-origin UI requests and origin-less native verification', () => {
    expect(isUnsafeCrossOriginRequest('POST', '/api/stream/start', 'http://127.0.0.1:4317', 'same-origin', allowed)).toBe(false)
    expect(isUnsafeCrossOriginRequest('POST', '/api/backup/export', undefined, undefined, allowed)).toBe(false)
  })

  it('does not block read-only API or non-API requests', () => {
    expect(isUnsafeCrossOriginRequest('GET', '/api/status', 'https://evil.example', 'cross-site', allowed)).toBe(false)
    expect(isUnsafeCrossOriginRequest('POST', '/', 'https://evil.example', 'cross-site', allowed)).toBe(false)
  })
})
