import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ListChecks } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Pill } from '@/components/Pill'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useServers, type ServerRecord } from '@/api/servers'
import { listNetqualityHosts, putNetqualityHost, type NetqualityHost } from '@/api/netquality'
import { useUI } from '@/store/ui'
import HostTargetsDialog from './HostTargetsDialog'

// One row per server. enabled toggle is the master switch; the interval
// selector only matters when enabled is true. We default new hosts to
// 300s (5 min) — matches the server-side schema default.
const INTERVAL_OPTIONS = [
  { value: 60,   label: '1 min' },
  { value: 180,  label: '3 min' },
  { value: 300,  label: '5 min' },
  { value: 600,  label: '10 min' },
  { value: 1800, label: '30 min' },
]

export default function HostsTab() {
  const qc = useQueryClient()
  const toast = useUI((s) => s.toast)

  const { data: servers = [] } = useServers()
  const hostsQ = useQuery({
    queryKey: ['netquality', 'hosts'],
    queryFn: listNetqualityHosts,
    refetchInterval: 15_000,
  })
  const hostByID = new Map<number, NetqualityHost>(
    (hostsQ.data ?? []).map((h) => [h.server_id, h]),
  )

  // Per-host targets dialog state. We track which server's picker is open
  // here (rather than inside HostRow) so the dialog re-renders cleanly on
  // close — keying off a single piece of state.
  const [targetsFor, setTargetsFor] = useState<{ id: number; name: string } | null>(null)

  const apply = useMutation({
    mutationFn: ({ serverID, enabled, interval }: { serverID: number; enabled: boolean; interval: number }) =>
      putNetqualityHost(serverID, { enabled, sample_interval_seconds: interval }),
    onSuccess: () => {
      toast('success', 'Updated')
      qc.invalidateQueries({ queryKey: ['netquality', 'hosts'] })
    },
    onError: (e: unknown) => toast('error', String((e as Error)?.message ?? e)),
  })

  return (
    <div className="space-y-2">
      <div className="text-[12.5px] text-muted-foreground mb-3">
        Enable the netquality probe on a server, then pick how often the agent should run the ping
        burst. Builtin targets are used; manage the catalog under the <em>Targets</em> tab.
      </div>
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b text-[11px] text-muted-foreground uppercase tracking-wide">
            <th className="text-left py-2 pr-4 font-medium">Server</th>
            <th className="text-left py-2 pr-4 font-medium">Enabled</th>
            <th className="text-left py-2 pr-4 font-medium">Interval</th>
            <th className="text-left py-2 pr-4 font-medium">Last error</th>
            <th className="text-left py-2 font-medium">Updated</th>
          </tr>
        </thead>
        <tbody>
          {servers.map((s: ServerRecord) => (
            <HostRow
              key={s.id}
              server={s}
              host={hostByID.get(s.id)}
              busy={apply.isPending}
              onApply={(enabled, interval) => apply.mutate({ serverID: s.id, enabled, interval })}
              onPickTargets={() => setTargetsFor({ id: s.id, name: s.name })}
            />
          ))}
          {servers.length === 0 && (
            <tr>
              <td colSpan={5} className="py-6 text-center text-muted-foreground text-[13px]">
                No servers registered yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {targetsFor && (
        <HostTargetsDialog
          open={true}
          onOpenChange={(open) => { if (!open) setTargetsFor(null) }}
          serverID={targetsFor.id}
          serverName={targetsFor.name}
        />
      )}
    </div>
  )
}

function HostRow({
  server,
  host,
  busy,
  onApply,
  onPickTargets,
}: {
  server: ServerRecord
  host: NetqualityHost | undefined
  busy: boolean
  onApply: (enabled: boolean, interval: number) => void
  onPickTargets: () => void
}) {
  // Local state tracks the user's pending edit. We commit on toggle /
  // interval change immediately — saves a round of "click apply".
  const [enabled, setEnabled] = useState<boolean>(host?.enabled ?? false)
  const [interval, setInterval] = useState<number>(host?.sample_interval_seconds ?? 300)
  // Resync local state when server data changes underneath us (other tab,
  // batch toggle, etc.). Strict-mode safe because effect compares values.
  if (host && (host.enabled !== enabled || host.sample_interval_seconds !== interval)) {
    // Only sync when the operator hasn't started editing — we never want
    // to clobber an in-flight click. Cheapest signal: if mutation isn't
    // pending. (busy is the mutation's own pending flag.)
    if (!busy) {
      setEnabled(host.enabled)
      setInterval(host.sample_interval_seconds)
    }
  }

  const sshHost = server.ssh_host?.Valid ? server.ssh_host.String : null
  const lastErr = host?.last_error
  return (
    <tr className="border-b last:border-0">
      <td className="py-2 pr-4">
        <div className="font-medium">{server.name}</div>
        {sshHost && <div className="text-[11px] text-muted-foreground font-mono">{sshHost}</div>}
      </td>
      <td className="py-2 pr-4">
        <Switch
          checked={enabled}
          disabled={busy}
          onCheckedChange={(v) => {
            setEnabled(v)
            onApply(v, interval)
          }}
        />
      </td>
      <td className="py-2 pr-4">
        <Select
          value={String(interval)}
          disabled={busy || !enabled}
          onValueChange={(v) => {
            const n = Number(v)
            setInterval(n)
            onApply(enabled, n)
          }}
        >
          <SelectTrigger className="h-7 w-24 text-[11.5px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {INTERVAL_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={String(o.value)}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </td>
      <td className="py-2 pr-4">
        {lastErr ? (
          <Pill kind="err">{lastErr.slice(0, 60)}</Pill>
        ) : (
          <span className="text-muted-foreground text-[12px]">—</span>
        )}
      </td>
      <td className="py-2 pr-4 font-mono text-[11px] text-muted-foreground">
        {host?.updated_at ? new Date(host.updated_at).toLocaleString() : '—'}
      </td>
      <td className="py-2 text-right">
        <span className="inline-flex items-center gap-1">
          {enabled && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[11.5px]"
              onClick={onPickTargets}
              title="Pick which targets this host samples"
            >
              <ListChecks className="h-3.5 w-3.5 mr-1" />
              Targets
            </Button>
          )}
          <Button asChild variant="ghost" size="sm" className="h-7 px-2 text-[11.5px]">
            <a href={`/admin/plugins/netquality/results?server_id=${server.id}`}>Results →</a>
          </Button>
        </span>
      </td>
    </tr>
  )
}
