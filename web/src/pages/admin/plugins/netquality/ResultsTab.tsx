import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Pill, type PillKind } from '@/components/Pill'
import { useServers, type ServerRecord } from '@/api/servers'
import { fetchNetqualityLatest, type NetqualityISP, type NetqualityLatestRow } from '@/api/netquality'
import HistoryDrawer from './HistoryDrawer'

const ISP_LABEL_FALLBACK: Record<NetqualityISP, string> = {
  telecom: 'Telecom',
  unicom: 'Unicom',
  mobile: 'Mobile',
  overseas: 'Overseas',
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
  const { t } = useTranslation()
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
        <span className="text-sm text-muted-foreground">{t('netquality.results.server_label', 'Server')}</span>
        <Select
          value={effectiveID ? String(effectiveID) : ''}
          onValueChange={(v) => {
            const n = Number(v)
            setServerID(n)
            sp.set('server_id', String(n))
            setSP(sp, { replace: true })
          }}
        >
          <SelectTrigger className="h-8 w-72 text-sm">
            <SelectValue placeholder={t('netquality.results.server_placeholder', 'Pick a server')} />
          </SelectTrigger>
          <SelectContent>
            {servers.map((s: ServerRecord) => (
              <SelectItem key={s.id} value={String(s.id)} className="text-sm">
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {latestQ.isLoading && <span className="text-xs text-muted-foreground">{t('common.loading', 'Loading…')}</span>}
      </div>

      {(latestQ.data ?? []).length === 0 && !latestQ.isLoading && (
        <p className="text-sm text-muted-foreground">
          {t('netquality.results.empty_pre', 'No samples yet. Enable the plugin on this server under')}{' '}
          <em>{t('netquality.results.empty_hosts_tab', 'Hosts')}</em>
          {t('netquality.results.empty_post', ', then wait one sample interval.')}
        </p>
      )}

      {(['telecom', 'unicom', 'mobile', 'overseas'] as NetqualityISP[]).map((isp) => {
        const rows = grouped.get(isp) ?? []
        if (rows.length === 0) return null
        return (
          <div key={isp} className="border rounded-md overflow-hidden">
            <div className="px-3 py-2 bg-elev border-b text-xs font-medium">
              {t(`netquality.isp.${isp}`, ISP_LABEL_FALLBACK[isp])}
            </div>
            <Table wrapperClassName="border-0 rounded-none bg-transparent">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t('netquality.results.region', 'Region')}</TableHead>
                  <TableHead>{t('netquality.results.target', 'Target')}</TableHead>
                  <TableHead>{t('netquality.results.rtt', 'RTT')}</TableHead>
                  <TableHead>{t('netquality.results.loss', 'Loss')}</TableHead>
                  <TableHead>{t('netquality.results.last_sample', 'Last sample')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow
                    key={r.target_id}
                    className="cursor-pointer"
                    onClick={() => setDrillFor({ targetID: r.target_id, label: r.label })}
                  >
                    <TableCell>{r.region}</TableCell>
                    <TableCell>{r.label}</TableCell>
                    <TableCell>
                      <Pill kind={rttKind(r.rtt_avg_ms, r.loss_pct)}>{fmtRTT(r.rtt_avg_ms)}</Pill>
                    </TableCell>
                    <TableCell>{fmtLoss(r.loss_pct)}</TableCell>
                    <TableCell className="font-mono text-2xs text-muted-foreground">
                      {r.ts ? new Date(r.ts).toLocaleTimeString() : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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
