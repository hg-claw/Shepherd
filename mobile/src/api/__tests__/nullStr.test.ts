import { nullStr } from '../metrics'

test('nullStr extracts from a Go sql.NullString, a plain string, or null', () => {
  expect(nullStr({ String: 'asia', Valid: true })).toBe('asia')
  expect(nullStr({ String: 'x', Valid: false })).toBe('')
  expect(nullStr('plain')).toBe('plain')
  expect(nullStr(null)).toBe('')
  expect(nullStr(undefined)).toBe('')
})
