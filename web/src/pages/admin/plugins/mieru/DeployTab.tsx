import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Play, Square, RotateCw, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Pill, type PillKind } from '@/components/Pill'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell, TableEmpty } from '@/components/ui/table'
import {
  listPluginHosts, fetchMieruVersions, patchMieruServerVersion, useHostLifecycle,
  type PluginHost,
} from '@/api/plugins'
import { useServers, type ServerRecord } from '@/api/servers'
import { useUI } from '@/store/ui'

type Status = PluginHost['status']

function statusPill(status: Status): { kind: PillKind; label: string } {
  switch (status) {
    case 'running': return { kind: 'ok', label: 'running' }
    case 'failed': return { kind: 'err', label: 'failed' }
    case 'deploying': return { kind: 'warn', label: 'deploying' }
    default: return { kind: 'neutral', label: status }
  }
}

function VersionInline({ serverID, current, versions }: { serverID: number; current: string | null; versions: string[] }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const toast = useUI((s) => s.toast)
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(current ?? '')
  const [useMirror, setUseMirror] = useState(false)
  const apply = useMutation({
    mutationFn: () => patchMieruServerVersion(serverID, value, useMirror),
    onSuccess: () => {
      toast('success', t('mieru.deploy.upgrading_toast', 'Upgrading to v{{version}}', { version: value }))
      qc.invalidateQueries({ queryKey: ['plugin-hosts', 'mieru'] })
      setEditing(false)
    },
    onError: (e: Error) => toast('error', e.message),
  })
  if (!editing) {
    return (
      <span className="font-mono text-xs text-fg-dim">
        {current ?? '—'}{' '}
        <button className="underline" onClick={() => { setValue(current ?? ''); setEditing(true) }}>{t('mieru.deploy.change', 'change')}</button>
      </span>
    )
  }
  const versionList = current && !versions.includes(current) ? [current, ...versions] : versions
  return (
    <span className="inline-flex items-center gap-1">
      <Select value={value} onValueChange={setValue}>
        <SelectTrigger className="h-6 w-28 font-mono text-2xs"><SelectValue /></SelectTrigger>
        <SelectContent>
          {versionList.map((v) => <SelectItem key={v} value={v} className="font-mono text-2xs">{v}</SelectItem>)}
        </SelectContent>
      </Select>
      <Button size="xs" className="text-2xs" disabled={apply.isPending} onClick={() => apply.mutate()}>{t('mieru.deploy.apply', 'Apply')}</Button>
      <label className="inline-flex items-center gap-1 text-fg-dim text-2xs cursor-pointer">
        <input type="checkbox" className="h-3 w-3" checked={useMirror} onChange={(e) => setUseMirror(e.target.checked)} />
        {t('mieru.deploy.mirror', 'mirror')}
      </label>
      <button className="text-fg-dim text-2xs" onClick={() => setEditing(false)}>{t('mieru.deploy.cancel', 'cancel')}</button>
    </span>
  )
}

function DeployButton({ serverID, versions }: { serverID: number; versions: string[] }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const toast = useUI((s) => s.toast)
  const [version, setVersion] = useState<string>(versions[0] ?? '')
  const [useMirror, setUseMirror] = useState(false)
  useEffect(() => { if (!version && versions[0]) setVersion(versions[0]) }, [versions, version])
  const deploy = useMutation({
    mutationFn: () => patchMieruServerVersion(serverID, version, useMirror),
    onSuccess: () => {
      toast('success', t('mieru.deploy.deploying_toast', 'Deploying v{{version}}', { version }))
      qc.invalidateQueries({ queryKey: ['plugin-hosts', 'mieru'] })
    },
    onError: (e: Error) => toast('error', e.message),
  })
  return (
    <span className="inline-flex items-center gap-1">
      <Select value={version} onValueChange={setVersion} disabled={!versions.length || deploy.isPending}>
        <SelectTrigger className="h-6 w-24 text-2xs font-mono"><SelectValue placeholder="version" /></SelectTrigger>
        <SelectContent>
          {versions.map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}
        </SelectContent>
      </Select>
      <Button size="xs" variant="outline" className="text-2xs" disabled={!version || deploy.isPending} onClick={() => deploy.mutate()}>
        {deploy.isPending ? t('mieru.deploy.deploying', 'Deploying…') : t('mieru.deploy.deploy', 'Deploy')}
      </Button>
      <label className="inline-flex items-center gap-1 text-fg-dim text-2xs cursor-pointer">
        <input type="checkbox" className="h-3 w-3" checked={useMirror} onChange={(e) => setUseMirror(e.target.checked)} />
        {t('mieru.deploy.mirror', 'mirror')}
      </label>
    </span>
  )
}

function LifecycleButtons({ serverID, status }: { serverID: number; status: Status }) {
  const { t } = useTranslation()
  const toast = useUI((s) => s.toast)
  const lc = useHostLifecycle('mieru', serverID)
  const busy = lc.start.isPending || lc.stop.isPending || lc.restart.isPending || lc.refreshStatus.isPending
  const wrap = (fn: () => Promise<unknown>) => () => fn().catch((e: Error) => toast('error', e.message))
  return (
    <span className="inline-flex items-center gap-1">
      {status !== 'running' && (
        <Button size="xs" variant="ghost" className="w-7 p-0" disabled={busy} title={t('mieru.deploy.start_title', 'Start')} onClick={wrap(() => lc.start.mutateAsync())}>
          <Play className="h-3 w-3" />
        </Button>
      )}
      {status === 'running' && (
        <Button size="xs" variant="ghost" className="w-7 p-0" disabled={busy} title={t('mieru.deploy.stop_title', 'Stop')} onClick={wrap(() => lc.stop.mutateAsync())}>
          <Square className="h-3 w-3" />
        </Button>
      )}
      <Button size="xs" variant="ghost" className="w-7 p-0" disabled={busy} title={t('mieru.deploy.restart_title', 'Restart')} onClick={wrap(() => lc.restart.mutateAsync())}>
        <RotateCw className="h-3 w-3" />
      </Button>
      <Button size="xs" variant="ghost" className="w-7 p-0" disabled={busy} title={t('mieru.deploy.refresh_title', 'Refresh status')} onClick={wrap(() => lc.refreshStatus.mutateAsync())}>
        <RefreshCw className="h-3 w-3" />
      </Button>
    </span>
  )
}

export default function DeployTab() {
  const { t } = useTranslation()
  const { data: servers = [] } = useServers()
  const hostsQ = useQuery({
    queryKey: ['plugin-hosts', 'mieru'],
    queryFn: () => listPluginHosts('mieru'),
    refetchInterval: (q) => {
      const rows = (q?.state?.data as Array<{ status?: string }> | undefined) ?? []
      return rows.some((r) => r.status === 'deploying') ? 2000 : 30_000
    },
  })
  const versionsQ = useQuery({ queryKey: ['mieru-versions'], queryFn: fetchMieruVersions })
  const hosts = hostsQ.data ?? []
  const hostByServerID = new Map(hosts.map((h) => [h.server_id, h]))
  const versionsData = versionsQ.data
  const allVersions: string[] = versionsData
    ? Array.from(new Set([...(versionsData.latest ?? []), ...(versionsData.cached ?? []).map((c) => c.version)]))
    : []
  const rows: Array<{ server: ServerRecord; host: PluginHost | undefined }> =
    servers.map((s) => ({ server: s, host: hostByServerID.get(s.id) }))

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        {t('mieru.deploy.linux_only', 'mita (mieru server) runs on Linux hosts only. Official binary from enfein/mieru.')}
      </p>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>{t('mieru.deploy.server', 'Server')}</TableHead>
            <TableHead>{t('mieru.deploy.status', 'Status')}</TableHead>
            <TableHead>{t('mieru.deploy.version', 'Version')}</TableHead>
            <TableHead>{t('mieru.deploy.last_error', 'Last Error')}</TableHead>
            <TableHead>{t('admin.actions', 'Actions')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(({ server, host }) => {
            const sshHost = server.ssh_host?.Valid ? server.ssh_host.String : null
            const { kind, label } = host ? statusPill(host.status) : { kind: 'neutral' as PillKind, label: '—' }
            const errTrunc = host?.last_error ? host.last_error.slice(0, 200) : null
            return (
              <TableRow key={server.id}>
                <TableCell>
                  <div className="font-medium">{server.name}</div>
                  {sshHost && <div className="text-2xs text-muted-foreground font-mono">{sshHost}</div>}
                </TableCell>
                <TableCell>
                  {host ? <Pill kind={kind}>{label}</Pill> : <span className="text-muted-foreground text-xs">{t('mieru.deploy.not_deployed', 'not deployed')}</span>}
                </TableCell>
                <TableCell>
                  {host ? <VersionInline serverID={server.id} current={host.deployed_version} versions={allVersions} /> : <span className="text-muted-foreground">—</span>}
                </TableCell>
                <TableCell>
                  {errTrunc ? (
                    <TooltipProvider delayDuration={150}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button type="button" className="inline-flex h-7 w-7 items-center justify-center rounded text-destructive" aria-label="error">⚠</button>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-md break-words text-xs">{errTrunc}</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  ) : <span className="text-muted-foreground">—</span>}
                </TableCell>
                <TableCell>
                  <span className="inline-flex items-center gap-1">
                    {host ? <LifecycleButtons serverID={server.id} status={host.status} /> : <DeployButton serverID={server.id} versions={allVersions} />}
                  </span>
                </TableCell>
              </TableRow>
            )
          })}
          {rows.length === 0 && <TableEmpty colSpan={5}>{t('mieru.empty.deploy', 'No servers found.')}</TableEmpty>}
        </TableBody>
      </Table>
    </div>
  )
}
