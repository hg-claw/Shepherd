import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Play, Square, RotateCw, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Pill, type PillKind } from '@/components/Pill'
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

function VersionInline({ serverID, current }: { serverID: number; current: string | null }) {
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
  return (
    <span className="inline-flex items-center gap-1">
      <Input value={value} onChange={(e) => setValue(e.target.value)}
        className="h-6 w-20 font-mono text-[11px]" />
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

function DeployButton({ serverID, latestVersion }: { serverID: number; latestVersion: string | null }) {
  const qc = useQueryClient()
  const toast = useUI((s) => s.toast)
  const deploy = useMutation({
    mutationFn: () => patchSingboxServerVersion(serverID, latestVersion ?? ''),
    onSuccess: () => {
      toast('success', `Deploying v${latestVersion}`)
      qc.invalidateQueries({ queryKey: ['plugin-hosts', 'singbox'] })
    },
    onError: (e: any) => toast('error', String(e?.message ?? e)),
  })
  return (
    <Button
      size="sm"
      variant="outline"
      className="h-6 px-2 text-[11px]"
      disabled={!latestVersion || deploy.isPending}
      onClick={() => deploy.mutate()}
    >
      {deploy.isPending ? 'Deploying…' : 'Deploy'}
    </Button>
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

  // Resolve latest version: prefer versions API latest[0], fallback to cached[0].version
  const versionsData = versionsQ.data
  const latestVersion: string | null = versionsData
    ? (versionsData.latest[0] ?? versionsData.cached[0]?.version ?? null)
    : null

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
                    <VersionInline serverID={server.id} current={host.deployed_version} />
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
                      <DeployButton serverID={server.id} latestVersion={latestVersion} />
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
