import React from 'react'
import { Alert } from 'react-native'
import { render, fireEvent, waitFor } from '@testing-library/react-native'
import PluginHosts from '../hosts'
jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: 'xray' }), useRouter: () => ({ back: jest.fn() }), Stack: Object.assign(() => null, { Screen: () => null }) }))
const mockRestart = jest.fn().mockResolvedValue({ status: 'running' })
const mockStop = jest.fn().mockResolvedValue({ status: 'stopped' })
const mockUndeploy = jest.fn().mockResolvedValue({ ok: true })
const mockRefetch = jest.fn()
jest.mock('@/api/plugins', () => ({
  usePluginHosts: () => ({ data: [{ id: 1, plugin_id: 'xray', server_id: 7, status: 'failed', last_error: 'boom', updated_at: '' }], isLoading: false, isError: false, refetch: mockRefetch }),
  deployHost: jest.fn(), undeployHost: (...a: unknown[]) => mockUndeploy(...a), startHost: jest.fn(),
  stopHost: (...a: unknown[]) => mockStop(...a),
  restartHost: (...a: unknown[]) => mockRestart(...a), refreshHost: jest.fn(),
}))

type AlertButton = { text?: string; style?: string; onPress?: () => void }

beforeEach(() => {
  mockRestart.mockClear()
  mockStop.mockClear()
  mockUndeploy.mockClear()
  mockRefetch.mockClear()
  jest.restoreAllMocks()
})

test('renders a host with its error and restart calls the API', async () => {
  const { getByText, getByTestId } = render(<PluginHosts />)
  expect(getByText(/server #7/)).toBeTruthy()
  expect(getByText(/boom/)).toBeTruthy()
  fireEvent.press(getByTestId('restart-7'))
  await waitFor(() => expect(mockRestart).toHaveBeenCalledWith('xray', 7))
})

test('undeploy asks for confirmation before mutating', async () => {
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {})
  const { getByTestId } = render(<PluginHosts />)
  fireEvent.press(getByTestId('undeploy-7'))
  expect(alertSpy).toHaveBeenCalled()
  expect(mockUndeploy).not.toHaveBeenCalled()
  expect(alertSpy.mock.calls[0][0]).toMatch(/Undeploy from server #7\?/)
  const buttons = alertSpy.mock.calls[0][2] as AlertButton[]
  const confirm = buttons.find((b) => b.style === 'destructive')
  expect(confirm).toBeTruthy()
  confirm!.onPress!()
  await waitFor(() => expect(mockUndeploy).toHaveBeenCalledWith('xray', 7))
  await waitFor(() => expect(mockRefetch).toHaveBeenCalled())
})

test('a mutation error is rendered inline in the host card', async () => {
  mockRestart.mockRejectedValueOnce(new Error('agent offline'))
  const { getByTestId, findByText } = render(<PluginHosts />)
  fireEvent.press(getByTestId('restart-7'))
  expect(await findByText('agent offline')).toBeTruthy()
  expect(getByTestId('action-error-7')).toBeTruthy()
  expect(mockRefetch).not.toHaveBeenCalled()
})

test('buttons are disabled while a mutation is in flight (no double fire)', async () => {
  let resolveRestart: (v: unknown) => void = () => {}
  mockRestart.mockImplementationOnce(() => new Promise((r) => { resolveRestart = r }))
  const { getByTestId, queryByTestId } = render(<PluginHosts />)
  fireEvent.press(getByTestId('restart-7'))
  // busy spinner visible, all of this host's buttons disabled
  await waitFor(() => expect(getByTestId('busy-7')).toBeTruthy())
  fireEvent.press(getByTestId('restart-7'))
  fireEvent.press(getByTestId('stop-7'))
  expect(mockRestart).toHaveBeenCalledTimes(1)
  expect(mockStop).not.toHaveBeenCalled()
  resolveRestart({ status: 'running' })
  await waitFor(() => expect(mockRefetch).toHaveBeenCalled())
  await waitFor(() => expect(queryByTestId('busy-7')).toBeNull())
})
