import { describe, it, expect, beforeEach } from 'vitest'
import { useWallLiveStore } from './wallLive'

describe('wallLive store', () => {
  beforeEach(() => useWallLiveStore.setState({ live: {}, connected: false }))

  it('setFrame updates only that id; other ids keep reference', () => {
    const s = useWallLiveStore.getState()
    s.setFrame(1, 10, 20)
    s.setFrame(2, 30, 40)
    const before = useWallLiveStore.getState().live[1]
    useWallLiveStore.getState().setFrame(2, 31, 41)
    const after = useWallLiveStore.getState().live
    expect(after[1]).toBe(before)
    expect(after[2]).toEqual({ rx_bps: 31, tx_bps: 41 })
  })

  it('setConnected toggles', () => {
    useWallLiveStore.getState().setConnected(true)
    expect(useWallLiveStore.getState().connected).toBe(true)
  })
})
