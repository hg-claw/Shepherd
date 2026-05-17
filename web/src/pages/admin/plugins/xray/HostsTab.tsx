// web/src/pages/admin/plugins/xray/HostsTab.tsx
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServers } from '@/api/servers'
import { listPluginHosts, removePluginHost, getPluginConfig, type PluginHost } from '@/api/plugins'
import { Button } from '@/components/ui/button'
import { Pill, type PillKind } from '@/components/Pill'
import { useUI } from '@/store/ui'
import DeployDialog from './DeployDialog'

function statusKind(s: string | undefined): PillKind {
  if (s === 'running') return 'ok'
  if (s === 'deploying' || s === 'pending') return 'warn'
  if (s === 'failed') return 'err'
  return 'neutral'
}

export default function HostsTab() {
  const toast = useUI((s) => s.toast)
  const serversQ = useServers({ refetchInterval: 30_000 })
  const hostsQ = useQuery({
    queryKey: ['plugin-hosts', 'xray'],
    queryFn: () => listPluginHosts('xray'),
    refetchInterval: 5_000,
  })
  const cfgQ = useQuery({
    queryKey: ['plugin-cfg', 'xray'],
    queryFn: () => getPluginConfig('xray'),
  })
  const qc = useQueryClient()
  const undeploy = useMutation({
    mutationFn: (serverID: number) => removePluginHost('xray', serverID),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plugin-hosts', 'xray'] }),
    onError: (e: any) => toast('error', String(e?.message ?? e)),
  })

  const [deployTarget, setDeployTarget] = useState<{ id: number; name: string } | null>(null)

  // Build hostsByServer map for O(1) lookup.
  const hostsByServer = new Map<number, PluginHost>()
  for (const h of hostsQ.data ?? []) hostsByServer.set(h.server_id, h)

  const defaultVersion = String((cfgQ.data?.default_version as string | undefined) ?? '1.8.11')

  return (
    <div className="space-y-3">
      <div className="rounded-lg border bg-elev overflow-x-auto">
        <table className="w-full text-[13px] border-collapse">
          <thead>
            <tr className="text-left">
              <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Server</th>
              <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Status</th>
              <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Version</th>
              <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Last error</th>
              <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(serversQ.data ?? []).map((s) => {
              const h = hostsByServer.get(s.id)
              const deployed = !!h
              return (
                <tr key={s.id} className="border-t">
                  <td className="px-3 py-2 font-mono">
                    <div>{s.name}</div>
                    <div className="text-fg-dim text-[11px]">
                      {s.ssh_host?.Valid ? s.ssh_host.String : '—'}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    {deployed
                      ? <Pill kind={statusKind(h?.status)}>{h?.status}</Pill>
                      : <Pill kind="neutral">not deployed</Pill>}
                  </td>
                  <td className="px-3 py-2 font-mono text-[12.5px]">{h?.deployed_version ?? '—'}</td>
                  <td className="px-3 py-2 text-[12px] text-err">{h?.last_error ?? ''}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    {deployed ? (
                      <>
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-[12px]"
                          onClick={() => setDeployTarget({ id: s.id, name: s.name })}>
                          Re-deploy
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-[12px] text-destructive"
                          onClick={() => undeploy.mutate(s.id)}
                          disabled={undeploy.isPending}>
                          Undeploy
                        </Button>
                      </>
                    ) : (
                      <Button size="sm" className="h-7 px-2 text-[12px]"
                        onClick={() => setDeployTarget({ id: s.id, name: s.name })}>
                        Deploy
                      </Button>
                    )}
                  </td>
                </tr>
              )
            })}
            {(serversQ.data ?? []).length === 0 && (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-muted-foreground text-[13px]">
                No managed servers.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      {deployTarget && (
        <DeployDialog
          open={true}
          onOpenChange={(open) => { if (!open) setDeployTarget(null) }}
          serverID={deployTarget.id}
          serverName={deployTarget.name}
          defaultVersion={defaultVersion}
        />
      )}
    </div>
  )
}
