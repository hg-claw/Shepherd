import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Pill } from '@/components/Pill'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell, TableEmpty } from '@/components/ui/table'
import { useServers, type ServerRecord } from '@/api/servers'
import { listSSHAuditHosts, putSSHAuditHost, collectSSHAuditHost, type SSHAuditHost } from '@/api/sshaudit'
import { relativeTime } from '@/lib/time'
import { useUI } from '@/store/ui'

// One row per server. enabled toggle is the master switch; the interval
// selector only matters when enabled is true. Server-side clamps to >= 60s,
// so we never offer anything below 1 min. Default new hosts to 300s (5 min).
const INTERVAL_OPTIONS = [
  { value: 60,   key: 'm1',  fallback: '1 min' },
  { value: 300,  key: 'm5',  fallback: '5 min' },
  { value: 900,  key: 'm15', fallback: '15 min' },
  { value: 1800, key: 'm30', fallback: '30 min' },
]

export default function HostsTab() {
  const { t } = useTranslation()
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
      toast('success', t('sshaudit.hosts.updated_toast', 'Updated'))
      qc.invalidateQueries({ queryKey: ['sshaudit', 'hosts'] })
    },
    onError: (e: unknown) => toast('error', String((e as Error)?.message ?? e)),
  })

  const collect = useMutation({
    mutationFn: (serverID: number) => collectSSHAuditHost(serverID),
    onSuccess: (res) => {
      toast('success', t('sshaudit.hosts.collected_toast', 'Collected ({{n}} new)', { n: res.inserted }))
      qc.invalidateQueries({ queryKey: ['sshaudit', 'hosts'] })
    },
    onError: (e: unknown) => toast('error', String((e as Error)?.message ?? e)),
  })

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {t('sshaudit.hosts.description_pre', 'Enable SSH auditing on a server, then pick how often the agent should collect login history (the minimum is 1 min). Use')}{' '}
        <em>{t('sshaudit.hosts.collect_now', 'Collect now')}</em>{' '}
        {t('sshaudit.hosts.description_mid', 'to force an immediate pull. Live sessions and the login history live under the')}{' '}
        <em>{t('sshaudit.hosts.sessions_tab_name', 'Sessions')}</em>{' '}
        {t('sshaudit.hosts.description_and', 'and')}{' '}
        <em>{t('sshaudit.hosts.history_tab_name', 'Login History')}</em>{' '}
        {t('sshaudit.hosts.description_post', 'tabs.')}
      </p>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>{t('sshaudit.hosts.server', 'Server')}</TableHead>
            <TableHead>{t('sshaudit.hosts.enabled', 'Enabled')}</TableHead>
            <TableHead>{t('sshaudit.hosts.interval', 'Interval')}</TableHead>
            <TableHead>{t('sshaudit.hosts.last_collect', 'Last collect')}</TableHead>
            <TableHead>{t('sshaudit.hosts.logins_24h', '24h logins')}</TableHead>
            <TableHead>{t('sshaudit.hosts.last_error', 'Last error')}</TableHead>
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
              collecting={collect.isPending && collect.variables === s.id}
              onApply={(enabled, interval) => apply.mutate({ serverID: s.id, enabled, interval })}
              onCollect={() => collect.mutate(s.id)}
            />
          ))}
          {servers.length === 0 && (
            <TableEmpty colSpan={7}>{t('sshaudit.empty.hosts', 'No servers registered yet.')}</TableEmpty>
          )}
        </TableBody>
      </Table>
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
                {t(`sshaudit.hosts.interval_options.${o.key}`, o.fallback)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {rel ? t(rel.key, { n: rel.n }) : '—'}
      </TableCell>
      <TableCell className="text-xs">
        {host ? (
          <span className="inline-flex items-center gap-2 font-mono tabular-nums">
            <span className="text-ok">✓ {host.accepted_24h}</span>
            <span className="text-err">✗ {host.failed_24h}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell>
        {lastErr ? (
          <Pill kind="err">{lastErr.slice(0, 60)}</Pill>
        ) : (
          <span className="text-muted-foreground text-xs">—</span>
        )}
      </TableCell>
      <TableCell className="text-right">
        <span className="inline-flex items-center gap-1">
          {enabled && (
            <Button
              variant="ghost"
              size="xs"
              className="text-2xs"
              disabled={collecting}
              onClick={onCollect}
              title={t('sshaudit.hosts.collect_now_title', 'Force an immediate collection')}
            >
              <RefreshCw className={`h-3.5 w-3.5 mr-1 ${collecting ? 'animate-spin' : ''}`} />
              {t('sshaudit.hosts.collect_now', 'Collect now')}
            </Button>
          )}
          <Button asChild variant="ghost" size="xs" className="text-2xs">
            <a href={`/admin/plugins/sshaudit/sessions?server_id=${server.id}`}>
              {t('sshaudit.hosts.sessions_link', 'Sessions →')}
            </a>
          </Button>
          <Button asChild variant="ghost" size="xs" className="text-2xs">
            <a href={`/admin/plugins/sshaudit/history?server_id=${server.id}`}>
              {t('sshaudit.hosts.history_link', 'History →')}
            </a>
          </Button>
        </span>
      </TableCell>
    </TableRow>
  )
}
