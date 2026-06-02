import { saveToken, loadToken, clearToken, saveBaseURL, loadBaseURL } from '../secure'

test('token round-trips and clears', async () => {
  expect(await loadToken()).toBeNull()
  await saveToken('tok-123')
  expect(await loadToken()).toBe('tok-123')
  await clearToken()
  expect(await loadToken()).toBeNull()
})

test('baseURL round-trips', async () => {
  await saveBaseURL('https://shep.example')
  expect(await loadBaseURL()).toBe('https://shep.example')
})
