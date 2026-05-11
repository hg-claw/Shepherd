import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { Plus, Trash2, LayoutGrid, Rows3, Search } from 'lucide-react'
import { useServers, useDeleteServer, type ServerWithLatest } from '@/api/servers'
import { useUI } from '@/store/ui'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Pill, type PillKind } from '@/components/Pill'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { pct } from '@/lib/bytes'
import { relativeTime } from '@/lib/time'
import { cn } from '@/lib/utils'

type HostStatus = 'ok' | 'warn' | 'err' | 'offline'

function isOnline(s: ServerWithLatest): boolean {
  if (!s.agent_last_seen?.Valid) return false
  return Date.now() - new Date(s.agent_last_seen.Time).getTime() <= 90 * 1000
}

function topPct(s: ServerWithLatest): number {
  if (!s.latest) return 0
  const m = pct(s.latest.mem_used, s.latest.mem_total) ?? 0
  let diskMax = 0
  if (s.latest.disks_json) {
    try {
      const ds = JSON.parse(s.latest.disks_json) as Array<{ used: number; total: number }>
      for (const d of ds) if (d.total > 0) diskMax = Math.max(diskMax, (d.used / d.total) * 100)
    } catch {}
  }
  return Math.max(s.latest.cpu_pct ?? 0, m, diskMax)
}

function hostStatus(s: ServerWithLatest): HostStatus {
  if (!isOnline(s)) return 'offline'
  const top = topPct(s)
  if (top >= 92) return 'err'
  if (top >= 80) return 'warn'
  return 'ok'
}

function stageKind(stage: string): PillKind {
  if (stage === 'failed') return 'err'
  if (stage === 'installing' || stage === 'pending') return 'warn'
  if (stage === 'installed' || stage === 'done') return 'ok'
  return 'neutral'
}

function pctKind(v: number | null | undefined): 'ok' | 'warn' | 'err' {
  if (v == null) return 'ok'
  if (v >= 92) return 'err'
  if (v >= 80) return 'warn'
  return 'ok'
}

function Bar({ value }: { value: number | null | undefined }) {
  if (value == null) return <span className="text-fg-dim">—</span>
  const k = pctKind(value)
  return (
    <div className="flex items-center gap-2">
      <div className="inline-block w-[78px] h-1.5 rounded-[3px] bg-sunken relative overflow-hidden align-middle">
        <i
          className={cn(
            'absolute left-0 top-0 bottom-0 rounded-[3px]',
            k === 'ok' && 'bg-primary',
            k === 'warn' && 'bg-warn',
            k === 'err' && 'bg-err',
          )}
          style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
        />
      </div>
      <span className="font-mono tabular-nums text-[12.5px]">{value.toFixed(0)}%</span>
    </div>
  )
}

const VIEW_KEY = 'shep_hosts_view'

export default function ServerList() {
  const { t, i18n } = useTranslation()
  const [filter, setFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | HostStatus>('all')
  const [view, setView] = useState<'grid' | 'table'>(() => {
    try {
      const v = localStorage.getItem(VIEW_KEY)
      return v === 'grid' ? 'grid' : 'table'
    } catch {
      return 'table'
    }
  })
  const { data, isLoading } = useServers({ withLatest: true, refetchInterval: 30_000 })
  const del = useDeleteServer()
  const toast = useUI((s) => s.toast)

  const all = data ?? []
  const counts = useMemo(() => {
    const c = { all: all.length, ok: 0, warn: 0, err: 0, offline: 0 }
    for (const s of all) c[hostStatus(s)] += 1
    return c
  }, [all])

  const avgCpu = useMemo(() => {
    const online = all.filter(isOnline)
    if (online.length === 0) return 0
    return online.reduce((sum, s) => sum + (s.latest?.cpu_pct ?? 0), 0) / online.length
  }, [all])
  const avgMem = useMemo(() => {
    const online = all.filter(isOnline)
    if (online.length === 0) return 0
    const sum = online.reduce(
      (acc, s) => acc + (pct(s.latest?.mem_used, s.latest?.mem_total) ?? 0),
      0,
    )
    return sum / online.length
  }, [all])

  if (isLoading) return <div className="text-muted-foreground">{t('common.loading')}</div>

  const servers = all.filter((s) => {
    if (statusFilter !== 'all' && hostStatus(s) !== statusFilter) return false
    if (!filter) return true
    const f = filter.toLowerCase()
    return s.name.toLowerCase().includes(f) || (s.ssh_host?.String ?? '').toLowerCase().includes(f)
  })

  const setViewPersist = (v: 'grid' | 'table') => {
    setView(v)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {}
  }

  const chipDefs: { key: 'all' | HostStatus; label: string; count: number }[] = [
    { key: 'all', label: t('filter.all', 'All'), count: counts.all },
    { key: 'ok', label: t('filter.ok', 'Healthy'), count: counts.ok },
    { key: 'warn', label: t('filter.warn', 'Warn'), count: counts.warn },
    { key: 'err', label: t('filter.err', 'Critical'), count: counts.err },
    { key: 'offline', label: t('filter.offline', 'Offline'), count: counts.offline },
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight m-0">
            {t('nav.hosts', 'Hosts')}
          </h1>
          <p className="text-muted-foreground text-[13px] mt-1">
            {servers.length} {t('hosts.of', 'of')} {all.length}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <SegmentToggle
            value={view}
            onChange={setViewPersist}
            options={[
              { value: 'grid', icon: LayoutGrid, label: t('view.grid', 'Grid') },
              { value: 'table', icon: Rows3, label: t('view.table', 'Table') },
            ]}
          />
          <Button asChild size="sm" className="h-8">
            <Link to="/admin/servers/new">
              <Plus className="mr-1 h-3.5 w-3.5" />
              {t('admin.add_server')}
            </Link>
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label={t('hosts.kpi.online', 'Online')} value={`${all.length - counts.offline}/${all.length}`} sub={`${counts.offline} ${t('wall.offline')}`} />
        <Kpi label={t('hosts.kpi.cpu', 'Avg CPU')} value={`${avgCpu.toFixed(1)}%`} sub={t('range.24h')} />
        <Kpi label={t('hosts.kpi.mem', 'Avg memory')} value={`${avgMem.toFixed(1)}%`} sub={t('range.24h')} />
        <Kpi
          label={t('hosts.kpi.alerts', 'Alerts')}
          value={String(counts.err + counts.warn)}
          sub={`${counts.err} ${t('filter.err', 'critical')}`}
          tone={counts.err > 0 ? 'err' : counts.warn > 0 ? 'warn' : undefined}
        />
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-fg-dim pointer-events-none" />
          <Input
            placeholder={t('common.filter', 'Filter…')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="pl-7 max-w-full sm:max-w-[260px] h-8 text-[13px]"
          />
        </div>
        {chipDefs.map((c) => (
          <button
            key={c.key}
            onClick={() => setStatusFilter(c.key)}
            className={cn(
              'h-[26px] px-2.5 rounded-full text-[12px] inline-flex items-center gap-1.5 border transition-colors',
              statusFilter === c.key
                ? 'bg-accent text-accent-foreground border-transparent'
                : 'bg-sunken text-muted-foreground border-transparent hover:text-foreground',
            )}
          >
            {c.label}
            <span className="font-mono text-[11px] opacity-70">{c.count}</span>
          </button>
        ))}
      </div>

      {view === 'grid' ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
          {servers.map((s) => (
            <HostCard
              key={s.id}
              server={s}
              onDelete={async () => {
                try {
                  await del.mutateAsync(s.id)
                  toast('success', t('common.ok'))
                } catch (err: any) {
                  toast('error', err?.message ?? t('common.error'))
                }
              }}
              t={t}
            />
          ))}
        </div>
      ) : (
        <div className="rounded-lg border bg-elev overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="text-left">
                <Th>{t('admin.name')}</Th>
                <Th className="hidden md:table-cell">{t('admin.host')}</Th>
                <Th className="hidden lg:table-cell">OS</Th>
                <Th className="hidden md:table-cell">Stage</Th>
                <Th className="hidden lg:table-cell">{t('admin.agent_last_seen')}</Th>
                <Th>CPU</Th>
                <Th className="hidden sm:table-cell">MEM</Th>
                <Th className="text-right">{t('admin.actions')}</Th>
              </tr>
            </thead>
            <tbody>
              {servers.map((s) => {
                const online = isOnline(s)
                const lastSeen = relativeTime(s.agent_last_seen?.Valid ? s.agent_last_seen.Time : null)
                const memPct = pct(s.latest?.mem_used, s.latest?.mem_total)
                return (
                  <tr key={s.id} className="border-t hover:bg-sunken/60 cursor-pointer">
                    <Td>
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span
                          className={cn(
                            'inline-block h-1.5 w-1.5 rounded-full shrink-0',
                            online
                              ? 'bg-ok shadow-[0_0_0_3px_hsl(var(--ok-soft))] motion-safe:shep-pulse'
                              : 'bg-err shadow-[0_0_0_3px_hsl(var(--err-soft))]',
                          )}
                        />
                        <Link
                          to={`/admin/servers/${s.id}`}
                          className="font-mono font-medium truncate hover:underline"
                        >
                          {s.name}
                        </Link>
                      </div>
                    </Td>
                    <Td className="hidden md:table-cell font-mono text-[12px] text-muted-foreground">
                      {s.ssh_host?.String ?? '—'}
                    </Td>
                    <Td className="hidden lg:table-cell font-mono text-[12px] text-fg-dim">
                      {s.agent_os?.String ?? '—'}/{s.agent_arch?.String ?? '—'}
                    </Td>
                    <Td className="hidden md:table-cell">
                      <Pill kind={stageKind(s.install_stage)}>{s.install_stage}</Pill>
                    </Td>
                    <Td className="hidden lg:table-cell text-[12px] text-muted-foreground">
                      {lastSeen ? t(lastSeen.key, { n: lastSeen.n, lng: i18n.language }) : '—'}
                    </Td>
                    <Td><Bar value={s.latest?.cpu_pct} /></Td>
                    <Td className="hidden sm:table-cell"><Bar value={memPct} /></Td>
                    <Td className="text-right whitespace-nowrap">
                      <Button asChild variant="ghost" size="sm" className="h-7 px-2 text-[12.5px]">
                        <Link to={`/admin/servers/${s.id}`}>{t('admin.details')}</Link>
                      </Button>
                      <Dialog>
                        <DialogTrigger asChild>
                          <Button variant="ghost" size="sm" aria-label="delete" className="h-7 w-7 p-0">
                            <Trash2 className="h-3.5 w-3.5 text-destructive" />
                          </Button>
                        </DialogTrigger>
                        <DialogContent>
                          <DialogHeader>
                            <DialogTitle>{t('admin.delete')}</DialogTitle>
                            <DialogDescription>
                              {t('admin.confirm_delete', { name: s.name })}
                            </DialogDescription>
                          </DialogHeader>
                          <DialogFooter>
                            <Button
                              variant="destructive"
                              onClick={async () => {
                                try {
                                  await del.mutateAsync(s.id)
                                  toast('success', t('common.ok'))
                                } catch (err: any) {
                                  toast('error', err?.message ?? t('common.error'))
                                }
                              }}
                            >
                              {t('admin.delete')}
                            </Button>
                          </DialogFooter>
                        </DialogContent>
                      </Dialog>
                    </Td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function Kpi({
  label,
  value,
  sub,
  tone,
}: {
  label: string
  value: string
  sub?: string
  tone?: 'ok' | 'warn' | 'err'
}) {
  return (
    <div className="relative bg-elev border rounded-lg px-4 py-3.5">
      <div className="text-[11.5px] uppercase tracking-[0.05em] text-muted-foreground whitespace-nowrap">
        {label}
      </div>
      <div
        className={cn(
          'font-mono text-[26px] mt-1 tracking-tight tabular-nums leading-none',
          tone === 'ok' && 'text-ok',
          tone === 'warn' && 'text-warn',
          tone === 'err' && 'text-err',
        )}
      >
        {value}
      </div>
      {sub && <div className="font-mono text-[11px] text-muted-foreground mt-1">{sub}</div>}
    </div>
  )
}

function HostCard({
  server,
  onDelete,
  t,
}: {
  server: ServerWithLatest
  onDelete: () => void
  t: (k: string, opts?: any) => string
}) {
  const online = isOnline(server)
  const status = hostStatus(server)
  const cpu = server.latest?.cpu_pct ?? 0
  const mem = pct(server.latest?.mem_used, server.latest?.mem_total) ?? 0
  const load = server.latest?.load_1 ?? 0
  const tcp = server.latest?.tcp_conn ?? 0
  return (
    <div className="bg-elev border rounded-lg p-3.5 hover:border-strong transition-colors">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <Link
            to={`/admin/servers/${server.id}`}
            className="font-mono font-medium text-[13.5px] hover:underline truncate block"
          >
            {server.name}
          </Link>
          <div className="font-mono text-[11.5px] text-muted-foreground mt-0.5 truncate">
            {(server.agent_os?.String ?? '—')} · {server.public_group?.String ?? '—'}
          </div>
        </div>
        <Pill kind={status === 'offline' ? 'neutral' : status}>
          {status === 'ok'
            ? t('filter.ok', 'healthy')
            : status === 'warn'
              ? t('filter.warn', 'warn')
              : status === 'err'
                ? t('filter.err', 'critical')
                : t('filter.offline', 'offline')}
        </Pill>
      </div>
      <div className="grid grid-cols-2 gap-y-2 gap-x-3.5 mt-3">
        <Stat label="CPU" v={online ? `${cpu.toFixed(1)}%` : '—'} />
        <Stat label="MEM" v={online ? `${mem.toFixed(1)}%` : '—'} />
        <Stat label="LOAD" v={online ? load.toFixed(2) : '—'} />
        <Stat label="TCP" v={online ? tcp.toLocaleString() : '—'} />
      </div>
      <div className="flex items-center gap-1 mt-3 pt-2.5 border-t border-dashed">
        <Button asChild variant="ghost" size="sm" className="h-7 px-2 text-[12px]">
          <Link to={`/admin/servers/${server.id}`}>{t('admin.details')}</Link>
        </Button>
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0 ml-auto" aria-label="delete">
              <Trash2 className="h-3.5 w-3.5 text-destructive" />
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('admin.delete')}</DialogTitle>
              <DialogDescription>
                {t('admin.confirm_delete', { name: server.name })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="destructive" onClick={onDelete}>
                {t('admin.delete')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  )
}

function Stat({ label, v }: { label: string; v: string }) {
  return (
    <div>
      <div className="text-[10.5px] text-fg-dim uppercase tracking-[0.05em]">{label}</div>
      <div className="font-mono font-medium text-[14px] tabular-nums mt-0.5">{v}</div>
    </div>
  )
}

function SegmentToggle<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; icon?: React.ComponentType<{ className?: string }>; label: string }[]
}) {
  return (
    <div className="inline-flex border rounded-md bg-elev overflow-hidden h-8">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'px-2.5 text-[12px] font-mono inline-flex items-center gap-1 border-r last:border-r-0 transition-colors',
            value === o.value ? 'bg-sunken text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {o.icon && <o.icon className="h-3.5 w-3.5" />}
          <span className="hidden sm:inline">{o.label}</span>
        </button>
      ))}
    </div>
  )
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={cn(
        'font-medium text-muted-foreground text-[11px] uppercase tracking-[0.05em] px-3.5 py-2 bg-elev sticky top-0',
        className,
      )}
    >
      {children}
    </th>
  )
}
function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={cn('px-3.5 py-2.5 align-middle', className)}>{children}</td>
}
