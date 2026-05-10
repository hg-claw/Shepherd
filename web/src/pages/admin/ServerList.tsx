import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { Plus, Trash2 } from 'lucide-react'
import { useServers, useDeleteServer, type ServerWithLatest } from '@/api/servers'
import { useUI } from '@/store/ui'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { OnlineDot } from '@/components/OnlineDot'
import { pct } from '@/lib/bytes'
import { relativeTime } from '@/lib/time'

function isOnline(s: ServerWithLatest): boolean {
  if (!s.agent_last_seen?.Valid) return false
  return Date.now() - new Date(s.agent_last_seen.Time).getTime() <= 90 * 1000
}

export default function ServerList() {
  const { t, i18n } = useTranslation()
  const [filter, setFilter] = useState('')
  const { data, isLoading } = useServers({ withLatest: true, refetchInterval: 30_000 })
  const del = useDeleteServer()
  const toast = useUI((s) => s.toast)

  if (isLoading) return <div>{t('common.loading')}</div>
  const servers = (data ?? []).filter((s) => {
    if (!filter) return true
    const f = filter.toLowerCase()
    return s.name.toLowerCase().includes(f) || (s.ssh_host?.String ?? '').toLowerCase().includes(f)
  })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl sm:text-2xl font-semibold">{t('admin.servers')}</h1>
        <Button asChild size="sm">
          <Link to="/admin/servers/new">
            <Plus className="mr-1 h-4 w-4" />
            {t('admin.add_server')}
          </Link>
        </Button>
      </div>
      <Input
        placeholder="filter…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        className="max-w-full sm:max-w-xs"
      />
      <div className="rounded-md border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('admin.name')}</TableHead>
              <TableHead className="hidden sm:table-cell">{t('admin.host')}</TableHead>
              <TableHead className="hidden lg:table-cell">OS</TableHead>
              <TableHead className="hidden md:table-cell">Stage</TableHead>
              <TableHead className="hidden lg:table-cell">{t('admin.agent_last_seen')}</TableHead>
              <TableHead>CPU</TableHead>
              <TableHead>MEM</TableHead>
              <TableHead className="w-24 sm:w-32 text-right">{t('admin.actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {servers.map((s) => {
              const online = isOnline(s)
              const lastSeen = relativeTime(s.agent_last_seen?.Valid ? s.agent_last_seen.Time : null)
              return (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      <OnlineDot online={online} />
                      <span className="truncate max-w-[10rem] sm:max-w-none">{s.name}</span>
                    </div>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell font-mono text-xs">
                    {s.ssh_host?.String ?? '-'}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell text-xs">
                    {s.agent_os?.String ?? '-'}/{s.agent_arch?.String ?? '-'}
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <Badge variant={s.install_stage === 'failed' ? 'destructive' : 'default'}>
                      {s.install_stage}
                    </Badge>
                  </TableCell>
                  <TableCell className="hidden lg:table-cell text-xs">
                    {lastSeen ? t(lastSeen.key, { n: lastSeen.n, lng: i18n.language }) : '-'}
                  </TableCell>
                  <TableCell className="font-mono tabular-nums">
                    {s.latest?.cpu_pct != null ? `${s.latest.cpu_pct.toFixed(0)}%` : '-'}
                  </TableCell>
                  <TableCell className="font-mono tabular-nums">
                    {(() => {
                      const p = pct(s.latest?.mem_used, s.latest?.mem_total)
                      return p == null ? '-' : `${p.toFixed(0)}%`
                    })()}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    <Button asChild variant="ghost" size="sm" className="px-2">
                      <Link to={`/admin/servers/${s.id}`}>{t('admin.details')}</Link>
                    </Button>
                    <Dialog>
                      <DialogTrigger asChild>
                        <Button variant="ghost" size="sm" aria-label="delete" className="px-2">
                          <Trash2 className="h-4 w-4 text-destructive" />
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
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
