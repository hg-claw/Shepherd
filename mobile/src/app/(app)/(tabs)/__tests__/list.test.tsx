import React from 'react'
import { render } from '@testing-library/react-native'
import ServerList from '../index'

jest.mock('expo-router', () => ({ router: { push: jest.fn() }, useRouter: () => ({ push: jest.fn() }) }))
jest.mock('@/api/servers', () => ({ useServers: jest.fn(), useServersLatest: jest.fn() }))
jest.mock('@/store/auth', () => ({ useAuth: Object.assign(() => jest.fn(), { getState: () => ({ logout: jest.fn() }) }) }))
import { useServers, useServersLatest } from '@/api/servers'

const rows = [
  { id: 1, name: 'alpha', connected: true, latest: { ts: '', cpu_pct: 12, mem_used: 1, mem_total: 2, net_rx_bps: 1000, net_tx_bps: 500 } },
  { id: 2, name: 'bravo', connected: false, latest: null },
]

test('renders rows with online + offline', () => {
  ;(useServers as jest.Mock).mockReturnValue({ data: rows, isLoading: false, isError: false, refetch: jest.fn() })
  ;(useServersLatest as jest.Mock).mockReturnValue({ data: rows, refetch: jest.fn() })
  const { getByText } = render(<ServerList />)
  expect(getByText('alpha')).toBeTruthy()
  expect(getByText('bravo')).toBeTruthy()
})

test('renders error state', () => {
  ;(useServers as jest.Mock).mockReturnValue({ data: undefined, isLoading: false, isError: true, error: new Error('boom'), refetch: jest.fn() })
  ;(useServersLatest as jest.Mock).mockReturnValue({ data: undefined, refetch: jest.fn() })
  const { getByText } = render(<ServerList />)
  expect(getByText(/boom/)).toBeTruthy()
})
