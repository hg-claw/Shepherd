import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Pill, type PillKind } from '@/components/Pill'
import {
  listPluginHosts,
  fetchSingboxVersions,
  patchSingboxServerVersion,
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

export default function DeployTab() {
  const { data: servers = [] } = useServers()
  const hostsQ = useQuery({
    queryKey: ['plugin-hosts', 'singbox'],
    queryFn: () => listPluginHosts('singbox'),
  })
  useQuery({ queryKey: ['singbox-versions'], queryFn: fetchSingboxVersions })

  const hosts = hostsQ.data ?? []
  const hostByServerID = new Map(hosts.map((h) => [h.server_id, h]))

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
                    <span
                      className="text-err text-[11px] cursor-help"
                      title={errTrunc}
                    >
                      see error
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="py-2 pr-4 font-mono text-[11px] text-muted-foreground">
                  {host?.updated_at ?? '—'}
                </td>
                <td className="py-2">
                  {host && (
                    <RedeployButton
                      serverID={server.id}
                      deployedVersion={host.deployed_version}
                    />
                  )}
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
