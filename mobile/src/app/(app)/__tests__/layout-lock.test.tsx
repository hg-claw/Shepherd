import React from 'react'
import { render } from '@testing-library/react-native'
import AppLayout from '../_layout'
jest.mock('expo-router', () => ({ Slot: () => null, Redirect: () => null }))
jest.mock('@/components/LockScreen', () => {
  const { Text } = require('react-native')
  return { LockScreen: () => <Text>LOCKED</Text> }
})
jest.mock('@/store/auth', () => ({ useAuth: (sel: (s: { status: string }) => unknown) => sel({ status: 'signedIn' }) }))
const mockLockState = { enabled: true, locked: true, hydrated: true, hydrate: jest.fn(), noteBackground: jest.fn(), maybeLockOnForeground: jest.fn() }
jest.mock('@/store/lock', () => ({ useLock: () => mockLockState }))

beforeEach(() => { mockLockState.enabled = true; mockLockState.locked = true; mockLockState.hydrated = true })

test('renders LockScreen overlay when enabled+locked and signed in', () => {
  const { getByText } = render(<AppLayout />)
  expect(getByText('LOCKED')).toBeTruthy()
})

test('renders nothing (no content flash) until the lock flag is hydrated', () => {
  mockLockState.hydrated = false
  const { queryByText } = render(<AppLayout />)
  expect(queryByText('LOCKED')).toBeNull() // overlay not shown — but neither is protected content
})
