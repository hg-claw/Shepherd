import { useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

/**
 * Table-row virtualization via the padding-row technique: render two
 * spacer <tr>s around the visible slice so the scrollbar length stays
 * correct without absolute positioning inside <tbody>.
 */
export function useVirtualRows<T>(rows: T[], opts?: { estimateSize?: number; overscan?: number }) {
  const parentRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => opts?.estimateSize ?? 36,
    overscan: opts?.overscan ?? 10,
  })
  const items = virtualizer.getVirtualItems()
  const padTop = items.length > 0 ? items[0].start : 0
  const padBottom = items.length > 0 ? virtualizer.getTotalSize() - items[items.length - 1].end : 0
  return { parentRef, items, padTop, padBottom }
}
