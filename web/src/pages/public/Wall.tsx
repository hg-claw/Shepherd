import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Server, CircleCheck, CircleX, Activity, ArrowDownUp, LayoutGrid, Rows3 } from 'lucide-react'
import { usePublicServers, type PublicCard } from '@/api/public'
import { useWallLiveConnection, useWallLiveStore } from '@/api/wallLive'
import { LiveNetCell } from '@/components/LiveNetCell'
import { bps, bytes } from '@/lib/bytes'
import { cn } from '@/lib/utils'
import { Seg } from '@/components/Seg'
import { OnlineDot } from '@/components/OnlineDot'
import { CountryFlag } from '@/components/CountryFlag'
import { MetricBar } from '@/components/MetricBar'
import { StatCard } from '@/components/StatCard'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'

const WALL_VIEW_KEY = 'shep_wall_view'

export default function Wall() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const servers = usePublicServers()
  useWallLiveConnection()

  const [view, setView] = useState<'list' | 'grid'>(() => {
    try { return localStorage.getItem(WALL_VIEW_KEY) === 'grid' ? 'grid' : 'list' } catch { return 'list' }
  })
  const setViewPersist = (v: 'list' | 'grid') => {
    setView(v)
    try { localStorage.setItem(WALL_VIEW_KEY, v) } catch {}
  }

  if (servers.isLoading) return <div className="text-muted-foreground">{t('common.loading')}</div>
  if (servers.error) return <div className="text-err">{t('common.error')}</div>

  const list = servers.data ?? []
  const total = list.length

  if (total === 0) {
    return <div className="text-muted-foreground">{t('wall.no_servers')}</div>
  }

  const onlineList = list.filter((s) => s.online)
  const onlineCount = onlineList.length
  const offlineCount = total - onlineCount

  const sumTrafficRx = list.reduce((a, s) => a + (s.traffic_rx_bytes ?? 0), 0)
  const sumTrafficTx = list.reduce((a, s) => a + (s.traffic_tx_bytes ?? 0), 0)

  // Group by s.group, sort by key
  const groups = new Map<string, PublicCard[]>()
  for (const s of list) {
    const key = s.group || ''
    const arr = groups.get(key) ?? []
    arr.push(s)
    groups.set(key, arr)
  }
  const orderedGroups = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex flex-wrap items-baseline gap-3">
        <div>
          <h1 className="font-mono text-lg tracking-tight m-0">
            {t('wall.title', 'Server status')}
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t('wall.subtitle', 'Public health overview — identifying data redacted.')}
          </p>
        </div>
        <span className="ml-auto">
          <Seg
            value={view}
            onChange={setViewPersist}
            size="sm"
            options={[
              { value: 'list' as const, icon: Rows3, label: t('view.list', 'List') },
              { value: 'grid' as const, icon: LayoutGrid, label: t('view.grid', 'Grid') },
            ]}
          />
        </span>
      </div>

      {/* Summary strip */}
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
        <StatCard variant="compact" label={t('wall.stat.nodes', 'Nodes')} value={String(total)} icon={Server} />
        <StatCard variant="compact" label={t('wall.online', 'Online')} value={String(onlineCount)} icon={CircleCheck} tone="ok" />
        <StatCard
          variant="compact"
          label={t('wall.offline', 'Offline')}
          value={String(offlineCount)}
          icon={CircleX}
          tone={offlineCount > 0 ? 'err' : undefined}
        />
        <RealtimeStat online={onlineList} label={t('wall.stat.realtime', 'Realtime')} />
        <StatCard
          variant="compact"
          label={t('wall.stat.traffic', 'Traffic')}
          value={`↓ ${bytes(sumTrafficRx)}`}
          sub={`↑ ${bytes(sumTrafficTx)}`}
          icon={ArrowDownUp}
        />
      </div>

      {/* Groups */}
      {orderedGroups.map(([group, ss]) => {
        const groupOnline = ss.filter((s) => s.online).length
        return (
          <section key={group} className="flex flex-col gap-2.5">
            {/* Group header */}
            <div className="flex items-baseline gap-3 border-b border-dashed px-0.5 pt-0.5 pb-2">
              <h2 className="font-mono text-sm tracking-tight m-0 whitespace-nowrap">
                {group || t('wall.ungrouped', 'Ungrouped')}
              </h2>
              <span className="font-mono text-2xs text-muted-foreground">
                {groupOnline}/{ss.length} {t('wall.online', 'online')}
              </span>
            </div>

            {view === 'list' ? (
              <ServerListTable servers={ss} navigate={navigate} />
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
                {ss
                  .slice()
                  .sort((a, b) => {
                    if (a.online !== b.online) return a.online ? -1 : 1
                    return a.alias.localeCompare(b.alias)
                  })
                  .map((s) => (
                    <WallServerCard
                      key={s.id}
                      server={s}
                    />
                  ))}
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}

function RealtimeStat({ online, label }: { online: PublicCard[]; label: string }) {
  const live = useWallLiveStore((s) => s.live)
  const rx = online.reduce((a, s) => a + (live[s.id]?.rx_bps ?? s.latest?.net_rx_bps ?? 0), 0)
  const tx = online.reduce((a, s) => a + (live[s.id]?.tx_bps ?? s.latest?.net_tx_bps ?? 0), 0)
  return <StatCard variant="compact" label={label} value={`↓ ${bps(rx)}`} sub={`↑ ${bps(tx)}`} icon={Activity} />
}

// ── List view ─────────────────────────────────────────────────────────────────

function ServerListTable({
  servers,
  navigate,
}: {
  servers: PublicCard[]
  navigate: ReturnType<typeof useNavigate>
}) {
  const { t } = useTranslation()
  const sorted = servers.slice().sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1
    return a.alias.localeCompare(b.alias)
  })
  return (
    <Table style={{ minWidth: 900 }}>
      <TableHeader className="[&_th]:bg-elev [&_th]:px-3.5 [&_th]:py-2">
        <TableRow className="hover:bg-transparent">
          <TableHead>{t('wall.col.node', 'Node')}</TableHead>
          <TableHead>{t('wall.col.platform', 'Platform')}</TableHead>
          <TableHead style={{ minWidth: 120 }}>CPU</TableHead>
          <TableHead style={{ minWidth: 120 }}>{t('wall.col.memory', 'Memory')}</TableHead>
          <TableHead style={{ minWidth: 120 }}>{t('wall.col.disk', 'Disk')}</TableHead>
          <TableHead>{t('wall.col.network', 'Network ↓↑')}</TableHead>
          <TableHead>{t('wall.col.traffic', 'Traffic ↓↑')}</TableHead>
          <TableHead className="text-right">{t('wall.col.load', 'Load')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody className="[&_td]:px-3.5 [&_td]:py-2.5">
        {sorted.map((s) => (
          <TableRow
            key={s.id}
            className="cursor-pointer"
            role="button"
            tabIndex={0}
            onClick={() => navigate(`/public/servers/${s.id}`)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                navigate(`/public/servers/${s.id}`)
              }
            }}
          >
            {/* Node */}
            <TableCell>
              <span className="flex items-center gap-2 min-w-0">
                <OnlineDot online={s.online} />
                <CountryFlag code={s.country_code} />
                <span className="font-mono font-medium truncate">{s.alias}</span>
              </span>
            </TableCell>
            {/* Platform */}
            <TableCell>
              {s.online ? (
                <span className="font-mono text-xs text-muted-foreground">
                  {s.platform ?? ''}
                  {s.arch ? <span className="text-fg-dim"> · {s.arch}</span> : null}
                </span>
              ) : (
                <span className="text-fg-dim">—</span>
              )}
            </TableCell>
            {/* CPU */}
            <TableCell>
              {s.online && s.latest != null ? (
                <MetricBar label="" value={s.latest.cpu_pct} />
              ) : (
                <span className="text-fg-dim">—</span>
              )}
            </TableCell>
            {/* Memory */}
            <TableCell>
              {s.online && s.latest != null ? (
                <MetricBar label="" value={s.latest.mem_pct} />
              ) : (
                <span className="text-fg-dim">—</span>
              )}
            </TableCell>
            {/* Disk */}
            <TableCell>
              {s.online && s.latest != null ? (
                <MetricBar label="" value={s.latest.disks_pct?.[0] ?? 0} />
              ) : (
                <span className="text-fg-dim">—</span>
              )}
            </TableCell>
            {/* Network ↓↑ */}
            <TableCell>
              {s.online ? (
                <div className="flex flex-col gap-[1px] font-mono tabular-nums text-2xs whitespace-nowrap">
                  <LiveNetCell id={s.id} fallbackRx={s.latest?.net_rx_bps ?? 0} fallbackTx={s.latest?.net_tx_bps ?? 0}>
                    {(rx, tx) => (
                      <>
                        <span>↓ {bps(rx)}</span>
                        <span>↑ {bps(tx)}</span>
                      </>
                    )}
                  </LiveNetCell>
                </div>
              ) : (
                <span className="text-fg-dim">—</span>
              )}
            </TableCell>
            {/* Traffic ↓↑ */}
            <TableCell>
              <div className="flex flex-col gap-[1px] font-mono tabular-nums text-2xs text-muted-foreground whitespace-nowrap">
                <span>↓ {bytes(s.traffic_rx_bytes ?? 0)}</span>
                <span>↑ {bytes(s.traffic_tx_bytes ?? 0)}</span>
              </div>
            </TableCell>
            {/* Load */}
            <TableCell className="text-right font-mono tabular-nums text-sm">
              {s.online && s.latest != null ? s.latest.load_1.toFixed(2) : <span className="text-fg-dim">—</span>}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

// ── Grid card ─────────────────────────────────────────────────────────────────

function WallServerCard({
  server: s,
}: {
  server: PublicCard
}) {
  const l = s.latest
  const top = !s.online || !l ? -1 : Math.max(l.cpu_pct ?? 0, l.mem_pct ?? 0, ...(l.disks_pct ?? []))
  const st: 'ok' | 'warn' | 'err' | 'offline' = !s.online
    ? 'offline'
    : top >= 92
      ? 'err'
      : top >= 80
        ? 'warn'
        : 'ok'

  return (
    <Link
      to={`/public/servers/${s.id}`}
      className={cn(
        'block bg-elev border rounded-lg p-3.5 flex flex-col gap-2.5 hover:border-primary transition-colors',
        st === 'ok' && 'border-[hsl(var(--ok)/0.3)]',
        st === 'warn' && 'border-[hsl(var(--warn)/0.5)]',
        st === 'err' && 'border-[hsl(var(--err)/0.5)]',
        st === 'offline' && 'opacity-60',
      )}
    >
      {/* Header row: dot + flag + alias */}
      <div className="flex items-center gap-2 min-w-0">
        <OnlineDot online={s.online} />
        <CountryFlag code={s.country_code} />
        <span className="font-mono font-medium text-sm truncate flex-1">{s.alias}</span>
      </div>

      {s.online && l ? (
        <>
          {/* Platform · arch */}
          <div className="font-mono text-fg-dim text-2xs">
            {s.platform ?? ''}
            {s.arch ? ` · ${s.arch}` : ''}
          </div>

          {/* Metric bars */}
          <MetricBar label="CPU" value={l.cpu_pct} />
          <MetricBar label="MEM" value={l.mem_pct} />
          <MetricBar label="DSK" value={l.disks_pct?.[0] ?? 0} />

          {/* Net + load */}
          <div className="flex items-center gap-3 font-mono tabular-nums text-2xs mt-0.5">
            <LiveNetCell id={s.id} fallbackRx={s.latest?.net_rx_bps ?? 0} fallbackTx={s.latest?.net_tx_bps ?? 0}>
              {(rx, tx) => (
                <>
                  <span className="text-ok">↓</span>
                  <span>{bps(rx)}</span>
                  <span className="text-primary">↑</span>
                  <span>{bps(tx)}</span>
                </>
              )}
            </LiveNetCell>
            <span className="ml-auto text-fg-dim">load {l.load_1.toFixed(2)}</span>
          </div>

          {/* Cumulative traffic */}
          <div className="font-mono tabular-nums text-2xs text-muted-foreground flex gap-3">
            <span>↓ {bytes(s.traffic_rx_bytes ?? 0)}</span>
            <span>↑ {bytes(s.traffic_tx_bytes ?? 0)}</span>
          </div>
        </>
      ) : (
        <div className="font-mono text-fg-dim text-2xs py-2">offline</div>
      )}
    </Link>
  )
}

