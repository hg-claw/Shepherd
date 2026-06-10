import React from 'react'
import { render, fireEvent, act } from '@testing-library/react-native'
import PluginLogsScreen from '../logs'
import { useAuth } from '@/store/auth'

// Default host rows = the generic deploy-table shape (with `id`). Individual
// tests can swap mockHosts to the netquality probe-config shape (no `id`).
let mockHosts: { data: unknown[]; isLoading: boolean; isError: boolean } = {
  data: [
    { id: 1, plugin_id: 'xray', server_id: 7, status: 'running', updated_at: '' },
    { id: 2, plugin_id: 'xray', server_id: 9, status: 'running', updated_at: '' },
  ],
  isLoading: false,
  isError: false,
}

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'xray' }),
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
  Stack: Object.assign(() => null, { Screen: () => null }),
}))
jest.mock('@/api/plugins', () => ({
  ...jest.requireActual('@/api/plugins'), // keep the REAL pluginLogsWSURL
  usePluginHosts: () => mockHosts,
}))
jest.mock('@/api/servers', () => ({
  useServers: () => ({
    data: [
      { id: 7, name: 'alpha', connected: true, latest: null },
      { id: 9, name: 'beta', connected: true, latest: null, public_alias: { String: 'edge-9', Valid: true } },
    ],
  }),
}))

type WSOpts = { headers?: Record<string, string> } | undefined

class FakeWS {
  static instances: FakeWS[] = []
  static get last(): FakeWS { return FakeWS.instances[FakeWS.instances.length - 1] }
  url: string
  opts: WSOpts
  readyState = 1
  onopen: (() => void) | null = null
  onmessage: ((e: { data?: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  close = jest.fn(() => { this.readyState = 3 })
  constructor(url: string, _protocols: unknown, opts: WSOpts) {
    this.url = url
    this.opts = opts
    FakeWS.instances.push(this)
  }
}

const line = (s: string) => ({ data: JSON.stringify({ ts: '2026-06-09T12:34:56Z', level: 'info', line: s }) })

const DEFAULT_HOSTS = {
  data: [
    { id: 1, plugin_id: 'xray', server_id: 7, status: 'running', updated_at: '' },
    { id: 2, plugin_id: 'xray', server_id: 9, status: 'running', updated_at: '' },
  ],
  isLoading: false,
  isError: false,
}

beforeEach(() => {
  jest.useFakeTimers()
  FakeWS.instances = []
  mockHosts = DEFAULT_HOSTS
  ;(global as unknown as { WebSocket: unknown }).WebSocket = FakeWS
  useAuth.setState({ status: 'signedIn', baseURL: 'https://h', token: 'SEKRIT123', admin: null, error: null })
})
afterEach(() => {
  jest.useRealTimers()
})

test('connects on mount to the first host with the bearer in headers, not the URL', () => {
  render(<PluginLogsScreen />)
  expect(FakeWS.instances).toHaveLength(1)
  expect(FakeWS.last.url).toBe('wss://h/api/admin/plugins/xray/hosts/7/logs')
  expect(FakeWS.last.opts?.headers?.Authorization).toBe('Bearer SEKRIT123')
  expect(FakeWS.last.url).not.toMatch(/SEKRIT123|bearer/i)
})

test('renders log lines on message; pause drops them; resume appends again', () => {
  const { getByText, getByTestId, queryByText } = render(<PluginLogsScreen />)
  act(() => { FakeWS.last.onopen?.() })
  expect(getByText('live')).toBeTruthy()

  act(() => { FakeWS.last.onmessage?.(line('hello-one')); jest.advanceTimersByTime(250) })
  expect(getByText(/hello-one/)).toBeTruthy()

  fireEvent.press(getByTestId('pause-btn'))
  act(() => { FakeWS.last.onmessage?.(line('hello-two')); jest.advanceTimersByTime(250) })
  expect(queryByText(/hello-two/)).toBeNull()
  expect(getByText(/hello-one/)).toBeTruthy() // pause keeps what's there

  fireEvent.press(getByTestId('pause-btn')) // resume
  act(() => { FakeWS.last.onmessage?.(line('hello-three')); jest.advanceTimersByTime(250) })
  expect(getByText(/hello-three/)).toBeTruthy()
})

test('clear empties the buffer', () => {
  const { getByText, getByTestId, queryByText } = render(<PluginLogsScreen />)
  act(() => { FakeWS.last.onmessage?.(line('to-be-cleared')); jest.advanceTimersByTime(250) })
  expect(getByText(/to-be-cleared/)).toBeTruthy()
  fireEvent.press(getByTestId('clear-btn'))
  expect(queryByText(/to-be-cleared/)).toBeNull()
  expect(getByText(/waiting for log lines/)).toBeTruthy()
})

test('close shows the pill; tapping it opens a fresh socket', () => {
  const { getByText, getByTestId } = render(<PluginLogsScreen />)
  act(() => { FakeWS.last.onopen?.(); FakeWS.last.readyState = 3; FakeWS.last.onclose?.() })
  expect(getByText(/closed · tap to reconnect/)).toBeTruthy()
  const first = FakeWS.last
  fireEvent.press(getByTestId('status-pill'))
  expect(FakeWS.instances).toHaveLength(2)
  expect(FakeWS.last).not.toBe(first)
  expect(first.close).toHaveBeenCalled() // old effect cleanup closed it
  expect(getByText('connecting')).toBeTruthy()
})

test('switching hosts closes the old socket and connects to the new one', () => {
  const { getByTestId, getByText, queryByText } = render(<PluginLogsScreen />)
  act(() => { FakeWS.last.onmessage?.(line('from-seven')); jest.advanceTimersByTime(250) })
  expect(getByText(/from-seven/)).toBeTruthy()
  const first = FakeWS.last
  expect(getByText('edge-9')).toBeTruthy() // alias label via nullStr
  fireEvent.press(getByTestId('host-9'))
  expect(first.close).toHaveBeenCalled()
  expect(FakeWS.instances).toHaveLength(2)
  expect(FakeWS.last.url).toBe('wss://h/api/admin/plugins/xray/hosts/9/logs')
  expect(queryByText(/from-seven/)).toBeNull() // buffer cleared on switch
})

test('unmount closes the socket', () => {
  const { unmount } = render(<PluginLogsScreen />)
  const ws = FakeWS.last
  unmount()
  expect(ws.close).toHaveBeenCalled()
})

// ── regression: netquality host shape (no `id`) ───────────────────────────────
// netquality is host-aware, so its plugin detail screen shows a "Logs" row that
// opens THIS screen with id='netquality'. But /api/admin/plugins/netquality/hosts
// returns probe-config rows ({server_id, enabled, sample_interval_seconds}) with
// NO `id` field (see api/netquality.ts + internal/plugins/netquality/routes.go).
// Keying the host chips on the absent `h.id` collapsed every chip to
// key="undefined", which React's reconciler flagged at the chip render on device.
test('netquality host shape (no id) renders chips without a duplicate-key warning', () => {
  mockHosts = {
    data: [
      { server_id: 7, enabled: true, sample_interval_seconds: 300 },
      { server_id: 9, enabled: true, sample_interval_seconds: 300 },
    ],
    isLoading: false,
    isError: false,
  }
  const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
  const { getByText, getByTestId } = render(<PluginLogsScreen />)

  // Both chips resolve their server labels (alias via nullStr, else name).
  expect(getByText('alpha')).toBeTruthy()
  expect(getByText('edge-9')).toBeTruthy()
  // Both chips are individually addressable (distinct keys → both kept).
  expect(getByTestId('host-7')).toBeTruthy()
  expect(getByTestId('host-9')).toBeTruthy()
  // Connects to the first host derived from the id-less rows (route id is the
  // mocked 'xray' here; the regression is about the id-less ROW SHAPE).
  expect(FakeWS.last.url).toBe('wss://h/api/admin/plugins/xray/hosts/7/logs')

  // The whole point: no "two children with the same key, `undefined`" warning.
  const dupKeyWarning = errSpy.mock.calls.some((c) =>
    c.some((a) => typeof a === 'string' && /same key/.test(a)),
  )
  expect(dupKeyWarning).toBe(false)
  errSpy.mockRestore()
})

// A malformed frame (parsed JSON missing ts/line) must never crash the list:
// item.ts.slice on undefined would throw, and a non-string child inside <Text>
// is illegal. Both are coerced defensively.
test('a log frame missing ts/line does not crash the list', () => {
  const { getByTestId } = render(<PluginLogsScreen />)
  expect(() => {
    act(() => {
      FakeWS.last.onmessage?.({ data: JSON.stringify({ level: 'info' }) }) // no ts, no line
      jest.advanceTimersByTime(250)
    })
  }).not.toThrow()
  expect(getByTestId('log-list')).toBeTruthy()
})
