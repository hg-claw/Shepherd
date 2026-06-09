import React from 'react'
import { render, fireEvent, waitFor } from '@testing-library/react-native'
import Settings from '../settings'
jest.mock('expo-router', () => ({ Stack: Object.assign(() => null, { Screen: () => null }) }))
const mockSetEnabled = jest.fn().mockResolvedValue(undefined)
jest.mock('@/store/lock', () => ({ useLock: () => ({ enabled: false, setEnabled: mockSetEnabled }) }))
jest.mock('@/store/auth', () => ({ useAuth: (sel: (s: { logout: () => void }) => unknown) => sel({ logout: jest.fn() }) }))
jest.mock('@/lib/biometrics', () => ({ hasHardware: jest.fn(async () => true), isEnrolled: jest.fn(async () => true) }))

beforeEach(() => mockSetEnabled.mockClear())

test('toggling the lock enables it once hardware is supported', async () => {
  const { getByTestId } = render(<Settings />)
  await waitFor(() => expect(getByTestId('lock-toggle').props.disabled).toBe(false))
  fireEvent(getByTestId('lock-toggle'), 'valueChange', true)
  await waitFor(() => expect(mockSetEnabled).toHaveBeenCalledWith(true))
})
