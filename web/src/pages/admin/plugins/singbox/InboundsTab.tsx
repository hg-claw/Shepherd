import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Pill } from '@/components/Pill'
import { useUI } from '@/store/ui'
import { copyText } from '@/lib/clipboard'
import {
  listSingboxInbounds, deleteSingboxInbound,
  fetchSingboxTrafficBatch, patchSingboxServerVersion, listPluginHosts,
  type SingboxInbound, type PluginHost,
} from '@/api/plugins'
import InboundDialog from './InboundDialog'
import BulkRelayDialog from './BulkRelayDialog'
import { useServers } from '@/api/servers'

// All 18 protocols that have share-URL builders implemented.
const SINGBOX_URL_PROTOCOLS = new Set([
  'vless-reality',
  'vless-ws-tls',
  'vless-h2-tls',
  'vless-httpupgrade-tls',
  'vmess-tcp',
  'vmess-http',
  'vmess-quic',
  'vmess-ws-tls',
  'vmess-h2-tls',
  'vmess-httpupgrade-tls',
  'trojan-tls',
  'trojan-ws-tls',
  'trojan-h2-tls',
  'trojan-httpupgrade-tls',
  'hysteria2',
  'tuic-v5',
  'anytls',
  'shadowsocks-2022',
])

function buildSingboxShareURL(inbound: SingboxInbound, hostname: string): string | null {
  if (!hostname || !inbound.port) return null
  const label = encodeURIComponent(`${inbound.server_name}/${inbound.tag}`)
  const p = inbound.protocol

  // ── VLESS family ────────────────────────────────────────────────────────────
  if (p === 'vless-reality') {
    if (!inbound.uuid || !inbound.reality_public_key) return null
    const q = new URLSearchParams({
      encryption: 'none',
      security: 'reality',
      sni: inbound.sni ?? '',
      fp: 'chrome',
      pbk: inbound.reality_public_key,
      sid: inbound.reality_short_id ?? '',
      type: 'tcp',
      flow: 'xtls-rprx-vision',
    })
    return `vless://${inbound.uuid}@${hostname}:${inbound.port}?${q.toString()}#${label}`
  }

  if (p === 'vless-ws-tls' || p === 'vless-h2-tls' || p === 'vless-httpupgrade-tls') {
    if (!inbound.uuid) return null
    const netMap: Record<string, string> = {
      'vless-ws-tls': 'ws',
      'vless-h2-tls': 'http',
      'vless-httpupgrade-tls': 'httpupgrade',
    }
    const q = new URLSearchParams({
      encryption: 'none',
      security: 'tls',
      sni: inbound.sni ?? inbound.transport_host ?? '',
      fp: 'chrome',
      type: netMap[p],
      path: inbound.transport_path || '/',
      host: inbound.transport_host ?? '',
    })
    return `vless://${inbound.uuid}@${hostname}:${inbound.port}?${q.toString()}#${label}`
  }

  // ── VMess family ─────────────────────────────────────────────────────────────
  if (p === 'vmess-tcp' || p === 'vmess-http' || p === 'vmess-quic' ||
      p === 'vmess-ws-tls' || p === 'vmess-h2-tls' || p === 'vmess-httpupgrade-tls') {
    if (!inbound.uuid) return null
    const netMap: Record<string, string> = {
      'vmess-tcp': 'tcp',
      'vmess-http': 'tcp',
      'vmess-quic': 'quic',
      'vmess-ws-tls': 'ws',
      'vmess-h2-tls': 'h2',
      'vmess-httpupgrade-tls': 'httpupgrade',
    }
    const tlsProtos = new Set(['vmess-ws-tls', 'vmess-h2-tls', 'vmess-httpupgrade-tls'])
    const obj = {
      v: '2',
      ps: `${inbound.server_name}/${inbound.tag}`,
      add: hostname,
      port: String(inbound.port),
      id: inbound.uuid,
      aid: String(inbound.alter_id ?? 0),
      scy: 'auto',
      net: netMap[p],
      type: p === 'vmess-http' ? 'http' : 'none',
      host: inbound.transport_host ?? '',
      path: inbound.transport_path || '/',
      tls: tlsProtos.has(p) ? 'tls' : '',
      sni: inbound.sni ?? inbound.transport_host ?? '',
    }
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(obj))))
    return `vmess://${b64}`
  }

  // ── Trojan family ────────────────────────────────────────────────────────────
  if (p === 'trojan-tls' || p === 'trojan-ws-tls' || p === 'trojan-h2-tls' || p === 'trojan-httpupgrade-tls') {
    if (!inbound.password) return null
    const netMap: Record<string, string> = {
      'trojan-tls': 'tcp',
      'trojan-ws-tls': 'ws',
      'trojan-h2-tls': 'http',
      'trojan-httpupgrade-tls': 'httpupgrade',
    }
    const q = new URLSearchParams({
      security: 'tls',
      sni: inbound.sni ?? '',
      type: netMap[p],
    })
    if (p !== 'trojan-tls') {
      q.set('path', inbound.transport_path || '/')
      q.set('host', inbound.transport_host ?? '')
    }
    const password = encodeURIComponent(inbound.password)
    return `trojan://${password}@${hostname}:${inbound.port}?${q.toString()}#${label}`
  }

  // ── Single protocols ─────────────────────────────────────────────────────────
  if (p === 'hysteria2') {
    if (!inbound.password || !inbound.sni) return null
    const q = new URLSearchParams({ sni: inbound.sni, insecure: '0' })
    const password = encodeURIComponent(inbound.password)
    return `hysteria2://${password}@${hostname}:${inbound.port}?${q.toString()}#${label}`
  }

  if (p === 'tuic-v5') {
    if (!inbound.uuid || !inbound.password || !inbound.sni) return null
    const q = new URLSearchParams({
      congestion_control: 'bbr',
      udp_relay_mode: 'native',
      sni: inbound.sni,
    })
    const password = encodeURIComponent(inbound.password)
    return `tuic://${inbound.uuid}:${password}@${hostname}:${inbound.port}?${q.toString()}#${label}`
  }

  if (p === 'anytls') {
    if (!inbound.password) return null
    const q = new URLSearchParams({ insecure: '0' })
    if (inbound.sni) q.set('sni', inbound.sni)
    const password = encodeURIComponent(inbound.password)
    return `anytls://${password}@${hostname}:${inbound.port}?${q.toString()}#${label}`
  }

  if (p === 'shadowsocks-2022') {
    if (!inbound.ss_method || !inbound.ss_password) return null
    const userinfo = btoa(`${inbound.ss_method}:${inbound.ss_password}`).replace(/=/g, '')
    return `ss://${userinfo}@${hostname}:${inbound.port}#${label}`
  }

  return null
}

export default function InboundsTab() {
  const qc = useQueryClient()
  const toast = useUI((s) => s.toast)
  const serversQ = useServers({ refetchInterval: 30_000 })
  const inboundsQ = useQuery({
    queryKey: ['singbox', 'inbounds'],
    queryFn: () => listSingboxInbounds(),
    refetchInterval: 5_000,
  })
  const hostsQ = useQuery({
    queryKey: ['plugin-hosts', 'singbox'],
    queryFn: () => listPluginHosts('singbox'),
    refetchInterval: 5_000,
  })

  // Group inbounds by server_id
  const groups = useMemo(() => {
    const m = new Map<number, SingboxInbound[]>()
    for (const i of inboundsQ.data ?? []) {
      const arr = m.get(i.server_id) ?? []
      arr.push(i)
      m.set(i.server_id, arr)
    }
    return m
  }, [inboundsQ.data])

  // Count relay dependents per landing-inbound id
  const dependentsByLandingID = useMemo(() => {
    const m = new Map<number, number>()
    for (const i of inboundsQ.data ?? []) {
      if (i.role === 'relay' && i.upstream_inbound_id != null) {
        m.set(i.upstream_inbound_id, (m.get(i.upstream_inbound_id) ?? 0) + 1)
      }
    }
    return m
  }, [inboundsQ.data])

  // PluginHost lookup for singbox version + process status
  const hostByServer = useMemo(() => {
    const m = new Map<number, PluginHost>()
    for (const h of hostsQ.data ?? []) m.set(h.server_id, h)
    return m
  }, [hostsQ.data])

  const del = useMutation({
    mutationFn: (id: number) => deleteSingboxInbound(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['singbox', 'inbounds'] })
      qc.invalidateQueries({ queryKey: ['plugin-hosts', 'singbox'] })
    },
    onError: (e: any) => toast('error', String(e?.message ?? e)),
  })

  // Active/idle detection: binary signal from last 2-min traffic batch.
  // Group tags by server_id to issue one batch call per server.
  const allTags = useMemo(() => (inboundsQ.data ?? []).map((i) => i.tag), [inboundsQ.data])

  const tagsByServer = useMemo(() => {
    const m = new Map<number, string[]>()
    for (const i of inboundsQ.data ?? []) {
      const arr = m.get(i.server_id) ?? []
      arr.push(i.tag)
      m.set(i.server_id, arr)
    }
    return m
  }, [inboundsQ.data])

  const activeByTag = useQuery({
    queryKey: ['singbox', 'traffic', 'active', allTags.join(',')],
    queryFn: async () => {
      const now = new Date()
      const from = new Date(now.getTime() - 2 * 60 * 1000).toISOString()
      const to = now.toISOString()
      const results = await Promise.all(
        Array.from(tagsByServer.entries()).map(([serverID, tags]) =>
          // sing-box agent emits kind="landing"|"relay" (not "inbound"); omit the
          // kind filter so the WHERE clause doesn't exclude every row.
          fetchSingboxTrafficBatch({ server_id: serverID, tags, from, to, resolution: 'raw' })
        )
      )
      const active = new Map<string, boolean>()
      for (const res of results) {
        for (const series of res.series ?? []) {
          const hasTraffic = series.points.some((p) => p.bytes_up + p.bytes_down > 0)
          active.set(series.tag, hasTraffic)
        }
      }
      return active
    },
    enabled: allTags.length > 0,
    refetchInterval: 30_000,
  })

  const activeMap: Map<string, boolean> = activeByTag.data ?? new Map()

  const [dialog, setDialog] = useState<
    { kind: 'new'; serverID?: number } |
    { kind: 'edit'; inbound: SingboxInbound } |
    null
  >(null)

  const [bulkRelayTarget, setBulkRelayTarget] = useState<SingboxInbound | null>(null)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-[12.5px] text-muted-foreground">
          Each row is one sing-box inbound. A single server can host multiple inbounds.
        </p>
        <Button size="sm" className="h-8" onClick={() => setDialog({ kind: 'new' })}>
          + New inbound
        </Button>
      </div>

      {inboundsQ.isLoading && (
        <p className="text-[12.5px] text-muted-foreground px-1">Loading…</p>
      )}

      {!inboundsQ.isLoading && (serversQ.data ?? []).map((s) => {
        const inbounds = groups.get(s.id) ?? []
        const host = hostByServer.get(s.id)
        const hostname = s.ssh_host?.Valid ? s.ssh_host.String : ''
        return (
          <div key={s.id} className="rounded-lg border bg-elev overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 border-b bg-background/40">
              <div className="text-[13px] font-mono">
                <span className="font-medium">{s.name}</span>
                <span className="text-fg-dim ml-2">
                  {hostname || '—'}
                </span>
                {host && (
                  <span className="text-fg-dim ml-3">
                    <VersionInline serverID={s.id} current={host?.deployed_version ?? null} />
                  </span>
                )}
                {host && (
                  <span className="ml-3">
                    <Pill kind={host.status === 'running' ? 'ok' : 'neutral'}>{host.status}</Pill>
                  </span>
                )}
              </div>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-[12px]"
                onClick={() => setDialog({ kind: 'new', serverID: s.id })}>
                + Add inbound
              </Button>
            </div>
            <table className="w-full text-[13px] border-collapse">
              <thead>
                <tr className="text-left">
                  <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Tag</th>
                  <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Role</th>
                  <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Protocol</th>
                  <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Port</th>
                  <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {inbounds.length === 0 && (
                  <tr><td colSpan={5} className="px-3 py-4 text-center text-muted-foreground text-[12.5px]">
                    No inbounds on this server.
                  </td></tr>
                )}
                {inbounds.map((i) => {
                  const dep = dependentsByLandingID.get(i.id) ?? 0
                  const isLanding = i.role === 'landing'
                  const shareURL = isLanding
                    ? buildSingboxShareURL(i, hostname)
                    : null
                  const urlSupported = SINGBOX_URL_PROTOCOLS.has(i.protocol)
                  const canCopyURL = urlSupported && !!shareURL
                  const copyTitle = canCopyURL
                    ? 'Copy share URL'
                    : urlSupported
                    ? 'cannot build URL — missing fields'
                    : 'client URL not yet supported for this protocol'
                  // TLS protocols that need a cert but have none: show warning
                  const needsTLS = (
                    i.protocol.endsWith('-tls') ||
                    i.protocol === 'hysteria2' ||
                    i.protocol === 'tuic-v5' ||
                    i.protocol === 'anytls'
                  )
                  const missingCert = needsTLS && i.cert_id == null
                  const isActive = activeMap.get(i.tag) === true

                  return (
                    <tr key={i.id} className="border-t">
                      <td className="px-3 py-2 font-mono">
                        <span
                          className={`inline-block w-1.5 h-1.5 rounded-full mr-2 align-middle ${
                            isActive ? 'bg-emerald-500' : 'bg-fg-dim/40'
                          }`}
                          title={isActive ? 'active (traffic in last 2 min)' : 'idle (no recent traffic)'}
                        />
                        {i.tag}
                        {missingCert && (
                          <span
                            className="ml-1.5 text-yellow-500 text-[11px]"
                            title="TLS protocol but no certificate assigned — assign a cert in the Certificates tab"
                          >⚠</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {isLanding
                          ? <Pill kind="neutral">landing</Pill>
                          : (
                            <span className="font-mono">
                              <Pill kind="ok">relay</Pill>
                              <span className="text-fg-dim ml-1">→ {i.upstream_tag} @ {i.upstream_server_name}</span>
                            </span>
                          )}
                      </td>
                      <td className="px-3 py-2 font-mono text-[12.5px]">{i.protocol}</td>
                      <td className="px-3 py-2 font-mono text-[12.5px]">{i.port}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        {isLanding && (
                          <Button size="sm" variant="ghost" className="h-7 px-2 text-[12px]"
                            onClick={() => setBulkRelayTarget(i)}>
                            + Bulk Relay
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-[12px]"
                          disabled={!canCopyURL}
                          title={copyTitle}
                          onClick={async () => {
                            if (!shareURL) return
                            try { await copyText(shareURL); toast('success', 'Share URL copied') }
                            catch (e) { toast('error', String((e as Error)?.message ?? e)) }
                          }}>
                          Copy URL
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-[12px]"
                          onClick={() => setDialog({ kind: 'edit', inbound: i })}>
                          Edit
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-[12px] text-destructive"
                          disabled={del.isPending || dep > 0}
                          title={dep > 0 ? `${dep} relay(s) depend on this landing; delete them first` : undefined}
                          onClick={() => del.mutate(i.id)}>
                          Delete
                        </Button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )
      })}

      {dialog?.kind === 'new' && (
        <InboundDialog
          serverID={dialog.serverID ?? (serversQ.data?.[0]?.id ?? 0)}
          open
          onClose={() => setDialog(null)}
          onSaved={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'edit' && (
        <InboundDialog
          serverID={dialog.inbound.server_id}
          initial={dialog.inbound}
          open
          onClose={() => setDialog(null)}
          onSaved={() => setDialog(null)}
        />
      )}
      {bulkRelayTarget && (
        <BulkRelayDialog
          open
          onOpenChange={(v) => { if (!v) setBulkRelayTarget(null) }}
          landingInbound={bulkRelayTarget}
          allInbounds={inboundsQ.data ?? []}
        />
      )}
    </div>
  )
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
      <span className="text-fg-dim">
        sing-box v{current ?? '—'}{' '}
        <button className="text-fg-dim underline" onClick={() => setEditing(true)}>change</button>
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
