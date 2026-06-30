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
  // This host's SSH login tally over the last 24h — plain numbers (zeros until
  // the poller collects), no sql.Null wrappers.
  accepted_24h: number
  failed_24h: number
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

// The time window the History tab drives. Maps to summary.window_hours
// 24/168/720 server-side; threaded into the events + summary querystrings.
export type SshauditWindow = '24h' | '7d' | '30d'

export function fetchSshauditEvents(
  serverID: number,
  result: SshauditEventFilter = 'all',
  window: SshauditWindow = '24h',
  limit: number = 200,
): Promise<SshauditEvent[]> {
  const qs = new URLSearchParams({ result, limit: String(limit), window })
  return authedFetch<SshauditEvent[]>(`${ROOT}/hosts/${serverID}/events?${qs.toString()}`)
}

// Newest-first event list. Query key carries the filter + window so switching
// All/Accepted/Failed or 24h/7d/30d refetches cleanly without an effect.
// Disabled until picked.
export function useSshauditEvents(
  serverID: number | null,
  result: SshauditEventFilter = 'all',
  window: SshauditWindow = '24h',
): UseQueryResult<SshauditEvent[]> {
  return useQuery({
    queryKey: ['sshaudit-events', serverID, result, window],
    queryFn: () => fetchSshauditEvents(serverID as number, result, window),
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

export function fetchSshauditSummary(
  serverID: number,
  window: SshauditWindow = '24h',
): Promise<SshauditSummary> {
  const qs = new URLSearchParams({ window })
  return authedFetch<SshauditSummary>(`${ROOT}/hosts/${serverID}/summary?${qs.toString()}`)
}

// Window-scoped rollup. Query key carries the window so 24h/7d/30d switches
// refetch the right summary (window_hours comes back 24/168/720).
export function useSshauditSummary(
  serverID: number | null,
  window: SshauditWindow = '24h',
): UseQueryResult<SshauditSummary> {
  return useQuery({
    queryKey: ['sshaudit-summary', serverID, window],
    queryFn: () => fetchSshauditSummary(serverID as number, window),
    enabled: serverID != null,
  })
}

// ── fleet-wide 24h overview (plugins-list badge) ────────────────────────────────

// overview in routes.go — fleet-wide accepted/failed login tally over a fixed
// 24h window. All plain numbers (zeros until the poller collects); no sql.Null.
export type SshauditOverview = {
  window_hours: number
  accepted: number
  failed: number
}

export function fetchSshauditOverview(): Promise<SshauditOverview> {
  return authedFetch<SshauditOverview>(`${ROOT}/overview`)
}

// Drives the compact 24h badge on the plugins list. Gated by `enabled` so we
// only hit the endpoint when the sshaudit plugin is actually turned on.
export function useSshauditOverview(enabled: boolean): UseQueryResult<SshauditOverview> {
  return useQuery({
    queryKey: ['sshaudit-overview'],
    queryFn: fetchSshauditOverview,
    enabled,
  })
}

// ── on-demand collect ──────────────────────────────────────────────────────────

// Force an immediate collection pass. 502 {error} on failure (host offline).
export function collectSshaudit(serverID: number): Promise<{ ok: true; inserted: number }> {
  return authedFetch<{ ok: true; inserted: number }>(`${ROOT}/hosts/${serverID}/collect`, { method: 'POST' })
}

// ── fail2ban hardening (per host) ───────────────────────────────────────────────

// fail2banStatus in routes.go — all plain values, no sql.Null wrappers.
// fail2ban is an SSH brute-force mitigation; this is defensive hardening of the
// operator's own managed hosts (install + enable/disable the local service).
export type SshauditFail2ban = {
  installed: boolean
  active: boolean
  currently_banned: number
  total_banned: number
  banned_ips: string[]
  // The ban policy: max_retry failed attempts within find_time seconds → a
  // ban of ban_time seconds. All 0 when unknown. Plain numbers, no sql.Null.
  max_retry: number
  find_time: number
  ban_time: number
}

export function fetchSshauditFail2ban(serverID: number): Promise<SshauditFail2ban> {
  return authedFetch<SshauditFail2ban>(`${ROOT}/hosts/${serverID}/fail2ban`)
}

// LIVE query — may 502 {error} when the host is offline; the Hardening tab
// renders a graceful retry/offline state off isError. Disabled until picked.
export function useSshauditFail2ban(serverID: number | null): UseQueryResult<SshauditFail2ban> {
  return useQuery({
    queryKey: ['sshaudit-fail2ban', serverID],
    queryFn: () => fetchSshauditFail2ban(serverID as number),
    enabled: serverID != null,
  })
}

// Enable installs the package + starts the service (can be slow → busy state);
// disable stops it. Returns the resulting status. 502 {error} on host offline.
export function setSshauditFail2ban(serverID: number, enabled: boolean): Promise<SshauditFail2ban> {
  return authedFetch<SshauditFail2ban>(`${ROOT}/hosts/${serverID}/fail2ban`, {
    method: 'POST',
    body: { enabled },
  })
}
