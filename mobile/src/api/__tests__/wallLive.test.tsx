import { renderHook } from '@testing-library/react-native'
import { useWallLiveStore, useWallLiveConnection, useLiveNet } from '../wallLive'
import { useAuth } from '@/store/auth'

class FakeWS {
  static last: FakeWS | null = null
  url: string
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  close = jest.fn()
  constructor(url: string) { this.url = url; FakeWS.last = this }
}

beforeEach(() => {
  useWallLiveStore.setState({ live: {}, connected: false })
  ;(global as unknown as { WebSocket: unknown }).WebSocket = FakeWS
  useAuth.setState({ status: 'signedIn', baseURL: 'https://h', token: 'T', admin: null, error: null })
})

test('setFrame updates one id; useLiveNet reads it', () => {
  useWallLiveStore.getState().setFrame(7, 100, 200)
  const { result } = renderHook(() => useLiveNet(7))
  expect(result.current).toEqual({ rx_bps: 100, tx_bps: 200 })
})

test('connection opens the public ws and writes frames', () => {
  renderHook(() => useWallLiveConnection())
  expect(FakeWS.last?.url).toBe('wss://h/api/public/net-live/ws')
  FakeWS.last?.onopen?.()
  expect(useWallLiveStore.getState().connected).toBe(true)
  FakeWS.last?.onmessage?.({ data: JSON.stringify({ server_id: 3, rx_bps: 5, tx_bps: 6 }) })
  expect(useWallLiveStore.getState().live[3]).toEqual({ rx_bps: 5, tx_bps: 6 })
})
