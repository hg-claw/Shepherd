import { memPct, firstDiskPct, isOnline } from '../metrics'

test('memPct', () => {
  expect(memPct({ ts: '', mem_used: 50, mem_total: 100 })).toBe(50)
  expect(memPct({ ts: '', mem_used: 50 })).toBeNull()
  expect(memPct(null)).toBeNull()
})

test('firstDiskPct parses defensively', () => {
  expect(firstDiskPct(JSON.stringify([{ used: 30, total: 60 }]))).toBe(50)
  expect(firstDiskPct('not json')).toBeNull()
  expect(firstDiskPct(undefined)).toBeNull()
  expect(firstDiskPct('[]')).toBeNull()
})

test('isOnline', () => {
  expect(isOnline({ id: 1, name: 'a', connected: true, latest: null })).toBe(true)
  const recent = new Date().toISOString()
  expect(isOnline({ id: 1, name: 'a', connected: false, latest: null, agent_last_seen: { Valid: true, Time: recent } })).toBe(true)
  const stale = new Date(Date.now() - 5 * 60_000).toISOString()
  expect(isOnline({ id: 1, name: 'a', connected: false, latest: null, agent_last_seen: { Valid: true, Time: stale } })).toBe(false)
})
