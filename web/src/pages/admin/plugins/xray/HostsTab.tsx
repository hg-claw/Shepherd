// web/src/pages/admin/plugins/xray/HostsTab.tsx
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServers } from '@/api/servers'
import { listPluginHosts, removePluginHost, type PluginHost } from '@/api/plugins'
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

function configSummary(cfg: unknown): { protocol: string; port: string } {
  if (!cfg || typeof cfg !== 'object') return { protocol: '—', port: '—' }
  const inbounds = (cfg as any).inbounds
  if (!Array.isArray(inbounds) || inbounds.length === 0) return { protocol: '—', port: '—' }
  const first = inbounds[0]
  const proto = String(first?.protocol ?? '—')
  const port = first?.port != null ? String(first.port) : '—'
  // Detect REALITY for clearer label
  const security = first?.streamSettings?.security
  const label = security === 'reality' ? `${proto} + REALITY` : proto
  return { protocol: label, port }
}

export default function HostsTab() {
  const toast = useUI((s) => s.toast)
  const serversQ = useServers({ refetchInterval: 30_000 })
  const hostsQ = useQuery({
    queryKey: ['plugin-hosts', 'xray'],
    queryFn: () => listPluginHosts('xray'),
    refetchInterval: 5_000,
  })
  const qc = useQueryClient()
  const undeploy = useMutation({
    mutationFn: (serverID: number) => removePluginHost('xray', serverID),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plugin-hosts', 'xray'] }),
    onError: (e: any) => toast('error', String(e?.message ?? e)),
  })

  // { id?: number; existing?: PluginHost } = deploy to specific server; {} = open dialog with no pre-selected server
  const [deployTarget, setDeployTarget] = useState<{ id?: number; existing?: PluginHost } | null>(null)

  // Build hostsByServer map for O(1) lookup.
  const hostsByServer = new Map<number, PluginHost>()
  for (const h of hostsQ.data ?? []) hostsByServer.set(h.server_id, h)

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[12.5px] text-muted-foreground">
          Each row is one xray deployment. Use "New configuration" to deploy to a new host.
        </p>
        <Button size="sm" className="h-8" onClick={() => setDeployTarget({})}>
          + New configuration
        </Button>
      </div>

      <div className="rounded-lg border bg-elev overflow-x-auto">
        <table className="w-full text-[13px] border-collapse">
          <thead>
            <tr className="text-left">
              <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Server</th>
              <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Protocol</th>
              <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Port</th>
              <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Status</th>
              <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Version</th>
              <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(serversQ.data ?? []).map((s) => {
              const h = hostsByServer.get(s.id)
              const deployed = !!h
              const summary = h ? configSummary(h.config) : { protocol: '—', port: '—' }
              return (
                <tr key={s.id} className="border-t">
                  <td className="px-3 py-2 font-mono">
                    <div>{s.name}</div>
                    <div className="text-fg-dim text-[11px]">
                      {s.ssh_host?.Valid ? s.ssh_host.String : '—'}
                    </div>
                  </td>
                  <td className="px-3 py-2 font-mono text-[12.5px]">{summary.protocol}</td>
                  <td className="px-3 py-2 font-mono text-[12.5px]">{summary.port}</td>
                  <td className="px-3 py-2">
                    {deployed
                      ? <Pill kind={statusKind(h?.status)}>{h?.status}</Pill>
                      : <Pill kind="neutral">not deployed</Pill>}
                    {h?.last_error && (
                      <div className="text-err text-[10.5px] mt-1 max-w-[200px] truncate" title={h.last_error}>
                        {h.last_error}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-[12.5px]">{h?.deployed_version ?? '—'}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    {deployed ? (
                      <>
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-[12px]"
                          onClick={() => setDeployTarget({ id: s.id, existing: h })}>
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
                        onClick={() => setDeployTarget({ id: s.id })}>
                        Deploy
                      </Button>
                    )}
                  </td>
                </tr>
              )
            })}
            {(serversQ.data ?? []).length === 0 && (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-muted-foreground text-[13px]">
                No managed servers.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {deployTarget !== null && (
        <DeployDialog
          open={true}
          onOpenChange={(open) => { if (!open) setDeployTarget(null) }}
          defaultServerID={deployTarget.id}
          existing={deployTarget.existing}
        />
      )}
    </div>
  )
}
