import { useQuery } from '@tanstack/react-query'
import { api } from '@/api/client'

interface Zone { id: string; name: string; status?: string; plan?: { name?: string } }

export default function ZonesTab() {
  const q = useQuery({
    queryKey: ['cf-zones'],
    queryFn: () => api.get<Zone[]>('/api/admin/plugins/cloudflare/zones'),
    staleTime: 60_000,
  })
  const zones = q.data ?? []
  if (q.isError) {
    return <div className="text-err text-[13px]">Failed to load zones: {(q.error as Error).message}</div>
  }
  return (
    <div className="rounded-lg border bg-elev overflow-x-auto">
      <table className="w-full text-[13px] border-collapse">
        <thead>
          <tr className="text-left">
            <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Name</th>
            <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Status</th>
            <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Plan</th>
            <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">ID</th>
          </tr>
        </thead>
        <tbody>
          {zones.map((z) => (
            <tr key={z.id} className="border-t">
              <td className="px-3 py-2 font-mono">{z.name}</td>
              <td className="px-3 py-2 text-[12px] text-muted-foreground">{z.status ?? '—'}</td>
              <td className="px-3 py-2 text-[12px] text-muted-foreground">{z.plan?.name ?? '—'}</td>
              <td className="px-3 py-2 font-mono text-[11px] text-fg-dim">{z.id}</td>
            </tr>
          ))}
          {zones.length === 0 && (
            <tr><td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">No zones.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
