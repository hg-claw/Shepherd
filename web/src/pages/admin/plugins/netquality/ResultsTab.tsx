import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Pill, type PillKind } from '@/components/Pill'
import { useServers, type ServerRecord } from '@/api/servers'
import { fetchNetqualityLatest, type NetqualityISP, type NetqualityLatestRow } from '@/api/netquality'
import HistoryDrawer from './HistoryDrawer'

const ISP_LABEL: Record<NetqualityISP, string> = {
  telecom: '电信',
  unicom: '联通',
  mobile: '移动',
  overseas: '海外',
}

// Latency thresholds for the colour pill. Tunable per operator preference;
// 80ms ≈ comfortable trans-province, 150ms ≈ trans-pacific, anything above
// is "investigate".
function rttKind(rttMs?: number, lossPct?: number): PillKind {
  if (lossPct != null && lossPct >= 50) return 'err'
  if (rttMs == null) return 'neutral'
  if (rttMs >= 250) return 'err'
  if (rttMs >= 150) return 'warn'
  return 'ok'
}

function fmtRTT(rtt?: number) {
  if (rtt == null) return '—'
  return `${rtt.toFixed(1)} ms`
}

function fmtLoss(loss?: number) {
  if (loss == null) return '—'
  return `${loss.toFixed(0)}%`
}

export default function ResultsTab() {
  const [sp, setSP] = useSearchParams()
  const initialID = Number(sp.get('server_id') || 0) || undefined

  const { data: servers = [] } = useServers()
  const [serverID, setServerID] = useState<number | undefined>(initialID)

  // Pick the first server when nothing is selected so the operator
  // doesn't see an empty page on first open.
  const effectiveID = serverID ?? (servers[0]?.id as number | undefined)

  const latestQ = useQuery({
    queryKey: ['netquality', 'latest', effectiveID],
    queryFn: () => fetchNetqualityLatest(effectiveID!),
    enabled: !!effectiveID,
    refetchInterval: 10_000,
  })

  // Group rows by ISP for the section headers.
  const grouped = useMemo(() => {
    const m = new Map<NetqualityISP, NetqualityLatestRow[]>()
    for (const r of latestQ.data ?? []) {
      const arr = m.get(r.isp) ?? []
      arr.push(r)
      m.set(r.isp, arr)
    }
    for (const arr of m.values()) arr.sort((a, b) => a.label.localeCompare(b.label))
    return m
  }, [latestQ.data])

  const [drillFor, setDrillFor] = useState<{ targetID: number; label: string } | null>(null)

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <span className="text-[12.5px] text-muted-foreground">Server</span>
        <Select
          value={effectiveID ? String(effectiveID) : ''}
          onValueChange={(v) => {
            const n = Number(v)
            setServerID(n)
            sp.set('server_id', String(n))
            setSP(sp, { replace: true })
          }}
        >
          <SelectTrigger className="h-8 w-72 text-[12.5px]">
            <SelectValue placeholder="Pick a server" />
          </SelectTrigger>
          <SelectContent>
            {servers.map((s: ServerRecord) => (
              <SelectItem key={s.id} value={String(s.id)} className="text-[12.5px]">
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {latestQ.isLoading && <span className="text-[12px] text-muted-foreground">loading…</span>}
      </div>

      {(latestQ.data ?? []).length === 0 && !latestQ.isLoading && (
        <p className="text-[12.5px] text-muted-foreground">
          No samples yet. Enable the plugin on this server under <em>Hosts</em>, then wait one
          sample interval.
        </p>
      )}

      {(['telecom', 'unicom', 'mobile', 'overseas'] as NetqualityISP[]).map((isp) => {
        const rows = grouped.get(isp) ?? []
        if (rows.length === 0) return null
        return (
          <div key={isp} className="border rounded-md overflow-hidden">
            <div className="px-3 py-2 bg-elev border-b text-[12px] font-medium">
              {ISP_LABEL[isp]}
            </div>
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b text-[11px] text-muted-foreground uppercase tracking-wide">
                  <th className="text-left py-2 pl-3 pr-4 font-medium">Region</th>
                  <th className="text-left py-2 pr-4 font-medium">Target</th>
                  <th className="text-left py-2 pr-4 font-medium">RTT</th>
                  <th className="text-left py-2 pr-4 font-medium">Loss</th>
                  <th className="text-left py-2 pr-3 font-medium">Last sample</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.target_id}
                    className="border-b last:border-0 hover:bg-elev cursor-pointer"
                    onClick={() => setDrillFor({ targetID: r.target_id, label: r.label })}
                  >
                    <td className="py-2 pl-3 pr-4">{r.region}</td>
                    <td className="py-2 pr-4">{r.label}</td>
                    <td className="py-2 pr-4">
                      <Pill kind={rttKind(r.rtt_avg_ms, r.loss_pct)}>{fmtRTT(r.rtt_avg_ms)}</Pill>
                    </td>
                    <td className="py-2 pr-4">{fmtLoss(r.loss_pct)}</td>
                    <td className="py-2 pr-3 font-mono text-[11px] text-muted-foreground">
                      {r.ts ? new Date(r.ts).toLocaleTimeString() : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      })}

      {drillFor && effectiveID && (
        <HistoryDrawer
          open={true}
          onOpenChange={(open) => { if (!open) setDrillFor(null) }}
          serverID={effectiveID}
          targetID={drillFor.targetID}
          label={drillFor.label}
        />
      )}
    </div>
  )
}
