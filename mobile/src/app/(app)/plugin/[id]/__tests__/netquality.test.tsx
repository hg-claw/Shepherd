import React from 'react'
import { render, fireEvent, waitFor, type RenderResult } from '@testing-library/react-native'
import { Alert } from 'react-native'
import NetqualityScreen, { rttKind, fmtRTT, fmtLoss, intervalLabel } from '../netquality'

const mockPush = jest.fn()
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'netquality' }),
  useRouter: () => ({ back: jest.fn(), push: mockPush }),
  Stack: Object.assign(() => null, { Screen: () => null }),
}))

type Q = { data?: unknown; isLoading: boolean; isError: boolean; isRefetching: boolean; refetch: jest.Mock }
const ok = (data: unknown): Q => ({ data, isLoading: false, isError: false, isRefetching: false, refetch: jest.fn() })
const loading: Q = { data: undefined, isLoading: true, isError: false, isRefetching: false, refetch: jest.fn() }
const failed: Q = { data: undefined, isLoading: false, isError: true, isRefetching: false, refetch: jest.fn() }

const mockServers = jest.fn<Q, []>()
jest.mock('@/api/servers', () => ({ useServers: () => mockServers() }))

const mockHostCfgs = jest.fn<Q, []>()
const mockTargets = jest.fn<Q, []>()
const mockPutHost = jest.fn().mockResolvedValue({ ok: true })
const mockPatchTarget = jest.fn().mockResolvedValue({ ok: true })
const mockDeleteTarget = jest.fn().mockResolvedValue({ ok: true })
jest.mock('@/api/netquality', () => ({
  useNetqualityHostConfigs: () => mockHostCfgs(),
  useNetqualityTargets: () => mockTargets(),
  putNetqualityHost: (...a: unknown[]) => mockPutHost(...a),
  patchNetqualityTarget: (...a: unknown[]) => mockPatchTarget(...a),
  deleteNetqualityTarget: (...a: unknown[]) => mockDeleteTarget(...a),
}))

const mockLatest = jest.fn<Q, [number | null]>()
jest.mock('@/api/plugins', () => ({
  ...jest.requireActual('@/api/plugins'),
  useNetqualityLatest: (sid: number | null) => mockLatest(sid),
}))

// Wire fixtures.
const SERVERS = [
  { id: 7, name: 'alpha', connected: true, latest: null },
  { id: 9, name: 'beta', connected: true, latest: null, public_alias: { String: 'edge-9', Valid: true } },
]
// netquality_hosts probe-config rows — NOT the generic deploy table. last_error/
// updated_at are pointer-omitempty (plain string-or-absent).
const HOST_CFGS = [
  { server_id: 7, enabled: true, sample_interval_seconds: 300, last_error: 'icmp blocked', updated_at: new Date(Date.now() - 30_000).toISOString() },
  { server_id: 9, enabled: false, sample_interval_seconds: 600 },
]
const TARGETS = [
  { id: 1, source: 'builtin', isp: 'telecom', region: '上海', label: '电信上海', host: '1.1.1.1', enabled: true, created_at: '2026-01-01T00:00:00Z' },
  { id: 9, source: 'custom', isp: 'overseas', region: 'US', label: 'google-dns', host: '8.8.8.8', enabled: false, created_at: '2026-06-01T00:00:00Z' },
]
const LATEST = [
  { target_id: 1, isp: 'telecom', region: '上海', label: '电信上海', ts: new Date(Date.now() - 30_000).toISOString(), rtt_avg_ms: 42.31, loss_pct: 0, status: 'ok' },
  { target_id: 9, isp: 'overseas', region: 'US', label: 'google-dns', ts: new Date(Date.now() - 120_000).toISOString(), rtt_avg_ms: 187.5, loss_pct: 2.4, status: 'ok' },
]

beforeEach(() => {
  jest.clearAllMocks()
  mockServers.mockReturnValue(ok(SERVERS))
  mockHostCfgs.mockReturnValue(ok(HOST_CFGS))
  mockTargets.mockReturnValue(ok(TARGETS))
  mockLatest.mockReturnValue(ok(LATEST))
  jest.spyOn(Alert, 'alert').mockImplementation(() => {})
})

// ── pure helpers ──────────────────────────────────────────────────────────────

test('rttKind mirrors the web ResultsTab thresholds', () => {
  expect(rttKind(undefined, undefined)).toBe('neutral')
  expect(rttKind(42, 0)).toBe('ok')
  expect(rttKind(150, 0)).toBe('warn')
  expect(rttKind(250, 0)).toBe('err')
  expect(rttKind(42, 50)).toBe('err')
})

test('fmtRTT / fmtLoss render without Intl', () => {
  expect(fmtRTT(42.31)).toBe('42.3 ms')
  expect(fmtRTT(undefined)).toBe('—')
  expect(fmtLoss(2.4)).toBe('2%')
  expect(fmtLoss(undefined)).toBe('—')
})

test('intervalLabel maps the standard set and falls back to raw seconds', () => {
  expect(intervalLabel(60)).toBe('1m')
  expect(intervalLabel(300)).toBe('5m')
  expect(intervalLabel(1800)).toBe('30m')
  expect(intervalLabel(45)).toBe('45s')
})

// ── Hosts section (the bug fix) ────────────────────────────────────────────────

test('Hosts: lists ALL servers joined with probe config; count reflects netquality_hosts enabled rows', () => {
  const { getByText, getByTestId } = render(<NetqualityScreen />)
  // every registered server appears (left join), not just deploy rows
  expect(getByText('alpha')).toBeTruthy()
  expect(getByText('edge-9')).toBeTruthy() // public_alias via nullStr
  // the CORRECT count: 1 of 2 servers is enabled in netquality_hosts
  expect(getByTestId('hosts-count').props.children.join('')).toContain('1 probing')
  expect(getByTestId('hosts-count').props.children.join('')).toContain('2 servers')
})

test('Hosts: probing count counts only enabled rows for REGISTERED servers (ignores orphan config rows)', () => {
  // An enabled config row for a server that is no longer registered must not
  // inflate the "probing" count — the count joins through the server list,
  // mirroring the web HostsTab. This is the "Hosts count" drift fix.
  mockHostCfgs.mockReturnValue(ok([
    ...HOST_CFGS,
    { server_id: 999, enabled: true, sample_interval_seconds: 300 }, // orphan: server 999 not in SERVERS
  ]))
  const { getByTestId } = render(<NetqualityScreen />)
  // still 1: only server 7 (registered + enabled) counts; the orphan is dropped
  expect(getByTestId('hosts-count').props.children.join('')).toContain('1 probing')
  expect(getByTestId('hosts-count').props.children.join('')).toContain('2 servers')
})

test('Hosts: an enabled host shows its interval + Targets; last_error renders', () => {
  const { getByTestId, getByText } = render(<NetqualityScreen />)
  expect(getByTestId('host-enable-7').props.accessibilityState.checked).toBe(true)
  expect(getByTestId('host-targets-7')).toBeTruthy() // shown only when enabled
  expect(getByText('icmp blocked')).toBeTruthy() // last_error (pointer string)
})

test('Hosts: a disabled host hides interval/targets controls', () => {
  const { getByTestId, queryByTestId } = render(<NetqualityScreen />)
  expect(getByTestId('host-enable-9').props.accessibilityState.checked).toBe(false)
  expect(queryByTestId('host-targets-9')).toBeNull()
})

test('Hosts: toggling enable PUTs the host config with the existing interval', async () => {
  const { getByTestId } = render(<NetqualityScreen />)
  // the Switch is a Pressable that toggles on press (server 9 starts disabled)
  fireEvent.press(getByTestId('host-enable-9'))
  await waitFor(() => expect(mockPutHost).toHaveBeenCalledWith(9, { enabled: true, sample_interval_seconds: 600 }))
})

test('Hosts: tapping Targets routes to the per-host picker sub-route', () => {
  const { getByTestId } = render(<NetqualityScreen />)
  fireEvent.press(getByTestId('host-targets-7'))
  expect(mockPush).toHaveBeenCalledWith('/(app)/plugin/netquality/nq-host-targets?serverId=7')
})

test('Hosts: no servers shows an empty state', () => {
  mockServers.mockReturnValue(ok([]))
  const { getByText } = render(<NetqualityScreen />)
  expect(getByText('No servers registered.')).toBeTruthy()
})

test('Hosts: a server error offers retry', () => {
  const fq = { ...failed, refetch: jest.fn() }
  mockServers.mockReturnValue(fq)
  const { getByText } = render(<NetqualityScreen />)
  fireEvent.press(getByText('Retry'))
  expect(fq.refetch).toHaveBeenCalled()
})

// ── Targets section ────────────────────────────────────────────────────────────

// "Targets" appears twice when a host is enabled (the segmented nav option AND
// that host's Targets button). The segmented option renders first.
const gotoTargets = (getAllByText: RenderResult['getAllByText']) =>
  fireEvent.press(getAllByText('Targets')[0])

test('Targets: ISP-grouped catalog with source pills; custom row gets delete', () => {
  const { getByText, getAllByText, getByTestId, queryByTestId } = render(<NetqualityScreen />)
  gotoTargets(getAllByText)
  expect(getByText('电信 (1)')).toBeTruthy()
  expect(getByText('海外 (1)')).toBeTruthy()
  expect(getByText('电信上海')).toBeTruthy()
  expect(getByText('google-dns')).toBeTruthy()
  // delete only on the custom target
  expect(getByTestId('target-delete-9')).toBeTruthy()
  expect(queryByTestId('target-delete-1')).toBeNull()
})

test('Targets: toggling enable PATCHes the target', async () => {
  const { getAllByText, getByTestId } = render(<NetqualityScreen />)
  gotoTargets(getAllByText)
  fireEvent.press(getByTestId('target-enable-9')) // custom target starts disabled
  await waitFor(() => expect(mockPatchTarget).toHaveBeenCalledWith(9, { enabled: true }))
})

test('Targets: delete confirms via Alert then DELETEs on confirm', async () => {
  const { getAllByText, getByTestId } = render(<NetqualityScreen />)
  gotoTargets(getAllByText)
  fireEvent.press(getByTestId('target-delete-9'))
  expect(Alert.alert).toHaveBeenCalled()
  // invoke the destructive action the Alert was given
  const buttons = (Alert.alert as jest.Mock).mock.calls[0][2] as { text: string; onPress?: () => void }[]
  const del = buttons.find((b) => b.text === 'Delete')!
  del.onPress!()
  await waitFor(() => expect(mockDeleteTarget).toHaveBeenCalledWith(9))
})

test('Targets: add routes to the create form sub-route', () => {
  const { getAllByText, getByTestId } = render(<NetqualityScreen />)
  gotoTargets(getAllByText)
  fireEvent.press(getByTestId('target-add'))
  expect(mockPush).toHaveBeenCalledWith('/(app)/plugin/netquality/nq-target-new')
})

// ── Results section ────────────────────────────────────────────────────────────

test('Results: groups latest samples by ISP with RTT/loss/relTime; defaults to first enabled host', () => {
  const { getByText } = render(<NetqualityScreen />)
  fireEvent.press(getByText('Results'))
  // server 7 is enabled → default selection
  expect(mockLatest).toHaveBeenCalledWith(7)
  expect(getByText('电信')).toBeTruthy()
  expect(getByText('海外')).toBeTruthy()
  expect(getByText('42.3 ms')).toBeTruthy()
  expect(getByText('0%')).toBeTruthy()
  expect(getByText('187.5 ms')).toBeTruthy()
  expect(getByText('2%')).toBeTruthy()
  // relTime is rendered (allow a second of drift between fixture build and render)
  expect(getByText(/上海 · \d+s ago/)).toBeTruthy()
})

test('Results: picking another host chip re-queries latest for it', () => {
  const { getByText, getByTestId } = render(<NetqualityScreen />)
  fireEvent.press(getByText('Results'))
  expect(mockLatest).toHaveBeenLastCalledWith(7)
  fireEvent.press(getByTestId('host-9'))
  expect(mockLatest).toHaveBeenLastCalledWith(9)
})

test('Results: tapping a row routes to the history screen for that server×target', () => {
  const { getByText, getByTestId } = render(<NetqualityScreen />)
  fireEvent.press(getByText('Results'))
  // server 7 is the default enabled host; target 1 is 电信上海
  fireEvent.press(getByTestId('result-1'))
  expect(mockPush).toHaveBeenCalledWith(
    '/(app)/plugin/netquality/nq-history?serverId=7&targetId=1&label=%E7%94%B5%E4%BF%A1%E4%B8%8A%E6%B5%B7',
  )
})

test('Results: empty sample set explains the wait', () => {
  mockLatest.mockReturnValue(ok([]))
  const { getByText } = render(<NetqualityScreen />)
  fireEvent.press(getByText('Results'))
  expect(getByText(/No samples yet/)).toBeTruthy()
})

test('Results: no probing hosts shows a guidance empty state', () => {
  mockHostCfgs.mockReturnValue(ok([]))
  const { getByText } = render(<NetqualityScreen />)
  fireEvent.press(getByText('Results'))
  expect(getByText(/No probing hosts/)).toBeTruthy()
})

// ── loading ladder ─────────────────────────────────────────────────────────────

test('Hosts: loading shows a spinner', () => {
  mockHostCfgs.mockReturnValue(loading)
  mockServers.mockReturnValue(loading)
  expect(render(<NetqualityScreen />).getByTestId('hosts-loading')).toBeTruthy()
})
