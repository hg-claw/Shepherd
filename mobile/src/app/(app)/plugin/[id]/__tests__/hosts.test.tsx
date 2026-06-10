import React from 'react'
import { Alert } from 'react-native'
import { render, fireEvent, waitFor } from '@testing-library/react-native'
import PluginHosts from '../hosts'
jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: 'xray' }), useRouter: () => ({ back: jest.fn() }), Stack: Object.assign(() => null, { Screen: () => null }) }))

const mockRestart = jest.fn().mockResolvedValue({ status: 'running' })
const mockStop = jest.fn().mockResolvedValue({ status: 'stopped' })
const mockUndeploy = jest.fn().mockResolvedValue({ ok: true })
const mockDeploy = jest.fn().mockResolvedValue({ id: 2, plugin_id: 'xray', server_id: 9, status: 'pending', updated_at: '' })
const mockRefetch = jest.fn()

// server #7 IS deployed (failed), server #9 is NOT deployed. The wire shape for
// public_alias / ssh_host is a Go sql.NullString {String, Valid}.
jest.mock('@/api/plugins', () => ({
  usePluginHosts: () => ({
    data: [{ id: 1, plugin_id: 'xray', server_id: 7, status: 'failed', last_error: 'boom', updated_at: '' }],
    isLoading: false, isError: false, isRefetching: false, refetch: mockRefetch,
  }),
  deployHost: (...a: unknown[]) => mockDeploy(...a),
  undeployHost: (...a: unknown[]) => mockUndeploy(...a),
  startHost: jest.fn(),
  stopHost: (...a: unknown[]) => mockStop(...a),
  restartHost: (...a: unknown[]) => mockRestart(...a),
  refreshHost: jest.fn(),
}))

jest.mock('@/api/servers', () => ({
  useServers: () => ({
    data: [
      { id: 7, name: 'edge-tokyo', connected: true, latest: null, public_alias: { String: 'Tokyo Edge', Valid: true }, ssh_host: { String: '10.0.0.7', Valid: true } },
      { id: 9, name: 'edge-osaka', connected: true, latest: null, public_alias: { String: '', Valid: false }, ssh_host: { String: '', Valid: false } },
    ],
    isLoading: false, isError: false, isRefetching: false, refetch: jest.fn(),
  }),
}))

type AlertButton = { text?: string; style?: string; onPress?: () => void }

beforeEach(() => {
  mockRestart.mockClear()
  mockStop.mockClear()
  mockUndeploy.mockClear()
  mockDeploy.mockClear()
  mockRefetch.mockClear()
  jest.restoreAllMocks()
})

test('shows the server NAME (alias) for a deployed host, not #id', () => {
  const { getByText, queryByText } = render(<PluginHosts />)
  // alias takes precedence over the internal name
  expect(getByText(/Tokyo Edge/)).toBeTruthy()
  // the old "server #7" wording is gone
  expect(queryByText(/server #7/)).toBeNull()
})

test('renders a deployed host with its error and restart calls the API', async () => {
  const { getByText, getByTestId } = render(<PluginHosts />)
  expect(getByText(/boom/)).toBeTruthy()
  fireEvent.press(getByTestId('restart-7'))
  await waitFor(() => expect(mockRestart).toHaveBeenCalledWith('xray', 7))
})

test('lists ALL servers — a not-deployed server shows its name, a Deploy button and a neutral status', async () => {
  const { getByText, getByTestId, queryByTestId } = render(<PluginHosts />)
  // server 9 has no alias → falls back to its internal name
  expect(getByText(/edge-osaka/)).toBeTruthy()
  expect(getByText(/not deployed/)).toBeTruthy()
  // not-deployed row: Deploy action, no lifecycle/undeploy buttons
  expect(getByTestId('deploy-9')).toBeTruthy()
  expect(queryByTestId('undeploy-9')).toBeNull()
  expect(queryByTestId('start-9')).toBeNull()
  // deployed row has no Deploy button
  expect(queryByTestId('deploy-7')).toBeNull()
  fireEvent.press(getByTestId('deploy-9'))
  await waitFor(() => expect(mockDeploy).toHaveBeenCalledWith('xray', { server_id: 9 }))
})

test('undeploy asks for confirmation using the server NAME before mutating', async () => {
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {})
  const { getByTestId } = render(<PluginHosts />)
  fireEvent.press(getByTestId('undeploy-7'))
  expect(alertSpy).toHaveBeenCalled()
  expect(mockUndeploy).not.toHaveBeenCalled()
  expect(alertSpy.mock.calls[0][0]).toMatch(/Undeploy from Tokyo Edge\?/)
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
