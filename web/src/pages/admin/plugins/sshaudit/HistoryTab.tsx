import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Pill } from '@/components/Pill'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell, TableEmpty } from '@/components/ui/table'
import { useServers, type ServerRecord } from '@/api/servers'
import {
  fetchSSHAuditEvents,
  fetchSSHAuditSummary,
  type SSHEvent,
  type SSHAuditWindow,
} from '@/api/sshaudit'

type ResultFilter = 'all' | 'accepted' | 'failed'

const FILTER_OPTIONS: { value: ResultFilter; key: string; fallback: string }[] = [
  { value: 'all',      key: 'all',      fallback: 'All' },
  { value: 'accepted', key: 'accepted', fallback: 'Accepted' },
  { value: 'failed',   key: 'failed',   fallback: 'Failed' },
]

const WINDOW_OPTIONS: { value: SSHAuditWindow; label: string }[] = [
  { value: '24h', label: '24h' },
  { value: '7d',  label: '7d' },
  { value: '30d', label: '30d' },
]

export default function HistoryTab() {
  const { t } = useTranslation()
  const [sp, setSP] = useSearchParams()
  const initialID = Number(sp.get('server_id') || 0) || undefined

  const { data: servers = [] } = useServers()
  const [serverID, setServerID] = useState<number | undefined>(initialID)
  const [filter, setFilter] = useState<ResultFilter>('all')
  const [window, setWindow] = useState<SSHAuditWindow>('24h')

  // Pick the first server when nothing is selected so the operator
  // doesn't see an empty page on first open.
  const effectiveID = serverID ?? (servers[0]?.id as number | undefined)

  const summaryQ = useQuery({
    queryKey: ['sshaudit', 'summary', effectiveID, window],
    queryFn: () => fetchSSHAuditSummary(effectiveID!, { window }),
    enabled: !!effectiveID,
    refetchInterval: 30_000,
  })

  const eventsQ = useQuery({
    queryKey: ['sshaudit', 'events', effectiveID, filter, window],
    queryFn: () => fetchSSHAuditEvents(effectiveID!, { result: filter, limit: 200, window }),
    enabled: !!effectiveID,
    refetchInterval: 30_000,
  })

  const events: SSHEvent[] = eventsQ.data ?? []
  const summary = summaryQ.data

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-sm text-muted-foreground">{t('sshaudit.history.server_label', 'Server')}</span>
        <Select
          value={effectiveID ? String(effectiveID) : ''}
          onValueChange={(v) => {
            const n = Number(v)
            setServerID(n)
            sp.set('server_id', String(n))
            setSP(sp, { replace: true })
          }}
        >
          <SelectTrigger className="h-8 w-64 text-sm">
            <SelectValue placeholder={t('sshaudit.history.server_placeholder', 'Pick a server')} />
          </SelectTrigger>
          <SelectContent>
            {servers.map((s: ServerRecord) => (
              <SelectItem key={s.id} value={String(s.id)} className="text-sm">
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex gap-1">
          {FILTER_OPTIONS.map((o) => (
            <Button
              key={o.value}
              size="xs"
              variant={o.value === filter ? 'default' : 'outline'}
              className="px-2.5 text-2xs"
              onClick={() => setFilter(o.value)}
            >
              {t(`sshaudit.history.filter_options.${o.key}`, o.fallback)}
            </Button>
          ))}
        </div>

        <div className="flex gap-1">
          {WINDOW_OPTIONS.map((o) => (
            <Button
              key={o.value}
              size="xs"
              variant={o.value === window ? 'default' : 'outline'}
              className="px-2.5 text-2xs"
              onClick={() => setWindow(o.value)}
            >
              {o.label}
            </Button>
          ))}
        </div>
      </div>

      {/* Summary strip */}
      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <SummaryCard
            label={t('sshaudit.history.accepted_label', 'Accepted ({{h}}h)', { h: summary.window_hours })}
            value={summary.accepted}
            tone="ok"
          />
          <SummaryCard
            label={t('sshaudit.history.failed_label', 'Failed ({{h}}h)', { h: summary.window_hours })}
            value={summary.failed}
            tone="err"
          />
          <SummaryCard label={t('sshaudit.history.unique_source_ips', 'Unique source IPs')} value={summary.unique_source_ips} />
          <div className="border rounded-md p-3 space-y-1.5">
            <div className="text-muted-foreground text-2xs uppercase tracking-[0.05em]">
              {t('sshaudit.history.top_sources', 'Top sources')}
            </div>
            {summary.top_sources.length === 0 ? (
              <div className="text-xs text-muted-foreground">—</div>
            ) : (
              summary.top_sources.slice(0, 3).map((src) => (
                <div key={src.source_ip} className="flex items-center justify-between gap-2">
                  <span className="font-mono text-2xs truncate">{src.source_ip}</span>
                  <span className="font-mono text-2xs text-muted-foreground tabular-nums">{src.count}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {summary && summary.top_failed_users.length > 0 && (
        <div className="border rounded-md p-3">
          <div className="text-muted-foreground text-2xs uppercase tracking-[0.05em] mb-2">
            {t('sshaudit.history.top_failed_usernames', 'Top failed usernames')}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {summary.top_failed_users.map((u) => (
              <Pill key={u.username} kind="warn">
                {u.username} · {u.count}
              </Pill>
            ))}
          </div>
        </div>
      )}

      {/* Events table */}
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>{t('sshaudit.history.time', 'Time')}</TableHead>
            <TableHead>{t('sshaudit.history.result', 'Result')}</TableHead>
            <TableHead>{t('sshaudit.history.username', 'Username')}</TableHead>
            <TableHead>{t('sshaudit.history.method', 'Method')}</TableHead>
            <TableHead className="font-mono">{t('sshaudit.history.source_ip', 'Source IP')}</TableHead>
            <TableHead>{t('sshaudit.history.port', 'Port')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {events.map((e) => {
            const failed = e.result === 'failed'
            return (
              <TableRow key={e.id} className={failed ? 'bg-err-soft/30 hover:bg-err-soft/30' : undefined}>
                <TableCell className="font-mono text-2xs text-muted-foreground whitespace-nowrap">
                  {e.ts ? new Date(e.ts).toLocaleString() : '—'}
                </TableCell>
                <TableCell>
                  <Pill kind={failed ? 'err' : 'ok'}>{e.result}</Pill>
                </TableCell>
                <TableCell>
                  <span className="inline-flex items-center gap-1.5">
                    <span className={e.invalid_user ? 'text-muted-foreground' : ''}>
                      {e.username || '—'}
                    </span>
                    {e.invalid_user && <Pill kind="warn">{t('sshaudit.history.invalid_user_badge', 'invalid')}</Pill>}
                  </span>
                </TableCell>
                <TableCell className="text-xs">{e.method || '—'}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{e.source_ip || '—'}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{e.port ?? '—'}</TableCell>
              </TableRow>
            )
          })}
          {events.length === 0 && !eventsQ.isLoading && (
            <TableEmpty colSpan={6}>{t('sshaudit.empty.history', 'No login events recorded yet.')}</TableEmpty>
          )}
          {eventsQ.isLoading && (
            <TableRow>
              <TableCell colSpan={6} className="py-6 text-center text-muted-foreground text-sm">
                {t('common.loading', 'Loading…')}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  )
}

function SummaryCard({ label, value, tone }: { label: string; value: number; tone?: 'ok' | 'err' }) {
  const toneClass = tone === 'ok' ? 'text-ok' : tone === 'err' ? 'text-err' : ''
  return (
    <div className="border rounded-md p-3">
      <div className="text-muted-foreground text-2xs uppercase tracking-[0.05em]">{label}</div>
      <div className={`text-title font-mono tabular-nums ${toneClass}`}>{value}</div>
    </div>
  )
}
