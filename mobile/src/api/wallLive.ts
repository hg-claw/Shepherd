import { useEffect } from 'react'
import { create } from 'zustand'
import { useAuth } from '@/store/auth'
import { wsURL } from '@/lib/wsurl'

export type LiveVal = { rx_bps: number; tx_bps: number }

type WallLiveState = {
  live: Record<number, LiveVal>
  connected: boolean
  setFrame: (id: number, rx: number, tx: number) => void
  setConnected: (b: boolean) => void
}

// One store keyed by server_id. setFrame replaces only the changed id's value so
// sibling references stay stable and per-id subscribers don't re-render.
export const useWallLiveStore = create<WallLiveState>((set) => ({
  live: {},
  connected: false,
  setFrame: (id, rx, tx) => set((s) => ({ live: { ...s.live, [id]: { rx_bps: rx, tx_bps: tx } } })),
  setConnected: (connected) => set({ connected }),
}))

// Opens the single public multiplexed net-live WS and writes frames into the store.
// Call ONCE for the authed session (mounted in (app)/_layout.tsx). Public endpoint
// → no bearer. Best-effort: if it never opens, cards use the polled fallback.
export function useWallLiveConnection(): void {
  useEffect(() => {
    const baseURL = useAuth.getState().baseURL
    if (!baseURL) return
    const ws = new WebSocket(wsURL(baseURL, '/api/public/net-live/ws'))
    const { setFrame, setConnected } = useWallLiveStore.getState()
    ws.onopen = () => setConnected(true)
    ws.onclose = () => setConnected(false)
    ws.onmessage = (ev: { data: string }) => {
      try {
        const f = JSON.parse(ev.data) as { server_id: number; rx_bps: number; tx_bps: number }
        setFrame(f.server_id, f.rx_bps, f.tx_bps)
      } catch {
        /* ignore malformed frame */
      }
    }
    return () => { ws.onmessage = null; ws.close() }
  }, [])
}

// Subscribes to one server's latest {rx,tx}; re-renders only when THAT id changes.
export function useLiveNet(id: number): LiveVal | undefined {
  return useWallLiveStore((s) => s.live[id])
}
