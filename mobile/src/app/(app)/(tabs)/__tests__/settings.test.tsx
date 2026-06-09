import React from 'react'
import { render, fireEvent, waitFor } from '@testing-library/react-native'
import Settings from '../settings'

jest.mock('expo-router', () => ({ Stack: Object.assign(() => null, { Screen: () => null }) }))

const mockSetEnabled = jest.fn().mockResolvedValue(undefined)
const mockLock = jest.fn()
jest.mock('@/store/lock', () => {
  const useLock = () => ({ enabled: false, setEnabled: mockSetEnabled })
  useLock.getState = () => ({ lock: mockLock })
  return { useLock }
})

jest.mock('@/store/auth', () => ({
  useAuth: (sel: (s: { logout: () => void; admin: null; baseURL: string }) => unknown) =>
    sel({ logout: jest.fn(), admin: null, baseURL: 'https://fleet.shepherd.app' }),
}))

const mockToggle = jest.fn().mockResolvedValue(undefined)
jest.mock('@/theme', () => {
  const actual = jest.requireActual('@/theme')
  const useThemeMode = (sel: (s: { mode: string }) => unknown) => sel({ mode: 'dark' })
  useThemeMode.getState = () => ({ toggle: mockToggle })
  return { ...actual, useThemeMode }
})

jest.mock('@/lib/biometrics', () => ({ hasHardware: jest.fn(async () => true), isEnrolled: jest.fn(async () => true) }))

beforeEach(() => { mockSetEnabled.mockClear(); mockLock.mockClear(); mockToggle.mockClear() })

test('toggling the lock enables it once hardware is supported', async () => {
  const { getByTestId } = render(<Settings />)
  await waitFor(() => expect(getByTestId('lock-toggle').props.accessibilityState.disabled).toBe(false))
  fireEvent.press(getByTestId('lock-toggle'))
  await waitFor(() => expect(mockSetEnabled).toHaveBeenCalledWith(true))
})

test('toggling dark mode calls the theme store toggle', () => {
  const { getByTestId } = render(<Settings />)
  fireEvent.press(getByTestId('darkmode-toggle'))
  expect(mockToggle).toHaveBeenCalled()
})
