import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Pill } from '@/components/Pill'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useServers, type ServerRecord } from '@/api/servers'
import { listSSHAuditHosts, putSSHAuditHost, collectSSHAuditHost, type SSHAuditHost } from '@/api/sshaudit'
import { relativeTime } from '@/lib/time'
import { useUI } from '@/store/ui'

// One row per server. enabled toggle is the master switch; the interval
// selector only matters when enabled is true. Server-side clamps to >= 60s,
// so we never offer anything below 1 min. Default new hosts to 300s (5 min).
const INTERVAL_OPTIONS = [
  { value: 60,   label: '1 min' },
  { value: 300,  label: '5 min' },
  { value: 900,  label: '15 min' },
  { value: 1800, label: '30 min' },
]

export default function HostsTab() {
  const qc = useQueryClient()
  const toast = useUI((s) => s.toast)

  const { data: servers = [] } = useServers()
  const hostsQ = useQuery({
    queryKey: ['sshaudit', 'hosts'],
    queryFn: listSSHAuditHosts,
    refetchInterval: 15_000,
  })
  const hostByID = new Map<number, SSHAuditHost>(
    (hostsQ.data ?? []).map((h) => [h.server_id, h]),
  )

  const apply = useMutation({
    mutationFn: ({ serverID, enabled, interval }: { serverID: number; enabled: boolean; interval: number }) =>
      putSSHAuditHost(serverID, { enabled, poll_interval_seconds: interval }),
    onSuccess: () => {
      toast('success', 'Updated')
      qc.invalidateQueries({ queryKey: ['sshaudit', 'hosts'] })
    },
    onError: (e: unknown) => toast('error', String((e as Error)?.message ?? e)),
  })

  const collect = useMutation({
    mutationFn: (serverID: number) => collectSSHAuditHost(serverID),
    onSuccess: (res) => {
      toast('success', `Collected (${res.inserted} new)`)
      qc.invalidateQueries({ queryKey: ['sshaudit', 'hosts'] })
    },
    onError: (e: unknown) => toast('error', String((e as Error)?.message ?? e)),
  })

  return (
    <div className="space-y-2">
      <div className="text-[12.5px] text-muted-foreground mb-3">
        Enable SSH auditing on a server, then pick how often the agent should collect login history
        (the minimum is 1 min). Use <em>Collect now</em> to force an immediate pull. Live sessions and
        the login history live under the <em>Sessions</em> and <em>Login History</em> tabs.
      </div>
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b text-[11px] text-muted-foreground uppercase tracking-wide">
            <th className="text-left py-2 pr-4 font-medium">Server</th>
            <th className="text-left py-2 pr-4 font-medium">Enabled</th>
            <th className="text-left py-2 pr-4 font-medium">Interval</th>
            <th className="text-left py-2 pr-4 font-medium">Last collect</th>
            <th className="text-left py-2 pr-4 font-medium">24h logins</th>
            <th className="text-left py-2 pr-4 font-medium">Last error</th>
            <th className="py-2"></th>
          </tr>
        </thead>
        <tbody>
          {servers.map((s: ServerRecord) => (
            <HostRow
              key={s.id}
              server={s}
              host={hostByID.get(s.id)}
              busy={apply.isPending}
              collecting={collect.isPending && collect.variables === s.id}
              onApply={(enabled, interval) => apply.mutate({ serverID: s.id, enabled, interval })}
              onCollect={() => collect.mutate(s.id)}
            />
          ))}
          {servers.length === 0 && (
            <tr>
              <td colSpan={7} className="py-6 text-center text-muted-foreground text-[13px]">
                No servers registered yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function HostRow({
  server,
  host,
  busy,
  collecting,
  onApply,
  onCollect,
}: {
  server: ServerRecord
  host: SSHAuditHost | undefined
  busy: boolean
  collecting: boolean
  onApply: (enabled: boolean, interval: number) => void
  onCollect: () => void
}) {
  const { t } = useTranslation()
  // Local state tracks the user's pending edit. We commit on toggle /
  // interval change immediately — saves a round of "click apply".
  const [enabled, setEnabled] = useState<boolean>(host?.enabled ?? false)
  const [interval, setInterval] = useState<number>(host?.poll_interval_seconds ?? 300)
  // Resync local state when server data changes underneath us (other tab,
  // batch toggle, etc.). Only when not mid-edit — never clobber an in-flight
  // click. (busy is the mutation's own pending flag.)
  if (host && (host.enabled !== enabled || host.poll_interval_seconds !== interval)) {
    if (!busy) {
      setEnabled(host.enabled)
      setInterval(host.poll_interval_seconds)
    }
  }

  const sshHost = server.ssh_host?.Valid ? server.ssh_host.String : null
  const lastErr = host?.last_error
  const rel = relativeTime(host?.last_collect_at ?? null)
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
      <td className="py-2 pr-4 text-[12px] text-muted-foreground">
        {rel ? t(rel.key, { n: rel.n }) : '—'}
      </td>
      <td className="py-2 pr-4 text-[12px]">
        {host ? (
          <span className="inline-flex items-center gap-2 font-mono tabular-nums">
            <span className="text-ok">✓ {host.accepted_24h}</span>
            <span className="text-err">✗ {host.failed_24h}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="py-2 pr-4">
        {lastErr ? (
          <Pill kind="err">{lastErr.slice(0, 60)}</Pill>
        ) : (
          <span className="text-muted-foreground text-[12px]">—</span>
        )}
      </td>
      <td className="py-2 text-right">
        <span className="inline-flex items-center gap-1">
          {enabled && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[11.5px]"
              disabled={collecting}
              onClick={onCollect}
              title="Force an immediate collection"
            >
              <RefreshCw className={`h-3.5 w-3.5 mr-1 ${collecting ? 'animate-spin' : ''}`} />
              Collect now
            </Button>
          )}
          <Button asChild variant="ghost" size="sm" className="h-7 px-2 text-[11.5px]">
            <a href={`/admin/plugins/sshaudit/sessions?server_id=${server.id}`}>Sessions →</a>
          </Button>
          <Button asChild variant="ghost" size="sm" className="h-7 px-2 text-[11.5px]">
            <a href={`/admin/plugins/sshaudit/history?server_id=${server.id}`}>History →</a>
          </Button>
        </span>
      </td>
    </tr>
  )
}
