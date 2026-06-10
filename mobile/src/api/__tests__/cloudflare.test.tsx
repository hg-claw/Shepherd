import React from 'react'
import { renderHook, waitFor } from '@testing-library/react-native'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  listCfZones, listCfRecords, createCfRecord, deleteCfRecord,
  listHostDomains, addHostDomain, removeHostDomain,
  useCfZones, useCfRecords, useHostDomains,
} from '../cloudflare'
jest.mock('../authed', () => ({ authedFetch: jest.fn() }))
import { authedFetch } from '../authed'

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

beforeEach(() => { (authedFetch as jest.Mock).mockReset() })

// ── zones ───────────────────────────────────────────────────────────────────────

// Raw CF zone passthrough (json.Encode of []map[string]any) — plain values, extra
// CF fields the UI ignores must be tolerated. NOT sql.Null*.
const WIRE_ZONES = [
  {
    id: 'z-bbbb', name: 'beta.example.com', status: 'active', plan: { name: 'Free Website' },
    account: { id: 'acct-1' }, name_servers: ['ns1', 'ns2'], // ignored extras
  },
  { id: 'z-aaaa', name: 'alpha.example.com', status: 'pending', plan: { name: 'Pro' } },
]

test('listCfZones GETs the zones path and surfaces the raw rows', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue(WIRE_ZONES)
  const rows = await listCfZones()
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/cloudflare/zones')
  expect(rows[0].name).toBe('beta.example.com')
  expect(rows[0].plan?.name).toBe('Free Website')
})

test('useCfZones respects the enabled flag (token gate)', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue(WIRE_ZONES)
  renderHook(() => useCfZones(false), { wrapper })
  expect(authedFetch).not.toHaveBeenCalled()
  const { result } = renderHook(() => useCfZones(true), { wrapper })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(result.current.data).toHaveLength(2)
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/cloudflare/zones')
})

// ── dns records ──────────────────────────────────────────────────────────────────

// Raw CF dns_record passthrough — ttl:1 means auto; proxied may be absent.
const WIRE_RECORDS = [
  { id: 'r1', name: 'www.alpha.example.com', type: 'A', content: '1.2.3.4', ttl: 1, proxied: false, zone_id: 'z-aaaa' },
  { id: 'r2', name: 'mail.alpha.example.com', type: 'MX', content: 'mx.alpha.example.com', ttl: 3600 },
]

test('listCfRecords hits the per-zone records path', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue(WIRE_RECORDS)
  const rows = await listCfRecords('z-aaaa')
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/cloudflare/zones/z-aaaa/records')
  expect(rows[1].ttl).toBe(3600)
  expect(rows[0].proxied).toBe(false)
})

test('useCfRecords stays idle until a zone id is given', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue(WIRE_RECORDS)
  const { result, rerender } = renderHook(
    ({ z }: { z: string }) => useCfRecords(z),
    { wrapper, initialProps: { z: '' } },
  )
  expect(authedFetch).not.toHaveBeenCalled()
  rerender({ z: 'z-aaaa' })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/cloudflare/zones/z-aaaa/records')
})

test('createCfRecord POSTs the verbatim CF body (ttl:1, proxied:false)', async () => {
  const created = { id: 'r9', name: 'new.alpha.example.com', type: 'A', content: '9.9.9.9', ttl: 1, proxied: false }
  ;(authedFetch as jest.Mock).mockResolvedValue(created)
  const res = await createCfRecord('z-aaaa', { type: 'A', name: 'new.alpha.example.com', content: '9.9.9.9', ttl: 1, proxied: false })
  expect(authedFetch).toHaveBeenCalledWith(
    '/api/admin/plugins/cloudflare/zones/z-aaaa/records',
    { method: 'POST', body: { type: 'A', name: 'new.alpha.example.com', content: '9.9.9.9', ttl: 1, proxied: false } },
  )
  expect(res.id).toBe('r9')
})

test('deleteCfRecord issues DELETE and tolerates the 204 empty body (null)', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue(null)
  const res = await deleteCfRecord('z-aaaa', 'r1')
  expect(authedFetch).toHaveBeenCalledWith(
    '/api/admin/plugins/cloudflare/zones/z-aaaa/records/r1',
    { method: 'DELETE' },
  )
  expect(res).toBeNull()
})

// ── host domains ─────────────────────────────────────────────────────────────────

// hostDomainRow — ALL plain values (record_id COALESCE'd to ''), NO sql.Null*.
const WIRE_HOST_DOMAINS = [
  {
    id: 1, server_id: 7, zone_id: 'z-aaaa', record_id: 'r-100',
    domain: 'alpha.hosts.example.com', type: 'A', content: '1.2.3.4',
    created_at: '2026-06-09T00:00:00Z',
  },
  {
    id: 2, server_id: 7, zone_id: 'z-aaaa', record_id: '', // COALESCE'd to '' when null
    domain: 'beta.hosts.example.com', type: 'A', content: '5.6.7.8',
    created_at: '2026-06-09T01:00:00Z',
  },
]

test('listHostDomains GETs the host-domains path with plain values', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue(WIRE_HOST_DOMAINS)
  const rows = await listHostDomains()
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/cloudflare/host-domains')
  expect(rows[0].record_id).toBe('r-100')
  expect(rows[1].record_id).toBe('') // coalesced, never null
  expect(typeof rows[0].server_id).toBe('number')
})

test('useHostDomains GETs the list', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue(WIRE_HOST_DOMAINS)
  const { result } = renderHook(() => useHostDomains(), { wrapper })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(result.current.data).toHaveLength(2)
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/cloudflare/host-domains')
})

test('addHostDomain POSTs the default body (server_id only → auto-build)', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue(WIRE_HOST_DOMAINS[0])
  await addHostDomain({ server_id: 7 })
  expect(authedFetch).toHaveBeenCalledWith(
    '/api/admin/plugins/cloudflare/host-domains',
    { method: 'POST', body: { server_id: 7 } },
  )
})

test('addHostDomain POSTs a custom domain body verbatim', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue(WIRE_HOST_DOMAINS[0])
  await addHostDomain({ server_id: 7, domain: 'custom.example.com' })
  expect(authedFetch).toHaveBeenCalledWith(
    '/api/admin/plugins/cloudflare/host-domains',
    { method: 'POST', body: { server_id: 7, domain: 'custom.example.com' } },
  )
})

test('removeHostDomain issues DELETE on the row id and tolerates 204 (null)', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue(null)
  const res = await removeHostDomain(2)
  expect(authedFetch).toHaveBeenCalledWith(
    '/api/admin/plugins/cloudflare/host-domains/2',
    { method: 'DELETE' },
  )
  expect(res).toBeNull()
})
