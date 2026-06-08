import * as LA from 'expo-local-authentication'
import { hasHardware, isEnrolled, authenticate } from '../biometrics'

test('wrappers map to the SDK', async () => {
  expect(await hasHardware()).toBe(true)
  expect(await isEnrolled()).toBe(true)
  ;(LA.authenticateAsync as jest.Mock).mockResolvedValueOnce({ success: true })
  expect(await authenticate()).toBe(true)
  ;(LA.authenticateAsync as jest.Mock).mockResolvedValueOnce({ success: false })
  expect(await authenticate()).toBe(false)
})
