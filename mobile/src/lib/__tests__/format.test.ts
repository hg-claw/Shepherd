import { bps, pct, relTime } from '../format'

test('bps', () => {
  expect(bps(0)).toBe('0 B/s')
  expect(bps(1500)).toMatch(/KB\/s$/)
  expect(bps(5_000_000)).toMatch(/MB\/s$/)
})
test('pct', () => {
  expect(pct(42.6)).toBe('43%')
  expect(pct(null)).toBe('—')
})
test('relTime recent', () => {
  expect(relTime(new Date(Date.now() - 90_000).toISOString())).toMatch(/m ago$/)
})
