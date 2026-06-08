import type { ReactNode } from 'react'
import { useLiveNet } from '@/api/wallLive'

// Subscribes to one server's live net and renders through children, so only this
// leaf re-renders on a frame. Falls back to the polled values until a frame lands.
export function LiveNet({ id, fallbackRx, fallbackTx, children }: {
  id: number; fallbackRx: number; fallbackTx: number; children: (rx: number, tx: number) => ReactNode
}) {
  const live = useLiveNet(id)
  return <>{children(live?.rx_bps ?? fallbackRx, live?.tx_bps ?? fallbackTx)}</>
}
