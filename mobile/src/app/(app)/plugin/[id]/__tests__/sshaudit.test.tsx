import React from 'react'
import { render, fireEvent, waitFor } from '@testing-library/react-native'
import { Alert } from 'react-native'
import SshauditScreen from '../sshaudit'

const mockPush = jest.fn()
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'sshaudit' }),
  useRouter: () => ({ back: jest.fn(), push: mockPush }),
  Stack: Object.assign(() => null, { Screen: () => null }),
}))

type Q = { data?: unknown; isLoading: boolean; isError: boolean; isRefetching: boolean; refetch: jest.Mock }
const ok = (data: unknown): Q => ({ data, isLoading: false, isError: false, isRefetching: false, refetch: jest.fn() })
const loading: Q = { data: undefined, isLoading: true, isError: false, isRefetching: false, refetch: jest.fn() }
const failed: Q = { data: undefined, isLoading: false, isError: true, isRefetching: false, refetch: jest.fn() }

const mockServers = jest.fn<Q, []>()
jest.mock('@/api/servers', () => ({ useServers: () => mockServers() }))

const mockHosts = jest.fn<Q, []>()
const mockSessions = jest.fn<Q, [number | null]>()
const mockEvents = jest.fn<Q, [number | null, string]>()
const mockSummary = jest.fn<Q, [number | null]>()
const mockCollect = jest.fn().mockResolvedValue({ ok: true, inserted: 3 })
jest.mock('@/api/sshaudit', () => ({
  useSshauditHosts: () => mockHosts(),
  useSshauditSessions: (sid: number | null) => mockSessions(sid),
  useSshauditEvents: (sid: number | null, result: string) => mockEvents(sid, result),
  useSshauditSummary: (sid: number | null) => mockSummary(sid),
  collectSshaudit: (...a: unknown[]) => mockCollect(...a),
}))

// Wire fixtures — server public_alias as Go sql.NullString {String,Valid}.
const SERVERS = [
  { id: 7, name: 'alpha', connected: true, latest: null },
  { id: 9, name: 'beta', connected: true, latest: null, public_alias: { String: 'edge-9', Valid: true } },
]
const HOSTS = [
  { server_id: 7, enabled: true, poll_interval_seconds: 60, last_collect_at: new Date(Date.now() - 30_000).toISOString(), last_error: null },
  { server_id: 9, enabled: false, poll_interval_seconds: 300, last_collect_at: null, last_error: 'ssh dial failed' },
]
const SESSIONS = {
  collected_at: new Date(Date.now() - 10_000).toISOString(),
  sessions: [
    { user: 'root', source_ip: '203.0.113.7', tty: 'pts/0', login_at: new Date(Date.now() - 600_000).toISOString(), pid: 4821 },
    { user: 'deploy', source_ip: '198.51.100.3', tty: 'pts/1', login_at: new Date(Date.now() - 120_000).toISOString(), pid: null },
  ],
}
const EVENTS = [
  { id: 30, ts: new Date(Date.now() - 60_000).toISOString(), result: 'failed', method: 'password', invalid_user: true, username: 'admin', source_ip: '203.0.113.9', port: 51234 },
  { id: 29, ts: new Date(Date.now() - 90_000).toISOString(), result: 'accepted', method: 'publickey', invalid_user: false, username: 'root', source_ip: '203.0.113.7', port: null },
]
const SUMMARY = {
  window_hours: 24,
  accepted: 12,
  failed: 87,
  unique_source_ips: 9,
  top_sources: [{ source_ip: '203.0.113.9', count: 60, last_ts: new Date().toISOString() }],
  top_failed_users: [{ username: 'admin', count: 40 }],
}

beforeEach(() => {
  jest.clearAllMocks()
  mockServers.mockReturnValue(ok(SERVERS))
  mockHosts.mockReturnValue(ok(HOSTS))
  mockSessions.mockReturnValue(ok(SESSIONS))
  mockEvents.mockReturnValue(ok(EVENTS))
  mockSummary.mockReturnValue(ok(SUMMARY))
  jest.spyOn(Alert, 'alert').mockImplementation(() => {})
})

// ── Sessions tab ─────────────────────────────────────────────────────────────

test('Sessions: lists live sessions for the first configured host by default', () => {
  const { getByText, getByTestId } = render(<SshauditScreen />)
  // server 7 is the first configured host → default selection
  expect(mockSessions).toHaveBeenCalledWith(7)
  expect(getByText('root')).toBeTruthy()
  expect(getByText('deploy')).toBeTruthy()
  expect(getByTestId('session-0')).toBeTruthy()
  // source_ip + pid render (pid null on session 1 → no pid suffix)
  expect(getByText(/203\.0\.113\.7 · pid 4821/)).toBeTruthy()
  expect(getByText('198.51.100.3')).toBeTruthy()
})

test('Sessions: a 502 / host-offline error shows a graceful retry state', () => {
  const fq = { ...failed, refetch: jest.fn() }
  mockSessions.mockReturnValue(fq)
  const { getByText } = render(<SshauditScreen />)
  expect(getByText(/Host offline/)).toBeTruthy()
  fireEvent.press(getByText('Retry'))
  expect(fq.refetch).toHaveBeenCalled()
})

test('Sessions: empty session set shows an empty state', () => {
  mockSessions.mockReturnValue(ok({ collected_at: new Date().toISOString(), sessions: [] }))
  const { getByText } = render(<SshauditScreen />)
  expect(getByText('No active SSH sessions.')).toBeTruthy()
})

test('Sessions: Collect now POSTs collect then refetches', async () => {
  const refetch = jest.fn()
  mockSessions.mockReturnValue({ ...ok(SESSIONS), refetch })
  const { getByTestId } = render(<SshauditScreen />)
  fireEvent.press(getByTestId('collect-now'))
  await waitFor(() => expect(mockCollect).toHaveBeenCalledWith(7))
  await waitFor(() => expect(refetch).toHaveBeenCalled())
})

test('Sessions: picking another host chip re-queries sessions for it', () => {
  const { getByTestId } = render(<SshauditScreen />)
  expect(mockSessions).toHaveBeenLastCalledWith(7)
  fireEvent.press(getByTestId('host-9'))
  expect(mockSessions).toHaveBeenLastCalledWith(9)
})

test('Sessions: host chips render server names via nullStr(public_alias)||name', () => {
  const { getByText } = render(<SshauditScreen />)
  expect(getByText('alpha')).toBeTruthy()
  expect(getByText('edge-9')).toBeTruthy()
})

// ── History tab ───────────────────────────────────────────────────────────────

const gotoHistory = (getByText: (t: string) => unknown) => fireEvent.press(getByText('History') as never)

test('History: renders accepted/failed pills + invalid badge for the events', () => {
  const { getByText, getByTestId } = render(<SshauditScreen />)
  gotoHistory(getByText)
  expect(mockEvents).toHaveBeenCalledWith(7, 'all')
  // result pills
  expect(getByText('failed')).toBeTruthy()
  expect(getByText('accepted')).toBeTruthy()
  // usernames + invalid badge on the invalid_user event (id 30)
  expect(getByText('admin')).toBeTruthy()
  expect(getByTestId('event-invalid-30')).toBeTruthy()
  // port renders on event 30, absent on null-port event 29
  expect(getByText(/203\.0\.113\.9:51234 · password/)).toBeTruthy()
})

test('History: summary strip shows 24h accepted/failed/unique-IP counts', () => {
  const { getByText } = render(<SshauditScreen />)
  gotoHistory(getByText)
  expect(getByText('12 accepted')).toBeTruthy()
  expect(getByText('87 failed')).toBeTruthy()
  expect(getByText('9 IPs')).toBeTruthy()
})

test('History: result filter switches the events query (Failed)', () => {
  const { getByText } = render(<SshauditScreen />)
  gotoHistory(getByText)
  expect(mockEvents).toHaveBeenLastCalledWith(7, 'all')
  fireEvent.press(getByText('Failed'))
  expect(mockEvents).toHaveBeenLastCalledWith(7, 'failed')
})

test('History: empty event set shows an empty state', () => {
  mockEvents.mockReturnValue(ok([]))
  const { getByText } = render(<SshauditScreen />)
  gotoHistory(getByText)
  expect(getByText('No login events recorded.')).toBeTruthy()
})

test('History: a load error offers retry', () => {
  const fq = { ...failed, refetch: jest.fn() }
  mockEvents.mockReturnValue(fq)
  const { getByText } = render(<SshauditScreen />)
  gotoHistory(getByText)
  fireEvent.press(getByText('Retry'))
  expect(fq.refetch).toHaveBeenCalled()
})

// ── host-level states ───────────────────────────────────────────────────────────

test('no configured hosts shows guidance', () => {
  mockHosts.mockReturnValue(ok([]))
  const { getByText } = render(<SshauditScreen />)
  expect(getByText(/No SSH audit hosts/)).toBeTruthy()
})

test('hosts loading shows a spinner', () => {
  mockHosts.mockReturnValue(loading)
  const { getByTestId } = render(<SshauditScreen />)
  expect(getByTestId('hosts-loading')).toBeTruthy()
})

test('hosts error offers retry', () => {
  const fq = { ...failed, refetch: jest.fn() }
  mockHosts.mockReturnValue(fq)
  const { getByText } = render(<SshauditScreen />)
  fireEvent.press(getByText('Retry'))
  expect(fq.refetch).toHaveBeenCalled()
})
