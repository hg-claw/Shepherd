import { useEffect, useRef, useState } from 'react'

export type LiveNetSample = { ts: string; rx_bps: number; tx_bps: number }
export type LivePoint = { ts: string; v: number }

export function liveNetWSURL(id: number): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${window.location.host}/api/servers/${id}/net-live/ws`
}

const WINDOW = 60

export function useLiveNet(id: number) {
  const [rx, setRx] = useState<number | null>(null)
  const [tx, setTx] = useState<number | null>(null)
  const [rxSeries, setRxSeries] = useState<LivePoint[]>([])
  const [txSeries, setTxSeries] = useState<LivePoint[]>([])
  const [connected, setConnected] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    if (!id) return
    const ws = new WebSocket(liveNetWSURL(id))
    wsRef.current = ws
    ws.onopen = () => setConnected(true)
    ws.onclose = () => setConnected(false)
    ws.onmessage = (ev) => {
      let s: LiveNetSample
      try {
        s = JSON.parse(ev.data as string)
      } catch {
        return
      }
      setRx(s.rx_bps)
      setTx(s.tx_bps)
      setRxSeries((prev) => [...prev, { ts: s.ts, v: s.rx_bps }].slice(-WINDOW))
      setTxSeries((prev) => [...prev, { ts: s.ts, v: s.tx_bps }].slice(-WINDOW))
    }
    return () => {
      ws.onmessage = null
      ws.close()
      wsRef.current = null
    }
  }, [id])

  return { rx, tx, rxSeries, txSeries, connected }
}
