import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { Plus, Trash2 } from 'lucide-react'
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

function isOnline(s: ServerWithLatest): boolean {
  if (!s.agent_last_seen?.Valid) return false
  return Date.now() - new Date(s.agent_last_seen.Time).getTime() <= 90 * 1000
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

export default function ServerList() {
  const { t, i18n } = useTranslation()
  const [filter, setFilter] = useState('')
  const { data, isLoading } = useServers({ withLatest: true, refetchInterval: 30_000 })
  const del = useDeleteServer()
  const toast = useUI((s) => s.toast)

  if (isLoading) return <div className="text-muted-foreground">{t('common.loading')}</div>
  const servers = (data ?? []).filter((s) => {
    if (!filter) return true
    const f = filter.toLowerCase()
    return s.name.toLowerCase().includes(f) || (s.ssh_host?.String ?? '').toLowerCase().includes(f)
  })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight m-0">{t('admin.servers')}</h1>
          <p className="text-muted-foreground text-[13px] mt-1">{servers.length} hosts</p>
        </div>
        <Button asChild size="sm" className="h-8">
          <Link to="/admin/servers/new">
            <Plus className="mr-1 h-3.5 w-3.5" />
            {t('admin.add_server')}
          </Link>
        </Button>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <Input
          placeholder={t('common.filter', 'Filter…')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="max-w-full sm:max-w-[260px] h-8 text-[13px]"
        />
      </div>
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
