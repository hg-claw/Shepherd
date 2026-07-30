import { describe, it, expect } from 'vitest'
import { singboxMinorAtLeast } from './version'

describe('singboxMinorAtLeast', () => {
  it.each([
    ['1.14.0', true], ['v1.14.0', true],
    ['1.14.0-beta.2', true], ['v1.14.0-beta.2', true],
    ['1.15.3', true], ['2.0.0', true],
    ['1.13.14', false], ['1.13.12', false], ['1.9.0', false],
    ['', false], ['garbage', false],
  ])('%s -> %s', (input, want) => {
    expect(singboxMinorAtLeast(input, 1, 14)).toBe(want)
  })

  it('fails closed on null/undefined', () => {
    expect(singboxMinorAtLeast(null, 1, 14)).toBe(false)
    expect(singboxMinorAtLeast(undefined, 1, 14)).toBe(false)
  })
})
