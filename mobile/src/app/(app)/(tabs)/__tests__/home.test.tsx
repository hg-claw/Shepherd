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
  { id: 1, name: 'alpha', public_group: mockNs('asia'), country_code: mockNs('HK'), connected: true, agent_os: mockNs('linux'), agent_arch: mockNs('amd64'), latest: { ts: '', cpu_pct: 10, mem_used: 1, mem_total: 2, load_1: 0.5, net_rx_bps: 100, net_tx_bps: 50, disks_json: '[]' } },
  { id: 2, name: 'beta', public_group: mockNs('asia'), country_code: mockNs('US'), connected: false, latest: null },
]
jest.mock('@/api/servers', () => ({
  useServers: () => ({ data: mockRows, isLoading: false, isError: false, refetch: jest.fn() }),
  useServersLatest: () => ({ data: mockRows, refetch: jest.fn() }),
}))
jest.mock('@/api/metrics', () => ({ ...jest.requireActual('@/api/metrics'), isOnline: (r: { connected: boolean }) => r.connected, memPct: () => 50, firstDiskPct: () => 30 }))

beforeEach(() => mockPush.mockClear())

test('renders grouped cards, summary counts, and navigates on tap', () => {
  const { getByText } = render(<Home />)
  expect(getByText('asia')).toBeTruthy()                 // NullString group rendered as a string
  expect(getByText('alpha')).toBeTruthy()
  expect(getByText(/linux/)).toBeTruthy()                // NullString agent_os rendered
  expect(getByText('beta')).toBeTruthy()
  expect(getByText('1/2 online')).toBeTruthy()
  fireEvent.press(getByText('alpha'))
  expect(mockPush).toHaveBeenCalledWith('/(app)/server/1')
})
