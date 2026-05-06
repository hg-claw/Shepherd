import { describe, expect, it } from 'vitest'
import { bps, bytes, pct } from './bytes'

describe('bytes', () => {
  it('handles small bytes', () => {
    expect(bytes(0)).toBe('0 B')
    expect(bytes(512)).toBe('512 B')
    expect(bytes(1023)).toBe('1023 B')
  })
  it('scales to KB/MB/GB', () => {
    expect(bytes(1024)).toBe('1.0 KB')
    expect(bytes(1024 * 1024)).toBe('1.0 MB')
    expect(bytes(5 * 1024 * 1024 * 1024)).toBe('5.0 GB')
  })
  it('returns dash for null', () => {
    expect(bytes(null)).toBe('-')
    expect(bytes(undefined)).toBe('-')
  })
})

describe('bps', () => {
  it('uses B/s units', () => {
    expect(bps(1024)).toBe('1.0 KB/s')
    expect(bps(0)).toBe('0 B/s')
  })
})

describe('pct', () => {
  it('computes percentage', () => {
    expect(pct(50, 100)).toBe(50)
    expect(pct(1, 4)).toBe(25)
  })
  it('returns null for invalid inputs', () => {
    expect(pct(null, 100)).toBeNull()
    expect(pct(50, 0)).toBeNull()
    expect(pct(50, null)).toBeNull()
  })
})
