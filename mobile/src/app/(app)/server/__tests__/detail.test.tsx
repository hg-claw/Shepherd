import React from 'react'
import { render } from '@testing-library/react-native'
import ServerDetail from '../[id]'

jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: '7' }), useRouter: () => ({ push: jest.fn() }), Stack: Object.assign(() => null, { Screen: () => null }) }))
jest.mock('@/api/servers', () => ({ useServer: jest.fn() }))
jest.mock('@/api/wallLive', () => ({ useLiveNet: () => ({ rx_bps: 4096, tx_bps: 100 }) }))
import { useServer } from '@/api/servers'

test('renders metrics for a server', () => {
  ;(useServer as jest.Mock).mockReturnValue({
    id: 7, name: 'gamma', connected: true, agent_os: 'linux', agent_arch: 'amd64',
    latest: { ts: '', cpu_pct: 33, mem_used: 1, mem_total: 4, load_1: 0.5, tcp_conn: 12, net_rx_bps: 2000, net_tx_bps: 1000 },
  })
  const { getByText } = render(<ServerDetail />)
  expect(getByText('gamma')).toBeTruthy()
  expect(getByText(/linux/)).toBeTruthy()
  expect(getByText(/4\.1 KB\/s/)).toBeTruthy()
})

test('not found when absent', () => {
  ;(useServer as jest.Mock).mockReturnValue(undefined)
  const { getByText } = render(<ServerDetail />)
  expect(getByText(/not found/i)).toBeTruthy()
})
