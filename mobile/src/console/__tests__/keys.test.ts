import { KEYS, charBytes } from '../keys'
test('control keys', () => {
  expect(Array.from(KEYS.esc)).toEqual([0x1b])
  expect(Array.from(KEYS.ctrlC)).toEqual([0x03])
  expect(Array.from(KEYS.up)).toEqual([0x1b, 0x5b, 0x41])
  expect(Array.from(KEYS.tab)).toEqual([0x09])
})
test('charBytes utf-8', () => {
  expect(Array.from(charBytes('a'))).toEqual([0x61])
  expect(Array.from(charBytes('\r'))).toEqual([0x0d])
})
