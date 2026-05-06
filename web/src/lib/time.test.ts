import { describe, expect, it } from 'vitest'
import { formatHHMM, relativeTime } from './time'

const fixedNow = new Date('2026-05-06T12:00:00Z')

describe('relativeTime', () => {
  it('null/invalid returns null', () => {
    expect(relativeTime(null, fixedNow)).toBeNull()
    expect(relativeTime('not-a-date', fixedNow)).toBeNull()
  })
  it('within 5 seconds → just_now', () => {
    expect(relativeTime(new Date(fixedNow.getTime() - 1000), fixedNow)).toEqual({
      key: 'common.just_now',
      n: 0,
    })
  })
  it('seconds bucket', () => {
    expect(relativeTime(new Date(fixedNow.getTime() - 30_000), fixedNow)).toEqual({
      key: 'common.second_ago',
      n: 30,
    })
  })
  it('minutes bucket', () => {
    expect(relativeTime(new Date(fixedNow.getTime() - 5 * 60_000), fixedNow)).toEqual({
      key: 'common.minute_ago',
      n: 5,
    })
  })
  it('hours bucket', () => {
    expect(relativeTime(new Date(fixedNow.getTime() - 3 * 3600_000), fixedNow)).toEqual({
      key: 'common.hour_ago',
      n: 3,
    })
  })
  it('days bucket', () => {
    expect(relativeTime(new Date(fixedNow.getTime() - 2 * 86400_000), fixedNow)).toEqual({
      key: 'common.day_ago',
      n: 2,
    })
  })
})

describe('formatHHMM', () => {
  it('zero-pads', () => {
    expect(formatHHMM(new Date(2026, 4, 6, 7, 5))).toBe('07:05')
  })
})
