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
const mockEvents = jest.fn<Q, [number | null, string, string]>()
const mockSummary = jest.fn<Q, [number | null, string]>()
const mockFail2ban = jest.fn<Q, [number | null]>()
const mockCollect = jest.fn().mockResolvedValue({ ok: true, inserted: 3 })
const mockSetFail2ban = jest.fn().mockResolvedValue({ installed: true, active: true, currently_banned: 0, total_banned: 0, banned_ips: [] })
jest.mock('@/api/sshaudit', () => ({
  useSshauditHosts: () => mockHosts(),
  useSshauditSessions: (sid: number | null) => mockSessions(sid),
  useSshauditEvents: (sid: number | null, result: string, window: string) => mockEvents(sid, result, window),
  useSshauditSummary: (sid: number | null, window: string) => mockSummary(sid, window),
  useSshauditFail2ban: (sid: number | null) => mockFail2ban(sid),
  collectSshaudit: (...a: unknown[]) => mockCollect(...a),
  setSshauditFail2ban: (...a: unknown[]) => mockSetFail2ban(...a),
}))

// Wire fixtures — server public_alias as Go sql.NullString {String,Valid}.
const SERVERS = [
  { id: 7, name: 'alpha', connected: true, latest: null },
  { id: 9, name: 'beta', connected: true, latest: null, public_alias: { String: 'edge-9', Valid: true } },
]
const HOSTS = [
  { server_id: 7, enabled: true, poll_interval_seconds: 60, last_collect_at: new Date(Date.now() - 30_000).toISOString(), last_error: null, accepted_24h: 12, failed_24h: 87 },
  { server_id: 9, enabled: false, poll_interval_seconds: 300, last_collect_at: null, last_error: 'ssh dial failed', accepted_24h: 0, failed_24h: 0 },
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
const FAIL2BAN = {
  installed: true,
  active: true,
  currently_banned: 3,
  total_banned: 41,
  banned_ips: ['203.0.113.9', '198.51.100.3', '192.0.2.4'],
  max_retry: 5,
  find_time: 600,
  ban_time: 3600,
}

beforeEach(() => {
  jest.clearAllMocks()
  mockServers.mockReturnValue(ok(SERVERS))
  mockHosts.mockReturnValue(ok(HOSTS))
  mockSessions.mockReturnValue(ok(SESSIONS))
  mockEvents.mockReturnValue(ok(EVENTS))
  mockSummary.mockReturnValue(ok(SUMMARY))
  mockFail2ban.mockReturnValue(ok(FAIL2BAN))
  mockSetFail2ban.mockResolvedValue({ installed: true, active: true, currently_banned: 0, total_banned: 41, banned_ips: [] })
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

test('Sessions: host chips show the per-host 24h ✓N ✗M login tally', () => {
  const { getByText, getByTestId } = render(<SshauditScreen />)
  // host 7 tally: 12 accepted / 87 failed (split across colored Text spans)
  expect(getByTestId('host-tally-7')).toBeTruthy()
  expect(getByText('✓12')).toBeTruthy()
  expect(getByText('✗87')).toBeTruthy()
  // host 9 tally: zeros
  expect(getByText('✓0')).toBeTruthy()
  expect(getByText('✗0')).toBeTruthy()
})

// ── History tab ───────────────────────────────────────────────────────────────

const gotoHistory = (getByText: (t: string) => unknown) => fireEvent.press(getByText('History') as never)

test('History: renders accepted/failed pills + invalid badge for the events', () => {
  const { getByText, getByTestId } = render(<SshauditScreen />)
  gotoHistory(getByText)
  expect(mockEvents).toHaveBeenCalledWith(7, 'all', '24h')
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
  expect(mockEvents).toHaveBeenLastCalledWith(7, 'all', '24h')
  fireEvent.press(getByText('Failed'))
  expect(mockEvents).toHaveBeenLastCalledWith(7, 'failed', '24h')
})

test('History: window Segmented switches both the events and summary queries', () => {
  const { getByText } = render(<SshauditScreen />)
  gotoHistory(getByText)
  expect(mockEvents).toHaveBeenLastCalledWith(7, 'all', '24h')
  expect(mockSummary).toHaveBeenLastCalledWith(7, '24h')
  fireEvent.press(getByText('7d'))
  expect(mockEvents).toHaveBeenLastCalledWith(7, 'all', '7d')
  expect(mockSummary).toHaveBeenLastCalledWith(7, '7d')
  fireEvent.press(getByText('30d'))
  expect(mockEvents).toHaveBeenLastCalledWith(7, 'all', '30d')
  expect(mockSummary).toHaveBeenLastCalledWith(7, '30d')
})

test('History: shows the summary-reflects-window label', () => {
  const { getByText } = render(<SshauditScreen />)
  gotoHistory(getByText)
  expect(getByText('summary reflects window')).toBeTruthy()
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

// ── Hardening tab ─────────────────────────────────────────────────────────────

const gotoHardening = (getByText: (t: string) => unknown) => fireEvent.press(getByText('Hardening') as never)

test('Hardening: fetches fail2ban status for the first host and shows installed/active state', () => {
  const { getByText, getByTestId } = render(<SshauditScreen />)
  gotoHardening(getByText)
  expect(mockFail2ban).toHaveBeenCalledWith(7)
  expect(getByText('active')).toBeTruthy()
  expect(getByTestId('fail2ban-switch')).toBeTruthy()
})

test('Hardening: renders currently-banned + total-banned counts and the banned IP list', () => {
  const { getByText, getByTestId } = render(<SshauditScreen />)
  gotoHardening(getByText)
  expect(getByText('3')).toBeTruthy() // currently banned
  expect(getByText('41')).toBeTruthy() // total banned
  expect(getByText('currently banned')).toBeTruthy()
  expect(getByText('total banned')).toBeTruthy()
  // banned IP rows (mono)
  expect(getByText('203.0.113.9')).toBeTruthy()
  expect(getByText('198.51.100.3')).toBeTruthy()
  expect(getByTestId('banned-0')).toBeTruthy()
})

test('Hardening: renders the ban policy line when installed+active with policy values', () => {
  const { getByText, getByTestId } = render(<SshauditScreen />)
  gotoHardening(getByText)
  expect(getByTestId('fail2ban-policy')).toBeTruthy()
  // "5 failed attempts within 10m → ban for 1h" — humanized seconds
  expect(getByText(/5 failed attempts within 10m → ban for 1h/)).toBeTruthy()
})

test('Hardening: hides the ban policy line when policy values are 0', () => {
  mockFail2ban.mockReturnValue(ok({ ...FAIL2BAN, max_retry: 0, find_time: 0, ban_time: 0 }))
  const { getByText, queryByTestId } = render(<SshauditScreen />)
  gotoHardening(getByText)
  expect(queryByTestId('fail2ban-policy')).toBeNull()
})

test('Hardening: a 502 / host-offline error shows a graceful retry state', () => {
  const fq = { ...failed, refetch: jest.fn() }
  mockFail2ban.mockReturnValue(fq)
  const { getByText } = render(<SshauditScreen />)
  gotoHardening(getByText)
  expect(getByText(/Host offline/)).toBeTruthy()
  fireEvent.press(getByText('Retry'))
  expect(fq.refetch).toHaveBeenCalled()
})

test('Hardening: not-installed shows an Enable hardening CTA', () => {
  mockFail2ban.mockReturnValue(ok({ installed: false, active: false, currently_banned: 0, total_banned: 0, banned_ips: [] }))
  const { getByText, getByTestId } = render(<SshauditScreen />)
  gotoHardening(getByText)
  expect(getByText('fail2ban is not installed')).toBeTruthy()
  expect(getByTestId('fail2ban-enable')).toBeTruthy()
})

test('Hardening: enabling confirms via Alert then calls setSshauditFail2ban(true)', async () => {
  // Make the Alert "Enable" button fire its onPress synchronously.
  jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
    const enable = (buttons ?? []).find((b) => b.text === 'Enable')
    enable?.onPress?.()
  })
  mockFail2ban.mockReturnValue(ok({ installed: false, active: false, currently_banned: 0, total_banned: 0, banned_ips: [] }))
  const refetch = jest.fn()
  mockFail2ban.mockReturnValue({ ...ok({ installed: false, active: false, currently_banned: 0, total_banned: 0, banned_ips: [] }), refetch })
  const { getByText, getByTestId } = render(<SshauditScreen />)
  gotoHardening(getByText)
  fireEvent.press(getByTestId('fail2ban-enable'))
  expect(Alert.alert).toHaveBeenCalled()
  await waitFor(() => expect(mockSetFail2ban).toHaveBeenCalledWith(7, true))
  await waitFor(() => expect(refetch).toHaveBeenCalled())
})

test('Hardening: toggling the switch off disables fail2ban without an Alert', async () => {
  const refetch = jest.fn()
  mockFail2ban.mockReturnValue({ ...ok(FAIL2BAN), refetch })
  const { getByText, getByTestId } = render(<SshauditScreen />)
  gotoHardening(getByText)
  fireEvent(getByTestId('fail2ban-switch'), 'press')
  expect(Alert.alert).not.toHaveBeenCalled()
  await waitFor(() => expect(mockSetFail2ban).toHaveBeenCalledWith(7, false))
  await waitFor(() => expect(refetch).toHaveBeenCalled())
})

test('Hardening: picking another host chip re-queries fail2ban for it', () => {
  const { getByText, getByTestId } = render(<SshauditScreen />)
  gotoHardening(getByText)
  expect(mockFail2ban).toHaveBeenLastCalledWith(7)
  fireEvent.press(getByTestId('host-9'))
  expect(mockFail2ban).toHaveBeenLastCalledWith(9)
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
