import { api } from './client'

export interface PluginMeta {
  name: string
  description: string
  icon: string
  category: string
  host_aware: boolean
}

export interface PluginEntry {
  id: string
  meta: PluginMeta
  enabled: boolean
  enabled_at: string | null
  host_count: number | null
}

export interface PluginHost {
  id: number
  server_id: number
  config: unknown
  deployed_version: string | null
  status: 'pending' | 'deploying' | 'running' | 'failed' | 'stopped'
  last_error: string | null
  updated_at: string
}

export interface PluginEvent {
  ts: string
  admin_id: number | null
  server_id: number | null
  action: string
  result: string
  details: unknown
}

export interface XrayTopologyRow {
  role: 'landing' | 'relay'
  upstream_server_id: number | null
  upstream_name: string | null
}

// Map keyed by server_id (string in JSON, number for callers).
// Servers without an xray deployment are simply absent.
export const fetchXrayTopology = async (): Promise<Map<number, XrayTopologyRow>> => {
  const raw = await api.get<Record<string, XrayTopologyRow>>('/api/admin/plugins/xray/topology')
  const out = new Map<number, XrayTopologyRow>()
  for (const [k, v] of Object.entries(raw)) out.set(Number(k), v)
  return out
}

export const listPlugins = () => api.get<PluginEntry[]>('/api/admin/plugins')

export const enablePlugin = (id: string) =>
  api.post<{ enabled: boolean }>(`/api/admin/plugins/${id}/enable`, {})

export const disablePlugin = (id: string) =>
  api.post<{ enabled: boolean }>(`/api/admin/plugins/${id}/disable`, {})

export const getPluginConfig = (id: string) =>
  api.get<Record<string, unknown>>(`/api/admin/plugins/${id}/config`)

export const putPluginConfig = (id: string, body: Record<string, unknown>) =>
  api.put(`/api/admin/plugins/${id}/config`, body)

export const listPluginHosts = (id: string) =>
  api.get<PluginHost[]>(`/api/admin/plugins/${id}/hosts`)

export const deployPluginHost = (id: string, body: {
  server_id: number
  version?: string
  config?: unknown
  topology?: { role: 'landing' | 'relay'; upstream_server_id?: number }
}) => api.post<PluginHost>(`/api/admin/plugins/${id}/hosts`, body)

export const removePluginHost = (id: string, serverId: number) =>
  api.del(`/api/admin/plugins/${id}/hosts/${serverId}`)

export const listPluginEvents = (id: string, params: { since?: string; limit?: number; server_id?: number } = {}) => {
  const q = new URLSearchParams()
  if (params.since) q.set('since', params.since)
  if (params.limit) q.set('limit', String(params.limit))
  if (params.server_id) q.set('server_id', String(params.server_id))
  const qs = q.toString()
  return api.get<PluginEvent[]>(`/api/admin/plugins/${id}/events${qs ? '?' + qs : ''}`)
}

export const pluginLogsWSURL = (id: string, serverId: number) => {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${window.location.host}/api/admin/plugins/${id}/hosts/${serverId}/logs`
}

export interface HostDomain {
  id: number
  server_id: number
  zone_id: string
  record_id: string
  domain: string
  type: string
  content: string
  created_at: string
}

export const listHostDomains = (serverID?: number) => {
  const qs = serverID != null ? `?server_id=${serverID}` : ''
  return api.get<HostDomain[]>(`/api/admin/plugins/cloudflare/host-domains${qs}`)
}

export const addHostDomain = (body: { server_id: number; domain?: string; content?: string; type?: string }) =>
  api.post<HostDomain>(`/api/admin/plugins/cloudflare/host-domains`, body)

export const removeHostDomain = (id: number) =>
  api.del(`/api/admin/plugins/cloudflare/host-domains/${id}`)

export interface XrayVersionsResp { cached: { version: string; os: string; arch: string }[]; latest: string[] }
export const fetchXrayVersions = () =>
  api.get<XrayVersionsResp>('/api/admin/plugins/xray/versions')

export interface X25519KeyPair { private_key: string; public_key: string }
export const generateX25519 = () =>
  api.post<X25519KeyPair>('/api/admin/plugins/xray/keys/x25519', {})

export const generateShortID = () =>
  api.post<{ short_id: string }>('/api/admin/plugins/xray/keys/short-id', {})

export interface XrayInbound {
  id: number
  server_id: number
  server_name: string
  tag: string
  port: number
  role: 'landing' | 'relay'
  protocol: 'vless-reality' | 'vmess-ws' | 'shadowsocks'
  uuid: string
  sni: string
  public_key: string
  private_key: string  // always "[REDACTED]" in GET responses
  short_id: string
  ws_path: string
  ss_method: string
  upstream_inbound_id: number | null
  upstream_tag: string | null
  upstream_server_id: number | null
  upstream_server_name: string | null
  created_at: string
  updated_at: string
}

export interface CreateXrayInboundBody {
  server_id: number
  port: number
  role: 'landing' | 'relay'
  protocol: 'vless-reality' | 'vmess-ws' | 'shadowsocks'
  uuid?: string
  sni?: string
  public_key?: string
  private_key?: string
  short_id?: string
  ws_path?: string
  ss_method?: string
  ss_password?: string
  upstream_inbound_id?: number
}

export interface PatchXrayInboundBody {
  port?: number
  uuid?: string
  sni?: string
  public_key?: string
  private_key?: string
  short_id?: string
  ws_path?: string
  ss_method?: string
  ss_password?: string
}

export const listXrayInbounds = (params: { server_id?: number } = {}) => {
  const q = new URLSearchParams()
  if (params.server_id) q.set('server_id', String(params.server_id))
  const qs = q.toString()
  return api.get<XrayInbound[]>(`/api/admin/plugins/xray/inbounds${qs ? '?' + qs : ''}`)
}

export const createXrayInbound = (body: CreateXrayInboundBody) =>
  api.post<XrayInbound>('/api/admin/plugins/xray/inbounds', body)

export const patchXrayInbound = (id: number, body: PatchXrayInboundBody) =>
  api.patch<XrayInbound>(`/api/admin/plugins/xray/inbounds/${id}`, body)

export const deleteXrayInbound = (id: number) =>
  api.del(`/api/admin/plugins/xray/inbounds/${id}`)

export const patchXrayServerVersion = (serverID: number, version: string) =>
  api.patch<{ ok: true; version: string }>(`/api/admin/plugins/xray/servers/${serverID}`, { version })

// ── xray traffic monitoring ──────────────────────────────────────────────────

export interface XrayTrafficPoint {
  ts: string       // ISO 8601 UTC
  bytes_up: number
  bytes_down: number
}

export interface XrayTrafficSeries {
  tag: string
  kind: string
  points: XrayTrafficPoint[]
}

export interface XrayTrafficResponse {
  server_id: number
  tag: string
  kind: string
  resolution: 'raw' | 'minute' | 'hour'
  points: XrayTrafficPoint[]
}

export interface XrayTrafficBatchResponse {
  resolution: 'raw' | 'minute' | 'hour'
  series: XrayTrafficSeries[]
}

export const fetchXrayTraffic = (params: {
  server_id: number
  tag: string
  kind?: string
  from: string
  to: string
  resolution?: 'raw' | 'minute' | 'hour'
}): Promise<XrayTrafficResponse> => {
  const q = new URLSearchParams({ server_id: String(params.server_id), tag: params.tag, from: params.from, to: params.to })
  if (params.kind)       q.set('kind', params.kind)
  if (params.resolution) q.set('resolution', params.resolution)
  return api.get<XrayTrafficResponse>(`/api/admin/plugins/xray/traffic?${q}`)
}

export const fetchXrayTrafficBatch = (params: {
  server_id: number
  tags: string[]
  kind?: string
  from: string
  to: string
  resolution?: 'raw' | 'minute' | 'hour'
}): Promise<XrayTrafficBatchResponse> => {
  const q = new URLSearchParams({
    server_id: String(params.server_id),
    tags: params.tags.join(','),
    from: params.from,
    to: params.to,
  })
  if (params.kind)       q.set('kind', params.kind)
  if (params.resolution) q.set('resolution', params.resolution)
  return api.get<XrayTrafficBatchResponse>(`/api/admin/plugins/xray/traffic/batch?${q}`)
}

// ── singbox plugin ────────────────────────────────────────────────────────────

export type SingboxProtocol =
  | 'vless-reality'
  | 'vless-ws-tls' | 'vless-h2-tls' | 'vless-httpupgrade-tls'
  | 'vmess-tcp'    | 'vmess-http'    | 'vmess-quic'
  | 'vmess-ws-tls' | 'vmess-h2-tls' | 'vmess-httpupgrade-tls'
  | 'trojan-tls'   | 'trojan-ws-tls' | 'trojan-h2-tls' | 'trojan-httpupgrade-tls'
  | 'hysteria2' | 'tuic-v5' | 'anytls' | 'shadowsocks-2022'

export interface SingboxInbound {
  id: number
  server_id: number
  server_name: string
  tag: string
  port: number
  role: 'landing' | 'relay'
  protocol: SingboxProtocol
  uuid?: string
  password?: string
  sni?: string
  reality_private_key?: string    // "[REDACTED]" in GET responses
  reality_public_key?: string
  reality_short_id?: string
  reality_handshake_server?: string
  reality_handshake_port?: number
  flow?: string
  transport_type?: string
  transport_path?: string
  transport_host?: string
  alter_id?: number
  ss_method?: string
  ss_password?: string
  cert_id?: number | null
  extra_json?: string | null
  // upstream JOIN fields (relay rows only)
  upstream_inbound_id?: number | null
  upstream_tag?: string | null
  upstream_server_id?: number | null
  upstream_server_name?: string | null
  created_at: string
  updated_at: string
}

export interface CreateSingboxInboundBody {
  server_id: number
  port: number
  role: 'landing' | 'relay'
  protocol: SingboxProtocol
  uuid?: string
  password?: string
  sni?: string
  reality_private_key?: string
  reality_public_key?: string
  reality_short_id?: string
  reality_handshake_server?: string
  reality_handshake_port?: number
  flow?: string
  transport_type?: string
  transport_path?: string
  transport_host?: string
  alter_id?: number
  ss_method?: string
  ss_password?: string
  cert_id?: number
  extra_json?: string
  upstream_inbound_id?: number
}

export interface PatchSingboxInboundBody {
  port?: number
  uuid?: string
  password?: string
  sni?: string
  reality_private_key?: string
  reality_public_key?: string
  reality_short_id?: string
  reality_handshake_server?: string
  reality_handshake_port?: number
  flow?: string
  transport_type?: string
  transport_path?: string
  transport_host?: string
  alter_id?: number
  ss_method?: string
  ss_password?: string
  cert_id?: number | null
  extra_json?: string | null
}

export interface SingboxCertificate {
  id: number
  domain: string
  status: 'issuing' | 'valid' | 'failed' | 'revoked'
  issuer: string
  expires_at: string | null
  challenge_type: 'dns-01-cf' | 'http-01'
  last_renew_attempt_at: string | null
  last_error: string | null
  created_at: string
  updated_at: string
}

export interface IssueSingboxCertBody {
  domain: string
  challenge_type: 'dns-01-cf' | 'http-01'
  email: string
}

// Traffic response shapes are identical to xray's — alias for clarity
export type SingboxTrafficPoint = XrayTrafficPoint
export type SingboxTrafficSeries = XrayTrafficSeries
export type SingboxTrafficResponse = XrayTrafficResponse
export type SingboxTrafficBatchResponse = XrayTrafficBatchResponse

const SINGBOX = '/api/admin/plugins/singbox'

export const listSingboxInbounds = (params: { server_id?: number } = {}): Promise<SingboxInbound[]> => {
  const q = new URLSearchParams()
  if (params.server_id) q.set('server_id', String(params.server_id))
  const qs = q.toString()
  return api.get<SingboxInbound[]>(`${SINGBOX}/inbounds${qs ? '?' + qs : ''}`)
}

export const createSingboxInbound = (body: CreateSingboxInboundBody): Promise<SingboxInbound> =>
  api.post<SingboxInbound>(`${SINGBOX}/inbounds`, body)

export const patchSingboxInbound = (id: number, body: PatchSingboxInboundBody): Promise<SingboxInbound> =>
  api.patch<SingboxInbound>(`${SINGBOX}/inbounds/${id}`, body)

export const deleteSingboxInbound = (id: number): Promise<void> =>
  api.del(`${SINGBOX}/inbounds/${id}`)

export const patchSingboxServerVersion = (serverID: number, version: string) =>
  api.patch<{ ok: true; version: string }>(`${SINGBOX}/servers/${serverID}`, { version })

export const fetchSingboxVersions = () =>
  api.get<{ cached: { version: string; os: string; arch: string }[]; latest: string[] }>(`${SINGBOX}/versions`)

export const listSingboxCerts = (): Promise<SingboxCertificate[]> =>
  api.get<SingboxCertificate[]>(`${SINGBOX}/certificates`)

export const issueSingboxCert = (body: IssueSingboxCertBody): Promise<SingboxCertificate> =>
  api.post<SingboxCertificate>(`${SINGBOX}/certificates`, body)

export const deleteSingboxCert = (id: number): Promise<void> =>
  api.del(`${SINGBOX}/certificates/${id}`)

export const renewSingboxCert = (id: number): Promise<{ id: number; status: string }> =>
  api.post<{ id: number; status: string }>(`${SINGBOX}/certificates/${id}/renew`, {})

export const fetchSingboxTraffic = (params: {
  server_id: number
  tag: string
  kind?: string
  from: string
  to: string
  resolution?: 'raw' | 'minute' | 'hour'
}): Promise<SingboxTrafficResponse> => {
  const q = new URLSearchParams({ server_id: String(params.server_id), tag: params.tag, from: params.from, to: params.to })
  if (params.kind)       q.set('kind', params.kind)
  if (params.resolution) q.set('resolution', params.resolution)
  return api.get<SingboxTrafficResponse>(`${SINGBOX}/traffic?${q}`)
}

export const fetchSingboxTrafficBatch = (params: {
  server_id: number
  tags: string[]
  kind?: string
  from: string
  to: string
  resolution?: 'raw' | 'minute' | 'hour'
}): Promise<SingboxTrafficBatchResponse> => {
  const q = new URLSearchParams({
    server_id: String(params.server_id),
    tags: params.tags.join(','),
    from: params.from,
    to: params.to,
  })
  if (params.kind)       q.set('kind', params.kind)
  if (params.resolution) q.set('resolution', params.resolution)
  return api.get<SingboxTrafficBatchResponse>(`${SINGBOX}/traffic/batch?${q}`)
}
