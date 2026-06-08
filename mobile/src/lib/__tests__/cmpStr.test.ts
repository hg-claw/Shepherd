import { cmpStr } from '../format'

test('cmpStr orders strings without localeCompare', () => {
  expect(cmpStr('a', 'b')).toBe(-1)
  expect(cmpStr('b', 'a')).toBe(1)
  expect(cmpStr('a', 'a')).toBe(0)
  expect(['c', 'a', 'b'].slice().sort(cmpStr)).toEqual(['a', 'b', 'c'])
})
