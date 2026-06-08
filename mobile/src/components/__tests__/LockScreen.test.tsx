import React from 'react'
import { render, fireEvent, waitFor } from '@testing-library/react-native'
import { LockScreen } from '../LockScreen'
const mockUnlock = jest.fn()
const mockLogout = jest.fn()
jest.mock('@/store/lock', () => ({ useLock: (sel: (s: { unlock: () => void }) => unknown) => sel({ unlock: mockUnlock }) }))
jest.mock('@/store/auth', () => ({ useAuth: (sel: (s: { logout: () => void }) => unknown) => sel({ logout: mockLogout }) }))
const mockAuth = jest.fn()
jest.mock('@/lib/biometrics', () => ({ authenticate: () => mockAuth() }))

beforeEach(() => { mockUnlock.mockClear(); mockLogout.mockClear() })

test('successful auth on mount unlocks', async () => {
  mockAuth.mockResolvedValueOnce(true)
  render(<LockScreen />)
  await waitFor(() => expect(mockUnlock).toHaveBeenCalled())
})
test('failed auth shows Sign out, which logs out', async () => {
  mockAuth.mockResolvedValue(false)
  const { getByText } = render(<LockScreen />)
  await waitFor(() => expect(getByText('Sign out')).toBeTruthy())
  fireEvent.press(getByText('Sign out'))
  expect(mockLogout).toHaveBeenCalled()
})
