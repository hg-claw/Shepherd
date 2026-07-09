import { useQuery } from '@tanstack/react-query'
import { listPluginEvents } from '@/api/plugins'
import { Pill, type PillKind } from '@/components/Pill'
import { useVirtualRows } from '@/lib/useVirtualRows'

function resultKind(r: string): PillKind {
  return r === 'ok' ? 'ok' : 'err'
}

const COLS = 4

export default function EventsTab() {
  const q = useQuery({
    queryKey: ['plugin-events', 'singbox'],
    queryFn: () => listPluginEvents('singbox', { limit: 200 }),
    refetchInterval: 10_000,
  })
  const rows = q.data ?? []
  const { parentRef, items, padTop, padBottom } = useVirtualRows(rows)
  return (
    <div className="rounded-lg border bg-elev">
      <div ref={parentRef} className="max-h-[70vh] overflow-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-left">
              <th className="px-3 py-2 text-2xs uppercase tracking-[0.05em] text-muted-foreground">Time</th>
              <th className="px-3 py-2 text-2xs uppercase tracking-[0.05em] text-muted-foreground">Action</th>
              <th className="px-3 py-2 text-2xs uppercase tracking-[0.05em] text-muted-foreground">Host</th>
              <th className="px-3 py-2 text-2xs uppercase tracking-[0.05em] text-muted-foreground">Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={COLS} className="px-3 py-6 text-center text-muted-foreground">No events yet.</td></tr>
            ) : (
              <>
                {padTop > 0 && <tr aria-hidden><td colSpan={COLS} style={{ height: padTop }} /></tr>}
                {items.map((vi) => {
                  const e = rows[vi.index]
                  return (
                    <tr key={vi.index} data-index={vi.index} className="border-t">
                      <td className="px-3 py-2 font-mono text-xs text-fg-dim whitespace-nowrap">{e.ts}</td>
                      <td className="px-3 py-2 font-mono text-sm">{e.action}</td>
                      <td className="px-3 py-2 font-mono text-xs">{e.server_id ?? '—'}</td>
                      <td className="px-3 py-2"><Pill kind={resultKind(e.result)}>{e.result}</Pill></td>
                    </tr>
                  )
                })}
                {padBottom > 0 && <tr aria-hidden><td colSpan={COLS} style={{ height: padBottom }} /></tr>}
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
