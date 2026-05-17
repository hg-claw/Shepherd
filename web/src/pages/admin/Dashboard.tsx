import { useTranslation } from 'react-i18next'
import { useServers, type ServerWithLatest } from '@/api/servers'
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

  if (isLoading) return <div className="text-muted-foreground">{t('common.loading')}</div>
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
    .sort(
      (a, b) =>
        (pct(b.latest!.mem_used, b.latest!.mem_total) ?? 0) -
        (pct(a.latest!.mem_used, a.latest!.mem_total) ?? 0),
    )
    .slice(0, 5)

  return (
    <div className="space-y-5">
      <div className="flex items-end gap-3.5 mb-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight m-0">{t('admin.dashboard')}</h1>
          <p className="text-muted-foreground text-[13px] mt-1">
            {t('admin.dashboard_sub', 'Fleet at a glance.')}
          </p>
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label={t('admin.summary.total')} value={total} />
        <Kpi label={t('admin.summary.online')} value={online} tone="ok" />
        <Kpi label={t('admin.summary.offline')} value={offline} tone={offline > 0 ? 'err' : undefined} />
        <Kpi label={t('admin.summary.alerts')} value={alerts} tone={alerts > 0 ? 'warn' : undefined} />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <TopList title={t('admin.summary.top_cpu')} items={topCPU.map((s) => ({
          name: s.public_alias?.Valid ? s.public_alias.String : s.name,
          v: `${(s.latest!.cpu_pct ?? 0).toFixed(0)}%`,
        }))} />
        <TopList title={t('admin.summary.top_mem')} items={topMEM.map((s) => ({
          name: s.public_alias?.Valid ? s.public_alias.String : s.name,
          v: `${(pct(s.latest!.mem_used, s.latest!.mem_total) ?? 0).toFixed(0)}%`,
        }))} />
      </div>
    </div>
  )
}

function Kpi({ label, value, tone }: { label: string; value: number; tone?: 'ok' | 'warn' | 'err' }) {
  return (
    <div className="relative overflow-hidden bg-elev border rounded-lg px-4 py-3.5">
      <div className="text-[11.5px] uppercase tracking-[0.05em] text-muted-foreground whitespace-nowrap">
        {label}
      </div>
      <div
        className={
          'font-mono text-[26px] mt-1 tracking-tight tabular-nums leading-none ' +
          (tone === 'ok' ? 'text-ok' : tone === 'warn' ? 'text-warn' : tone === 'err' ? 'text-err' : '')
        }
      >
        {value}
      </div>
    </div>
  )
}

function TopList({ title, items }: { title: string; items: { name: string; v: string }[] }) {
  return (
    <div className="bg-elev border rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-3.5 py-3 border-b text-[12.5px] text-muted-foreground">
        <span className="text-foreground font-medium">{title}</span>
      </div>
      <div className="px-3.5 py-2 space-y-1.5">
        {items.length === 0 && <p className="text-muted-foreground text-[12.5px] py-1">—</p>}
        {items.map((it) => (
          <div key={it.name} className="flex justify-between items-center text-[13px]">
            <span className="font-mono truncate">{it.name}</span>
            <span className="font-mono tabular-nums">{it.v}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
