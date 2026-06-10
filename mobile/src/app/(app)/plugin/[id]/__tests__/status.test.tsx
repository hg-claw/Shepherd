import React from 'react'
import { render, fireEvent } from '@testing-library/react-native'
import PluginStatusScreen, {
  hasStatusView, certDaysLeft, certTone, certExpiryLabel, certStatusKind,
  rttKind, fmtRTT, fmtLoss, sumSeries,
} from '../status'

let mockId = 'singbox'
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: mockId }),
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
  Stack: Object.assign(() => null, { Screen: () => null }),
}))

type Q = {
  data?: unknown
  isLoading: boolean
  isError: boolean
  isRefetching: boolean
  refetch: jest.Mock
}
const ok = (data: unknown): Q => ({ data, isLoading: false, isError: false, isRefetching: false, refetch: jest.fn() })
const loading: Q = { data: undefined, isLoading: true, isError: false, isRefetching: false, refetch: jest.fn() }
const failed: Q = { data: undefined, isLoading: false, isError: true, isRefetching: false, refetch: jest.fn() }

const mockHosts = jest.fn<Q, [string]>()
const mockInbounds = jest.fn<Q, [string, number | null]>()
const mockTraffic = jest.fn<Q, [string, unknown]>()
const mockCerts = jest.fn<Q, [boolean]>()
const mockLatest = jest.fn<Q, [number | null]>()
jest.mock('@/api/plugins', () => ({
  ...jest.requireActual('@/api/plugins'),
  usePluginHosts: (id: string) => mockHosts(id),
  useProxyInbounds: (plugin: string, sid: number | null) => mockInbounds(plugin, sid),
  useTrafficBatch: (plugin: string, params: unknown) => mockTraffic(plugin, params),
  useSingboxCerts: (enabled: boolean) => mockCerts(enabled),
  useNetqualityLatest: (sid: number | null) => mockLatest(sid),
}))
jest.mock('@/api/servers', () => ({
  useServers: () => ({
    data: [
      { id: 7, name: 'alpha', connected: true, latest: null },
      { id: 9, name: 'beta', connected: true, latest: null, public_alias: { String: 'edge-9', Valid: true } },
    ],
  }),
}))

const HOSTS = [
  { id: 1, plugin_id: 'singbox', server_id: 7, status: 'running', updated_at: '' },
  { id: 2, plugin_id: 'singbox', server_id: 9, status: 'running', updated_at: '' },
]
const INBOUNDS = [
  { id: 11, server_id: 7, server_name: 'alpha', tag: 'vless-reality-8443', alias: 'main', port: 8443, role: 'landing', protocol: 'vless-reality' },
  { id: 12, server_id: 7, server_name: 'alpha', tag: 'hy2-443', alias: '', port: 443, role: 'landing', protocol: 'hysteria2' },
]
// 1536 B up → "1.5 KB"; 1 GiB down → "1.0 GB".
const BATCH = {
  resolution: 'hour',
  series: [
    {
      tag: 'vless-reality-8443', kind: 'landing',
      points: [
        { ts: '2026-06-08T12:00:00Z', bytes_up: 1024, bytes_down: 1073741824 },
        { ts: '2026-06-08T13:00:00Z', bytes_up: 512, bytes_down: 0 },
      ],
    },
  ],
}

const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString()

beforeEach(() => {
  jest.clearAllMocks() // drop recorded calls; return values are re-set below
  mockId = 'singbox'
  mockHosts.mockReturnValue(ok(HOSTS))
  mockInbounds.mockReturnValue(ok(INBOUNDS))
  mockTraffic.mockReturnValue(ok(BATCH))
  mockCerts.mockReturnValue(ok([]))
  mockLatest.mockReturnValue(ok([]))
})

// ── pure helpers ──────────────────────────────────────────────────────────────

test('certDaysLeft handles real expiries and the Go zero time', () => {
  expect(certDaysLeft('0001-01-01T00:00:00Z')).toBeNull() // issuing → no expiry yet
  expect(certDaysLeft('not a date')).toBeNull()
  const now = Date.parse('2026-06-09T00:00:00Z')
  expect(certDaysLeft('2026-06-16T12:00:00Z', now)).toBe(7)
  expect(certDaysLeft('2026-06-01T00:00:00Z', now)).toBeLessThan(0)
})

test('certTone urgency thresholds: <14d err, <30d warn, else ok', () => {
  expect(certTone(null)).toBe('neutral')
  expect(certTone(-1)).toBe('err') // expired
  expect(certTone(7)).toBe('err')
  expect(certTone(13)).toBe('err')
  expect(certTone(14)).toBe('warn')
  expect(certTone(29)).toBe('warn')
  expect(certTone(30)).toBe('ok')
  expect(certTone(90)).toBe('ok')
})

test('certExpiryLabel / certStatusKind', () => {
  expect(certExpiryLabel(null)).toBe('—')
  expect(certExpiryLabel(-3)).toBe('expired')
  expect(certExpiryLabel(12)).toBe('12d left')
  expect(certStatusKind('active')).toBe('ok')
  expect(certStatusKind('issuing')).toBe('warn')
  expect(certStatusKind('failed')).toBe('err')
  expect(certStatusKind('revoked')).toBe('err')
})

test('rttKind mirrors the web ResultsTab thresholds', () => {
  expect(rttKind(undefined, undefined)).toBe('neutral')
  expect(rttKind(42, 0)).toBe('ok')
  expect(rttKind(149.9, 0)).toBe('ok')
  expect(rttKind(150, 0)).toBe('warn')
  expect(rttKind(249.9, 0)).toBe('warn')
  expect(rttKind(250, 0)).toBe('err')
  expect(rttKind(42, 50)).toBe('err') // heavy loss overrides a good RTT
  expect(rttKind(undefined, 100)).toBe('err')
})

test('fmtRTT / fmtLoss render without Intl', () => {
  expect(fmtRTT(42.31)).toBe('42.3 ms')
  expect(fmtRTT(undefined)).toBe('—')
  expect(fmtLoss(2.4)).toBe('2%')
  expect(fmtLoss(undefined)).toBe('—')
})

test('sumSeries folds per-tag totals and the combined sparkline series', () => {
  const m = sumSeries(BATCH.series)
  const t = m.get('vless-reality-8443')!
  expect(t.up).toBe(1536)
  expect(t.down).toBe(1073741824)
  expect(t.combined).toEqual([1024 + 1073741824, 512])
  expect(m.get('hy2-443')).toBeUndefined()
})

test('hasStatusView gates the known plugin ids', () => {
  expect(hasStatusView('singbox')).toBe(true)
  expect(hasStatusView('xray')).toBe(true)
  expect(hasStatusView('netquality')).toBe(false)
  expect(hasStatusView('cloudflare')).toBe(false)
  expect(hasStatusView(undefined)).toBe(false)
})

// ── singbox / xray ────────────────────────────────────────────────────────────

test('singbox: inbounds render tag/protocol/port with humanized 24h totals', () => {
  const { getByText } = render(<PluginStatusScreen />)
  expect(getByText('Traffic (24h)')).toBeTruthy()
  expect(getByText('vless-reality-8443')).toBeTruthy()
  expect(getByText('vless-reality')).toBeTruthy()
  expect(getByText(':8443')).toBeTruthy()
  expect(getByText('↑ 1.5 KB')).toBeTruthy()
  expect(getByText('↓ 1.0 GB')).toBeTruthy()
  // an inbound with no series shows zero totals
  expect(getByText('hy2-443')).toBeTruthy()
  expect(getByText('↑ 0 B')).toBeTruthy()
  expect(getByText('↓ 0 B')).toBeTruthy()
  // traffic was requested for the first host, hour resolution, both tags
  const [plugin, params] = mockTraffic.mock.calls[0]
  expect(plugin).toBe('singbox')
  expect(params).toMatchObject({ server_id: 7, tags: ['vless-reality-8443', 'hy2-443'], resolution: 'hour' })
})

test('singbox: certificate rows get urgency-toned expiry pills', () => {
  mockCerts.mockReturnValue(ok([
    { id: 1, domain: 'soon.example.com', status: 'active', issuer: 'le', expires_at: days(7.5), challenge_type: 'dns-01-cf', last_renew_attempt_at: null, last_error: null },
    { id: 2, domain: 'mid.example.com', status: 'active', issuer: 'le', expires_at: days(20.5), challenge_type: 'dns-01-cf', last_renew_attempt_at: null, last_error: null },
    { id: 3, domain: 'fine.example.com', status: 'active', issuer: 'le', expires_at: days(90.5), challenge_type: 'dns-01-cf', last_renew_attempt_at: null, last_error: null },
    { id: 4, domain: 'new.example.com', status: 'issuing', issuer: '', expires_at: '0001-01-01T00:00:00Z', challenge_type: 'http-01', last_renew_attempt_at: null, last_error: null },
    { id: 5, domain: 'dead.example.com', status: 'failed', issuer: 'le', expires_at: days(-2.5), challenge_type: 'http-01', last_renew_attempt_at: null, last_error: 'acme: boom' },
  ]))
  const { getByText, getAllByText } = render(<PluginStatusScreen />)
  expect(getByText('Certificates')).toBeTruthy()
  expect(getByText('soon.example.com')).toBeTruthy()
  expect(getByText('7d left')).toBeTruthy()   // <14d → err tone
  expect(getByText('20d left')).toBeTruthy()  // <30d → warn tone
  expect(getByText('90d left')).toBeTruthy()  // ok tone
  expect(getByText('—')).toBeTruthy()         // issuing, Go zero time
  expect(getByText('expired')).toBeTruthy()
  expect(getAllByText('active').length).toBe(3)
  expect(getByText('issuing')).toBeTruthy()
  expect(getByText('failed')).toBeTruthy()
  expect(mockCerts).toHaveBeenCalledWith(true)
})

test('xray: no Certificates section, certs query disabled', () => {
  mockId = 'xray'
  mockHosts.mockReturnValue(ok(HOSTS.map((h) => ({ ...h, plugin_id: 'xray' }))))
  const { getByText, queryByText } = render(<PluginStatusScreen />)
  expect(getByText('Traffic (24h)')).toBeTruthy()
  expect(queryByText('Certificates')).toBeNull()
  expect(mockCerts).toHaveBeenCalledWith(false)
  expect(mockTraffic.mock.calls[0][0]).toBe('xray')
})

test('picking another host chip re-queries inbounds for it', () => {
  const { getByTestId, getByText } = render(<PluginStatusScreen />)
  expect(mockInbounds).toHaveBeenLastCalledWith('singbox', 7)
  expect(getByText('edge-9')).toBeTruthy() // alias label via nullStr
  fireEvent.press(getByTestId('host-9'))
  expect(mockInbounds).toHaveBeenLastCalledWith('singbox', 9)
})

test('loading hosts shows a spinner; a hosts error offers retry', () => {
  mockHosts.mockReturnValue(loading)
  expect(render(<PluginStatusScreen />).getByTestId('status-loading')).toBeTruthy()

  const fq = { ...failed, refetch: jest.fn() }
  mockHosts.mockReturnValue(fq)
  const { getByText } = render(<PluginStatusScreen />)
  fireEvent.press(getByText('Retry'))
  expect(fq.refetch).toHaveBeenCalled()
})

test('undeployed proxy plugin shows the traffic empty state', () => {
  mockHosts.mockReturnValue(ok([]))
  const { getByText } = render(<PluginStatusScreen />)
  expect(getByText('Not deployed anywhere.')).toBeTruthy()
})

// ── non-proxy plugins (netquality has its own dedicated screen now) ─────────────

test('netquality renders the no-status empty state here (it has a dedicated screen)', () => {
  mockId = 'netquality'
  const { getByText } = render(<PluginStatusScreen />)
  expect(getByText('No status view for this plugin.')).toBeTruthy()
  expect(mockHosts).not.toHaveBeenCalled()
})

test('unknown plugin id renders the no-status empty state', () => {
  mockId = 'cloudflare'
  const { getByText } = render(<PluginStatusScreen />)
  expect(getByText('No status view for this plugin.')).toBeTruthy()
  expect(mockHosts).not.toHaveBeenCalled()
})
