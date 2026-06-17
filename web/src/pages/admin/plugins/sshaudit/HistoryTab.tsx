import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Pill } from '@/components/Pill'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { useServers, type ServerRecord } from '@/api/servers'
import {
  fetchSSHAuditEvents,
  fetchSSHAuditSummary,
  type SSHEvent,
  type SSHAuditWindow,
} from '@/api/sshaudit'

type ResultFilter = 'all' | 'accepted' | 'failed'

const FILTER_OPTIONS: { value: ResultFilter; label: string }[] = [
  { value: 'all',      label: 'All' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'failed',   label: 'Failed' },
]

const WINDOW_OPTIONS: { value: SSHAuditWindow; label: string }[] = [
  { value: '24h', label: '24h' },
  { value: '7d',  label: '7d' },
  { value: '30d', label: '30d' },
]

export default function HistoryTab() {
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
        <span className="text-[12.5px] text-muted-foreground">Server</span>
        <Select
          value={effectiveID ? String(effectiveID) : ''}
          onValueChange={(v) => {
            const n = Number(v)
            setServerID(n)
            sp.set('server_id', String(n))
            setSP(sp, { replace: true })
          }}
        >
          <SelectTrigger className="h-8 w-64 text-[12.5px]">
            <SelectValue placeholder="Pick a server" />
          </SelectTrigger>
          <SelectContent>
            {servers.map((s: ServerRecord) => (
              <SelectItem key={s.id} value={String(s.id)} className="text-[12.5px]">
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex gap-1">
          {FILTER_OPTIONS.map((o) => (
            <Button
              key={o.value}
              size="sm"
              variant={o.value === filter ? 'default' : 'outline'}
              className="h-7 px-2.5 text-[11.5px]"
              onClick={() => setFilter(o.value)}
            >
              {o.label}
            </Button>
          ))}
        </div>

        <div className="flex gap-1">
          {WINDOW_OPTIONS.map((o) => (
            <Button
              key={o.value}
              size="sm"
              variant={o.value === window ? 'default' : 'outline'}
              className="h-7 px-2.5 text-[11.5px]"
              onClick={() => setWindow(o.value)}
            >
              {o.label}
            </Button>
          ))}
        </div>
      </div>

      {/* Summary strip */}
      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-[12.5px]">
          <SummaryCard label={`Accepted (${summary.window_hours}h)`} value={summary.accepted} tone="ok" />
          <SummaryCard label={`Failed (${summary.window_hours}h)`} value={summary.failed} tone="err" />
          <SummaryCard label="Unique source IPs" value={summary.unique_source_ips} />
          <div className="border rounded-md p-3 space-y-1.5">
            <div className="text-muted-foreground text-[11px] uppercase tracking-wide">Top sources</div>
            {summary.top_sources.length === 0 ? (
              <div className="text-[12px] text-muted-foreground">—</div>
            ) : (
              summary.top_sources.slice(0, 3).map((t) => (
                <div key={t.source_ip} className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[11.5px] truncate">{t.source_ip}</span>
                  <span className="font-mono text-[11.5px] text-muted-foreground tabular-nums">{t.count}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {summary && summary.top_failed_users.length > 0 && (
        <div className="border rounded-md p-3">
          <div className="text-muted-foreground text-[11px] uppercase tracking-wide mb-2">
            Top failed usernames
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
      <div className="border rounded-md overflow-hidden">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b text-[11px] text-muted-foreground uppercase tracking-wide">
              <th className="text-left py-2 pl-3 pr-4 font-medium">Time</th>
              <th className="text-left py-2 pr-4 font-medium">Result</th>
              <th className="text-left py-2 pr-4 font-medium">Username</th>
              <th className="text-left py-2 pr-4 font-medium">Method</th>
              <th className="text-left py-2 pr-4 font-medium font-mono">Source IP</th>
              <th className="text-left py-2 pr-3 font-medium">Port</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => {
              const failed = e.result === 'failed'
              return (
                <tr
                  key={e.id}
                  className={`border-b last:border-0 ${failed ? 'bg-err-soft/30' : ''}`}
                >
                  <td className="py-2 pl-3 pr-4 font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                    {e.ts ? new Date(e.ts).toLocaleString() : '—'}
                  </td>
                  <td className="py-2 pr-4">
                    <Pill kind={failed ? 'err' : 'ok'}>{e.result}</Pill>
                  </td>
                  <td className="py-2 pr-4">
                    <span className="inline-flex items-center gap-1.5">
                      <span className={e.invalid_user ? 'text-muted-foreground' : ''}>
                        {e.username || '—'}
                      </span>
                      {e.invalid_user && <Pill kind="warn">invalid</Pill>}
                    </span>
                  </td>
                  <td className="py-2 pr-4 text-[12px]">{e.method || '—'}</td>
                  <td className="py-2 pr-4 font-mono text-[12px] text-muted-foreground">{e.source_ip || '—'}</td>
                  <td className="py-2 pr-3 font-mono text-[12px] text-muted-foreground">{e.port ?? '—'}</td>
                </tr>
              )
            })}
            {events.length === 0 && !eventsQ.isLoading && (
              <tr>
                <td colSpan={6} className="py-6 text-center text-muted-foreground text-[13px]">
                  No login events recorded yet.
                </td>
              </tr>
            )}
            {eventsQ.isLoading && (
              <tr>
                <td colSpan={6} className="py-6 text-center text-muted-foreground text-[13px]">
                  Loading…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function SummaryCard({ label, value, tone }: { label: string; value: number; tone?: 'ok' | 'err' }) {
  const toneClass = tone === 'ok' ? 'text-ok' : tone === 'err' ? 'text-err' : ''
  return (
    <div className="border rounded-md p-3">
      <div className="text-muted-foreground text-[11px] uppercase tracking-wide">{label}</div>
      <div className={`text-[20px] font-mono tabular-nums ${toneClass}`}>{value}</div>
    </div>
  )
}
