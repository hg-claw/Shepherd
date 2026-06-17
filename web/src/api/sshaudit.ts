// Client for /api/admin/plugins/sshaudit/*.
//
// Wire shape mirrors the backend handler exactly; if a JSON-tag here drifts
// from the server's struct tag the TS compiler keeps shipping but the
// rendered UI silently misses data. Keep these in sync.
import { api } from './client'

const ROOT = '/api/admin/plugins/sshaudit'

// One row per *configured* server (i.e. a host with an sshaudit config row).
// Join with useServers() in the UI to render every server.
export interface SSHAuditHost {
  server_id: number
  enabled: boolean
  poll_interval_seconds: number
  last_collect_at: string | null
  last_error: string | null
}

// A live SSH session as reported by the agent. pid is null when the agent
// can't attribute the session to a process.
export interface SSHSession {
  user: string
  source_ip: string
  tty: string
  login_at: string
  pid: number | null
}

export interface SSHSessionsResponse {
  collected_at: string
  sessions: SSHSession[]
}

export type SSHEventResult = 'accepted' | 'failed'

// A single sshd auth log line, parsed. invalid_user marks an attempt against
// a username that doesn't exist on the box. port is null when sshd didn't
// report it.
export interface SSHEvent {
  id: number
  ts: string
  result: SSHEventResult
  method: string
  invalid_user: boolean
  username: string
  source_ip: string
  port: number | null
}

export interface SSHTopSource {
  source_ip: string
  count: number
  last_ts: string
}

export interface SSHTopFailedUser {
  username: string
  count: number
}

export interface SSHAuditSummary {
  window_hours: number
  accepted: number
  failed: number
  unique_source_ips: number
  top_sources: SSHTopSource[]
  top_failed_users: SSHTopFailedUser[]
}

// Rolling window for the login-history views. The summary/events endpoints
// map these to window_hours of 24 / 168 / 720 respectively.
export type SSHAuditWindow = '24h' | '7d' | '30d'

// fail2ban status for a host. installed=false means the package isn't present;
// active=false means it's installed but the service isn't running. May 502
// {error} when the host is offline — callers handle the APIError gracefully.
export interface SSHFail2banStatus {
  installed: boolean
  active: boolean
  currently_banned: number
  total_banned: number
  banned_ips: string[]
}

// 1. List configured hosts (only servers with a config row).
export const listSSHAuditHosts = () =>
  api.get<SSHAuditHost[]>(`${ROOT}/hosts`)

// 2. Enable/disable a host and set its poll interval. The interval is
//    clamped server-side to >= 60s; we mirror that clamp in the UI.
export const putSSHAuditHost = (
  serverID: number,
  body: { enabled: boolean; poll_interval_seconds?: number },
) => api.put<{ ok: true }>(`${ROOT}/hosts/${serverID}`, body)

// 3. Live current sessions. May 502 with {error} when the host is offline /
//    has no agent — callers handle the APIError gracefully.
export const fetchSSHAuditSessions = (serverID: number) =>
  api.get<SSHSessionsResponse>(`${ROOT}/hosts/${serverID}/sessions`)

// 4. Login history. result filters accepted|failed|all; window scopes to the
//    selected rolling window (default 24h); newest first.
export const fetchSSHAuditEvents = (
  serverID: number,
  params: { result?: 'accepted' | 'failed' | 'all'; limit?: number; window?: SSHAuditWindow } = {},
) => {
  const q = new URLSearchParams()
  if (params.result) q.set('result', params.result)
  if (params.limit != null) q.set('limit', String(params.limit))
  if (params.window) q.set('window', params.window)
  const qs = q.toString()
  return api.get<SSHEvent[]>(`${ROOT}/hosts/${serverID}/events${qs ? '?' + qs : ''}`)
}

// 5. Rolling-window summary (counts + top sources / failed users). window
//    selects the span; the response's window_hours echoes 24 / 168 / 720.
export const fetchSSHAuditSummary = (serverID: number, params: { window?: SSHAuditWindow } = {}) => {
  const q = new URLSearchParams()
  if (params.window) q.set('window', params.window)
  const qs = q.toString()
  return api.get<SSHAuditSummary>(`${ROOT}/hosts/${serverID}/summary${qs ? '?' + qs : ''}`)
}

// 6. Force a collection now. 502 {error} on failure.
export const collectSSHAuditHost = (serverID: number) =>
  api.post<{ ok: true; inserted: number }>(`${ROOT}/hosts/${serverID}/collect`, {})

// 7. fail2ban status for a host. May 502 {error} when the host is offline.
export const fetchSSHAuditFail2ban = (serverID: number) =>
  api.get<SSHFail2banStatus>(`${ROOT}/hosts/${serverID}/fail2ban`)

// 8. Enable (install+configure+start) or disable (stop) fail2ban on a host.
//    Enabling can take a while (installs the package); returns the resulting
//    status. 502 {error} when the host is offline.
export const setSSHAuditFail2ban = (serverID: number, enabled: boolean) =>
  api.post<SSHFail2banStatus>(`${ROOT}/hosts/${serverID}/fail2ban`, { enabled })
