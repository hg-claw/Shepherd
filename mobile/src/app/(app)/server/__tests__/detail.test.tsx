import React from 'react'
import { render, fireEvent, waitFor } from '@testing-library/react-native'
import { Alert } from 'react-native'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import ServerDetail from '../[id]'
import { APIError } from '@/api/client'

const mockBack = jest.fn()
const mockPush = jest.fn()
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: '7' }),
  useRouter: () => ({ push: mockPush, back: mockBack }),
  Stack: Object.assign(() => null, { Screen: () => null }),
}))
jest.mock('@/api/servers', () => ({
  useServersLatest: jest.fn(),
  useHostTraffic: jest.fn(),
  updateAgent: jest.fn(),
  repairServer: jest.fn(),
  deleteServer: jest.fn(),
}))
jest.mock('@/api/metrics', () => ({
  ...jest.requireActual('@/api/metrics'),
  useTelemetrySeries: jest.fn(),
}))
jest.mock('@/api/wallLive', () => ({ useLiveNet: () => ({ rx_bps: 4096, tx_bps: 100 }) }))
import { useServersLatest, useHostTraffic, updateAgent, repairServer, deleteServer } from '@/api/servers'
import { useTelemetrySeries } from '@/api/metrics'

const ROW = {
  id: 7, name: 'gamma', connected: true, agent_os: 'linux', agent_arch: 'amd64',
  latest: { ts: '', cpu_pct: 33, mem_used: 1, mem_total: 4, load_1: 0.5, tcp_conn: 12, net_rx_bps: 2000, net_tx_bps: 1000 },
}

// Real number shapes: 1.5 GB up / 70 MB down this cycle; 50 MB / 1 KB previous.
const TRAFFIC = {
  server_id: 7,
  cum_bytes_up: 1610612736, cum_bytes_down: 73400320,
  prev_bytes_up: 52428800, prev_bytes_down: 1024,
  reset_day: 5, last_reset_at: '2026-06-05T00:00:00Z',
}

let qc: QueryClient
const renderScreen = () => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ServerDetail />
    </QueryClientProvider>,
  )
}

// Pull a button out of the last Alert.alert call and return it (tests invoke
// onPress directly — RN Alerts don't render in the test tree).
const alertButton = (label: string) => {
  const calls = (Alert.alert as jest.Mock).mock.calls
  expect(calls.length).toBeGreaterThan(0)
  const btns = (calls[calls.length - 1][2] ?? []) as { text: string; style?: string; onPress?: () => void }[]
  const b = btns.find((x) => x.text === label)
  expect(b).toBeTruthy()
  return b!
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.spyOn(Alert, 'alert').mockImplementation(() => {})
  ;(useServersLatest as jest.Mock).mockReturnValue({ data: [ROW], isLoading: false })
  ;(useHostTraffic as jest.Mock).mockReturnValue({ data: TRAFFIC, isLoading: false, isError: false })
  ;(useTelemetrySeries as jest.Mock).mockReturnValue({
    data: [
      { ts: '2026-06-09T00:00:00Z', cpu_pct: 10, mem_used: 1, mem_total: 4, net_rx_bps: 1000, net_tx_bps: 500 },
      { ts: '2026-06-09T00:00:30Z', cpu_pct: 50, mem_used: 2, mem_total: 4, net_rx_bps: 2000, net_tx_bps: 700 },
    ],
    isLoading: false,
  })
})

test('renders metrics for a server', () => {
  const { getAllByText, getByText } = renderScreen()
  // alias renders in both the NavBar title and the page title.
  expect(getAllByText('gamma').length).toBeGreaterThan(0)
  expect(getByText(/linux/)).toBeTruthy()
  expect(getByText(/4\.1 KB\/s/)).toBeTruthy()
})

test('renders the History section with range selector and charts', () => {
  const { getByText } = renderScreen()
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
  const { getByText } = renderScreen()
  fireEvent.press(getByText('24h'))
  expect(useTelemetrySeries).toHaveBeenCalledWith(7, '24h')
})

test('shows spinner while the server query is loading (no not-found flash)', () => {
  ;(useServersLatest as jest.Mock).mockReturnValue({ data: undefined, isLoading: true })
  const { queryAllByText } = renderScreen()
  expect(queryAllByText(/not found/i)).toHaveLength(0)
})

test('not found when absent', () => {
  ;(useServersLatest as jest.Mock).mockReturnValue({ data: [], isLoading: false })
  const { getAllByText } = renderScreen()
  expect(getAllByText(/not found/i).length).toBeGreaterThan(0)
})

// --- Traffic card ---

test('traffic card renders humanized cycle counters and reset caption', () => {
  const { getByText } = renderScreen()
  expect(getByText('Traffic')).toBeTruthy()
  // RNTL normalizes runs of whitespace to a single space when matching.
  expect(getByText(/↑ 1\.5 GB ↓ 70 MB/)).toBeTruthy()
  expect(getByText(/↑ 50 MB ↓ 1\.0 KB/)).toBeTruthy()
  expect(getByText(/resets day 5/)).toBeTruthy()
})

test('traffic card shows a fallback when the query errors', () => {
  ;(useHostTraffic as jest.Mock).mockReturnValue({ data: undefined, isLoading: false, isError: true })
  const { getByText } = renderScreen()
  expect(getByText('failed to load traffic')).toBeTruthy()
})

// --- Actions card ---

test('actions card renders all three actions', () => {
  const { getByText } = renderScreen()
  expect(getByText('Actions')).toBeTruthy()
  expect(getByText('Update agent')).toBeTruthy()
  expect(getByText('Repair enrollment')).toBeTruthy()
  expect(getByText('Delete server')).toBeTruthy()
})

test('update agent: confirm offers standard + CN mirror; standard POSTs without cn', async () => {
  ;(updateAgent as jest.Mock).mockResolvedValue(null)
  const { getByText, findByTestId } = renderScreen()
  fireEvent.press(getByText('Update agent'))
  expect(Alert.alert).toHaveBeenCalled()
  alertButton('Cancel') // all three buttons present
  alertButton('Update (CN mirror)')
  alertButton('Update').onPress!()
  expect(updateAgent).toHaveBeenCalledWith(7)
  const notice = await findByTestId('action-notice')
  expect(notice).toHaveTextContent('agent update started')
})

test('update agent: CN mirror button passes cn=true', async () => {
  ;(updateAgent as jest.Mock).mockResolvedValue(null)
  const { getByText, findByTestId } = renderScreen()
  fireEvent.press(getByText('Update agent'))
  alertButton('Update (CN mirror)').onPress!()
  expect(updateAgent).toHaveBeenCalledWith(7, true)
  await findByTestId('action-notice')
})

test('update agent: 409 surfaces the agent-offline inline error', async () => {
  ;(updateAgent as jest.Mock).mockRejectedValue(new APIError(409, 'agent offline'))
  const { getByText, findByTestId } = renderScreen()
  fireEvent.press(getByText('Update agent'))
  alertButton('Update').onPress!()
  const err = await findByTestId('action-error-update')
  expect(err).toHaveTextContent(/agent offline/)
})

test('repair: confirm → token shown in mono box with expiry + copy', async () => {
  ;(repairServer as jest.Mock).mockResolvedValue({ enrollment_token: 'tok-abc-123', expires_at: '2026-06-09T12:34:00Z' })
  const { getByText, findByTestId, getByTestId } = renderScreen()
  fireEvent.press(getByText('Repair enrollment'))
  alertButton('Repair').onPress!()
  const tok = await findByTestId('repair-token')
  expect(tok).toHaveTextContent('tok-abc-123')
  expect(repairServer).toHaveBeenCalledWith(7)
  // Hermes-safe local time: assert shape, not TZ-dependent exact value.
  expect(getByText(/expires \d{4}-\d{2}-\d{2} \d{2}:\d{2}/)).toBeTruthy()
  // expo-clipboard is mocked in jest-setup, so the guarded require resolved → Copy renders.
  fireEvent.press(getByTestId('copy-token'))
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  expect(require('expo-clipboard').setStringAsync).toHaveBeenCalledWith('tok-abc-123')
})

test('repair: failure shows inline error', async () => {
  ;(repairServer as jest.Mock).mockRejectedValue(new Error('boom'))
  const { getByText, findByTestId } = renderScreen()
  fireEvent.press(getByText('Repair enrollment'))
  alertButton('Repair').onPress!()
  const err = await findByTestId('action-error-repair')
  expect(err).toHaveTextContent('boom')
})

test('delete: destructive confirm names the server; success invalidates servers and goes back', async () => {
  ;(deleteServer as jest.Mock).mockResolvedValue({ ok: true })
  const { getByText } = renderScreen()
  const invalidate = jest.spyOn(qc, 'invalidateQueries')
  fireEvent.press(getByText('Delete server'))
  expect((Alert.alert as jest.Mock).mock.calls[0][0]).toContain('gamma')
  const del = alertButton('Delete')
  expect(del.style).toBe('destructive')
  del.onPress!()
  await waitFor(() => expect(mockBack).toHaveBeenCalled())
  expect(deleteServer).toHaveBeenCalledWith(7)
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['servers'] })
})

test('delete: failure shows inline error and does not navigate', async () => {
  ;(deleteServer as jest.Mock).mockRejectedValue(new Error('nope'))
  const { getByText, findByTestId } = renderScreen()
  fireEvent.press(getByText('Delete server'))
  alertButton('Delete').onPress!()
  const err = await findByTestId('action-error-delete')
  expect(err).toHaveTextContent('nope')
  expect(mockBack).not.toHaveBeenCalled()
})
