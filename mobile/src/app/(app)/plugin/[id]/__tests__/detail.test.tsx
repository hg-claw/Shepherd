import React from 'react'
import { render, fireEvent } from '@testing-library/react-native'
import PluginDetail from '../index'
const mockPush = jest.fn()
jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: 'xray' }), useRouter: () => ({ push: mockPush, back: jest.fn() }), Stack: Object.assign(() => null, { Screen: () => null }) }))
const mockPlugins = [{ id: 'xray', meta: { name: 'Xray', description: 'proxy', icon: '🛰', category: 'net', host_aware: true }, enabled: true, host_count: 3 }]
let mockQ: { data?: typeof mockPlugins; isLoading: boolean } = { data: mockPlugins, isLoading: false }
jest.mock('@/api/plugins', () => ({
  usePlugins: () => mockQ,
  enablePlugin: jest.fn(), disablePlugin: jest.fn(),
}))

beforeEach(() => { mockQ = { data: mockPlugins, isLoading: false }; mockPush.mockClear() })

test('renders meta and a Hosts row for host-aware plugins', () => {
  const { getAllByText, getByText } = render(<PluginDetail />)
  expect(getAllByText(/Xray/).length).toBeGreaterThan(0)
  expect(getByText(/Hosts/)).toBeTruthy()
})

test('a Logs row navigates to the logs screen (host-aware only)', () => {
  const { getByText } = render(<PluginDetail />)
  fireEvent.press(getByText('Logs'))
  expect(mockPush).toHaveBeenCalledWith('/(app)/plugin/xray/logs')
})

test('non-host-aware plugins get neither Hosts nor Logs rows', () => {
  mockQ = { data: [{ ...mockPlugins[0], meta: { ...mockPlugins[0].meta, host_aware: false } }], isLoading: false }
  const { queryByText } = render(<PluginDetail />)
  expect(queryByText('Hosts')).toBeNull()
  expect(queryByText('Logs')).toBeNull()
})

test('shows a spinner while loading instead of flashing "not found"', () => {
  mockQ = { data: undefined, isLoading: true }
  const { getByTestId, queryByText } = render(<PluginDetail />)
  expect(getByTestId('plugin-loading')).toBeTruthy()
  expect(queryByText(/not found/i)).toBeNull()
})

test('shows not-found only after loading finishes with no match', () => {
  mockQ = { data: [], isLoading: false }
  const { getByText } = render(<PluginDetail />)
  expect(getByText(/Plugin not found/)).toBeTruthy()
})
