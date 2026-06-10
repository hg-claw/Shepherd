import React from 'react'
import { render, fireEvent } from '@testing-library/react-native'
import Home from '../index'
const mockPush = jest.fn()
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }))
jest.mock('@/store/auth', () => ({ useAuth: (sel: (s: { logout: () => void }) => unknown) => sel({ logout: jest.fn() }) }))
jest.mock('@/api/wallLive', () => ({ useWallLiveStore: (sel: (s: { live: Record<number, unknown> }) => unknown) => sel({ live: {} }), useLiveNet: () => undefined }))
// NullString fields arrive from Go as {String, Valid} objects, not plain strings.
const mockNs = (s: string) => ({ String: s, Valid: true })
const mockRows = [
  { id: 1, name: 'alpha', public_group: mockNs('asia'), country_code: mockNs('HK'), ssh_host: mockNs('10.0.0.5'), connected: true, agent_os: mockNs('linux'), agent_arch: mockNs('amd64'), latest: { ts: '', cpu_pct: 10, mem_used: 1, mem_total: 2, load_1: 0.5, net_rx_bps: 100, net_tx_bps: 50, disks_json: '[]' } },
  { id: 2, name: 'beta', public_group: mockNs('asia'), country_code: mockNs('US'), connected: false, latest: null },
  // alias is a NullString too — the card renders it instead of the raw name.
  { id: 3, name: 'gamma', public_alias: mockNs('edge-1'), public_group: mockNs('eu'), ssh_host: { String: '', Valid: false }, connected: true, latest: { ts: '', cpu_pct: 95, mem_used: 1, mem_total: 2, net_rx_bps: 0, net_tx_bps: 0, disks_json: '[]' } },
]
jest.mock('@/api/servers', () => ({
  useServers: () => ({ data: mockRows, isLoading: false, isError: false, refetch: jest.fn() }),
  useServersLatest: () => ({ data: mockRows, refetch: jest.fn() }),
}))
// memPct 50 / disk 30 → alerting score is driven by cpu_pct (95 ⇒ warn, 10 ⇒ healthy).
jest.mock('@/api/metrics', () => ({ ...jest.requireActual('@/api/metrics'), isOnline: (r: { connected: boolean }) => r.connected, memPct: () => 50, firstDiskPct: () => 30 }))

beforeEach(() => mockPush.mockClear())

test('renders grouped cards, summary counts, and navigates on tap', () => {
  const { getByText } = render(<Home />)
  expect(getByText('asia')).toBeTruthy()                 // NullString group rendered as a string
  expect(getByText('alpha')).toBeTruthy()
  expect(getByText(/linux/)).toBeTruthy()                // NullString agent_os rendered
  expect(getByText('beta')).toBeTruthy()
  expect(getByText('edge-1')).toBeTruthy()               // NullString alias replaces the name
  expect(getByText('1/2 online')).toBeTruthy()
  fireEvent.press(getByText('alpha'))
  expect(mockPush).toHaveBeenCalledWith('/(app)/server/1')
})

test("the header '+' opens the add-server flow", () => {
  const { getByLabelText } = render(<Home />)
  fireEvent.press(getByLabelText('Add server'))
  expect(mockPush).toHaveBeenCalledWith('/(app)/server-new')
})

test('search narrows by name, NullString alias, and ssh_host (case-insensitive)', () => {
  const { getByPlaceholderText, getByText, queryByText } = render(<Home />)
  const input = getByPlaceholderText('Search name, alias, or host')

  fireEvent.changeText(input, 'ALPHA')                   // toLowerCase match on name
  expect(getByText('alpha')).toBeTruthy()
  expect(queryByText('beta')).toBeNull()
  expect(queryByText('edge-1')).toBeNull()

  fireEvent.changeText(input, 'edge')                    // public_alias NullString
  expect(getByText('edge-1')).toBeTruthy()
  expect(queryByText('alpha')).toBeNull()

  fireEvent.changeText(input, '10.0.0')                  // ssh_host NullString
  expect(getByText('alpha')).toBeTruthy()
  expect(queryByText('edge-1')).toBeNull()

  fireEvent.changeText(input, 'zzz')                     // empty state, list not replaced by errors
  expect(getByText('No matches.')).toBeTruthy()
})

test('status chips show live counts and filter the list, combined with search', () => {
  const { getByPlaceholderText, getByText, queryByText } = render(<Home />)
  expect(getByText('All 3')).toBeTruthy()
  expect(getByText('Online 2')).toBeTruthy()
  expect(getByText('Warn 1')).toBeTruthy()               // gamma: cpu 95 ≥ 80
  expect(getByText('Offline 1')).toBeTruthy()

  fireEvent.press(getByText('Offline 1'))
  expect(getByText('beta')).toBeTruthy()
  expect(queryByText('alpha')).toBeNull()
  expect(queryByText('edge-1')).toBeNull()

  fireEvent.press(getByText('Warn 1'))
  expect(getByText('edge-1')).toBeTruthy()
  expect(queryByText('alpha')).toBeNull()

  // Chip counts follow the searched set; combining search + chip can empty out.
  fireEvent.changeText(getByPlaceholderText('Search name, alias, or host'), 'alpha')
  expect(getByText('All 1')).toBeTruthy()
  expect(getByText('Warn 0')).toBeTruthy()
  expect(getByText('No matches.')).toBeTruthy()          // alpha is healthy, warn chip still active

  fireEvent.press(getByText('All 1'))
  expect(getByText('alpha')).toBeTruthy()
})
