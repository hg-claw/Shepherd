import { useEffect, useState } from 'react'

export type WallLiveMap = Map<number, { rx_bps: number; tx_bps: number }>

// useWallLiveNet opens ONE multiplexed public WebSocket and keeps the latest
// {rx_bps,tx_bps} per server_id. All other wall metrics stay on the 30s poll.
export function useWallLiveNet(): { live: WallLiveMap; connected: boolean } {
  const [live, setLive] = useState<WallLiveMap>(() => new Map())
  const [connected, setConnected] = useState(false)
  useEffect(() => {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${window.location.host}/api/public/net-live/ws`)
    ws.onopen = () => setConnected(true)
    ws.onclose = () => setConnected(false)
    ws.onmessage = (ev) => {
      let f: { server_id: number; rx_bps: number; tx_bps: number }
      try {
        f = JSON.parse(ev.data as string)
      } catch {
        return
      }
      setLive((prev) => {
        const m = new Map(prev)
        m.set(f.server_id, { rx_bps: f.rx_bps, tx_bps: f.tx_bps })
        return m
      })
    }
    return () => {
      ws.onmessage = null
      ws.close()
    }
  }, [])
  return { live, connected }
}
