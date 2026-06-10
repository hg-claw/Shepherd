import React from 'react'
import { Alert } from 'react-native'
import { render, fireEvent, waitFor } from '@testing-library/react-native'
import Settings from '../settings'

const mockPush = jest.fn()
jest.mock('expo-router', () => ({
  Stack: Object.assign(() => null, { Screen: () => null }),
  useRouter: () => ({ push: mockPush, back: jest.fn() }),
}))

const mockSetEnabled = jest.fn().mockResolvedValue(undefined)
const mockLock = jest.fn()
jest.mock('@/store/lock', () => {
  const useLock = () => ({ enabled: false, setEnabled: mockSetEnabled })
  useLock.getState = () => ({ lock: mockLock })
  return { useLock }
})

const mockLogout = jest.fn().mockResolvedValue(undefined)
jest.mock('@/store/auth', () => ({
  useAuth: (sel: (s: { logout: () => void; admin: null; baseURL: string }) => unknown) =>
    sel({ logout: mockLogout, admin: null, baseURL: 'https://fleet.shepherd.app' }),
}))

const mockToggle = jest.fn().mockResolvedValue(undefined)
jest.mock('@/theme', () => {
  const actual = jest.requireActual('@/theme')
  const useThemeMode = (sel: (s: { mode: string }) => unknown) => sel({ mode: 'dark' })
  useThemeMode.getState = () => ({ toggle: mockToggle })
  return { ...actual, useThemeMode }
})

jest.mock('@/lib/biometrics', () => ({ hasHardware: jest.fn(async () => true), isEnrolled: jest.fn(async () => true) }))

beforeEach(() => {
  mockSetEnabled.mockClear(); mockLock.mockClear(); mockToggle.mockClear(); mockLogout.mockClear(); mockPush.mockClear()
  jest.restoreAllMocks()
})

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

test('audit log row navigates to the audit screen', () => {
  const { getByText } = render(<Settings />)
  fireEvent.press(getByText('Audit log'))
  expect(mockPush).toHaveBeenCalledWith('/(app)/audit')
})

test('sign out asks for confirmation and only logs out on confirm', () => {
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {})
  const { getByText } = render(<Settings />)
  fireEvent.press(getByText('Sign out'))
  expect(alertSpy).toHaveBeenCalled()
  expect(mockLogout).not.toHaveBeenCalled()
  const buttons = alertSpy.mock.calls[0][2] as { text?: string; style?: string; onPress?: () => void }[]
  const confirm = buttons.find((b) => b.style === 'destructive')
  expect(confirm).toBeTruthy()
  confirm!.onPress!()
  expect(mockLogout).toHaveBeenCalled()
})
