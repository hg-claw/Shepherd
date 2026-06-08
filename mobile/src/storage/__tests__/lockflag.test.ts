import { saveLockEnabled, loadLockEnabled } from '../secure'

test('lock flag round-trips, defaults false', async () => {
  expect(await loadLockEnabled()).toBe(false)
  await saveLockEnabled(true)
  expect(await loadLockEnabled()).toBe(true)
  await saveLockEnabled(false)
  expect(await loadLockEnabled()).toBe(false)
})
