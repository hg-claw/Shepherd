import { describe, expect, it } from 'vitest'
import { flagEmoji } from './country'

describe('flagEmoji', () => {
  it('converts known codes', () => {
    expect(flagEmoji('US')).toBe('🇺🇸')
    expect(flagEmoji('hk')).toBe('🇭🇰')
    expect(flagEmoji('JP')).toBe('🇯🇵')
  })
  it('rejects invalid input', () => {
    expect(flagEmoji('')).toBe('')
    expect(flagEmoji(null)).toBe('')
    expect(flagEmoji('USA')).toBe('')
    expect(flagEmoji('1A')).toBe('')
  })
})
