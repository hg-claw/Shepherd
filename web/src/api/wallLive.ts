import { create } from 'zustand'
import { useEffect } from 'react'

export type LiveVal = { rx_bps: number; tx_bps: number }

type WallLiveState = {
  live: Record<number, LiveVal>
  connected: boolean
  setFrame: (id: number, rx: number, tx: number) => void
  setConnected: (b: boolean) => void
}

// One store keyed by server_id. setFrame replaces only the changed id's value,
// leaving sibling references stable so per-id subscribers don't re-render.
export const useWallLiveStore = create<WallLiveState>((set) => ({
  live: {},
  connected: false,
  setFrame: (id, rx, tx) =>
    set((s) => ({ live: { ...s.live, [id]: { rx_bps: rx, tx_bps: tx } } })),
  setConnected: (connected) => set({ connected }),
}))

// useWallLiveConnection opens the single multiplexed public net WS and writes
// frames into the store. Call ONCE near the top of the wall.
export function useWallLiveConnection(): void {
  useEffect(() => {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${window.location.host}/api/public/net-live/ws`)
    const { setFrame, setConnected } = useWallLiveStore.getState()
    ws.onopen = () => setConnected(true)
    ws.onclose = () => setConnected(false)
    ws.onmessage = (ev) => {
      try {
        const f = JSON.parse(ev.data as string) as { server_id: number; rx_bps: number; tx_bps: number }
        setFrame(f.server_id, f.rx_bps, f.tx_bps)
      } catch {
        /* ignore malformed frame */
      }
    }
    return () => {
      ws.onmessage = null
      ws.close()
    }
  }, [])
}

// useLiveNet subscribes to one server's latest {rx,tx}; re-renders the caller
// only when THAT id's value changes.
export function useLiveNet(id: number): LiveVal | undefined {
  return useWallLiveStore((s) => s.live[id])
}
