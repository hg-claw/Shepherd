import { useEffect } from 'react'
import { AppState } from 'react-native'
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
// → no bearer. Re-keys on baseURL (so a new login reconnects to the new host), and
// auto-reconnects with backoff + on foreground — otherwise the socket dies on the
// first sleep/wake or network blip and the "live" numbers silently freeze.
export function useWallLiveConnection(): void {
  const baseURL = useAuth((s) => s.baseURL)
  useEffect(() => {
    if (!baseURL) return
    const { setFrame, setConnected } = useWallLiveStore.getState()
    let ws: WebSocket | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let stopped = false
    let backoff = 1000

    const open = () => {
      if (stopped) return
      ws = new WebSocket(wsURL(baseURL, '/api/public/net-live/ws'))
      ws.onopen = () => { backoff = 1000; setConnected(true) }
      ws.onmessage = (ev: { data: string }) => {
        try {
          const f = JSON.parse(ev.data) as { server_id: number; rx_bps: number; tx_bps: number }
          setFrame(f.server_id, f.rx_bps, f.tx_bps)
        } catch {
          /* ignore malformed frame */
        }
      }
      ws.onerror = () => { ws?.close() }
      ws.onclose = () => {
        setConnected(false)
        if (!stopped) { timer = setTimeout(open, backoff); backoff = Math.min(backoff * 2, 30_000) }
      }
    }

    // On resume, if the socket is gone, reopen immediately instead of waiting on backoff.
    const reconnectNow = () => {
      if (stopped) return
      if (!ws || ws.readyState === 2 || ws.readyState === 3) {
        if (timer) { clearTimeout(timer); timer = null }
        backoff = 1000
        open()
      }
    }
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') reconnectNow() })

    open()
    return () => {
      stopped = true
      sub.remove()
      if (timer) clearTimeout(timer)
      if (ws) { ws.onclose = null; ws.onmessage = null; ws.close() }
    }
  }, [baseURL])
}

// Subscribes to one server's latest {rx,tx}; re-renders only when THAT id changes.
export function useLiveNet(id: number): LiveVal | undefined {
  return useWallLiveStore((s) => s.live[id])
}
