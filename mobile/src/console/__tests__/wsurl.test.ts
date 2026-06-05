import { consoleWSURL } from '../wsurl'
test('https→wss + sid encoded', () => {
  expect(consoleWSURL('https://h.example', 'a b')).toBe('wss://h.example/api/admin/console/ws?sid=a%20b')
})
test('http→ws', () => {
  expect(consoleWSURL('http://h:8080', 'x')).toBe('ws://h:8080/api/admin/console/ws?sid=x')
})
