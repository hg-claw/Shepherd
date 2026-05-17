import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { listPluginHosts } from '@/api/plugins'
import { Pill, type PillKind } from '@/components/Pill'

function statusKind(s: string): PillKind {
  if (s === 'running') return 'ok'
  if (s === 'deploying' || s === 'pending') return 'warn'
  if (s === 'failed') return 'err'
  return 'neutral'
}

export default function HostsTab() {
  const q = useQuery({
    queryKey: ['plugin-hosts', 'xray'],
    queryFn: () => listPluginHosts('xray'),
    refetchInterval: 5_000,
  })
  const hosts = q.data ?? []
  return (
    <div className="rounded-lg border bg-elev overflow-x-auto">
      <table className="w-full text-[13px] border-collapse">
        <thead>
          <tr className="text-left">
            <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Host</th>
            <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Version</th>
            <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Status</th>
            <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Last error</th>
          </tr>
        </thead>
        <tbody>
          {hosts.map((h) => (
            <tr key={h.id} className="border-t">
              <td className="px-3 py-2 font-mono">
                <Link className="hover:underline" to={`/admin/servers/${h.server_id}`}>#{h.server_id}</Link>
              </td>
              <td className="px-3 py-2 font-mono text-[12.5px]">{h.deployed_version ?? '—'}</td>
              <td className="px-3 py-2"><Pill kind={statusKind(h.status)}>{h.status}</Pill></td>
              <td className="px-3 py-2 text-[12px] text-err">{h.last_error ?? ''}</td>
            </tr>
          ))}
          {hosts.length === 0 && (
            <tr><td colSpan={4} className="px-3 py-6 text-center text-muted-foreground text-[13px]">
              No hosts deployed yet.
            </td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
