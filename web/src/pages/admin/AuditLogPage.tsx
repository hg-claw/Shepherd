import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, Search } from 'lucide-react'
import { useAuditLog, type AuditRow } from '@/api/audit'
import { KpiCard } from '@/components/KpiCard'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

function rowsToCSV(rows: AuditRow[]): string {
  const headers = ['ts', 'admin_id', 'server_id', 'action', 'result', 'details']
  const lines = [headers.join(',')]
  for (const r of rows) {
    const cells = [
      r.ts,
      r.admin_id ?? '',
      r.server_id ?? '',
      r.action,
      r.result,
      JSON.stringify(r.details).replace(/,/g, ';'),
    ]
    lines.push(cells.join(','))
  }
  return lines.join('\n')
}

export default function AuditLogPage() {
  const { t } = useTranslation()
  const [action, setAction] = useState('')
  const [serverID, setServerID] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const { data, isLoading } = useAuditLog({
    action: action || undefined,
    server_id: serverID ? Number(serverID) : undefined,
    from: from || undefined,
    to: to || undefined,
  })

  const rows = data ?? []

  const handleDownloadCSV = () => {
    const csv = rowsToCSV(rows)
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `audit-${new Date().toISOString()}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const okCount = rows.filter((r) => r.result === 'ok').length
  const errCount = rows.filter((r) => r.result === 'error').length
  const uniqueAdmins = new Set(rows.map((r) => r.admin_id).filter(Boolean)).size

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight m-0">{t('audit.title', 'Audit log')}</h1>
          <p className="text-muted-foreground text-[13px] mt-1">
            {t('audit.sub', 'Every privileged operation.')}{' '}
            <span className="font-mono">30 days</span>{' '}
            {t('audit.retention_hint', 'retention · exportable as CSV.')}
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={handleDownloadCSV} className="gap-1.5">
          <Download className="h-3.5 w-3.5" />
          CSV
        </Button>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard label={t('audit.kpi.total', 'Total events')} value={String(rows.length)} sub={t('audit.kpi.in_view', 'in view')} />
        <KpiCard label={t('audit.kpi.ok', 'Succeeded')} value={String(okCount)} sub={t('audit.kpi.ok_sub', 'result ok')} tone="ok" />
        <KpiCard
          label={t('audit.kpi.errors', 'Errors')}
          value={String(errCount)}
          sub={t('audit.kpi.errors_sub', 'result error')}
          tone={errCount > 0 ? 'err' : undefined}
        />
        <KpiCard label={t('audit.kpi.admins', 'Admins')} value={String(uniqueAdmins)} sub={t('audit.kpi.admins_sub', 'unique')} />
      </div>

      {/* Filters */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-fg-dim pointer-events-none" />
          <Input
            placeholder={t('audit.action_filter', 'filter action…')}
            value={action}
            onChange={(e) => setAction(e.target.value)}
            className="pl-8 font-mono text-[12px]"
          />
        </div>
        <Input
          placeholder={t('audit.server_id_filter', 'server id')}
          value={serverID}
          onChange={(e) => setServerID(e.target.value)}
          className="font-mono text-[12px]"
        />
        <Input
          placeholder={t('audit.from', 'from (RFC3339)')}
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="font-mono text-[12px]"
        />
        <Input
          placeholder={t('audit.to', 'to (RFC3339)')}
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="font-mono text-[12px]"
        />
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="text-muted-foreground text-[13px]">{t('common.loading')}</div>
      ) : (
        <div className="border rounded-lg bg-elev overflow-hidden">
          <div className="flex items-center gap-2 px-3.5 py-2.5 border-b">
            <span className="text-foreground font-medium text-[12.5px]">
              {t('audit.events', 'Events')}
            </span>
            <span className="text-fg-dim font-mono text-[11px] ml-auto">{rows.length} rows</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px] border-collapse">
              <thead>
                <tr>
                  <th className="text-left font-medium text-muted-foreground text-[10.5px] uppercase tracking-[0.05em] px-4 py-2 border-b whitespace-nowrap">
                    {t('audit.ts', 'Time')}
                  </th>
                  <th className="text-left font-medium text-muted-foreground text-[10.5px] uppercase tracking-[0.05em] px-4 py-2 border-b">
                    {t('audit.action', 'Action')}
                  </th>
                  <th className="text-left font-medium text-muted-foreground text-[10.5px] uppercase tracking-[0.05em] px-4 py-2 border-b hidden sm:table-cell">
                    {t('audit.admin', 'Admin')}
                  </th>
                  <th className="text-left font-medium text-muted-foreground text-[10.5px] uppercase tracking-[0.05em] px-4 py-2 border-b hidden sm:table-cell">
                    {t('audit.server', 'Server')}
                  </th>
                  <th className="text-left font-medium text-muted-foreground text-[10.5px] uppercase tracking-[0.05em] px-4 py-2 border-b">
                    {t('audit.result', 'Result')}
                  </th>
                  <th className="text-left font-medium text-muted-foreground text-[10.5px] uppercase tracking-[0.05em] px-4 py-2 border-b hidden md:table-cell">
                    {t('audit.details', 'Details')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-fg-dim font-mono text-[12px]">
                      {t('audit.empty', 'no events in this range')}
                    </td>
                  </tr>
                ) : (
                  rows.map((r) => (
                    <tr
                      key={r.id}
                      className={cn(
                        'border-t transition-colors',
                        r.result === 'error'
                          ? 'bg-err-soft/20 hover:bg-err-soft/30'
                          : 'hover:bg-sunken/70',
                      )}
                    >
                      <td className="px-4 py-2 font-mono text-[11.5px] text-fg-dim whitespace-nowrap">
                        {r.ts}
                      </td>
                      <td className="px-4 py-2 font-mono text-[12px]">{r.action}</td>
                      <td className="px-4 py-2 hidden sm:table-cell font-mono text-[12px] text-fg-dim">
                        {r.admin_id ?? '—'}
                      </td>
                      <td className="px-4 py-2 hidden sm:table-cell font-mono text-[12px] text-fg-dim">
                        {r.server_id ?? '—'}
                      </td>
                      <td className="px-4 py-2">
                        <span
                          className={cn(
                            'font-mono text-[12px]',
                            r.result === 'error' ? 'text-err' : 'text-ok',
                          )}
                        >
                          {r.result}
                        </span>
                      </td>
                      <td className="px-4 py-2 hidden md:table-cell font-mono text-[11.5px] text-fg-dim max-w-md">
                        <span className="truncate block">{r.details}</span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
