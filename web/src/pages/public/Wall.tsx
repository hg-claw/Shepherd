import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Server, CircleCheck, CircleX, Activity, ArrowDownUp, LayoutGrid, Rows3 } from 'lucide-react'
import { usePublicServers, type PublicCard } from '@/api/public'
import { useWallLiveNet } from '@/api/wallLive'
import { bps, bytes } from '@/lib/bytes'
import { cn } from '@/lib/utils'
import { Seg } from '@/components/Seg'
import { OnlineDot } from '@/components/OnlineDot'
import { CountryFlag } from '@/components/CountryFlag'
import { MetricBar } from '@/components/MetricBar'
import { SummaryStat } from '@/components/SummaryStat'

const WALL_VIEW_KEY = 'shep_wall_view'

export default function Wall() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const servers = usePublicServers()
  const { live } = useWallLiveNet()

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

  // Effective net: live wins, else fall back to polled latest
  const rxOf = (s: PublicCard) => live.get(s.id)?.rx_bps ?? s.latest?.net_rx_bps ?? 0
  const txOf = (s: PublicCard) => live.get(s.id)?.tx_bps ?? s.latest?.net_tx_bps ?? 0

  const onlineList = list.filter((s) => s.online)
  const onlineCount = onlineList.length
  const offlineCount = total - onlineCount

  const sumRxBps = onlineList.reduce((a, s) => a + rxOf(s), 0)
  const sumTxBps = onlineList.reduce((a, s) => a + txOf(s), 0)
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
          <h1 className="font-mono text-[18px] tracking-tight m-0">
            {t('wall.title', 'Server status')}
          </h1>
          <p className="text-[12px] text-muted-foreground mt-0.5">
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
        <SummaryStat label={t('wall.stat.nodes', 'Nodes')} value={String(total)} icon={Server} />
        <SummaryStat label={t('wall.online', 'Online')} value={String(onlineCount)} icon={CircleCheck} tone="ok" />
        <SummaryStat
          label={t('wall.offline', 'Offline')}
          value={String(offlineCount)}
          icon={CircleX}
          tone={offlineCount > 0 ? 'err' : undefined}
        />
        <SummaryStat
          label={t('wall.stat.realtime', 'Realtime')}
          value={`↓ ${bps(sumRxBps)}`}
          sub={`↑ ${bps(sumTxBps)}`}
          icon={Activity}
        />
        <SummaryStat
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
              <h2 className="font-mono text-[13.5px] tracking-tight m-0 whitespace-nowrap">
                {group || t('wall.ungrouped', 'Ungrouped')}
              </h2>
              <span className="font-mono text-[11.5px] text-muted-foreground">
                {groupOnline}/{ss.length} {t('wall.online', 'online')}
              </span>
            </div>

            {view === 'list' ? (
              <ServerListTable servers={ss} navigate={navigate} rxOf={rxOf} txOf={txOf} />
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
                      navigate={navigate}
                      rxOf={rxOf}
                      txOf={txOf}
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

// ── List view ─────────────────────────────────────────────────────────────────

function ServerListTable({
  servers,
  navigate,
  rxOf,
  txOf,
}: {
  servers: PublicCard[]
  navigate: ReturnType<typeof useNavigate>
  rxOf: (s: PublicCard) => number
  txOf: (s: PublicCard) => number
}) {
  const { t } = useTranslation()
  const sorted = servers.slice().sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1
    return a.alias.localeCompare(b.alias)
  })
  return (
    <div className="bg-elev border rounded-lg overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]" style={{ minWidth: 900 }}>
          <thead>
            <tr className="text-left">
              <Th>{t('wall.col.node', 'Node')}</Th>
              <Th>{t('wall.col.platform', 'Platform')}</Th>
              <Th style={{ minWidth: 120 }}>CPU</Th>
              <Th style={{ minWidth: 120 }}>{t('wall.col.memory', 'Memory')}</Th>
              <Th style={{ minWidth: 120 }}>{t('wall.col.disk', 'Disk')}</Th>
              <Th>{t('wall.col.network', 'Network ↓↑')}</Th>
              <Th>{t('wall.col.traffic', 'Traffic ↓↑')}</Th>
              <Th className="text-right">{t('wall.col.load', 'Load')}</Th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((s) => (
              <tr
                key={s.id}
                className="border-t hover:bg-sunken/60 cursor-pointer"
                onClick={() => navigate(`/public/servers/${s.id}`)}
              >
                {/* Node */}
                <Td>
                  <span className="flex items-center gap-2 min-w-0">
                    <OnlineDot online={s.online} />
                    <CountryFlag code={s.country_code} />
                    <span className="font-mono font-medium truncate">{s.alias}</span>
                  </span>
                </Td>
                {/* Platform */}
                <Td>
                  {s.online ? (
                    <span className="font-mono text-[12px] text-muted-foreground">
                      {s.platform ?? ''}
                      {s.arch ? <span className="text-fg-dim"> · {s.arch}</span> : null}
                    </span>
                  ) : (
                    <span className="text-fg-dim">—</span>
                  )}
                </Td>
                {/* CPU */}
                <Td>
                  {s.online && s.latest != null ? (
                    <MetricBar label="" value={s.latest.cpu_pct} />
                  ) : (
                    <span className="text-fg-dim">—</span>
                  )}
                </Td>
                {/* Memory */}
                <Td>
                  {s.online && s.latest != null ? (
                    <MetricBar label="" value={s.latest.mem_pct} />
                  ) : (
                    <span className="text-fg-dim">—</span>
                  )}
                </Td>
                {/* Disk */}
                <Td>
                  {s.online && s.latest != null ? (
                    <MetricBar label="" value={s.latest.disks_pct?.[0] ?? 0} />
                  ) : (
                    <span className="text-fg-dim">—</span>
                  )}
                </Td>
                {/* Network ↓↑ */}
                <Td>
                  {s.online ? (
                    <div className="flex flex-col gap-[1px] font-mono tabular-nums text-[11.5px] whitespace-nowrap">
                      <span>↓ {bps(rxOf(s))}</span>
                      <span>↑ {bps(txOf(s))}</span>
                    </div>
                  ) : (
                    <span className="text-fg-dim">—</span>
                  )}
                </Td>
                {/* Traffic ↓↑ */}
                <Td>
                  <div className="flex flex-col gap-[1px] font-mono tabular-nums text-[11.5px] text-muted-foreground whitespace-nowrap">
                    <span>↓ {bytes(s.traffic_rx_bytes ?? 0)}</span>
                    <span>↑ {bytes(s.traffic_tx_bytes ?? 0)}</span>
                  </div>
                </Td>
                {/* Load */}
                <Td className="text-right font-mono tabular-nums text-[12.5px]">
                  {s.online && s.latest != null ? s.latest.load_1.toFixed(2) : <span className="text-fg-dim">—</span>}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Grid card ─────────────────────────────────────────────────────────────────

function WallServerCard({
  server: s,
  navigate,
  rxOf,
  txOf,
}: {
  server: PublicCard
  navigate: ReturnType<typeof useNavigate>
  rxOf: (s: PublicCard) => number
  txOf: (s: PublicCard) => number
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
    <div
      className={cn(
        'bg-elev border rounded-lg p-3.5 flex flex-col gap-2.5 cursor-pointer hover:border-primary transition-colors',
        st === 'ok' && 'border-[hsl(var(--ok)/0.3)]',
        st === 'warn' && 'border-[hsl(var(--warn)/0.5)]',
        st === 'err' && 'border-[hsl(var(--err)/0.5)]',
        st === 'offline' && 'opacity-60',
      )}
      onClick={() => navigate(`/public/servers/${s.id}`)}
    >
      {/* Header row: dot + flag + alias */}
      <div className="flex items-center gap-2 min-w-0">
        <OnlineDot online={s.online} />
        <CountryFlag code={s.country_code} />
        <span className="font-mono font-medium text-[13.5px] truncate flex-1">{s.alias}</span>
      </div>

      {s.online && l ? (
        <>
          {/* Platform · arch */}
          <div className="font-mono text-fg-dim text-[10.5px]">
            {s.platform ?? ''}
            {s.arch ? ` · ${s.arch}` : ''}
          </div>

          {/* Metric bars */}
          <MetricBar label="CPU" value={l.cpu_pct} />
          <MetricBar label="MEM" value={l.mem_pct} />
          <MetricBar label="DSK" value={l.disks_pct?.[0] ?? 0} />

          {/* Net + load */}
          <div className="flex items-center gap-3 font-mono tabular-nums text-[11px] mt-0.5">
            <span className="text-ok">↓</span>
            <span>{bps(rxOf(s))}</span>
            <span className="text-primary">↑</span>
            <span>{bps(txOf(s))}</span>
            <span className="ml-auto text-fg-dim">load {l.load_1.toFixed(2)}</span>
          </div>

          {/* Cumulative traffic */}
          <div className="font-mono tabular-nums text-[11px] text-muted-foreground flex gap-3">
            <span>↓ {bytes(s.traffic_rx_bytes ?? 0)}</span>
            <span>↑ {bytes(s.traffic_tx_bytes ?? 0)}</span>
          </div>
        </>
      ) : (
        <div className="font-mono text-fg-dim text-[11.5px] py-2">offline</div>
      )}
    </div>
  )
}

// ── Table helpers ─────────────────────────────────────────────────────────────

function Th({
  children,
  className,
  style,
}: {
  children?: React.ReactNode
  className?: string
  style?: React.CSSProperties
}) {
  return (
    <th
      className={cn(
        'font-medium text-muted-foreground text-[11px] uppercase tracking-[0.05em] px-3.5 py-2 bg-elev sticky top-0 text-left',
        className,
      )}
      style={style}
    >
      {children}
    </th>
  )
}

function Td({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return <td className={cn('px-3.5 py-2.5 align-middle', className)}>{children}</td>
}
