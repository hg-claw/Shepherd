import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Sparkline } from '@/components/Sparkline'
import {
  listXrayInbounds, fetchXrayTrafficBatch,
  type XrayInbound,
} from '@/api/plugins'
import { useServers } from '@/api/servers'
import TrafficDrawer from './TrafficDrawer'

// Time-range options driving the page-level fetcher. Resolution is auto:
// raw under 2h, minute under 7d, hour for longer windows.
const RANGES = [
  { key: '1h',  label: '1h',  ms: 60 * 60 * 1000,                 resolution: 'raw'    as const },
  { key: '24h', label: '24h', ms: 24 * 60 * 60 * 1000,            resolution: 'minute' as const },
  { key: '7d',  label: '7d',  ms: 7 * 24 * 60 * 60 * 1000,        resolution: 'minute' as const },
  { key: '30d', label: '30d', ms: 30 * 24 * 60 * 60 * 1000,       resolution: 'hour'   as const },
]

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  if (n < 1024 * 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
  return `${(n / (1024 * 1024 * 1024 * 1024)).toFixed(2)} TB`
}

interface Stat {
  totalUp: number
  totalDown: number
  sparkline: number[] // bytes_up + bytes_down per bucket
}

export default function TrafficTab() {
  const serversQ = useServers({ refetchInterval: 30_000 })
  const inboundsQ = useQuery({
    queryKey: ['xray-inbounds'],
    queryFn: () => listXrayInbounds(),
    refetchInterval: 10_000,
  })

  const [rangeKey, setRangeKey] = useState<string>('1h')
  const range = RANGES.find((r) => r.key === rangeKey) ?? RANGES[0]

  // Group inbounds by server for the per-server batch fetches.
  const tagsByServer = useMemo(() => {
    const m = new Map<number, string[]>()
    for (const i of inboundsQ.data ?? []) {
      const arr = m.get(i.server_id) ?? []
      arr.push(i.tag)
      m.set(i.server_id, arr)
    }
    return m
  }, [inboundsQ.data])

  const allTags = useMemo(
    () => (inboundsQ.data ?? []).map((i) => i.tag).sort().join(','),
    [inboundsQ.data],
  )

  const trafficQ = useQuery({
    queryKey: ['xray-traffic-tab', range.key, allTags],
    queryFn: async () => {
      const now = new Date()
      const from = new Date(now.getTime() - range.ms).toISOString()
      const to = now.toISOString()
      const results = await Promise.all(
        Array.from(tagsByServer.entries()).map(([serverID, tags]) =>
          fetchXrayTrafficBatch({ server_id: serverID, tags, kind: 'inbound', from, to, resolution: range.resolution })
        )
      )
      const byTag = new Map<string, Stat>()
      for (const res of results) {
        for (const series of res.series ?? []) {
          const stat: Stat = { totalUp: 0, totalDown: 0, sparkline: [] }
          for (const p of series.points) {
            stat.totalUp   += p.bytes_up
            stat.totalDown += p.bytes_down
            stat.sparkline.push(p.bytes_up + p.bytes_down)
          }
          byTag.set(series.tag, stat)
        }
      }
      return byTag
    },
    enabled: tagsByServer.size > 0,
    refetchInterval: 30_000,
  })
  const stats: Map<string, Stat> = trafficQ.data ?? new Map()

  // Group inbounds by server for display.
  const groups = useMemo(() => {
    const m = new Map<number, XrayInbound[]>()
    for (const i of inboundsQ.data ?? []) {
      const arr = m.get(i.server_id) ?? []
      arr.push(i)
      m.set(i.server_id, arr)
    }
    return m
  }, [inboundsQ.data])

  const [drillFor, setDrillFor] = useState<{ serverID: number; tag: string } | null>(null)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-[12.5px] text-muted-foreground">
          Inbound 流量 — uplink + downlink，按 inbound tag 切分。点击任一行 drill-down 看时序图。
        </p>
        <div className="flex items-center gap-1">
          {RANGES.map((r) => (
            <Button
              key={r.key}
              size="sm"
              variant={r.key === rangeKey ? 'default' : 'ghost'}
              className="h-7 px-2 text-[12px]"
              onClick={() => setRangeKey(r.key)}
            >
              {r.label}
            </Button>
          ))}
        </div>
      </div>

      {(serversQ.data ?? []).map((s) => {
        const inbounds = groups.get(s.id) ?? []
        if (inbounds.length === 0) return null
        return (
          <div key={s.id} className="rounded-lg border bg-elev overflow-hidden">
            <div className="px-3 py-2 border-b bg-background/40 text-[13px] font-mono">
              <span className="font-medium">{s.name}</span>
              <span className="text-fg-dim ml-2">
                {s.ssh_host?.Valid ? s.ssh_host.String : '—'}
              </span>
            </div>
            <table className="w-full text-[13px] border-collapse">
              <thead>
                <tr className="text-left">
                  <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Tag</th>
                  <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Role</th>
                  <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Last {range.label}</th>
                  <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground text-right">Uplink</th>
                  <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground text-right">Downlink</th>
                  <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {inbounds.map((i) => {
                  const st = stats.get(i.tag)
                  const total = (st?.totalUp ?? 0) + (st?.totalDown ?? 0)
                  return (
                    <tr
                      key={i.id}
                      className="border-t hover:bg-background/40 cursor-pointer"
                      onClick={() => setDrillFor({ serverID: s.id, tag: i.tag })}
                    >
                      <td className="px-3 py-2 font-mono">{i.tag}</td>
                      <td className="px-3 py-2 font-mono text-[12px] text-fg-dim">
                        {i.role}
                        {i.role === 'relay' && i.upstream_tag && (
                          <span className="ml-1">→ {i.upstream_tag}</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {st && st.sparkline.length >= 2 ? (
                          <Sparkline values={st.sparkline} width={120} height={28} className="text-primary" />
                        ) : (
                          <span className="font-mono text-fg-dim text-[12px]">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-[12.5px]">
                        {formatBytes(st?.totalUp ?? 0)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-[12.5px]">
                        {formatBytes(st?.totalDown ?? 0)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-[12.5px] font-medium">
                        {formatBytes(total)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )
      })}

      {(inboundsQ.data ?? []).length === 0 && (
        <div className="rounded-lg border bg-elev p-6 text-center text-muted-foreground text-[13px]">
          No inbounds deployed yet. Create some in the Inbounds tab.
        </div>
      )}

      {drillFor && (
        <TrafficDrawer
          open={true}
          onOpenChange={(open) => { if (!open) setDrillFor(null) }}
          serverID={drillFor.serverID}
          tag={drillFor.tag}
          kind="inbound"
        />
      )}
    </div>
  )
}
