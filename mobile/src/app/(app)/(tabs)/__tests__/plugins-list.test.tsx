import React from 'react'
import { render, fireEvent, waitFor } from '@testing-library/react-native'
import PluginsList from '../plugins'
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }), Stack: Object.assign(() => null, { Screen: () => null }) }))
const mockEnable = jest.fn().mockResolvedValue({ enabled: true })
const mockRefetch = jest.fn()
let mockPlugins: unknown[] = [{ id: 'xray', meta: { name: 'Xray', description: 'proxy', icon: '🛰', category: 'net', host_aware: true }, enabled: false }]
jest.mock('@/api/plugins', () => ({
  usePlugins: () => ({ data: mockPlugins, isLoading: false, isError: false, refetch: mockRefetch }),
  enablePlugin: (...a: unknown[]) => mockEnable(...a),
  disablePlugin: jest.fn(),
}))
// The sshaudit overview drives the 24h badge; default to a fleet-wide tally.
let mockOverview: unknown = { window_hours: 24, accepted: 12, failed: 87 }
jest.mock('@/api/sshaudit', () => ({
  useSshauditOverview: (enabled: boolean) => ({ data: enabled ? mockOverview : undefined }),
}))

beforeEach(() => {
  mockEnable.mockClear()
  mockRefetch.mockClear()
  mockPlugins = [{ id: 'xray', meta: { name: 'Xray', description: 'proxy', icon: '🛰', category: 'net', host_aware: true }, enabled: false }]
  mockOverview = { window_hours: 24, accepted: 12, failed: 87 }
})

test('renders a plugin and toggling enables it', async () => {
  const { getByText, getByTestId } = render(<PluginsList />)
  expect(getByText('Xray')).toBeTruthy()
  fireEvent.press(getByTestId('toggle-xray'))
  await waitFor(() => expect(mockEnable).toHaveBeenCalledWith('xray'))
})

test('renders the 24h tally badge on an enabled sshaudit row', () => {
  mockPlugins = [{ id: 'sshaudit', meta: { name: 'SSH Audit', description: 'logins', icon: 'shield', category: 'security', host_aware: true }, enabled: true }]
  const { getByText } = render(<PluginsList />)
  expect(getByText('✓12')).toBeTruthy()
  expect(getByText('✗87')).toBeTruthy()
})

test('omits the 24h badge when sshaudit is disabled', () => {
  mockPlugins = [{ id: 'sshaudit', meta: { name: 'SSH Audit', description: 'logins', icon: 'shield', category: 'security', host_aware: true }, enabled: false }]
  const { queryByText } = render(<PluginsList />)
  expect(queryByText('✓12')).toBeNull()
})
