import type { ReactNode } from 'react'
import { useLiveNet } from '@/api/wallLive'

// LiveNetCell subscribes to one server's live net via useLiveNet(id) and renders
// through the children render-prop, so only this leaf re-renders on a live frame
// (the surrounding row, with its 30s-static metrics, does not).
export function LiveNetCell({
  id,
  fallbackRx,
  fallbackTx,
  children,
}: {
  id: number
  fallbackRx: number
  fallbackTx: number
  children: (rx: number, tx: number) => ReactNode
}) {
  const live = useLiveNet(id)
  return <>{children(live?.rx_bps ?? fallbackRx, live?.tx_bps ?? fallbackTx)}</>
}
