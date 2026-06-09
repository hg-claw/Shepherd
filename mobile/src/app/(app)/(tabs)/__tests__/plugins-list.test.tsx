import React from 'react'
import { render, fireEvent, waitFor } from '@testing-library/react-native'
import PluginsList from '../plugins'
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }), Stack: Object.assign(() => null, { Screen: () => null }) }))
const mockEnable = jest.fn().mockResolvedValue({ enabled: true })
const mockRefetch = jest.fn()
jest.mock('@/api/plugins', () => ({
  usePlugins: () => ({ data: [{ id: 'xray', meta: { name: 'Xray', description: 'proxy', icon: '🛰', category: 'net', host_aware: true }, enabled: false }], isLoading: false, isError: false, refetch: mockRefetch }),
  enablePlugin: (...a: unknown[]) => mockEnable(...a),
  disablePlugin: jest.fn(),
}))

beforeEach(() => { mockEnable.mockClear(); mockRefetch.mockClear() })

test('renders a plugin and toggling enables it', async () => {
  const { getByText, getByTestId } = render(<PluginsList />)
  expect(getByText('Xray')).toBeTruthy()
  fireEvent.press(getByTestId('toggle-xray'))
  await waitFor(() => expect(mockEnable).toHaveBeenCalledWith('xray'))
})
