import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useServers, type ServerWithLatest } from '@/api/servers'
import { useAuditLog } from '@/api/audit'
import { pct } from '@/lib/bytes'
import { KpiCard } from '@/components/KpiCard'
import { TopList } from '@/components/TopList'
import { Pill } from '@/components/Pill'
import { relativeTime } from '@/lib/time'

// ── helpers ──────────────────────────────────────────────────────────────────

function isOnline(s: ServerWithLatest): boolean {
  if (!s.agent_last_seen?.Valid) return false
  const t = new Date(s.agent_last_seen.Time)
  return Date.now() - t.getTime() <= 90 * 1000
}

function isAlerting(s: ServerWithLatest): boolean {
  if (!s.latest) return false
  const cpu = s.latest.cpu_pct ?? 0
  const memPct = pct(s.latest.mem_used, s.latest.mem_total) ?? 0
  return cpu >= 80 || memPct >= 80
}

function displayName(s: ServerWithLatest): string {
  return s.public_alias?.Valid ? s.public_alias.String : s.name
}

// ── Regions card ─────────────────────────────────────────────────────────────

type GroupStats = {
  total: number
  online: number
  alerting: number
  cpuSum: number
  cpuCount: number
}

function buildGroups(servers: ServerWithLatest[]): Map<string, GroupStats> {
  const map = new Map<string, GroupStats>()
  for (const s of servers) {
    const key = (s.public_group?.Valid ? s.public_group.String : null) ?? 'ungrouped'
    if (!map.has(key)) map.set(key, { total: 0, online: 0, alerting: 0, cpuSum: 0, cpuCount: 0 })
    const g = map.get(key)!
    g.total++
    const on = isOnline(s)
    if (on) {
      g.online++
      if (s.latest?.cpu_pct != null) {
        g.cpuSum += s.latest.cpu_pct
        g.cpuCount++
      }
    }
    if (isAlerting(s)) g.alerting++
  }
  return map
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Dashboard() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { data, isLoading } = useServers({ withLatest: true, refetchInterval: 30_000 })
  const auditQ = useAuditLog({})

  if (isLoading) return <div className="text-muted-foreground">{t('common.loading')}</div>

  const servers = data ?? []
  const total = servers.length
  const online = servers.filter(isOnline).length
  const offline = total - online
  const alerts = servers.filter(isAlerting).length

  // Top CPU / Top MEM (up to 5 each)
  const topCPU = [...servers]
    .filter((s) => s.latest?.cpu_pct != null)
    .sort((a, b) => (b.latest!.cpu_pct! ?? 0) - (a.latest!.cpu_pct! ?? 0))
    .slice(0, 5)

  const topMEM = [...servers]
    .filter((s) => s.latest?.mem_used != null && s.latest?.mem_total)
    .sort(
      (a, b) =>
        (pct(b.latest!.mem_used, b.latest!.mem_total) ?? 0) -
        (pct(a.latest!.mem_used, a.latest!.mem_total) ?? 0),
    )
    .slice(0, 5)

  // Regional groups
  const groups = buildGroups(servers)
  const sortedGroups = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))

  // Recent audit (last 8)
  const recentAudit = (auditQ.data ?? []).slice(0, 8)

  return (
    <div className="flex flex-col gap-5">
      {/* Header */}
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight m-0">
          {t('admin.dashboard', 'Dashboard')}
        </h1>
        <p className="text-muted-foreground text-[13px] mt-1">
          {t('admin.dashboard_sub', 'Fleet at a glance.')}
        </p>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard label={t('admin.summary.total', 'Total')} value={total} />
        <KpiCard label={t('admin.summary.online', 'Online')} value={online} tone="ok" />
        <KpiCard
          label={t('admin.summary.offline', 'Offline')}
          value={offline}
          tone={offline > 0 ? 'err' : undefined}
        />
        <KpiCard
          label={t('admin.summary.alerts', 'Alerting')}
          value={alerts}
          tone={alerts > 0 ? 'warn' : undefined}
        />
      </div>

      {/* Top CPU + Top MEM */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <TopList
          title={t('admin.summary.top_cpu', 'Top CPU')}
          linkBase="/admin/servers"
          items={topCPU.map((s) => ({
            id: s.id,
            name: displayName(s),
            value: `${(s.latest!.cpu_pct ?? 0).toFixed(0)}%`,
            sparkData: [],
          }))}
        />
        <TopList
          title={t('admin.summary.top_mem', 'Top memory')}
          linkBase="/admin/servers"
          items={topMEM.map((s) => ({
            id: s.id,
            name: displayName(s),
            value: `${(pct(s.latest!.mem_used, s.latest!.mem_total) ?? 0).toFixed(0)}%`,
            sparkData: [],
          }))}
        />
      </div>

      {/* Regions + Recent activity */}
      <div className="grid gap-3" style={{ gridTemplateColumns: '1.4fr 1fr' }}>
        {/* Regions card */}
        <div className="bg-elev border rounded-lg overflow-hidden">
          <div className="px-4 pt-3 pb-2.5 flex items-center gap-2 border-b">
            <span className="text-foreground font-medium text-[12.5px]">
              {t('admin.regions', 'Regions')}
            </span>
            <button
              className="ml-auto text-[12px] text-muted-foreground underline underline-offset-[3px] hover:text-foreground transition-colors"
              onClick={() => navigate('/admin/servers')}
            >
              {t('admin.all_hosts', 'all hosts →')}
            </button>
          </div>
          <div className="py-1">
            {sortedGroups.length === 0 && (
              <p className="text-muted-foreground text-[12.5px] px-4 py-3">—</p>
            )}
            {sortedGroups.map(([name, g]) => {
              const avgCpu = g.cpuCount > 0 ? g.cpuSum / g.cpuCount : 0
              const onlinePct = g.total > 0 ? (g.online / g.total) * 100 : 0
              return (
                <div
                  key={name}
                  className="flex items-center gap-3 px-4 py-2.5 border-b border-dashed last:border-b-0"
                >
                  <span className="font-mono text-[13px] font-medium text-foreground w-28 shrink-0 truncate">
                    {name}
                  </span>
                  <span className="font-mono tabular-nums text-[12px] text-muted-foreground w-20 shrink-0">
                    {g.online}/{g.total} {t('admin.online_suffix', 'online')}
                  </span>
                  {/* progress bar */}
                  <div className="h-1.5 max-w-60 flex-1 bg-muted rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{
                        width: `${onlinePct}%`,
                        background:
                          g.alerting > 0 ? 'hsl(var(--warn))' : 'hsl(var(--ok))',
                      }}
                    />
                  </div>
                  <span className="font-mono tabular-nums text-[12px] w-16 text-right shrink-0">
                    {avgCpu.toFixed(0)}%{' '}
                    <span className="text-muted-foreground">cpu</span>
                  </span>
                  {g.alerting > 0 && (
                    <Pill kind="warn">
                      {g.alerting} {t('admin.alert_suffix', 'alert')}
                    </Pill>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {/* Recent activity card */}
        <div className="bg-elev border rounded-lg overflow-hidden">
          <div className="px-4 pt-3 pb-2.5 flex items-center gap-2 border-b">
            <span className="text-foreground font-medium text-[12.5px]">
              {t('admin.recent_activity', 'Recent activity')}
            </span>
            <button
              className="ml-auto text-[12px] text-muted-foreground underline underline-offset-[3px] hover:text-foreground transition-colors"
              onClick={() => navigate('/admin/audit')}
            >
              {t('admin.audit_log', 'audit log →')}
            </button>
          </div>
          <div className="py-1">
            {recentAudit.length === 0 && !auditQ.isLoading && (
              <p className="text-muted-foreground text-[12.5px] px-4 py-3">—</p>
            )}
            {recentAudit.map((r, i) => {
              const rel = relativeTime(r.ts)
              const relLabel = rel ? t(rel.key, { n: rel.n }) : r.ts
              const toneDot =
                r.result === 'ok'
                  ? 'hsl(var(--ok))'
                  : 'hsl(var(--err))'
              return (
                <div
                  key={r.id}
                  className={
                    'flex items-center gap-2 px-4 py-2 ' +
                    (i < recentAudit.length - 1 ? 'border-b border-dashed' : '')
                  }
                >
                  {/* tone dot */}
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ background: toneDot }}
                  />
                  <span className="font-mono text-[12px] font-medium shrink-0">{r.action}</span>
                  <span className="text-muted-foreground text-[12px] min-w-0 flex-1 truncate">
                    {r.server_id != null && (
                      <span className="font-mono"> · #{r.server_id}</span>
                    )}
                    {r.details && (
                      <span className="text-fg-dim"> · {r.details}</span>
                    )}
                  </span>
                  <span className="font-mono text-[11px] text-fg-dim ml-auto whitespace-nowrap shrink-0">
                    {relLabel}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
