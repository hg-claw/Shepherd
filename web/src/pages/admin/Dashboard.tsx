import { useTranslation } from 'react-i18next'
import { useServers, type ServerWithLatest } from '@/api/servers'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { levelForPct } from '@/lib/thresholds'
import { pct } from '@/lib/bytes'

function isOnline(s: ServerWithLatest): boolean {
  if (!s.agent_last_seen?.Valid) return false
  const t = new Date(s.agent_last_seen.Time)
  return Date.now() - t.getTime() <= 90 * 1000
}

function isAlerting(s: ServerWithLatest): boolean {
  if (!s.latest) return false
  const cpuLevel = levelForPct('cpu', s.latest.cpu_pct ?? null)
  const memLevel = levelForPct('mem', pct(s.latest.mem_used, s.latest.mem_total))
  let diskMax = 0
  if (s.latest.disks_json) {
    try {
      const ds = JSON.parse(s.latest.disks_json) as Array<{ used: number; total: number }>
      for (const d of ds) {
        if (d.total > 0) diskMax = Math.max(diskMax, (d.used / d.total) * 100)
      }
    } catch {}
  }
  const diskLevel = levelForPct('disk', diskMax)
  return cpuLevel === 'alert' || memLevel === 'alert' || diskLevel === 'alert'
}

export default function Dashboard() {
  const { t } = useTranslation()
  const { data, isLoading } = useServers({ withLatest: true, refetchInterval: 30_000 })

  if (isLoading) return <div>{t('common.loading')}</div>
  const servers = data ?? []
  const total = servers.length
  const online = servers.filter(isOnline).length
  const offline = total - online
  const alerts = servers.filter(isAlerting).length

  const topCPU = servers
    .filter((s) => s.latest?.cpu_pct != null)
    .sort((a, b) => (b.latest!.cpu_pct! ?? 0) - (a.latest!.cpu_pct! ?? 0))
    .slice(0, 5)

  const topMEM = servers
    .filter((s) => s.latest?.mem_used != null && s.latest?.mem_total)
    .sort((a, b) => (pct(b.latest!.mem_used, b.latest!.mem_total) ?? 0) - (pct(a.latest!.mem_used, a.latest!.mem_total) ?? 0))
    .slice(0, 5)

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t('admin.dashboard')}</h1>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <SummaryCard label={t('admin.summary.total')} value={total} />
        <SummaryCard label={t('admin.summary.online')} value={online} />
        <SummaryCard label={t('admin.summary.offline')} value={offline} />
        <SummaryCard label={t('admin.summary.alerts')} value={alerts} />
      </div>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>{t('admin.summary.top_cpu')}</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {topCPU.length === 0 && <p className="text-muted-foreground">-</p>}
            {topCPU.map((s) => (
              <div key={s.id} className="flex justify-between">
                <span>{s.public_alias?.Valid ? s.public_alias.String : s.name}</span>
                <span className="font-mono">{(s.latest!.cpu_pct ?? 0).toFixed(0)}%</span>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>{t('admin.summary.top_mem')}</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {topMEM.length === 0 && <p className="text-muted-foreground">-</p>}
            {topMEM.map((s) => (
              <div key={s.id} className="flex justify-between">
                <span>{s.public_alias?.Valid ? s.public_alias.String : s.name}</span>
                <span className="font-mono">
                  {(pct(s.latest!.mem_used, s.latest!.mem_total) ?? 0).toFixed(0)}%
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function SummaryCard({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs uppercase text-muted-foreground">{label}</div>
        <div className="mt-1 text-3xl font-semibold">{value}</div>
      </CardContent>
    </Card>
  )
}
