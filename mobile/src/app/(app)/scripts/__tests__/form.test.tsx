import React from 'react'
import { render, fireEvent, waitFor } from '@testing-library/react-native'
import RunForm from '../[id]'
const mockPush = jest.fn()
jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: '1', serverId: '7' }), useRouter: () => ({ push: mockPush }) }))
const mockRun = jest.fn().mockResolvedValue({ run_id: 9 })
const mockUseScripts = jest.fn()
jest.mock('@/api/scripts', () => ({
  useScripts: () => mockUseScripts(),
  runScript: (...a: unknown[]) => mockRun(...a),
}))

beforeEach(() => {
  mockRun.mockClear()
  mockPush.mockClear()
  mockUseScripts.mockReturnValue({ data: [{ id: 1, name: 'deploy', params: [{ name: 'tag', required: true }] }] })
})

test('Run is gated on required param, then calls runScript', async () => {
  const { getByText, getByPlaceholderText } = render(<RunForm />)
  fireEvent.press(getByText('Run'))
  expect(mockRun).not.toHaveBeenCalled()
  fireEvent.changeText(getByPlaceholderText('tag'), 'v1')
  fireEvent.press(getByText('Run'))
  await waitFor(() => expect(mockRun).toHaveBeenCalledWith(1, { tag: 'v1' }, 7))
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
