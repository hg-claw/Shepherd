// web/src/pages/admin/plugins/xray/HostsTab.tsx
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServers } from '@/api/servers'
import { listPluginHosts, removePluginHost, fetchXrayTopology, type PluginHost, type XrayTopologyRow } from '@/api/plugins'
import { Button } from '@/components/ui/button'
import { Pill, type PillKind } from '@/components/Pill'
import { useUI } from '@/store/ui'
import { copyText } from '@/lib/clipboard'
import { parseConfig, buildShareURL } from './templates'
import DeployDialog from './DeployDialog'
import BulkRelayDialog from './BulkRelayDialog'

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
  const topoQ = useQuery({
    queryKey: ['xray-topology'],
    queryFn: fetchXrayTopology,
    refetchInterval: 10_000,
  })
  const topo: Map<number, XrayTopologyRow> = topoQ.data ?? new Map()

  // Count how many relays depend on each landing for the undeploy guard.
  const relayCountByUpstream = new Map<number, number>()
  for (const v of topo.values()) {
    if (v.role === 'relay' && v.upstream_server_id != null) {
      relayCountByUpstream.set(v.upstream_server_id, (relayCountByUpstream.get(v.upstream_server_id) ?? 0) + 1)
    }
  }

  const qc = useQueryClient()
  const undeploy = useMutation({
    mutationFn: (serverID: number) => removePluginHost('xray', serverID),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plugin-hosts', 'xray'] }),
    onError: (e: any) => toast('error', String(e?.message ?? e)),
  })

  // { id?: number; existing?: PluginHost } = deploy to specific server; {} = open dialog with no pre-selected server
  const [deployTarget, setDeployTarget] = useState<{ id?: number; existing?: PluginHost } | null>(null)

  const [bulkRelayFor, setBulkRelayFor] = useState<{ host: PluginHost; serverName: string; serverHost: string } | null>(null)

  // Set of server IDs that already have xray deployed (passed to BulkRelayDialog
  // so its target picker excludes them and the landing itself).
  const xrayServerIDs = new Set<number>((hostsQ.data ?? []).map((h) => h.server_id))

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
              <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Role</th>
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
              const hostname = s.ssh_host?.Valid ? s.ssh_host.String : ''
              const shareURL = h ? buildShareURL(parseConfig(h.config), hostname, s.name) : null
              return (
                <tr key={s.id} className="border-t">
                  <td className="px-3 py-2 font-mono">
                    <div>{s.name}</div>
                    <div className="text-fg-dim text-[11px]">
                      {s.ssh_host?.Valid ? s.ssh_host.String : '—'}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-[12.5px]">
                    {(() => {
                      const t = topo.get(s.id)
                      if (!t) return <span className="text-muted-foreground">—</span>
                      if (t.role === 'landing') return <Pill kind="neutral">landing</Pill>
                      return (
                        <span className="font-mono">
                          <Pill kind="ok">relay</Pill>
                          <span className="text-fg-dim ml-1">→ {t.upstream_name ?? `#${t.upstream_server_id}`}</span>
                        </span>
                      )
                    })()}
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
                        <Button
                          size="sm" variant="ghost" className="h-7 px-2 text-[12px]"
                          disabled={!shareURL}
                          title={shareURL ? 'Copy vless:// or vmess:// URL' : 'config or host address incomplete'}
                          onClick={async () => {
                            if (!shareURL) return
                            try {
                              await copyText(shareURL)
                              toast('success', 'Share URL copied')
                            } catch (e) {
                              toast('error', String((e as Error)?.message ?? e))
                            }
                          }}
                        >
                          Copy URL
                        </Button>
                        {(topo.get(s.id)?.role === 'landing') && (
                          <Button size="sm" variant="ghost" className="h-7 px-2 text-[12px]"
                            onClick={() => {
                              if (!h) return
                              const sHost = s.ssh_host?.Valid ? s.ssh_host.String : ''
                              if (!sHost) {
                                toast('error', `${s.name} has no ssh_host yet; cannot bulk-deploy relays to it`)
                                return
                              }
                              setBulkRelayFor({ host: h, serverName: s.name, serverHost: sHost })
                            }}>
                            + Relays
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-[12px]"
                          onClick={() => setDeployTarget({ id: s.id, existing: h })}>
                          Re-deploy
                        </Button>
                        {(() => {
                          const dependents = relayCountByUpstream.get(s.id) ?? 0
                          const disabled = undeploy.isPending || dependents > 0
                          const title = dependents > 0
                            ? `${dependents} relay(s) depend on this landing; undeploy them first`
                            : undefined
                          return (
                            <Button size="sm" variant="ghost" className="h-7 px-2 text-[12px] text-destructive"
                              onClick={() => undeploy.mutate(s.id)}
                              disabled={disabled}
                              title={title}>
                              Undeploy
                            </Button>
                          )
                        })()}
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
              <tr><td colSpan={7} className="px-3 py-6 text-center text-muted-foreground text-[13px]">
                No managed servers.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {deployTarget !== null && (
        // Key on identity so switching targets (e.g. Re-deploy row A → Deploy
        // row B without closing) forces a remount; DeployDialog lazy-inits
        // its form state from props on mount.
        <DeployDialog
          key={`${deployTarget.id ?? 'new'}:${deployTarget.existing ? 're' : 'fresh'}`}
          open={true}
          onOpenChange={(open) => { if (!open) setDeployTarget(null) }}
          defaultServerID={deployTarget.id}
          existing={deployTarget.existing}
        />
      )}

      {bulkRelayFor && (
        <BulkRelayDialog
          open={true}
          onOpenChange={(open) => { if (!open) setBulkRelayFor(null) }}
          landing={bulkRelayFor.host}
          landingServerHost={bulkRelayFor.serverHost}
          landingServerName={bulkRelayFor.serverName}
          existingXrayServerIDs={xrayServerIDs}
        />
      )}
    </div>
  )
}
