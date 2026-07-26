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
  listPluginHosts,
  fetchXrayVersions,
  patchXrayServerVersion,
  useHostLifecycle,
  type PluginHost,
} from '@/api/plugins'
import { useServers, type ServerRecord } from '@/api/servers'
import { useUI } from '@/store/ui'

type XrayStatus = PluginHost['status']

function statusPill(status: XrayStatus): { kind: PillKind; label: string } {
  switch (status) {
    case 'running':   return { kind: 'ok',      label: 'running' }
    case 'deploying': return { kind: 'warn',     label: 'deploying' }
    case 'pending':   return { kind: 'warn',     label: 'pending' }
    case 'failed':    return { kind: 'err',      label: 'failed' }
    case 'stopped':   return { kind: 'neutral',  label: 'stopped' }
    default:          return { kind: 'neutral',  label: String(status) }
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
    mutationFn: () => patchXrayServerVersion(serverID, value, useMirror),
    onSuccess: () => {
      toast('success', t('xray.deploy.upgrading_toast', 'Upgrading to v{{version}}', { version: value }))
      qc.invalidateQueries({ queryKey: ['plugin-hosts', 'xray'] })
      setEditing(false)
    },
    onError: (e: any) => toast('error', String(e?.message ?? e)),
  })
  if (!editing) {
    return (
      <span className="font-mono text-xs text-fg-dim">
        {current ?? '—'}{' '}
        <button className="underline" onClick={() => { setValue(current ?? ''); setEditing(true) }}>{t('xray.deploy.change', 'change')}</button>
      </span>
    )
  }
  // Build version list; prepend current if not already included
  const versionList = current && !versions.includes(current) ? [current, ...versions] : versions
  return (
    <span className="inline-flex items-center gap-1">
      <Select value={value} onValueChange={setValue}>
        <SelectTrigger className="h-6 w-28 font-mono text-2xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {versionList.map((v) => (
            <SelectItem key={v} value={v} className="font-mono text-2xs">{v}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button size="xs" className="text-2xs" disabled={apply.isPending}
        onClick={() => apply.mutate()}>{t('xray.deploy.apply', 'Apply')}</Button>
      <label className="inline-flex items-center gap-1 text-fg-dim text-2xs cursor-pointer" title={t('xray.deploy.mirror_title', 'Route the binary download via gh-proxy.com (for CN hosts)')}>
        <input type="checkbox" className="h-3 w-3" checked={useMirror} onChange={(e) => setUseMirror(e.target.checked)} />
        {t('xray.deploy.mirror', 'mirror')}
      </label>
      <button className="text-fg-dim text-2xs" onClick={() => setEditing(false)}>{t('xray.deploy.cancel', 'cancel')}</button>
    </span>
  )
}

function RedeployButton({ serverID, deployedVersion }: { serverID: number; deployedVersion: string | null }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const toast = useUI((s) => s.toast)
  const [useMirror, setUseMirror] = useState(false)
  const redeploy = useMutation({
    mutationFn: () => patchXrayServerVersion(serverID, deployedVersion ?? '', useMirror),
    onSuccess: () => {
      toast('success', t('xray.deploy.redeploy_toast', 'Re-deploy triggered'))
      qc.invalidateQueries({ queryKey: ['plugin-hosts', 'xray'] })
    },
    onError: (e: any) => toast('error', String(e?.message ?? e)),
  })
  return (
    <span className="inline-flex items-center gap-1">
      <Button
        size="xs"
        variant="outline"
        className="text-2xs"
        disabled={!deployedVersion || redeploy.isPending}
        onClick={() => redeploy.mutate()}
      >
        {t('xray.deploy.redeploy', 'Re-deploy')}
      </Button>
      <label className="inline-flex items-center gap-1 text-fg-dim text-2xs cursor-pointer" title={t('xray.deploy.mirror_title', 'Route the binary download via gh-proxy.com (for CN hosts)')}>
        <input type="checkbox" className="h-3 w-3" checked={useMirror} onChange={(e) => setUseMirror(e.target.checked)} />
        {t('xray.deploy.mirror', 'mirror')}
      </label>
    </span>
  )
}

function DeployButton({ serverID, versions }: { serverID: number; versions: string[] }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const toast = useUI((s) => s.toast)
  const [version, setVersion] = useState<string>(versions[0] ?? '')
  const [useMirror, setUseMirror] = useState(false)
  useEffect(() => {
    if (!version && versions[0]) {
      setVersion(versions[0])
    }
  }, [versions, version])
  const deploy = useMutation({
    mutationFn: () => patchXrayServerVersion(serverID, version, useMirror),
    onSuccess: () => {
      toast('success', t('xray.deploy.deploying_toast', 'Deploying v{{version}}', { version }))
      qc.invalidateQueries({ queryKey: ['plugin-hosts', 'xray'] })
    },
    onError: (e: any) => toast('error', String(e?.message ?? e)),
  })
  return (
    <span className="inline-flex items-center gap-1">
      <Select value={version} onValueChange={setVersion} disabled={!versions.length || deploy.isPending}>
        <SelectTrigger className="h-6 w-24 text-2xs font-mono">
          <SelectValue placeholder={t('xray.deploy.version_placeholder', 'version')} />
        </SelectTrigger>
        <SelectContent>
          {versions.map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}
        </SelectContent>
      </Select>
      <Button
        size="xs"
        variant="outline"
        className="text-2xs"
        disabled={!version || deploy.isPending}
        onClick={() => deploy.mutate()}
      >
        {deploy.isPending ? t('xray.deploy.deploying', 'Deploying…') : t('xray.deploy.deploy', 'Deploy')}
      </Button>
      <label className="inline-flex items-center gap-1 text-fg-dim text-2xs cursor-pointer" title={t('xray.deploy.mirror_title', 'Route the binary download via gh-proxy.com (for CN hosts)')}>
        <input type="checkbox" className="h-3 w-3" checked={useMirror} onChange={(e) => setUseMirror(e.target.checked)} />
        {t('xray.deploy.mirror', 'mirror')}
      </label>
    </span>
  )
}

function LifecycleButtons({ serverID, status }: { serverID: number; status: XrayStatus }) {
  const { t } = useTranslation()
  const toast = useUI((s) => s.toast)
  const lc = useHostLifecycle('xray', serverID)
  const busy = lc.start.isPending || lc.stop.isPending || lc.restart.isPending || lc.refreshStatus.isPending

  const wrap = (fn: () => Promise<any>) => () => fn().catch((e: any) => toast('error', String(e?.message ?? e)))

  return (
    <span className="inline-flex items-center gap-1">
      {status !== 'running' && (
        <Button
          size="xs"
          variant="ghost"
          className="w-7 p-0"
          disabled={busy}
          title={t('xray.deploy.start_title', 'Start')}
          onClick={wrap(() => lc.start.mutateAsync())}
        >
          <Play className="h-3 w-3" />
        </Button>
      )}
      {status === 'running' && (
        <Button
          size="xs"
          variant="ghost"
          className="w-7 p-0"
          disabled={busy}
          title={t('xray.deploy.stop_title', 'Stop')}
          onClick={wrap(() => lc.stop.mutateAsync())}
        >
          <Square className="h-3 w-3" />
        </Button>
      )}
      <Button
        size="xs"
        variant="ghost"
        className="w-7 p-0"
        disabled={busy}
        title={t('xray.deploy.restart_title', 'Restart')}
        onClick={wrap(() => lc.restart.mutateAsync())}
      >
        <RotateCw className="h-3 w-3" />
      </Button>
      <Button
        size="xs"
        variant="ghost"
        className="w-7 p-0"
        disabled={busy}
        title={t('xray.deploy.refresh_title', 'Refresh status')}
        onClick={wrap(() => lc.refreshStatus.mutateAsync())}
      >
        <RefreshCw className="h-3 w-3" />
      </Button>
    </span>
  )
}

export default function DeployTab() {
  const { t } = useTranslation()
  const { data: servers = [] } = useServers()
  const hostsQ = useQuery({
    queryKey: ['plugin-hosts', 'xray'],
    queryFn: () => listPluginHosts('xray'),
    refetchInterval: (q) => {
      const rows = (q?.state?.data as Array<{ status?: string }> | undefined) ?? []
      const transient = rows.some((r) => r.status === 'deploying')
      return transient ? 2000 : 30_000
    },
  })
  const versionsQ = useQuery({ queryKey: ['xray-versions'], queryFn: fetchXrayVersions })

  const hosts = hostsQ.data ?? []
  const hostByServerID = new Map(hosts.map((h) => [h.server_id, h]))

  // Unique union of latest + cached versions for the version dropdown.
  // First-time Deploy defaults to allVersions[0] (the freshest), and
  // VersionInline lets admins pick a specific version when changing.
  const versionsData = versionsQ.data
  const allVersions: string[] = versionsData
    ? Array.from(new Set([
        ...(versionsData.latest ?? []),
        ...(versionsData.cached ?? []).map((c) => c.version),
      ]))
    : []

  const rows: Array<{ server: ServerRecord; host: PluginHost | undefined }> =
    servers.map((s) => ({ server: s, host: hostByServerID.get(s.id) }))

  return (
    <div className="space-y-4">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>{t('xray.deploy.server', 'Server')}</TableHead>
            <TableHead>{t('xray.deploy.status', 'Status')}</TableHead>
            <TableHead>{t('xray.deploy.version', 'Version')}</TableHead>
            <TableHead>{t('xray.deploy.last_error', 'Last Error')}</TableHead>
            <TableHead>{t('xray.deploy.last_update', 'Last Update')}</TableHead>
            <TableHead>{t('admin.actions', 'Actions')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(({ server, host }) => {
            const sshHost = server.ssh_host?.Valid ? server.ssh_host.String : null
            const { kind, label } = host
              ? statusPill(host.status)
              : { kind: 'neutral' as PillKind, label: '—' }
            const errTrunc = host?.last_error
              ? host.last_error.slice(0, 200)
              : null
            return (
              <TableRow key={server.id}>
                <TableCell>
                  <div className="font-medium">{server.name}</div>
                  {sshHost && (
                    <div className="text-2xs text-muted-foreground font-mono">{sshHost}</div>
                  )}
                </TableCell>
                <TableCell>
                  {host ? (
                    <Pill kind={kind}>{label}</Pill>
                  ) : (
                    <span className="text-muted-foreground text-xs">{t('xray.deploy.not_deployed', 'not deployed')}</span>
                  )}
                </TableCell>
                <TableCell>
                  {host ? (
                    <VersionInline serverID={server.id} current={host.deployed_version} versions={allVersions} />
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>
                  {errTrunc ? (
                    <TooltipProvider delayDuration={150}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            className="inline-flex h-7 w-7 items-center justify-center rounded text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/60"
                            aria-label={t('xray.deploy.show_last_error_aria', 'Show last error')}
                          >
                            ⚠
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-md break-words text-xs">
                          {errTrunc}
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="font-mono text-2xs text-muted-foreground">
                  {host?.updated_at ?? '—'}
                </TableCell>
                <TableCell>
                  <span className="inline-flex items-center gap-1">
                    {host ? (
                      <>
                        <LifecycleButtons serverID={server.id} status={host.status} />
                        <RedeployButton
                          serverID={server.id}
                          deployedVersion={host.deployed_version}
                        />
                      </>
                    ) : (
                      <DeployButton serverID={server.id} versions={allVersions} />
                    )}
                  </span>
                </TableCell>
              </TableRow>
            )
          })}
          {rows.length === 0 && (
            <TableEmpty colSpan={6}>{t('xray.empty.deploy', 'No servers found.')}</TableEmpty>
          )}
        </TableBody>
      </Table>
    </div>
  )
}
