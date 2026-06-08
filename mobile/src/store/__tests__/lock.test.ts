import { useLock } from '../lock'

beforeEach(() => { useLock.setState({ enabled: false, locked: false, lastBackground: null }) })

test('setEnabled persists and locks; unlock clears', async () => {
  await useLock.getState().setEnabled(true)
  expect(useLock.getState().enabled).toBe(true)
  expect(useLock.getState().locked).toBe(true)
  useLock.getState().unlock()
  expect(useLock.getState().locked).toBe(false)
  await useLock.getState().setEnabled(false)
  expect(useLock.getState().enabled).toBe(false)
  expect(useLock.getState().locked).toBe(false)
})

test('hydrate loads persisted flag', async () => {
  await useLock.getState().setEnabled(true)
  useLock.setState({ enabled: false, locked: false })
  await useLock.getState().hydrate()
  expect(useLock.getState().enabled).toBe(true)
  expect(useLock.getState().locked).toBe(true)
})

test('maybeLockOnForeground locks only after >30s background', () => {
  useLock.setState({ enabled: true, locked: false, lastBackground: 1_000 })
  useLock.getState().maybeLockOnForeground(1_000 + 30_000)
  expect(useLock.getState().locked).toBe(false)
  useLock.getState().maybeLockOnForeground(1_000 + 30_001)
  expect(useLock.getState().locked).toBe(true)
})

test('maybeLockOnForeground is a no-op when disabled', () => {
  useLock.setState({ enabled: false, locked: false, lastBackground: 0 })
  useLock.getState().maybeLockOnForeground(999_999)
  expect(useLock.getState().locked).toBe(false)
})
