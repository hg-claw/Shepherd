import React from 'react'
import { render, fireEvent, waitFor } from '@testing-library/react-native'
import NetqualityHostTargetsScreen, { initialSelection } from '../nq-host-targets'
import type { NetqualityHostTarget } from '@/api/netquality'

const mockBack = jest.fn()
const mockParams = jest.fn<Record<string, string | undefined>, []>(() => ({ id: 'netquality', serverId: '7' }))
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams(),
  useRouter: () => ({ back: mockBack, push: jest.fn() }),
  Stack: Object.assign(() => null, { Screen: () => null }),
}))

type Q = { data?: unknown; isLoading: boolean; isError: boolean; isRefetching: boolean; refetch: jest.Mock }
const ok = (data: unknown): Q => ({ data, isLoading: false, isError: false, isRefetching: false, refetch: jest.fn() })
const loading: Q = { data: undefined, isLoading: true, isError: false, isRefetching: false, refetch: jest.fn() }

const mockHostTargets = jest.fn<Q, [number | null]>()
const mockUpdate = jest.fn().mockResolvedValue({ ok: true })
jest.mock('@/api/netquality', () => ({
  useNetqualityHostTargets: (sid: number | null) => mockHostTargets(sid),
  updateNetqualityHostTargets: (...a: unknown[]) => mockUpdate(...a),
}))

const ROWS: NetqualityHostTarget[] = [
  { target_id: 1, isp: 'telecom', region: '上海', label: '电信上海', host: '1.1.1.1', selected: true },
  { target_id: 2, isp: 'telecom', region: '北京', label: '电信北京', host: '2.2.2.2', selected: false },
  { target_id: 9, isp: 'overseas', region: 'US', label: 'google-dns', host: '8.8.8.8', selected: false },
]

beforeEach(() => {
  jest.clearAllMocks()
  mockParams.mockReturnValue({ id: 'netquality', serverId: '7' })
  mockHostTargets.mockReturnValue(ok(ROWS))
})

test('initialSelection seeds from the selected flag', () => {
  expect([...initialSelection(ROWS)]).toEqual([1])
  expect(initialSelection([]).size).toBe(0)
})

test('renders ISP-grouped rows, seeds switches from the selected flag', () => {
  const { getByText, getByTestId } = render(<NetqualityHostTargetsScreen />)
  expect(getByText('电信')).toBeTruthy()
  expect(getByText('海外')).toBeTruthy()
  expect(getByTestId('pick-1').props.accessibilityState.checked).toBe(true)
  expect(getByTestId('pick-2').props.accessibilityState.checked).toBe(false)
})

test('hits the per-host targets query with the route serverId', () => {
  render(<NetqualityHostTargetsScreen />)
  expect(mockHostTargets).toHaveBeenCalledWith(7)
})

test('toggling then Save PUTs the resulting target_ids set and returns', async () => {
  const { getByTestId } = render(<NetqualityHostTargetsScreen />)
  // the Switch is a Pressable that toggles on press
  fireEvent.press(getByTestId('pick-2')) // add 2 (was off)
  fireEvent.press(getByTestId('pick-1')) // remove the pre-selected 1 (was on)
  fireEvent.press(getByTestId('picker-save'))
  await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith(7, [2]))
  await waitFor(() => expect(mockBack).toHaveBeenCalled())
})

test('"N selected" footer reflects the buffer', () => {
  const { getByText, getByTestId } = render(<NetqualityHostTargetsScreen />)
  expect(getByText('1 selected')).toBeTruthy()
  fireEvent.press(getByTestId('pick-2'))
  expect(getByText('2 selected')).toBeTruthy()
})

test('loading shows a spinner', () => {
  mockHostTargets.mockReturnValue(loading)
  expect(render(<NetqualityHostTargetsScreen />).getByTestId('picker-loading')).toBeTruthy()
})

test('no enabled targets shows guidance', () => {
  mockHostTargets.mockReturnValue(ok([]))
  const { getByText } = render(<NetqualityHostTargetsScreen />)
  expect(getByText(/No enabled targets/)).toBeTruthy()
})

test('a missing/invalid serverId renders the no-server state and never queries', () => {
  mockParams.mockReturnValue({ id: 'netquality', serverId: 'undefined' })
  const { getByText } = render(<NetqualityHostTargetsScreen />)
  expect(getByText('No server selected.')).toBeTruthy()
  expect(mockHostTargets).not.toHaveBeenCalled()
})
