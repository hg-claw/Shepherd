import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Play, Square, RotateCw, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Pill, type PillKind } from '@/components/Pill'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  listPluginHosts,
  fetchSingboxVersions,
  patchSingboxServerVersion,
  useHostLifecycle,
  type PluginHost,
} from '@/api/plugins'
import { useServers, type ServerRecord } from '@/api/servers'
import { useUI } from '@/store/ui'

type SingboxStatus = PluginHost['status']

function statusPill(status: SingboxStatus): { kind: PillKind; label: string } {
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
  const qc = useQueryClient()
  const toast = useUI((s) => s.toast)
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(current ?? '')
  const apply = useMutation({
    mutationFn: () => patchSingboxServerVersion(serverID, value),
    onSuccess: () => {
      toast('success', `Upgrading to v${value}`)
      qc.invalidateQueries({ queryKey: ['plugin-hosts', 'singbox'] })
      setEditing(false)
    },
    onError: (e: any) => toast('error', String(e?.message ?? e)),
  })
  if (!editing) {
    return (
      <span className="font-mono text-[12px] text-fg-dim">
        {current ?? '—'}{' '}
        <button className="underline" onClick={() => { setValue(current ?? ''); setEditing(true) }}>change</button>
      </span>
    )
  }
  // Build version list; prepend current if not already included
  const versionList = current && !versions.includes(current) ? [current, ...versions] : versions
  return (
    <span className="inline-flex items-center gap-1">
      <Select value={value} onValueChange={setValue}>
        <SelectTrigger className="h-6 w-28 font-mono text-[11px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {versionList.map((v) => (
            <SelectItem key={v} value={v} className="font-mono text-[11px]">{v}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button size="sm" className="h-6 px-2 text-[11px]" disabled={apply.isPending}
        onClick={() => apply.mutate()}>Apply</Button>
      <button className="text-fg-dim text-[11px]" onClick={() => setEditing(false)}>cancel</button>
    </span>
  )
}

function RedeployButton({ serverID, deployedVersion }: { serverID: number; deployedVersion: string | null }) {
  const qc = useQueryClient()
  const toast = useUI((s) => s.toast)
  const redeploy = useMutation({
    mutationFn: () => patchSingboxServerVersion(serverID, deployedVersion ?? ''),
    onSuccess: () => {
      toast('success', 'Re-deploy triggered')
      qc.invalidateQueries({ queryKey: ['plugin-hosts', 'singbox'] })
    },
    onError: (e: any) => toast('error', String(e?.message ?? e)),
  })
  return (
    <Button
      size="sm"
      variant="outline"
      className="h-6 px-2 text-[11px]"
      disabled={!deployedVersion || redeploy.isPending}
      onClick={() => redeploy.mutate()}
    >
      Re-deploy
    </Button>
  )
}

function DeployButton({ serverID, versions }: { serverID: number; versions: string[] }) {
  const qc = useQueryClient()
  const toast = useUI((s) => s.toast)
  // useState initializer fires once at mount. When the parent renders us
  // before fetchSingboxVersions resolved (the common case for a "not
  // deployed" row visible immediately on tab open), versions[0] is
  // undefined → version starts as "" → Deploy stays disabled even after
  // the versions list lands. Sync via effect so the first version
  // becomes the default once available; operator can still override
  // from the dropdown before clicking Deploy.
  const [version, setVersion] = useState<string>(versions[0] ?? '')
  useEffect(() => {
    if (!version && versions[0]) {
      setVersion(versions[0])
    }
  }, [versions, version])
  const deploy = useMutation({
    mutationFn: () => patchSingboxServerVersion(serverID, version),
    onSuccess: () => {
      toast('success', `Deploying v${version}`)
      qc.invalidateQueries({ queryKey: ['plugin-hosts', 'singbox'] })
    },
    onError: (e: any) => toast('error', String(e?.message ?? e)),
  })
  return (
    <span className="inline-flex items-center gap-1">
      <Select value={version} onValueChange={setVersion} disabled={!versions.length || deploy.isPending}>
        <SelectTrigger className="h-6 w-24 text-[11px] font-mono">
          <SelectValue placeholder="version" />
        </SelectTrigger>
        <SelectContent>
          {versions.map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}
        </SelectContent>
      </Select>
      <Button
        size="sm"
        variant="outline"
        className="h-6 px-2 text-[11px]"
        disabled={!version || deploy.isPending}
        onClick={() => deploy.mutate()}
      >
        {deploy.isPending ? 'Deploying…' : 'Deploy'}
      </Button>
    </span>
  )
}

function LifecycleButtons({ serverID, status }: { serverID: number; status: SingboxStatus }) {
  const toast = useUI((s) => s.toast)
  const lc = useHostLifecycle('singbox', serverID)
  const busy = lc.start.isPending || lc.stop.isPending || lc.restart.isPending || lc.refreshStatus.isPending

  const wrap = (fn: () => Promise<any>) => () => fn().catch((e: any) => toast('error', String(e?.message ?? e)))

  return (
    <span className="inline-flex items-center gap-1">
      {status !== 'running' && (
        <Button
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0"
          disabled={busy}
          title="Start"
          onClick={wrap(() => lc.start.mutateAsync())}
        >
          <Play className="h-3 w-3" />
        </Button>
      )}
      {status === 'running' && (
        <Button
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0"
          disabled={busy}
          title="Stop"
          onClick={wrap(() => lc.stop.mutateAsync())}
        >
          <Square className="h-3 w-3" />
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        className="h-6 w-6 p-0"
        disabled={busy}
        title="Restart"
        onClick={wrap(() => lc.restart.mutateAsync())}
      >
        <RotateCw className="h-3 w-3" />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-6 w-6 p-0"
        disabled={busy}
        title="Refresh status"
        onClick={wrap(() => lc.refreshStatus.mutateAsync())}
      >
        <RefreshCw className="h-3 w-3" />
      </Button>
    </span>
  )
}

export default function DeployTab() {
  const { data: servers = [] } = useServers()
  const hostsQ = useQuery({
    queryKey: ['plugin-hosts', 'singbox'],
    queryFn: () => listPluginHosts('singbox'),
    refetchInterval: (q) => {
      const rows = (q?.state?.data as Array<{ status?: string }> | undefined) ?? []
      const transient = rows.some((r) => r.status === 'deploying')
      return transient ? 2000 : 30_000
    },
  })
  const versionsQ = useQuery({ queryKey: ['singbox-versions'], queryFn: fetchSingboxVersions })

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
    <div className="space-y-2">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b text-[11px] text-muted-foreground uppercase tracking-wide">
            <th className="text-left py-2 pr-4 font-medium">Server</th>
            <th className="text-left py-2 pr-4 font-medium">Status</th>
            <th className="text-left py-2 pr-4 font-medium">Version</th>
            <th className="text-left py-2 pr-4 font-medium">Last Error</th>
            <th className="text-left py-2 pr-4 font-medium">Last Update</th>
            <th className="text-left py-2 font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ server, host }) => {
            const sshHost = server.ssh_host?.Valid ? server.ssh_host.String : null
            const { kind, label } = host
              ? statusPill(host.status)
              : { kind: 'neutral' as PillKind, label: '—' }
            const errTrunc = host?.last_error
              ? host.last_error.slice(0, 200)
              : null
            return (
              <tr key={server.id} className="border-b last:border-0">
                <td className="py-2 pr-4">
                  <div className="font-medium">{server.name}</div>
                  {sshHost && (
                    <div className="text-[11px] text-muted-foreground font-mono">{sshHost}</div>
                  )}
                </td>
                <td className="py-2 pr-4">
                  {host ? (
                    <Pill kind={kind}>{label}</Pill>
                  ) : (
                    <span className="text-muted-foreground text-[12px]">not deployed</span>
                  )}
                </td>
                <td className="py-2 pr-4">
                  {host ? (
                    <VersionInline serverID={server.id} current={host.deployed_version} versions={allVersions} />
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="py-2 pr-4">
                  {errTrunc ? (
                    <TooltipProvider delayDuration={150}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            className="inline-flex h-6 w-6 items-center justify-center rounded text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/60"
                            aria-label="Show last error"
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
                </td>
                <td className="py-2 pr-4 font-mono text-[11px] text-muted-foreground">
                  {host?.updated_at ?? '—'}
                </td>
                <td className="py-2">
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
                </td>
              </tr>
            )
          })}
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} className="py-6 text-center text-muted-foreground text-[13px]">
                No servers found.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
