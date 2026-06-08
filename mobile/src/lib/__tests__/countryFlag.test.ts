import { countryFlag } from '../format'
test('ISO-2 → flag emoji, else empty', () => {
  expect(countryFlag('US')).toBe('\u{1F1FA}\u{1F1F8}')
  expect(countryFlag('us')).toBe('\u{1F1FA}\u{1F1F8}')
  expect(countryFlag('')).toBe('')
  expect(countryFlag(null)).toBe('')
  expect(countryFlag('X')).toBe('')
})
