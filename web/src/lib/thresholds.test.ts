import { describe, expect, it } from 'vitest'
import { levelForNetBps, levelForPct } from './thresholds'

describe('levelForPct', () => {
  it('cpu boundaries', () => {
    expect(levelForPct('cpu', 0)).toBe('low')
    expect(levelForPct('cpu', 39.99)).toBe('low')
    expect(levelForPct('cpu', 40)).toBe('mid')
    expect(levelForPct('cpu', 69.99)).toBe('mid')
    expect(levelForPct('cpu', 70)).toBe('high')
    expect(levelForPct('cpu', 89.99)).toBe('high')
    expect(levelForPct('cpu', 90)).toBe('alert')
    expect(levelForPct('cpu', 100)).toBe('alert')
  })
  it('mem and disk pull from their own tables', () => {
    expect(levelForPct('mem', 49.99)).toBe('low')
    expect(levelForPct('mem', 50)).toBe('mid')
    expect(levelForPct('disk', 59.99)).toBe('low')
    expect(levelForPct('disk', 60)).toBe('mid')
  })
  it('null → low', () => {
    expect(levelForPct('cpu', null)).toBe('low')
  })
})

describe('levelForNetBps', () => {
  const MB = 1024 * 1024
  it('uses max of rx/tx', () => {
    expect(levelForNetBps(0, 5 * MB)).toBe('low')
    expect(levelForNetBps(11 * MB, 0)).toBe('mid')
    expect(levelForNetBps(0, 51 * MB)).toBe('high')
    expect(levelForNetBps(201 * MB, 0)).toBe('alert')
  })
})
