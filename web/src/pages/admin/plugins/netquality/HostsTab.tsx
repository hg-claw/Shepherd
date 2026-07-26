import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ListChecks } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Pill } from '@/components/Pill'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell, TableEmpty } from '@/components/ui/table'
import { useServers, type ServerRecord } from '@/api/servers'
import { listNetqualityHosts, putNetqualityHost, type NetqualityHost } from '@/api/netquality'
import { useUI } from '@/store/ui'
import HostTargetsDialog from './HostTargetsDialog'

// One row per server. enabled toggle is the master switch; the interval
// selector only matters when enabled is true. We default new hosts to
// 300s (5 min) — matches the server-side schema default.
const INTERVAL_OPTIONS = [
  { value: 60,   key: 'm1',  fallback: '1 min' },
  { value: 180,  key: 'm3',  fallback: '3 min' },
  { value: 300,  key: 'm5',  fallback: '5 min' },
  { value: 600,  key: 'm10', fallback: '10 min' },
  { value: 1800, key: 'm30', fallback: '30 min' },
]

export default function HostsTab() {
  const { t } = useTranslation()
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
      toast('success', t('netquality.hosts.updated_toast', 'Updated'))
      qc.invalidateQueries({ queryKey: ['netquality', 'hosts'] })
    },
    onError: (e: unknown) => toast('error', String((e as Error)?.message ?? e)),
  })

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {t('netquality.hosts.description_pre', 'Enable the netquality probe on a server, then pick how often the agent should run the ping burst. Builtin targets are used; manage the catalog under the')}{' '}
        <em>{t('netquality.hosts.description_targets_tab', 'Targets')}</em>{' '}
        {t('netquality.hosts.description_post', 'tab.')}
      </p>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>{t('netquality.hosts.server', 'Server')}</TableHead>
            <TableHead>{t('netquality.hosts.enabled', 'Enabled')}</TableHead>
            <TableHead>{t('netquality.hosts.interval', 'Interval')}</TableHead>
            <TableHead>{t('netquality.hosts.last_error', 'Last error')}</TableHead>
            <TableHead>{t('netquality.hosts.updated', 'Updated')}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
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
            <TableEmpty colSpan={6}>{t('netquality.empty.hosts', 'No servers registered yet.')}</TableEmpty>
          )}
        </TableBody>
      </Table>

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
  const { t } = useTranslation()
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
    <TableRow>
      <TableCell>
        <div className="font-medium">{server.name}</div>
        {sshHost && <div className="text-2xs text-muted-foreground font-mono">{sshHost}</div>}
      </TableCell>
      <TableCell>
        <Switch
          checked={enabled}
          disabled={busy}
          onCheckedChange={(v) => {
            setEnabled(v)
            onApply(v, interval)
          }}
        />
      </TableCell>
      <TableCell>
        <Select
          value={String(interval)}
          disabled={busy || !enabled}
          onValueChange={(v) => {
            const n = Number(v)
            setInterval(n)
            onApply(enabled, n)
          }}
        >
          <SelectTrigger className="h-7 w-24 text-2xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {INTERVAL_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={String(o.value)}>
                {t(`netquality.hosts.interval_options.${o.key}`, o.fallback)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell>
        {lastErr ? (
          <Pill kind="err">{lastErr.slice(0, 60)}</Pill>
        ) : (
          <span className="text-muted-foreground text-xs">—</span>
        )}
      </TableCell>
      <TableCell className="font-mono text-2xs text-muted-foreground">
        {host?.updated_at ? new Date(host.updated_at).toLocaleString() : '—'}
      </TableCell>
      <TableCell className="text-right">
        <span className="inline-flex items-center gap-1">
          {enabled && (
            <Button
              variant="ghost"
              size="xs"
              className="text-2xs"
              onClick={onPickTargets}
              title={t('netquality.hosts.pick_targets_title', 'Pick which targets this host samples')}
            >
              <ListChecks className="h-3.5 w-3.5 mr-1" />
              {t('netquality.hosts.pick_targets', 'Targets')}
            </Button>
          )}
          <Button asChild variant="ghost" size="xs" className="text-2xs">
            <a href={`/admin/plugins/netquality/results?server_id=${server.id}`}>
              {t('netquality.hosts.results_link', 'Results →')}
            </a>
          </Button>
        </span>
      </TableCell>
    </TableRow>
  )
}
