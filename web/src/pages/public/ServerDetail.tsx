import { useParams } from 'react-router-dom'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { TimeSeriesChart } from '@/components/TimeSeriesChart'
import { usePublicTelemetry } from '@/api/public'
import type { Range } from '@/api/servers'
import { bps, bytes, pct } from '@/lib/bytes'

export default function PublicServerDetail() {
  const { id: idStr } = useParams<{ id: string }>()
  const id = Number(idStr)
  const { t } = useTranslation()
  const [range, setRange] = useState<Range>('1h')
  const { data, isLoading, error } = usePublicTelemetry(id, range)

  if (isLoading) return <div>{t('common.loading')}</div>
  if (error) return <div>{t('common.not_found')}</div>

  const points = data ?? []
  const cpu = points.map((p) => ({ ts: p.ts, v: p.cpu_pct ?? 0 }))
  const memPct = points.map((p) => ({ ts: p.ts, v: pct(p.mem_used, p.mem_total) ?? 0 }))
  const netRx = points.map((p) => ({ ts: p.ts, v: p.net_rx_bps ?? 0 }))
  const netTx = points.map((p) => ({ ts: p.ts, v: p.net_tx_bps ?? 0 }))
  const load = points.map((p) => ({ ts: p.ts, v: p.load_1 ?? 0 }))
  const tcp = points.map((p) => ({ ts: p.ts, v: p.tcp_conn ?? 0 }))

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Server #{id}</h1>
        <Tabs value={range} onValueChange={(v) => setRange(v as Range)}>
          <TabsList>
            <TabsTrigger value="1h">{t('range.1h')}</TabsTrigger>
            <TabsTrigger value="24h">{t('range.24h')}</TabsTrigger>
            <TabsTrigger value="7d">{t('range.7d')}</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <Card>
        <CardHeader><CardTitle>{t('metric.cpu')}</CardTitle></CardHeader>
        <CardContent>
          <TimeSeriesChart series={[{ name: 'CPU%', values: cpu }]} yMin={0} yMax={100} yFormat={(v) => `${v.toFixed(0)}%`} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t('metric.mem')}</CardTitle></CardHeader>
        <CardContent>
          <TimeSeriesChart series={[{ name: 'MEM%', values: memPct }]} yMin={0} yMax={100} yFormat={(v) => `${v.toFixed(0)}%`} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t('metric.net')}</CardTitle></CardHeader>
        <CardContent>
          <TimeSeriesChart
            series={[
              { name: 'rx', values: netRx },
              { name: 'tx', values: netTx },
            ]}
            yFormat={(v) => bps(v)}
            tooltipFormat={(v) => bps(v)}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t('metric.load')}</CardTitle></CardHeader>
        <CardContent>
          <TimeSeriesChart series={[{ name: 'load1', values: load }]} yFormat={(v) => v.toFixed(1)} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t('metric.tcp')}</CardTitle></CardHeader>
        <CardContent>
          <TimeSeriesChart series={[{ name: 'tcp', values: tcp }]} />
        </CardContent>
      </Card>
      {points.length > 0 && (
        <p className="text-xs text-muted-foreground">
          mem: {bytes(points[points.length - 1].mem_used)} / {bytes(points[points.length - 1].mem_total)}
        </p>
      )}
    </div>
  )
}
