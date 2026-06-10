import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { authedFetch } from './authed'

// Wire shapes mirror web/src/pages/admin/plugins/cloudflare/* and the Go handlers
// in internal/plugins/cloudflare/routes.go.
//
// IMPORTANT: /zones and /zones/{id}/records are PASS-THROUGH of the raw Cloudflare
// API JSON (json.Encode of []map[string]any), NOT typed Go structs — fields beyond
// the ones the UI reads exist and are ignored. They are PLAIN values, never the
// sql.Null* {String,Valid} shape. Only servers.ssh_host (consumed on the Hosts tab
// via nullStr) is a Go sql.NullString.

// ── raw CF zone / record (loosely typed, guard everything with ?? '—') ──────────

export type CfZone = {
  id: string
  name: string
  status?: string
  plan?: { name?: string } | null
}

export type CfRecord = {
  id: string
  name: string
  type: string
  content: string
  ttl?: number
  proxied?: boolean
}

// cf_host_domains row — ALL plain values (record_id COALESCE'd to ''), NO sql.Null*.
export type HostDomain = {
  id: number
  server_id: number
  zone_id: string
  record_id: string
  domain: string
  type: string
  content: string
  created_at: string // RFC3339
}

// addDomainBody: server_id REQUIRED; empty domain auto-builds {server}.{prefix}.{zone};
// empty content uses server.ssh_host; empty type → 'A'. The backend requires the
// plugin config zone_id (and prefix for auto-build) to be set, else 502.
export type AddDomainBody = {
  server_id: number
  domain?: string
  content?: string
  type?: string
}

// ── zones ───────────────────────────────────────────────────────────────────────

export function listCfZones(): Promise<CfZone[]> {
  return authedFetch<CfZone[]>('/api/admin/plugins/cloudflare/zones')
}

// staleTime mirrors the web ZonesTab (60s). Disabled until a token is configured —
// the caller passes `enabled` so the zones-dependent UI degrades instead of 400ing
// the whole screen.
export function useCfZones(enabled: boolean = true): UseQueryResult<CfZone[]> {
  return useQuery({
    queryKey: ['cf-zones'],
    queryFn: listCfZones,
    staleTime: 60_000,
    enabled,
  })
}

// ── dns records ──────────────────────────────────────────────────────────────────

export function listCfRecords(zoneId: string): Promise<CfRecord[]> {
  return authedFetch<CfRecord[]>(`/api/admin/plugins/cloudflare/zones/${zoneId}/records`)
}

export function useCfRecords(zoneId: string): UseQueryResult<CfRecord[]> {
  return useQuery({
    queryKey: ['cf-records', zoneId],
    queryFn: () => listCfRecords(zoneId),
    enabled: !!zoneId,
  })
}

// createCfRecord forwards the body verbatim to CF. Web sends ttl:1 (auto), proxied:false.
export type CreateRecordBody = {
  type: string
  name: string
  content: string
  ttl: number
  proxied: boolean
}

export function createCfRecord(zoneId: string, body: CreateRecordBody): Promise<CfRecord> {
  return authedFetch<CfRecord>(`/api/admin/plugins/cloudflare/zones/${zoneId}/records`, { method: 'POST', body })
}

// deleteCfRecord → 204 No Content, EMPTY body (apiFetch tolerates → null).
export function deleteCfRecord(zoneId: string, recordId: string): Promise<null> {
  return authedFetch<null>(`/api/admin/plugins/cloudflare/zones/${zoneId}/records/${recordId}`, { method: 'DELETE' })
}

// ── per-server host domains ──────────────────────────────────────────────────────

export function listHostDomains(): Promise<HostDomain[]> {
  return authedFetch<HostDomain[]>('/api/admin/plugins/cloudflare/host-domains')
}

// refetchInterval mirrors the web HostsTab (30s).
export function useHostDomains(): UseQueryResult<HostDomain[]> {
  return useQuery({
    queryKey: ['cf-host-domains'],
    queryFn: listHostDomains,
    refetchInterval: 30_000,
  })
}

export function addHostDomain(body: AddDomainBody): Promise<HostDomain> {
  return authedFetch<HostDomain>('/api/admin/plugins/cloudflare/host-domains', { method: 'POST', body })
}

// removeHostDomain → 204 No Content, EMPTY body (apiFetch tolerates → null).
export function removeHostDomain(id: number): Promise<null> {
  return authedFetch<null>(`/api/admin/plugins/cloudflare/host-domains/${id}`, { method: 'DELETE' })
}
