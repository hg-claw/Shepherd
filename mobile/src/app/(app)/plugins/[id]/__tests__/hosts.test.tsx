import React from 'react'
import { render, fireEvent, waitFor } from '@testing-library/react-native'
import PluginHosts from '../hosts'
jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: 'xray' }) }))
const mockRestart = jest.fn().mockResolvedValue({ status: 'running' })
const mockRefetch = jest.fn()
jest.mock('@/api/plugins', () => ({
  usePluginHosts: () => ({ data: [{ id: 1, plugin_id: 'xray', server_id: 7, status: 'failed', last_error: 'boom', updated_at: '' }], isLoading: false, isError: false, refetch: mockRefetch }),
  deployHost: jest.fn(), undeployHost: jest.fn(), startHost: jest.fn(), stopHost: jest.fn(),
  restartHost: (...a: unknown[]) => mockRestart(...a), refreshHost: jest.fn(),
}))

beforeEach(() => { mockRestart.mockClear(); mockRefetch.mockClear() })

test('renders a host with its error and restart calls the API', async () => {
  const { getByText, getByTestId } = render(<PluginHosts />)
  expect(getByText(/server #7/)).toBeTruthy()
  expect(getByText(/boom/)).toBeTruthy()
  fireEvent.press(getByTestId('restart-7'))
  await waitFor(() => expect(mockRestart).toHaveBeenCalledWith('xray', 7))
})
