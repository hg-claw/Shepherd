import { useQuery } from '@tanstack/react-query'
import { listPluginEvents } from '@/api/plugins'
import { Pill, type PillKind } from '@/components/Pill'

function resultKind(r: string): PillKind {
  return r === 'ok' ? 'ok' : 'err'
}

export default function EventsTab() {
  const q = useQuery({
    queryKey: ['plugin-events', 'xray'],
    queryFn: () => listPluginEvents('xray', { limit: 200 }),
    refetchInterval: 10_000,
  })
  const rows = q.data ?? []
  return (
    <div className="rounded-lg border bg-elev overflow-x-auto">
      <table className="w-full text-[13px] border-collapse">
        <thead>
          <tr className="text-left">
            <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Time</th>
            <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Action</th>
            <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Host</th>
            <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Result</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e, i) => (
            <tr key={i} className="border-t">
              <td className="px-3 py-2 font-mono text-[12px] text-fg-dim whitespace-nowrap">{e.ts}</td>
              <td className="px-3 py-2 font-mono text-[12.5px]">{e.action}</td>
              <td className="px-3 py-2 font-mono text-[12px]">{e.server_id ?? '—'}</td>
              <td className="px-3 py-2"><Pill kind={resultKind(e.result)}>{e.result}</Pill></td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">No events yet.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
