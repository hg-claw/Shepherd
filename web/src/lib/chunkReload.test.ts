import { describe, it, expect } from 'vitest'
import { isChunkError } from './chunkReload'

describe('isChunkError', () => {
  it('matches the browser dynamic-import failure messages', () => {
    expect(isChunkError('Failed to fetch dynamically imported module: /assets/AuditLogPage-DPwA4puQ.js')).toBe(true)
    expect(isChunkError('error loading dynamically imported module')).toBe(true)
    expect(isChunkError('Importing a module script failed.')).toBe(true)
  })

  it('ignores unrelated errors', () => {
    expect(isChunkError('TypeError: x is not a function')).toBe(false)
    expect(isChunkError('NetworkError when attempting to fetch resource')).toBe(false)
    expect(isChunkError('')).toBe(false)
  })
})
