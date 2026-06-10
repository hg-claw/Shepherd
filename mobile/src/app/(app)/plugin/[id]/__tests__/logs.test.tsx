import React from 'react'
import { render, fireEvent, act } from '@testing-library/react-native'
import PluginLogsScreen from '../logs'
import { useAuth } from '@/store/auth'

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'xray' }),
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
  Stack: Object.assign(() => null, { Screen: () => null }),
}))
jest.mock('@/api/plugins', () => ({
  ...jest.requireActual('@/api/plugins'), // keep the REAL pluginLogsWSURL
  usePluginHosts: () => ({
    data: [
      { id: 1, plugin_id: 'xray', server_id: 7, status: 'running', updated_at: '' },
      { id: 2, plugin_id: 'xray', server_id: 9, status: 'running', updated_at: '' },
    ],
    isLoading: false,
    isError: false,
  }),
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

beforeEach(() => {
  jest.useFakeTimers()
  FakeWS.instances = []
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
