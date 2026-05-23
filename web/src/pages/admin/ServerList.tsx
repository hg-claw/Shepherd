import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { Plus, Trash2, LayoutGrid, Rows3, ArrowUpCircle } from 'lucide-react'
import { useServers, useDeleteServer, useBatchUpdateAgent, type ServerWithLatest } from '@/api/servers'
import { useUI } from '@/store/ui'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Pill, type PillKind } from '@/components/Pill'
import { KpiCard } from '@/components/KpiCard'
import { OnlineDot } from '@/components/OnlineDot'
import { CountryFlag } from '@/components/CountryFlag'
import { Seg } from '@/components/Seg'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { pct } from '@/lib/bytes'
import { relativeTime } from '@/lib/time'
import { cn } from '@/lib/utils'
import { Search } from 'lucide-react'

type HostStatus = 'ok' | 'warn' | 'err' | 'offline'

function isOnline(s: ServerWithLatest): boolean {
  // Prefer the real-time `connected` field (Hub.IsOnline); fall back to the
  // time-based heuristic for backwards-compat with older API responses.
  if (s.connected !== undefined) return s.connected
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

// HostStage is the derived "where is this host in its lifecycle right now"
// surfaced in the table's Stage column. install_stage alone freezes at
// "done" once installed, so a host whose agent has died silently still
// looked green. This folds in agent_last_seen so the column reflects
// current reachability.
type HostStage = 'installing' | 'install-failed' | 'online' | 'offline' | 'not-installed'

function hostStage(s: ServerWithLatest): HostStage {
  if (s.install_stage === 'pending' || s.install_stage === 'installing') {
    return 'installing'
  }
  if (s.install_stage === 'failed') {
    return 'install-failed'
  }
  // install_stage === 'done' from here on.
  if (!s.agent_last_seen?.Valid) {
    // Install reported success but the agent never connected back.
    // Most common cause: install script wrote the binary and exited 0
    // but the systemd unit never came up (env file missing, port
    // collision, signature mismatch, …). Distinct from "we used to see
    // it and now we don't" — that's plain "offline".
    return 'not-installed'
  }
  return isOnline(s) ? 'online' : 'offline'
}

function hostStageKind(st: HostStage): PillKind {
  switch (st) {
    case 'installing':     return 'warn'
    case 'install-failed': return 'err'
    case 'online':         return 'ok'
    case 'offline':        return 'err'
    case 'not-installed':  return 'neutral'
  }
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
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [view, setView] = useState<'grid' | 'table'>(() => {
    try {
      const v = localStorage.getItem(VIEW_KEY)
      return v === 'grid' ? 'grid' : 'table'
    } catch {
      return 'table'
    }
  })

  // refetchInterval is dynamic: poll fast (1.5s) when ANY server is in a
  // transient stage (pending/installing) so the UI tracks state changes
  // promptly during a script install. Drops back to 30s once everything
  // settles.
  const { data, isLoading } = useServers({
    withLatest: true,
    refetchInterval: (q: any) => {
      const rows = (q?.state?.data ?? []) as Array<{ install_stage?: string }>
      const transient = rows.some(
        (r) => r.install_stage === 'pending' || r.install_stage === 'installing',
      )
      return transient ? 1500 : 30_000
    },
  })
  const del = useDeleteServer()
  const batchUpdate = useBatchUpdateAgent()
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

  const onlineCount = all.length - counts.offline

  const chipDefs: { key: 'all' | HostStatus; label: string; count: number }[] = [
    { key: 'all', label: t('filter.all', 'All'), count: counts.all },
    { key: 'ok', label: t('filter.ok', 'Healthy'), count: counts.ok },
    { key: 'warn', label: t('filter.warn', 'Warn'), count: counts.warn },
    { key: 'err', label: t('filter.err', 'Critical'), count: counts.err },
    { key: 'offline', label: t('filter.offline', 'Offline'), count: counts.offline },
  ]

  const handleDelete = async (s: ServerWithLatest) => {
    try {
      await del.mutateAsync(s.id)
      toast('success', t('common.ok'))
    } catch (err: any) {
      toast('error', err?.message ?? t('common.error'))
    }
  }

  const handleBatchUpdate = async () => {
    const ids = Array.from(selected)
    if (ids.length === 0) return
    try {
      const res = await batchUpdate.mutateAsync(ids)
      const failed = res.results.filter((r) => !r.ok)
      if (failed.length === 0) {
        toast('success', t('server.batch_update_started', 'Started update for {{n}} agents', { n: ids.length }))
      } else {
        toast('success', t('server.batch_update_partial', 'Started {{ok}} updates; {{fail}} failed', {
          ok: ids.length - failed.length,
          fail: failed.length,
        }))
      }
      setSelected(new Set())
    } catch (err: any) {
      toast('error', err?.message ?? t('common.error'))
    }
  }

  const toggleSelect = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAll = () => {
    if (selected.size === servers.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(servers.map((s) => s.id)))
    }
  }

  return (
    <div className="space-y-4">
      {/* Header */}
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
          <Seg
            value={view}
            onChange={setViewPersist}
            size="sm"
            options={[
              { value: 'grid' as const, icon: LayoutGrid, label: t('view.grid', 'Grid') },
              { value: 'table' as const, icon: Rows3, label: t('view.table', 'Table') },
            ]}
          />
          <Button asChild size="sm" className="h-8">
            <Link to="/admin/servers/new">
              <Plus className="mr-1 h-3.5 w-3.5" />
              {t('admin.add_server', 'Add server')}
            </Link>
          </Button>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard
          label={t('hosts.kpi.online', 'Online')}
          value={`${onlineCount}/${all.length}`}
          sub={`${counts.offline} ${t('wall.offline', 'offline')}`}
        />
        <KpiCard
          label={t('hosts.kpi.cpu', 'Avg CPU')}
          value={`${avgCpu.toFixed(1)}%`}
          sub={t('range.24h', '24h')}
        />
        <KpiCard
          label={t('hosts.kpi.mem', 'Avg memory')}
          value={`${avgMem.toFixed(1)}%`}
          sub={t('range.24h', '24h')}
        />
        <KpiCard
          label={t('hosts.kpi.alerts', 'Alerts')}
          value={String(counts.err + counts.warn)}
          sub={`${counts.err} ${t('filter.err', 'critical')}`}
          tone={counts.err > 0 ? 'err' : counts.warn > 0 ? 'warn' : undefined}
        />
      </div>

      {/* Filter row */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-fg-dim pointer-events-none" />
          <Input
            placeholder={t('common.filter', 'Filter…')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="pl-7 max-w-full sm:max-w-[240px] h-7 text-[13px]"
          />
        </div>
        {chipDefs.map((c) => (
          <button
            key={c.key}
            type="button"
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

      {/* Batch action toolbar — only visible when servers are selected */}
      {selected.size > 0 && (
        <div className="flex items-center gap-3 rounded-lg border bg-accent/30 px-4 py-2.5">
          <span className="text-sm font-medium">
            {t('server.selected_count', '{{n}} selected', { n: selected.size })}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={batchUpdate.isPending}
            onClick={handleBatchUpdate}
            className="h-7 text-[12.5px]"
          >
            <ArrowUpCircle className="h-3.5 w-3.5 mr-1" />
            {batchUpdate.isPending
              ? t('server.updating', 'Updating…')
              : t('server.batch_update_agents', 'Update {{n}} agents', { n: selected.size })}
          </Button>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="ml-auto text-xs text-muted-foreground hover:text-foreground"
          >
            {t('common.cancel', 'Cancel')}
          </button>
        </div>
      )}

      {/* Views */}
      {view === 'grid' ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
          {servers.map((s) => (
            <HostCard
              key={s.id}
              server={s}
              onDelete={() => handleDelete(s)}
              t={t}
            />
          ))}
        </div>
      ) : (
        <div className="rounded-lg border bg-elev overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="text-left">
                <Th className="w-8">
                  <input
                    type="checkbox"
                    aria-label={t('server.select_all', 'Select all')}
                    checked={servers.length > 0 && selected.size === servers.length}
                    onChange={toggleSelectAll}
                    className="h-3.5 w-3.5 cursor-pointer"
                  />
                </Th>
                <Th>{t('admin.name', 'Name')}</Th>
                <Th className="hidden md:table-cell">{t('admin.host', 'Host')}</Th>
                <Th className="hidden lg:table-cell">OS</Th>
                <Th className="hidden md:table-cell">Stage</Th>
                <Th className="hidden lg:table-cell">{t('admin.agent_last_seen', 'Last seen')}</Th>
                <Th>CPU</Th>
                <Th className="hidden sm:table-cell">MEM</Th>
                <Th className="text-right">{t('admin.actions', 'Actions')}</Th>
              </tr>
            </thead>
            <tbody>
              {servers.map((s) => {
                const online = isOnline(s)
                const lastSeen = relativeTime(s.agent_last_seen?.Valid ? s.agent_last_seen.Time : null)
                const memPct = pct(s.latest?.mem_used, s.latest?.mem_total)
                return (
                  <tr
                    key={s.id}
                    className="border-t hover:bg-sunken/60 cursor-pointer"
                    onClick={() => window.location.assign(`/admin/servers/${s.id}`)}
                  >
                    <Td onClick={(e) => { e.stopPropagation(); toggleSelect(s.id) }}>
                      <input
                        type="checkbox"
                        aria-label={t('server.select', 'Select {{name}}', { name: s.name })}
                        checked={selected.has(s.id)}
                        onChange={() => toggleSelect(s.id)}
                        onClick={(e) => e.stopPropagation()}
                        className="h-3.5 w-3.5 cursor-pointer"
                      />
                    </Td>
                    <Td>
                      <div className="flex items-center gap-2.5 min-w-0">
                        <OnlineDot online={online} />
                        <Link
                          to={`/admin/servers/${s.id}`}
                          className="font-mono font-medium truncate hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {s.name}
                        </Link>
                        {s.country_code?.String && (
                          <CountryFlag code={s.country_code.String} />
                        )}
                      </div>
                    </Td>
                    <Td className="hidden md:table-cell font-mono text-[12px] text-muted-foreground">
                      {s.ssh_host?.String ?? '—'}
                    </Td>
                    <Td className="hidden lg:table-cell font-mono text-[12px] text-fg-dim">
                      {[s.agent_os?.String, s.agent_arch?.String].filter(Boolean).join('/') || '—'}
                    </Td>
                    <Td className="hidden md:table-cell">
                      {(() => {
                        const st = hostStage(s)
                        return (
                          <Pill kind={hostStageKind(st)}>
                            {t(`host_stage.${st}`, st)}
                          </Pill>
                        )
                      })()}
                    </Td>
                    <Td className="hidden lg:table-cell text-[12px] text-muted-foreground font-mono tabular-nums">
                      {lastSeen ? t(lastSeen.key, { n: lastSeen.n, lng: i18n.language }) : '—'}
                    </Td>
                    <Td><Bar value={s.latest?.cpu_pct} /></Td>
                    <Td className="hidden sm:table-cell"><Bar value={memPct} /></Td>
                    <Td className="text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                      <Button asChild variant="ghost" size="sm" className="h-7 px-2 text-[12.5px]">
                        <Link to={`/admin/servers/${s.id}`}>{t('admin.details', 'Details')}</Link>
                      </Button>
                      <DeleteButton server={s} onDelete={() => handleDelete(s)} t={t} />
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

function DeleteButton({
  server,
  onDelete,
  t,
}: {
  server: ServerWithLatest
  onDelete: () => void
  t: (k: string, opts?: any) => string
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={t('admin.delete', 'Delete')} className="h-7 w-7 p-0">
          <Trash2 className="h-3.5 w-3.5 text-destructive" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('admin.delete', 'Delete')}</DialogTitle>
          <DialogDescription>
            {t('admin.confirm_delete', { name: server.name })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="destructive" onClick={onDelete}>
            {t('admin.delete', 'Delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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

  const statusLabel =
    status === 'ok'
      ? t('filter.ok', 'healthy')
      : status === 'warn'
        ? t('filter.warn', 'warn')
        : status === 'err'
          ? t('filter.err', 'critical')
          : t('filter.offline', 'offline')

  return (
    <div className="bg-elev border rounded-lg p-3.5 hover:border-strong transition-colors cursor-pointer">
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
        <Pill kind={status === 'offline' ? 'neutral' : status}>{statusLabel}</Pill>
      </div>
      <div className="grid grid-cols-2 gap-y-2 gap-x-3.5 mt-3">
        <Stat label="CPU" v={online ? `${cpu.toFixed(1)}%` : '—'} />
        <Stat label="MEM" v={online ? `${mem.toFixed(1)}%` : '—'} />
        <Stat label="LOAD" v={online ? load.toFixed(2) : '—'} />
        <Stat label="TCP" v={online ? tcp.toLocaleString() : '—'} />
      </div>
      <div className="flex items-center gap-1 mt-3 pt-2.5 border-t border-dashed">
        <Button asChild variant="ghost" size="sm" className="h-7 px-2 text-[12px]">
          <Link to={`/admin/servers/${server.id}`}>{t('admin.details', 'Details')}</Link>
        </Button>
        <div className="ml-auto" onClick={(e) => e.stopPropagation()}>
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" aria-label={t('admin.delete', 'Delete')}>
                <Trash2 className="h-3.5 w-3.5 text-destructive" />
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t('admin.delete', 'Delete')}</DialogTitle>
                <DialogDescription>
                  {t('admin.confirm_delete', { name: server.name })}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="destructive" onClick={onDelete}>
                  {t('admin.delete', 'Delete')}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
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

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={cn(
        'font-medium text-muted-foreground text-[11px] uppercase tracking-[0.05em] px-3.5 py-2 bg-elev sticky top-0 text-left',
        className,
      )}
    >
      {children}
    </th>
  )
}

function Td({ children, className, onClick }: { children: React.ReactNode; className?: string; onClick?: React.MouseEventHandler<HTMLTableCellElement> }) {
  return <td className={cn('px-3.5 py-2.5 align-middle', className)} onClick={onClick}>{children}</td>
}
