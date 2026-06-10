import React from 'react'
import { renderHook, waitFor } from '@testing-library/react-native'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  listProxyInbounds, fetchTrafficBatch, listSingboxCerts, fetchNetqualityLatest,
  useProxyInbounds, useTrafficBatch, useSingboxCerts, useNetqualityLatest,
} from '../plugins'
jest.mock('../authed', () => ({ authedFetch: jest.fn() }))
import { authedFetch } from '../authed'

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

beforeEach(() => { (authedFetch as jest.Mock).mockReset() })

// ── inbounds ──────────────────────────────────────────────────────────────────

// Real wire row per getInboundsHandler (web/src/api/plugins.ts SingboxInbound) —
// the mobile type only picks the rendered fields; extras must be tolerated.
const WIRE_SINGBOX_INBOUND = {
  id: 11, server_id: 7, server_name: 'alpha',
  tag: 'vless-reality-8443', alias: 'main', port: 8443,
  role: 'landing', protocol: 'vless-reality',
  uuid: '4f0d2c2c-1111-2222-3333-444455556666',
  sni: 'cdn.example.com',
  reality_private_key: '[REDACTED]', reality_public_key: 'pubkey', reality_short_id: 'aabb1122',
  cert_id: null, extra_json: null,
  upstream_inbound_id: null, upstream_tag: null, upstream_server_id: null, upstream_server_name: null,
  created_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-01T00:00:00Z',
}

test('listProxyInbounds hits the per-plugin path, with and without server_id', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue([WIRE_SINGBOX_INBOUND])
  const rows = await listProxyInbounds('singbox')
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/singbox/inbounds')
  expect(rows[0].tag).toBe('vless-reality-8443')
  expect(rows[0].port).toBe(8443)

  await listProxyInbounds('xray', 7)
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/xray/inbounds?server_id=7')
})

test('useProxyInbounds is disabled until a host is picked', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue([WIRE_SINGBOX_INBOUND])
  const { result, rerender } = renderHook(
    ({ sid }: { sid: number | null }) => useProxyInbounds('singbox', sid),
    { wrapper, initialProps: { sid: null as number | null } },
  )
  expect(authedFetch).not.toHaveBeenCalled()
  rerender({ sid: 7 })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/singbox/inbounds?server_id=7')
})

// ── traffic batch ─────────────────────────────────────────────────────────────

// Wire shape per trafficBatchQueryHandler: {resolution, series:[{tag,kind,points}]}.
const WIRE_BATCH = {
  resolution: 'hour',
  series: [
    {
      tag: 'vless-reality-8443', kind: 'landing',
      points: [
        { ts: '2026-06-08T12:00:00Z', bytes_up: 1024, bytes_down: 4096 },
        { ts: '2026-06-08T13:00:00Z', bytes_up: 512, bytes_down: 2048 },
      ],
    },
  ],
}

test('fetchTrafficBatch builds the batch URL with comma-joined tags and encoded window', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue(WIRE_BATCH)
  const res = await fetchTrafficBatch('xray', {
    server_id: 7,
    tags: ['vless-reality-8443', 'vmess-ws-443'],
    from: '2026-06-08T12:00:00.000Z',
    to: '2026-06-09T12:00:00.000Z',
    resolution: 'hour',
  })
  expect(authedFetch).toHaveBeenCalledWith(
    '/api/admin/plugins/xray/traffic/batch?server_id=7'
    + '&tags=vless-reality-8443,vmess-ws-443'
    + '&from=2026-06-08T12%3A00%3A00.000Z&to=2026-06-09T12%3A00%3A00.000Z'
    + '&resolution=hour',
  )
  expect(res.series[0].points[0].bytes_down).toBe(4096)
})

test('fetchTrafficBatch omits resolution when not given (server default)', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue(WIRE_BATCH)
  await fetchTrafficBatch('singbox', { server_id: 3, tags: ['a'], from: 'F', to: 'T' })
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/singbox/traffic/batch?server_id=3&tags=a&from=F&to=T')
})

test('useTrafficBatch stays idle with no tags, fetches once tags arrive', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue(WIRE_BATCH)
  const { result, rerender } = renderHook(
    ({ tags }: { tags: string[] }) =>
      useTrafficBatch('singbox', { server_id: 7, tags, from: 'F', to: 'T', resolution: 'hour' }),
    { wrapper, initialProps: { tags: [] as string[] } },
  )
  expect(authedFetch).not.toHaveBeenCalled()
  rerender({ tags: ['vless-reality-8443'] })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(result.current.data?.resolution).toBe('hour')
})

// ── singbox certificates ──────────────────────────────────────────────────────

// Real wire rows per certResponse in internal/plugins/singbox/cert_routes.go:
// expires_at is ALWAYS a string (Go zero time while issuing, NOT null);
// last_renew_attempt_at / last_error are *string → null.
const WIRE_CERTS = [
  {
    id: 1, domain: 'a.example.com', status: 'active', issuer: 'lets-encrypt',
    expires_at: '2026-08-01T00:00:00Z', challenge_type: 'dns-01-cf',
    last_renew_attempt_at: '2026-06-01T00:00:00Z', last_error: null,
  },
  {
    id: 2, domain: 'b.example.com', status: 'issuing', issuer: '',
    expires_at: '0001-01-01T00:00:00Z', challenge_type: 'http-01',
    last_renew_attempt_at: null, last_error: null,
  },
]

test('listSingboxCerts GETs the certificates path and surfaces the wire rows', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue(WIRE_CERTS)
  const rows = await listSingboxCerts()
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/singbox/certificates')
  expect(rows[0].domain).toBe('a.example.com')
  expect(rows[1].expires_at).toBe('0001-01-01T00:00:00Z') // Go zero time, not null
  expect(rows[1].last_renew_attempt_at).toBeNull()
})

test('useSingboxCerts respects the enabled flag', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue(WIRE_CERTS)
  renderHook(() => useSingboxCerts(false), { wrapper })
  expect(authedFetch).not.toHaveBeenCalled()
  const { result } = renderHook(() => useSingboxCerts(true), { wrapper })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(result.current.data).toHaveLength(2)
})

// ── netquality latest ─────────────────────────────────────────────────────────

// Real wire rows per latestPerTarget in internal/plugins/netquality/routes.go:
// ts/rtt_avg_ms/loss_pct/status are pointers with omitempty — a target with no
// samples yet omits them entirely (LEFT JOIN NULLs).
const WIRE_LATEST = [
  {
    target_id: 1, isp: 'telecom', region: '上海', label: '电信上海',
    ts: '2026-06-09T01:00:00Z', rtt_avg_ms: 42.3, loss_pct: 0, status: 'ok',
  },
  { target_id: 2, isp: 'overseas', region: 'US-West', label: 'google-dns' }, // no samples yet
]

test('fetchNetqualityLatest hits samples/latest with the server id', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue(WIRE_LATEST)
  const rows = await fetchNetqualityLatest(7)
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/netquality/samples/latest?server_id=7')
  expect(rows[0].rtt_avg_ms).toBe(42.3)
  expect(rows[1].rtt_avg_ms).toBeUndefined()
  expect(rows[1].ts).toBeUndefined()
})

test('useNetqualityLatest is disabled without a server and resolves with one', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue(WIRE_LATEST)
  renderHook(() => useNetqualityLatest(null), { wrapper })
  expect(authedFetch).not.toHaveBeenCalled()
  const { result } = renderHook(() => useNetqualityLatest(7), { wrapper })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(result.current.data?.[1].label).toBe('google-dns')
})
