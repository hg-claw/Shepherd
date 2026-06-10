import React from 'react'
import { render, fireEvent, waitFor } from '@testing-library/react-native'
import RunForm from '../[id]'
const mockPush = jest.fn()
const mockParams = jest.fn<Record<string, string | undefined>, []>(() => ({ id: '1', serverId: '7' }))
jest.mock('expo-router', () => ({ useLocalSearchParams: () => mockParams(), useRouter: () => ({ push: mockPush, back: jest.fn() }), Stack: Object.assign(() => null, { Screen: () => null }) }))
const mockRun = jest.fn().mockResolvedValue({ run_id: 9 })
const mockUseScripts = jest.fn()
jest.mock('@/api/scripts', () => ({
  useScripts: () => mockUseScripts(),
  runScript: (...a: unknown[]) => mockRun(...a),
}))
const mockUseServers = jest.fn()
jest.mock('@/api/servers', () => ({ useServers: () => mockUseServers() }))

// Wire-shaped fixtures: public_alias is a Go sql.NullString ({String, Valid}).
const SERVERS = [
  { id: 7, name: 'srv-7', public_alias: { String: 'alpha', Valid: true }, connected: true, latest: null },
  { id: 9, name: 'srv-9', public_alias: { String: 'gamma', Valid: true }, connected: true, latest: null },
  { id: 8, name: 'srv-8', public_alias: { String: '', Valid: false }, connected: false, agent_last_seen: null, latest: null },
]

beforeEach(() => {
  mockRun.mockClear()
  mockPush.mockClear()
  mockParams.mockReturnValue({ id: '1', serverId: '7' })
  mockUseScripts.mockReturnValue({ data: [{ id: 1, name: 'deploy', params: [{ name: 'tag', required: true }] }] })
  mockUseServers.mockReturnValue({ data: SERVERS })
})

test('preselects ?serverId=, gates Run on required param, sends array payload', async () => {
  const { getByText, getByPlaceholderText } = render(<RunForm />)
  fireEvent.press(getByText('Run on 1 server'))
  expect(mockRun).not.toHaveBeenCalled() // required param missing
  fireEvent.changeText(getByPlaceholderText('tag'), 'v1')
  fireEvent.press(getByText('Run on 1 server'))
  await waitFor(() => expect(mockRun).toHaveBeenCalledWith(1, { tag: 'v1' }, [7]))
})

test('undefined serverId → no preselect, Run disabled with hint (NaN never sent)', () => {
  mockParams.mockReturnValue({ id: '1', serverId: undefined })
  mockUseScripts.mockReturnValue({ data: [{ id: 1, name: 'deploy', params: [] }] })
  const { getByText } = render(<RunForm />)
  expect(getByText('select at least one target server')).toBeTruthy()
  fireEvent.press(getByText('Run')) // disabled — no NaN target ever reaches runScript
  expect(mockRun).not.toHaveBeenCalled()
})

test('the literal string "undefined" in the param is treated as no preselect', () => {
  mockParams.mockReturnValue({ id: '1', serverId: 'undefined' })
  mockUseScripts.mockReturnValue({ data: [{ id: 1, name: 'deploy', params: [] }] })
  const { getByText } = render(<RunForm />)
  expect(getByText('select at least one target server')).toBeTruthy()
})

test('manual multi-select sends all chosen targets', async () => {
  mockParams.mockReturnValue({ id: '1', serverId: undefined })
  mockUseScripts.mockReturnValue({ data: [{ id: 1, name: 'deploy', params: [] }] })
  const { getByText } = render(<RunForm />)
  fireEvent.press(getByText('alpha')) // server 7
  fireEvent.press(getByText('gamma')) // server 9
  fireEvent.press(getByText('Run on 2 servers'))
  await waitFor(() => expect(mockRun).toHaveBeenCalledWith(1, {}, [7, 9]))
})

test('select all online selects only online servers', async () => {
  mockParams.mockReturnValue({ id: '1', serverId: undefined })
  mockUseScripts.mockReturnValue({ data: [{ id: 1, name: 'deploy', params: [] }] })
  const { getByText } = render(<RunForm />)
  fireEvent.press(getByText('Select all online (2)'))
  fireEvent.press(getByText('Run on 2 servers'))
  await waitFor(() => expect(mockRun).toHaveBeenCalledWith(1, {}, [7, 9])) // 8 is offline
})

test('deselecting the preselected target disables Run', () => {
  mockUseScripts.mockReturnValue({ data: [{ id: 1, name: 'deploy', params: [] }] })
  const { getByText } = render(<RunForm />)
  fireEvent.press(getByText('alpha')) // toggle server 7 off
  expect(getByText('select at least one target server')).toBeTruthy()
  fireEvent.press(getByText('Run'))
  expect(mockRun).not.toHaveBeenCalled()
})

test('seeds param defaults when useScripts resolves after mount', async () => {
  // First render: query not yet resolved (data undefined) — the device race the unit mock used to hide.
  mockUseScripts.mockReturnValueOnce({ data: undefined })
  const { getByText, getByDisplayValue, rerender } = render(<RunForm />)
  expect(getByText('Script not found.')).toBeTruthy()
  // Query resolves with a script whose param carries a default; re-render.
  mockUseScripts.mockReturnValue({ data: [{ id: 1, name: 'deploy', params: [{ name: 'tag', default: 'latest' }] }] })
  rerender(<RunForm />)
  // The default must seed into the field (would be empty under the old useState-initializer bug).
  await waitFor(() => expect(getByDisplayValue('latest')).toBeTruthy())
})
