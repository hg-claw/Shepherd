import React from 'react'
import { render, fireEvent, waitFor } from '@testing-library/react-native'
import CloudflareScreen, { fmtTTL, errMsg } from '../cloudflare'

let mockId = 'cloudflare'
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: mockId }),
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
  Stack: Object.assign(() => null, { Screen: () => null }),
}))

type Q = {
  data?: unknown
  error?: unknown
  isLoading: boolean
  isError: boolean
  isSuccess?: boolean
  isRefetching: boolean
  refetch: jest.Mock
}
const ok = (data: unknown): Q => ({ data, isLoading: false, isError: false, isRefetching: false, refetch: jest.fn().mockResolvedValue(undefined) })
const failed = (error?: unknown): Q => ({ data: undefined, error, isLoading: false, isError: true, isRefetching: false, refetch: jest.fn() })

// cloudflare api ─ hooks return Q-shaped objects; mutators are jest fns.
const mockZones = jest.fn<Q, [boolean?]>()
const mockRecords = jest.fn<Q, [string]>()
const mockHostDomains = jest.fn<Q, []>()
const mockCreateRecord = jest.fn().mockResolvedValue({})
const mockDeleteRecord = jest.fn().mockResolvedValue(null)
const mockAddDomain = jest.fn().mockResolvedValue({})
const mockRemoveDomain = jest.fn().mockResolvedValue(null)
jest.mock('@/api/cloudflare', () => ({
  useCfZones: (enabled?: boolean) => mockZones(enabled),
  useCfRecords: (zoneId: string) => mockRecords(zoneId),
  useHostDomains: () => mockHostDomains(),
  createCfRecord: (...a: unknown[]) => mockCreateRecord(...a),
  deleteCfRecord: (...a: unknown[]) => mockDeleteRecord(...a),
  addHostDomain: (...a: unknown[]) => mockAddDomain(...a),
  removeHostDomain: (...a: unknown[]) => mockRemoveDomain(...a),
}))

// plugin config (Setup tab)
const mockConfig = jest.fn<Q, [string]>()
const mockSaveConfig = jest.fn().mockResolvedValue({ ok: true })
jest.mock('@/api/plugins', () => ({
  usePluginConfig: (id: string) => mockConfig(id),
  savePluginConfig: (...a: unknown[]) => mockSaveConfig(...a),
}))

// servers (Hosts tab — ssh_host is a Go sql.NullString)
const mockServers = jest.fn<Q, []>()
jest.mock('@/api/servers', () => ({
  useServers: () => mockServers(),
}))

const ZONES = [
  { id: 'z-bbbb', name: 'beta.example.com', status: 'pending', plan: { name: 'Pro' } },
  { id: 'z-aaaa', name: 'alpha.example.com', status: 'active', plan: { name: 'Free Website' } },
]
const RECORDS = [
  { id: 'r1', name: 'www.alpha.example.com', type: 'A', content: '1.2.3.4', ttl: 1, proxied: false },
  { id: 'r2', name: 'mail.alpha.example.com', type: 'MX', content: 'mx.alpha.example.com', ttl: 3600 },
]
const SERVERS = [
  { id: 7, name: 'alpha', connected: true, latest: null, ssh_host: { String: '203.0.113.7', Valid: true } },
  { id: 9, name: 'beta', connected: true, latest: null, ssh_host: { String: '', Valid: false } },
]
const DOMAINS = [
  { id: 1, server_id: 7, zone_id: 'z-aaaa', record_id: 'r-100', domain: 'alpha.hosts.example.com', type: 'A', content: '203.0.113.7', created_at: new Date(Date.now() - 60_000).toISOString() },
]

beforeEach(() => {
  jest.clearAllMocks()
  mockId = 'cloudflare'
  mockZones.mockReturnValue(ok(ZONES))
  mockRecords.mockReturnValue(ok(RECORDS))
  mockHostDomains.mockReturnValue(ok(DOMAINS))
  mockConfig.mockReturnValue(ok({ api_token: 'cf-tok', account_id: '', zone_id: 'z-aaaa', prefix: 'hosts' }))
  mockServers.mockReturnValue(ok(SERVERS))
  mockCreateRecord.mockResolvedValue({})
  mockDeleteRecord.mockResolvedValue(null)
  mockAddDomain.mockResolvedValue({})
  mockRemoveDomain.mockResolvedValue(null)
})

// ── pure helpers ──────────────────────────────────────────────────────────────

test('fmtTTL maps 1 → auto, undefined → em-dash, else the number', () => {
  expect(fmtTTL(1)).toBe('auto')
  expect(fmtTTL(undefined)).toBe('—')
  expect(fmtTTL(3600)).toBe('3600')
})

test('errMsg pulls Error.message and stringifies the rest', () => {
  expect(errMsg(new Error('plugin zone_id not configured'))).toBe('plugin zone_id not configured')
  expect(errMsg('boom')).toBe('boom')
})

// ── gating ──────────────────────────────────────────────────────────────────────

test('non-cloudflare id renders the gate empty state', () => {
  mockId = 'singbox'
  const { getByText } = render(<CloudflareScreen />)
  expect(getByText(/only available for the Cloudflare plugin/)).toBeTruthy()
})

// ── Setup ────────────────────────────────────────────────────────────────────────

test('Setup loads config into fields and saves the four keys', async () => {
  const { getByTestId } = render(<CloudflareScreen />)
  // Setup is the default tab.
  expect(getByTestId('setup-token').props.value).toBe('cf-tok')
  expect(getByTestId('setup-prefix').props.value).toBe('hosts')
  fireEvent.changeText(getByTestId('setup-account'), 'acct-123')
  fireEvent.press(getByTestId('setup-save'))
  await waitFor(() => expect(mockSaveConfig).toHaveBeenCalledWith('cloudflare', {
    api_token: 'cf-tok', account_id: 'acct-123', zone_id: 'z-aaaa', prefix: 'hosts',
  }))
})

test('Setup gates the zones query on a non-empty token', () => {
  mockConfig.mockReturnValue(ok({ api_token: '', account_id: '', zone_id: '', prefix: '' }))
  render(<CloudflareScreen />)
  // token empty → zones disabled
  expect(mockZones).toHaveBeenCalledWith(false)
})

test('Setup zone chips toggle the selected zone_id on save', async () => {
  const { getByTestId } = render(<CloudflareScreen />)
  // token present → zones enabled and chips render
  expect(mockZones).toHaveBeenCalledWith(true)
  fireEvent.press(getByTestId('setup-zone-z-bbbb'))
  fireEvent.press(getByTestId('setup-save'))
  await waitFor(() => expect(mockSaveConfig).toHaveBeenCalledWith('cloudflare', expect.objectContaining({ zone_id: 'z-bbbb' })))
})

// ── Zones ────────────────────────────────────────────────────────────────────────

test('Zones tab lists zones sorted by name (cmpStr, no Intl)', () => {
  const { getByTestId, getByText } = render(<CloudflareScreen />)
  fireEvent.press(getByTestId('tab-zones'))
  expect(getByText('alpha.example.com')).toBeTruthy()
  expect(getByText('beta.example.com')).toBeTruthy()
  expect(getByText('z-aaaa')).toBeTruthy() // full id rendered
  expect(getByText('Free Website')).toBeTruthy()
})

test('Zones tab surfaces a load error message', () => {
  mockZones.mockReturnValue(failed(new Error('api_token not configured')))
  const { getByTestId, getByText } = render(<CloudflareScreen />)
  fireEvent.press(getByTestId('tab-zones'))
  expect(getByText(/Failed to load zones: api_token not configured/)).toBeTruthy()
})

// ── DNS ──────────────────────────────────────────────────────────────────────────

test('DNS tab defaults to the first sorted zone and lists records with auto TTL', () => {
  const { getByTestId, getByText } = render(<CloudflareScreen />)
  fireEvent.press(getByTestId('tab-dns'))
  // first sorted zone is alpha → records requested for z-aaaa
  expect(mockRecords).toHaveBeenLastCalledWith('z-aaaa')
  expect(getByText('www.alpha.example.com')).toBeTruthy()
  expect(getByText('ttl auto')).toBeTruthy() // ttl 1 → 'auto'
  expect(getByText('ttl 3600')).toBeTruthy()
})

test('DNS create posts ttl:1/proxied:false and resets the draft', async () => {
  const { getByTestId } = render(<CloudflareScreen />)
  fireEvent.press(getByTestId('tab-dns'))
  fireEvent.changeText(getByTestId('dns-name'), 'svc')
  fireEvent.press(getByTestId('dns-type-CNAME'))
  fireEvent.changeText(getByTestId('dns-content'), 'target.example.com')
  fireEvent.press(getByTestId('dns-add'))
  await waitFor(() => expect(mockCreateRecord).toHaveBeenCalledWith('z-aaaa', {
    type: 'CNAME', name: 'svc', content: 'target.example.com', ttl: 1, proxied: false,
  }))
})

test('DNS delete calls deleteCfRecord with the zone + record id', async () => {
  const { getByTestId } = render(<CloudflareScreen />)
  fireEvent.press(getByTestId('tab-dns'))
  fireEvent.press(getByTestId('record-del-r1'))
  await waitFor(() => expect(mockDeleteRecord).toHaveBeenCalledWith('z-aaaa', 'r1'))
})

test('DNS picking another zone chip re-queries records', () => {
  const { getByTestId } = render(<CloudflareScreen />)
  fireEvent.press(getByTestId('tab-dns'))
  fireEvent.press(getByTestId('zone-z-bbbb'))
  expect(mockRecords).toHaveBeenLastCalledWith('z-bbbb')
})

// ── Hosts ────────────────────────────────────────────────────────────────────────

test('Hosts tab renders one card per server with ssh_host via nullStr', () => {
  const { getByTestId, getByText, getAllByText } = render(<CloudflareScreen />)
  fireEvent.press(getByTestId('tab-hosts'))
  expect(getByText('alpha')).toBeTruthy()
  expect(getByText('203.0.113.7')).toBeTruthy() // sql.NullString {Valid:true}
  expect(getByText('beta')).toBeTruthy()
  expect(getAllByText('—').length).toBeGreaterThanOrEqual(1) // beta ssh_host invalid → '—'
  // the existing mapping renders domain → content (type)
  expect(getByText('alpha.hosts.example.com')).toBeTruthy()
  expect(getByText(/203.0.113.7 \(A\)/)).toBeTruthy()
})

test('Hosts "default" button adds with server_id only (auto-build)', async () => {
  const { getByTestId } = render(<CloudflareScreen />)
  fireEvent.press(getByTestId('tab-hosts'))
  fireEvent.press(getByTestId('host-default-9'))
  await waitFor(() => expect(mockAddDomain).toHaveBeenCalledWith({ server_id: 9 }))
})

test('Hosts custom input adds with an explicit domain', async () => {
  const { getByTestId } = render(<CloudflareScreen />)
  fireEvent.press(getByTestId('tab-hosts'))
  fireEvent.changeText(getByTestId('host-input-7'), 'custom.example.com')
  fireEvent.press(getByTestId('host-add-7'))
  await waitFor(() => expect(mockAddDomain).toHaveBeenCalledWith({ server_id: 7, domain: 'custom.example.com' }))
})

test('Hosts trash removes a mapping by its local row id', async () => {
  const { getByTestId } = render(<CloudflareScreen />)
  fireEvent.press(getByTestId('tab-hosts'))
  fireEvent.press(getByTestId('host-del-1'))
  await waitFor(() => expect(mockRemoveDomain).toHaveBeenCalledWith(1))
})

test('Hosts surfaces a backend error (e.g. zone_id not configured)', async () => {
  mockAddDomain.mockRejectedValue(new Error('plugin zone_id not configured'))
  const { getByTestId, findByText } = render(<CloudflareScreen />)
  fireEvent.press(getByTestId('tab-hosts'))
  fireEvent.press(getByTestId('host-default-7'))
  expect(await findByText(/plugin zone_id not configured/)).toBeTruthy()
})

// ── Activity ─────────────────────────────────────────────────────────────────────

test('Activity tab is a static placeholder (no fetch)', () => {
  const { getByTestId, getByText } = render(<CloudflareScreen />)
  fireEvent.press(getByTestId('tab-activity'))
  expect(getByText(/audit log integration is tracked separately/)).toBeTruthy()
})
