import React from 'react'
import { renderHook, waitFor } from '@testing-library/react-native'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  listNetqualityTargets, createNetqualityTarget, patchNetqualityTarget, deleteNetqualityTarget,
  listNetqualityHostConfigs, putNetqualityHost,
  listNetqualityHostTargets, updateNetqualityHostTargets,
  fetchNetqualitySamples, rangeParams, useNetqualitySamples,
  useNetqualityTargets, useNetqualityHostConfigs, useNetqualityHostTargets,
} from '../netquality'
jest.mock('../authed', () => ({ authedFetch: jest.fn() }))
import { authedFetch } from '../authed'

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

beforeEach(() => { (authedFetch as jest.Mock).mockReset() })

// ── targets catalog ───────────────────────────────────────────────────────────

// Wire rows per targetRow in routes.go — all plain values, no sql.Null wrappers.
const WIRE_TARGETS = [
  { id: 1, source: 'builtin', isp: 'telecom', region: '上海', label: '电信上海', host: '1.1.1.1', enabled: true, created_at: '2026-01-01T00:00:00Z' },
  { id: 9, source: 'custom', isp: 'overseas', region: 'US', label: 'google-dns', host: '8.8.8.8', enabled: false, created_at: '2026-06-01T00:00:00Z' },
]

test('listNetqualityTargets GETs the catalog path and surfaces builtin+custom rows', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue(WIRE_TARGETS)
  const rows = await listNetqualityTargets()
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/netquality/targets')
  expect(rows[0].source).toBe('builtin')
  expect(rows[1].source).toBe('custom')
  expect(rows[1].enabled).toBe(false)
})

test('createNetqualityTarget POSTs the body with omitted optional region', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue({ ok: true })
  await createNetqualityTarget({ isp: 'mobile', label: 'my-target', host: '9.9.9.9' })
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/netquality/targets', {
    method: 'POST',
    body: { isp: 'mobile', label: 'my-target', host: '9.9.9.9' },
  })
})

test('patchNetqualityTarget PATCHes only the supplied fields', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue({ ok: true })
  await patchNetqualityTarget(9, { enabled: true })
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/netquality/targets/9', {
    method: 'PATCH',
    body: { enabled: true },
  })
})

test('deleteNetqualityTarget DELETEs the custom target by id', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue({ ok: true })
  await deleteNetqualityTarget(9)
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/netquality/targets/9', { method: 'DELETE' })
})

test('useNetqualityTargets respects the enabled flag', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue(WIRE_TARGETS)
  renderHook(() => useNetqualityTargets(false), { wrapper })
  expect(authedFetch).not.toHaveBeenCalled()
  const { result } = renderHook(() => useNetqualityTargets(true), { wrapper })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(result.current.data).toHaveLength(2)
})

// ── per-server probe config (netquality_hosts) ────────────────────────────────

// Wire rows per hostRow in routes.go: last_error is *string + omitempty and
// updated_at is *time.Time + omitempty — plain string-or-ABSENT, NOT sql.Null
// {String,Valid}. A never-enabled host omits both.
const WIRE_HOST_CONFIGS = [
  { server_id: 7, enabled: true, sample_interval_seconds: 300, last_error: 'icmp blocked', updated_at: '2026-06-09T01:00:00Z' },
  { server_id: 9, enabled: false, sample_interval_seconds: 600 }, // never enabled → no last_error/updated_at keys
]

test('listNetqualityHostConfigs GETs the probe-config /hosts path (NOT the deploy table)', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue(WIRE_HOST_CONFIGS)
  const rows = await listNetqualityHostConfigs()
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/netquality/hosts')
  // pointer-omitempty: present on row 0, absent on row 1 (NOT {String,Valid})
  expect(rows[0].last_error).toBe('icmp blocked')
  expect(rows[0].updated_at).toBe('2026-06-09T01:00:00Z')
  expect(rows[1].last_error).toBeUndefined()
  expect(rows[1].updated_at).toBeUndefined()
  expect(rows[1].sample_interval_seconds).toBe(600)
})

test('putNetqualityHost PUTs enable + interval for one server', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue({ ok: true })
  await putNetqualityHost(7, { enabled: true, sample_interval_seconds: 180 })
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/netquality/hosts/7', {
    method: 'PUT',
    body: { enabled: true, sample_interval_seconds: 180 },
  })
})

test('useNetqualityHostConfigs hits the probe-config path and exposes both rows', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue(WIRE_HOST_CONFIGS)
  const { result } = renderHook(() => useNetqualityHostConfigs(), { wrapper })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/netquality/hosts')
  // the correct "Hosts" count is the number of enabled rows, not deploy rows
  expect((result.current.data ?? []).filter((h) => h.enabled).length).toBe(1)
})

// ── per-host target picker ────────────────────────────────────────────────────

// Wire rows per hostTargetRow — plain values + a per-host `selected` flag.
const WIRE_HOST_TARGETS = [
  { target_id: 1, isp: 'telecom', region: '上海', label: '电信上海', host: '1.1.1.1', selected: true },
  { target_id: 2, isp: 'overseas', region: 'US', label: 'google-dns', host: '8.8.8.8', selected: false },
]

test('listNetqualityHostTargets GETs the per-host targets path', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue(WIRE_HOST_TARGETS)
  const rows = await listNetqualityHostTargets(7)
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/netquality/hosts/7/targets')
  expect(rows[0].selected).toBe(true)
  expect(rows[1].selected).toBe(false)
})

test('updateNetqualityHostTargets PUTs the target_ids set', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue({ ok: true })
  await updateNetqualityHostTargets(7, [1, 5, 9])
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/netquality/hosts/7/targets', {
    method: 'PUT',
    body: { target_ids: [1, 5, 9] },
  })
})

test('useNetqualityHostTargets is disabled without a server and resolves with one', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue(WIRE_HOST_TARGETS)
  renderHook(() => useNetqualityHostTargets(null), { wrapper })
  expect(authedFetch).not.toHaveBeenCalled()
  const { result } = renderHook(() => useNetqualityHostTargets(7), { wrapper })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/netquality/hosts/7/targets')
  expect(result.current.data).toHaveLength(2)
})

// ── sample history ─────────────────────────────────────────────────────────────

// querySamples wire shape: {resolution, points:[…]}. rtt_avg_ms may be null on
// a fully-lost bucket (raw values, NOT sql.Null wrappers).
const WIRE_SAMPLES = {
  resolution: 'raw',
  points: [
    { ts: '2026-06-09T01:00:00Z', rtt_avg_ms: 41.2, loss_pct: 0, status: 'ok' },
    { ts: '2026-06-09T01:05:00Z', rtt_avg_ms: null, loss_pct: 100, status: 'lost' },
  ],
}

test('rangeParams maps 1h→raw and 24h→minute (matches the server auto-resolution)', () => {
  expect(rangeParams('1h')).toEqual({ resolution: 'raw', ms: 60 * 60 * 1000 })
  expect(rangeParams('24h')).toEqual({ resolution: 'minute', ms: 24 * 60 * 60 * 1000 })
})

test('fetchNetqualitySamples GETs /samples with server_id, target_id, range + resolution', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue(WIRE_SAMPLES)
  const res = await fetchNetqualitySamples({
    server_id: 7, target_id: 1,
    from: '2026-06-09T00:00:00.000Z', to: '2026-06-09T01:00:00.000Z',
    resolution: 'raw',
  })
  expect(authedFetch).toHaveBeenCalledWith(
    '/api/admin/plugins/netquality/samples?server_id=7&target_id=1&from=2026-06-09T00%3A00%3A00.000Z&to=2026-06-09T01%3A00%3A00.000Z&resolution=raw',
  )
  expect(res.resolution).toBe('raw')
  expect(res.points[1].rtt_avg_ms).toBeNull() // null survives (no nullStr coercion)
})

test('useNetqualitySamples is disabled until both ids are present, then queries /samples', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue(WIRE_SAMPLES)
  const windowEnd = Date.UTC(2026, 5, 9, 1, 0, 0)
  renderHook(
    () => useNetqualitySamples({ serverID: null, targetID: 1, range: '1h', windowEnd }),
    { wrapper },
  )
  expect(authedFetch).not.toHaveBeenCalled()
  const { result } = renderHook(
    () => useNetqualitySamples({ serverID: 7, targetID: 1, range: '1h', windowEnd }),
    { wrapper },
  )
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  const url = (authedFetch as jest.Mock).mock.calls.at(-1)![0] as string
  expect(url).toContain('/api/admin/plugins/netquality/samples?')
  expect(url).toContain('server_id=7')
  expect(url).toContain('target_id=1')
  expect(url).toContain('resolution=raw')
  expect(result.current.data?.points).toHaveLength(2)
})
