// Client for the sshaudit plugin's dedicated endpoints (/api/admin/plugins/
// sshaudit/*). These let an admin view a server's live SSH sessions and its
// SSH login success/failure history.
//
// Wire shapes mirror internal/plugins/sshaudit/routes.go exactly. Unlike the
// servers join (public_alias is a Go sql.NullString → {String,Valid}), every
// field below is a PLAIN JSON value (string/number/boolean or a JSON null on
// nullable columns) — so nullStr() is the WRONG helper here. Guard pid/port
// with `!= null`; never wrap them.
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { authedFetch } from './authed'

const ROOT = '/api/admin/plugins/sshaudit'

// ── per-server config (only configured servers; join with useServers) ──────────

// hostRow in routes.go — plain values. last_collect_at/last_error are nullable
// columns → string-or-null (JSON null, NOT a sql.Null {String,Valid} object).
export type SshauditHost = {
  server_id: number
  enabled: boolean
  poll_interval_seconds: number
  last_collect_at: string | null
  last_error: string | null
}

export function listSshauditHosts(): Promise<SshauditHost[]> {
  return authedFetch<SshauditHost[]>(`${ROOT}/hosts`)
}

// The host-picker / config data source. Only configured servers come back; the
// screen joins these against useServers() for display names.
export function useSshauditHosts(): UseQueryResult<SshauditHost[]> {
  return useQuery({
    queryKey: ['sshaudit-hosts'],
    queryFn: listSshauditHosts,
    refetchInterval: 15000,
  })
}

// Enable/disable collection + optionally set the poll interval.
export function putSshauditHost(
  serverID: number,
  body: { enabled: boolean; poll_interval_seconds?: number },
): Promise<{ ok: true }> {
  return authedFetch<{ ok: true }>(`${ROOT}/hosts/${serverID}`, { method: 'PUT', body })
}

// ── live sessions (current SSH situation) ──────────────────────────────────────

// sessionRow in routes.go — plain values; pid is nullable → number-or-null.
export type SshauditSession = {
  user: string
  source_ip: string
  tty: string
  login_at: string
  pid: number | null
}

export type SshauditSessionsResponse = {
  collected_at: string
  sessions: SshauditSession[]
}

export function fetchSshauditSessions(serverID: number): Promise<SshauditSessionsResponse> {
  return authedFetch<SshauditSessionsResponse>(`${ROOT}/hosts/${serverID}/sessions`)
}

// LIVE query — may 502 {error} when the host is offline; the screen renders a
// graceful retry state off isError. Disabled until a server is picked.
export function useSshauditSessions(serverID: number | null): UseQueryResult<SshauditSessionsResponse> {
  return useQuery({
    queryKey: ['sshaudit-sessions', serverID],
    queryFn: () => fetchSshauditSessions(serverID as number),
    enabled: serverID != null,
  })
}

// ── login history (success/failure events) ─────────────────────────────────────

export type SshauditResult = 'accepted' | 'failed'

// eventRow in routes.go — plain values; port is nullable → number-or-null.
export type SshauditEvent = {
  id: number
  ts: string
  result: SshauditResult
  method: string
  invalid_user: boolean
  username: string
  source_ip: string
  port: number | null
}

// The result filter the History tab drives. 'all' omits the per-result filter.
export type SshauditEventFilter = SshauditResult | 'all'

export function fetchSshauditEvents(
  serverID: number,
  result: SshauditEventFilter = 'all',
  limit: number = 200,
): Promise<SshauditEvent[]> {
  const qs = new URLSearchParams({ result, limit: String(limit) })
  return authedFetch<SshauditEvent[]>(`${ROOT}/hosts/${serverID}/events?${qs.toString()}`)
}

// Newest-first event list. Query key carries the filter so switching All/
// Accepted/Failed refetches cleanly without an effect. Disabled until picked.
export function useSshauditEvents(
  serverID: number | null,
  result: SshauditEventFilter = 'all',
): UseQueryResult<SshauditEvent[]> {
  return useQuery({
    queryKey: ['sshaudit-events', serverID, result],
    queryFn: () => fetchSshauditEvents(serverID as number, result),
    enabled: serverID != null,
  })
}

// ── login summary (24h rollup strip) ───────────────────────────────────────────

// summary in routes.go — all plain values, no sql.Null wrappers.
export type SshauditSummary = {
  window_hours: number
  accepted: number
  failed: number
  unique_source_ips: number
  top_sources: { source_ip: string; count: number; last_ts: string }[]
  top_failed_users: { username: string; count: number }[]
}

export function fetchSshauditSummary(serverID: number): Promise<SshauditSummary> {
  return authedFetch<SshauditSummary>(`${ROOT}/hosts/${serverID}/summary`)
}

export function useSshauditSummary(serverID: number | null): UseQueryResult<SshauditSummary> {
  return useQuery({
    queryKey: ['sshaudit-summary', serverID],
    queryFn: () => fetchSshauditSummary(serverID as number),
    enabled: serverID != null,
  })
}

// ── on-demand collect ──────────────────────────────────────────────────────────

// Force an immediate collection pass. 502 {error} on failure (host offline).
export function collectSshaudit(serverID: number): Promise<{ ok: true; inserted: number }> {
  return authedFetch<{ ok: true; inserted: number }>(`${ROOT}/hosts/${serverID}/collect`, { method: 'POST' })
}
