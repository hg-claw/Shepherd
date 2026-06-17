import React from 'react'
import { renderHook, waitFor } from '@testing-library/react-native'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  listSshauditHosts, putSshauditHost,
  fetchSshauditSessions, useSshauditSessions,
  fetchSshauditEvents, useSshauditEvents,
  fetchSshauditSummary, useSshauditSummary,
  fetchSshauditFail2ban, useSshauditFail2ban, setSshauditFail2ban,
  collectSshaudit,
  useSshauditHosts,
} from '../sshaudit'
jest.mock('../authed', () => ({ authedFetch: jest.fn() }))
import { authedFetch } from '../authed'

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

beforeEach(() => { (authedFetch as jest.Mock).mockReset() })

// ── hosts (config) ──────────────────────────────────────────────────────────────

// hostRow wire shape: plain values; last_collect_at/last_error are nullable
// columns → string-or-JSON-null, NOT sql.Null {String,Valid}.
const WIRE_HOSTS = [
  { server_id: 7, enabled: true, poll_interval_seconds: 60, last_collect_at: '2026-06-16T01:00:00Z', last_error: null },
  { server_id: 9, enabled: false, poll_interval_seconds: 300, last_collect_at: null, last_error: 'ssh dial failed' },
]

test('listSshauditHosts GETs the /hosts path and surfaces null/plain values', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue(WIRE_HOSTS)
  const rows = await listSshauditHosts()
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/sshaudit/hosts')
  expect(rows[0].last_error).toBeNull() // JSON null survives (no nullStr coercion)
  expect(rows[0].last_collect_at).toBe('2026-06-16T01:00:00Z')
  expect(rows[1].last_collect_at).toBeNull()
  expect(rows[1].last_error).toBe('ssh dial failed')
})

test('useSshauditHosts queries /hosts and exposes config rows', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue(WIRE_HOSTS)
  const { result } = renderHook(() => useSshauditHosts(), { wrapper })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/sshaudit/hosts')
  expect((result.current.data ?? []).filter((h) => h.enabled).length).toBe(1)
})

test('putSshauditHost PUTs enabled + optional poll interval', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue({ ok: true })
  await putSshauditHost(7, { enabled: true, poll_interval_seconds: 120 })
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/sshaudit/hosts/7', {
    method: 'PUT',
    body: { enabled: true, poll_interval_seconds: 120 },
  })
})

test('putSshauditHost can omit the poll interval (enable only)', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue({ ok: true })
  await putSshauditHost(9, { enabled: false })
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/sshaudit/hosts/9', {
    method: 'PUT',
    body: { enabled: false },
  })
})

// ── live sessions ───────────────────────────────────────────────────────────────

// sessionsResponse wire shape: collected_at + sessions[]; pid is nullable.
const WIRE_SESSIONS = {
  collected_at: '2026-06-16T01:05:00Z',
  sessions: [
    { user: 'root', source_ip: '203.0.113.7', tty: 'pts/0', login_at: '2026-06-16T00:50:00Z', pid: 4821 },
    { user: 'deploy', source_ip: '198.51.100.3', tty: 'pts/1', login_at: '2026-06-16T01:00:00Z', pid: null },
  ],
}

test('fetchSshauditSessions GETs the per-host /sessions path', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue(WIRE_SESSIONS)
  const res = await fetchSshauditSessions(7)
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/sshaudit/hosts/7/sessions')
  expect(res.sessions).toHaveLength(2)
  expect(res.sessions[1].pid).toBeNull() // nullable pid survives
})

test('useSshauditSessions is disabled without a server and resolves with one', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue(WIRE_SESSIONS)
  renderHook(() => useSshauditSessions(null), { wrapper })
  expect(authedFetch).not.toHaveBeenCalled()
  const { result } = renderHook(() => useSshauditSessions(7), { wrapper })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/sshaudit/hosts/7/sessions')
  expect(result.current.data?.sessions).toHaveLength(2)
})

// ── login events ────────────────────────────────────────────────────────────────

// eventRow wire shape: plain values; invalid_user boolean, port nullable.
const WIRE_EVENTS = [
  { id: 30, ts: '2026-06-16T01:02:00Z', result: 'failed', method: 'password', invalid_user: true, username: 'admin', source_ip: '203.0.113.9', port: 51234 },
  { id: 29, ts: '2026-06-16T01:01:00Z', result: 'accepted', method: 'publickey', invalid_user: false, username: 'root', source_ip: '203.0.113.7', port: null },
]

test('fetchSshauditEvents GETs /events with result=all + limit + window=24h by default', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue(WIRE_EVENTS)
  const rows = await fetchSshauditEvents(7)
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/sshaudit/hosts/7/events?result=all&limit=200&window=24h')
  expect(rows[0].result).toBe('failed')
  expect(rows[0].invalid_user).toBe(true)
  expect(rows[1].port).toBeNull() // nullable port survives
})

test('fetchSshauditEvents passes the result filter through', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue([])
  await fetchSshauditEvents(7, 'failed')
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/sshaudit/hosts/7/events?result=failed&limit=200&window=24h')
})

test('fetchSshauditEvents threads the time window into the querystring', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue([])
  await fetchSshauditEvents(7, 'all', '7d')
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/sshaudit/hosts/7/events?result=all&limit=200&window=7d')
  await fetchSshauditEvents(7, 'failed', '30d')
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/sshaudit/hosts/7/events?result=failed&limit=200&window=30d')
})

test('useSshauditEvents is disabled without a server and carries the filter + window into the key', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue(WIRE_EVENTS)
  renderHook(() => useSshauditEvents(null, 'all'), { wrapper })
  expect(authedFetch).not.toHaveBeenCalled()
  const { result } = renderHook(() => useSshauditEvents(7, 'accepted', '7d'), { wrapper })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/sshaudit/hosts/7/events?result=accepted&limit=200&window=7d')
})

// ── summary ─────────────────────────────────────────────────────────────────────

const WIRE_SUMMARY = {
  window_hours: 24,
  accepted: 12,
  failed: 87,
  unique_source_ips: 9,
  top_sources: [{ source_ip: '203.0.113.9', count: 60, last_ts: '2026-06-16T01:02:00Z' }],
  top_failed_users: [{ username: 'admin', count: 40 }],
}

test('fetchSshauditSummary GETs the per-host /summary path with window=24h by default', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue(WIRE_SUMMARY)
  const res = await fetchSshauditSummary(7)
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/sshaudit/hosts/7/summary?window=24h')
  expect(res.window_hours).toBe(24)
  expect(res.failed).toBe(87)
  expect(res.top_sources[0].source_ip).toBe('203.0.113.9')
})

test('fetchSshauditSummary threads the time window into the querystring', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue({ ...WIRE_SUMMARY, window_hours: 720 })
  const res = await fetchSshauditSummary(7, '30d')
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/sshaudit/hosts/7/summary?window=30d')
  expect(res.window_hours).toBe(720)
})

test('useSshauditSummary is disabled without a server and carries the window into the key', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue(WIRE_SUMMARY)
  renderHook(() => useSshauditSummary(null), { wrapper })
  expect(authedFetch).not.toHaveBeenCalled()
  const { result } = renderHook(() => useSshauditSummary(7, '7d'), { wrapper })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/sshaudit/hosts/7/summary?window=7d')
})

// ── collect ─────────────────────────────────────────────────────────────────────

test('collectSshaudit POSTs the per-host /collect path and returns inserted count', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue({ ok: true, inserted: 5 })
  const res = await collectSshaudit(7)
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/sshaudit/hosts/7/collect', { method: 'POST' })
  expect(res.inserted).toBe(5)
})

// ── fail2ban hardening ────────────────────────────────────────────────────────

// fail2banStatus wire shape: all plain values, banned_ips is a plain string[].
const WIRE_FAIL2BAN = {
  installed: true,
  active: true,
  currently_banned: 3,
  total_banned: 41,
  banned_ips: ['203.0.113.9', '198.51.100.3', '192.0.2.4'],
  max_retry: 5,
  find_time: 600,
  ban_time: 3600,
}

test('fetchSshauditFail2ban GETs the per-host /fail2ban path and surfaces plain values', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue(WIRE_FAIL2BAN)
  const res = await fetchSshauditFail2ban(7)
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/sshaudit/hosts/7/fail2ban')
  expect(res.installed).toBe(true)
  expect(res.active).toBe(true)
  expect(res.currently_banned).toBe(3)
  expect(res.total_banned).toBe(41)
  expect(res.banned_ips).toEqual(['203.0.113.9', '198.51.100.3', '192.0.2.4'])
  // ban policy fields survive as plain numbers
  expect(res.max_retry).toBe(5)
  expect(res.find_time).toBe(600)
  expect(res.ban_time).toBe(3600)
})

test('useSshauditFail2ban is disabled without a server and resolves with one', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue(WIRE_FAIL2BAN)
  renderHook(() => useSshauditFail2ban(null), { wrapper })
  expect(authedFetch).not.toHaveBeenCalled()
  const { result } = renderHook(() => useSshauditFail2ban(7), { wrapper })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/sshaudit/hosts/7/fail2ban')
  expect(result.current.data?.currently_banned).toBe(3)
})

test('setSshauditFail2ban POSTs {enabled:true} and returns the resulting status', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue(WIRE_FAIL2BAN)
  const res = await setSshauditFail2ban(7, true)
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/sshaudit/hosts/7/fail2ban', {
    method: 'POST',
    body: { enabled: true },
  })
  expect(res.active).toBe(true)
})

test('setSshauditFail2ban POSTs {enabled:false} to disable', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue({ ...WIRE_FAIL2BAN, active: false, currently_banned: 0, banned_ips: [] })
  const res = await setSshauditFail2ban(9, false)
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/sshaudit/hosts/9/fail2ban', {
    method: 'POST',
    body: { enabled: false },
  })
  expect(res.active).toBe(false)
})
