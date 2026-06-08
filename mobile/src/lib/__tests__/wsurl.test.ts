import { wsURL } from '../wsurl'
test('http→ws, https→wss, path appended', () => {
  expect(wsURL('https://h.example', '/api/public/net-live/ws')).toBe('wss://h.example/api/public/net-live/ws')
  expect(wsURL('http://localhost:8080', '/x')).toBe('ws://localhost:8080/x')
})
