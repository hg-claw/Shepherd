import React from 'react'
import { render, fireEvent } from '@testing-library/react-native'
import Home from '../index'
const mockPush = jest.fn()
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }))
jest.mock('@/store/auth', () => ({ useAuth: (sel: (s: { logout: () => void }) => unknown) => sel({ logout: jest.fn() }) }))
jest.mock('@/api/wallLive', () => ({ useWallLiveStore: (sel: (s: { live: Record<number, unknown> }) => unknown) => sel({ live: {} }), useLiveNet: () => undefined }))
const rows = [
  { id: 1, name: 'alpha', public_group: 'asia', country_code: 'HK', connected: true, agent_os: 'linux', agent_arch: 'amd64', latest: { ts: '', cpu_pct: 10, mem_used: 1, mem_total: 2, load_1: 0.5, net_rx_bps: 100, net_tx_bps: 50, disks_json: '[]' } },
  { id: 2, name: 'beta', public_group: 'asia', country_code: 'US', connected: false, latest: null },
]
jest.mock('@/api/servers', () => ({ useServers: () => ({ data: rows, isLoading: false, isError: false, isRefetching: false, refetch: jest.fn() }) }))
jest.mock('@/api/metrics', () => ({ isOnline: (r: { connected: boolean }) => r.connected, memPct: () => 50, firstDiskPct: () => 30 }))

beforeEach(() => mockPush.mockClear())

test('renders grouped cards, summary counts, and navigates on tap', () => {
  const { getByText } = render(<Home />)
  expect(getByText('asia')).toBeTruthy()
  expect(getByText('alpha')).toBeTruthy()
  expect(getByText('beta')).toBeTruthy()
  expect(getByText('1/2 online')).toBeTruthy()
  fireEvent.press(getByText('alpha'))
  expect(mockPush).toHaveBeenCalledWith('/(app)/server/1')
})
