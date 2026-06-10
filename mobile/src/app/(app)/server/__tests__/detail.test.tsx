import React from 'react'
import { render, fireEvent } from '@testing-library/react-native'
import ServerDetail from '../[id]'

jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: '7' }), useRouter: () => ({ push: jest.fn(), back: jest.fn() }), Stack: Object.assign(() => null, { Screen: () => null }) }))
jest.mock('@/api/servers', () => ({ useServersLatest: jest.fn() }))
jest.mock('@/api/metrics', () => ({
  ...jest.requireActual('@/api/metrics'),
  useTelemetrySeries: jest.fn(),
}))
jest.mock('@/api/wallLive', () => ({ useLiveNet: () => ({ rx_bps: 4096, tx_bps: 100 }) }))
import { useServersLatest } from '@/api/servers'
import { useTelemetrySeries } from '@/api/metrics'

const ROW = {
  id: 7, name: 'gamma', connected: true, agent_os: 'linux', agent_arch: 'amd64',
  latest: { ts: '', cpu_pct: 33, mem_used: 1, mem_total: 4, load_1: 0.5, tcp_conn: 12, net_rx_bps: 2000, net_tx_bps: 1000 },
}

beforeEach(() => {
  ;(useServersLatest as jest.Mock).mockReturnValue({ data: [ROW], isLoading: false })
  ;(useTelemetrySeries as jest.Mock).mockReturnValue({
    data: [
      { ts: '2026-06-09T00:00:00Z', cpu_pct: 10, mem_used: 1, mem_total: 4, net_rx_bps: 1000, net_tx_bps: 500 },
      { ts: '2026-06-09T00:00:30Z', cpu_pct: 50, mem_used: 2, mem_total: 4, net_rx_bps: 2000, net_tx_bps: 700 },
    ],
    isLoading: false,
  })
})

test('renders metrics for a server', () => {
  const { getAllByText, getByText } = render(<ServerDetail />)
  // alias renders in both the NavBar title and the page title.
  expect(getAllByText('gamma').length).toBeGreaterThan(0)
  expect(getByText(/linux/)).toBeTruthy()
  expect(getByText(/4\.1 KB\/s/)).toBeTruthy()
})

test('renders the History section with range selector and charts', () => {
  const { getByText } = render(<ServerDetail />)
  expect(getByText('History')).toBeTruthy()
  // Segmented range options
  expect(getByText('1h')).toBeTruthy()
  expect(getByText('24h')).toBeTruthy()
  expect(getByText('7d')).toBeTruthy()
  // chart labels
  expect(getByText('CPU %')).toBeTruthy()
  expect(getByText('MEM %')).toBeTruthy()
  expect(getByText('NET ↓ RX')).toBeTruthy()
  expect(getByText('NET ↑ TX')).toBeTruthy()
  expect(useTelemetrySeries).toHaveBeenCalledWith(7, '1h')
})

test('switching the range refetches with the new range', () => {
  const { getByText } = render(<ServerDetail />)
  fireEvent.press(getByText('24h'))
  expect(useTelemetrySeries).toHaveBeenCalledWith(7, '24h')
})

test('shows spinner while the server query is loading (no not-found flash)', () => {
  ;(useServersLatest as jest.Mock).mockReturnValue({ data: undefined, isLoading: true })
  const { queryAllByText } = render(<ServerDetail />)
  expect(queryAllByText(/not found/i)).toHaveLength(0)
})

test('not found when absent', () => {
  ;(useServersLatest as jest.Mock).mockReturnValue({ data: [], isLoading: false })
  const { getAllByText } = render(<ServerDetail />)
  expect(getAllByText(/not found/i).length).toBeGreaterThan(0)
})
