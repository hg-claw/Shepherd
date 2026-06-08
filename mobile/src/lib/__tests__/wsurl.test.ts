import { wsURL } from '../wsurl'
test('http→ws, https→wss, path appended', () => {
  expect(wsURL('https://h.example', '/api/public/net-live/ws')).toBe('wss://h.example/api/public/net-live/ws')
  expect(wsURL('http://localhost:8080', '/x')).toBe('ws://localhost:8080/x')
})
test('normalizes trailing slash and uppercase scheme', () => {
  expect(wsURL('https://h.example/', '/x')).toBe('wss://h.example/x')
  expect(wsURL('HTTPS://h.example', '/x')).toBe('wss://h.example/x')
  expect(wsURL('http://h.example///', '/x')).toBe('ws://h.example/x')
})
