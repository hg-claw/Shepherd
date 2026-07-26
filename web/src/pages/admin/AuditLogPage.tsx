import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, Search } from 'lucide-react'
import { useAuditLog, type AuditRow } from '@/api/audit'
import { useTableSort } from '@/lib/useTableSort'
import { useVirtualRows } from '@/lib/useVirtualRows'
import { SortableTh } from '@/components/SortableTh'
import { StatCard } from '@/components/StatCard'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/PageHeader'
import { LoadingState } from '@/components/LoadingState'
import { EmptyState } from '@/components/EmptyState'

const auditSortAccessors = {
  ts: (r: AuditRow) => r.ts,
  action: (r: AuditRow) => r.action,
  result: (r: AuditRow) => r.result,
}

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
  const { sorted: sortedRows, sort: auditSort, toggle: auditToggle } = useTableSort(rows, auditSortAccessors)
  const COLS = 6
  const { parentRef, items, padTop, padBottom } = useVirtualRows(sortedRows)

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
    <div className="space-y-4">
      {/* Header */}
      <div>
        <PageHeader
          title={t('audit.title', 'Audit log')}
          actions={
            <Button size="sm" variant="outline" onClick={handleDownloadCSV} className="gap-1.5">
              <Download className="h-3.5 w-3.5" />
              CSV
            </Button>
          }
        />
        <p className="text-muted-foreground text-sm mt-1">
          {t('audit.sub', 'Every privileged operation.')}{' '}
          <span className="font-mono">30 days</span>{' '}
          {t('audit.retention_hint', 'retention · exportable as CSV.')}
        </p>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label={t('audit.kpi.total', 'Total events')} value={String(rows.length)} sub={t('audit.kpi.in_view', 'in view')} />
        <StatCard label={t('audit.kpi.ok', 'Succeeded')} value={String(okCount)} sub={t('audit.kpi.ok_sub', 'result ok')} tone="ok" />
        <StatCard
          label={t('audit.kpi.errors', 'Errors')}
          value={String(errCount)}
          sub={t('audit.kpi.errors_sub', 'result error')}
          tone={errCount > 0 ? 'err' : undefined}
        />
        <StatCard label={t('audit.kpi.admins', 'Admins')} value={String(uniqueAdmins)} sub={t('audit.kpi.admins_sub', 'unique')} />
      </div>

      {/* Filters */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-fg-dim pointer-events-none" />
          <Input
            placeholder={t('audit.action_filter', 'filter action…')}
            value={action}
            onChange={(e) => setAction(e.target.value)}
            className="pl-8 font-mono text-xs"
          />
        </div>
        <Input
          placeholder={t('audit.server_id_filter', 'server id')}
          value={serverID}
          onChange={(e) => setServerID(e.target.value)}
          className="font-mono text-xs"
        />
        <Input
          placeholder={t('audit.from', 'from (RFC3339)')}
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="font-mono text-xs"
        />
        <Input
          placeholder={t('audit.to', 'to (RFC3339)')}
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="font-mono text-xs"
        />
      </div>

      {/* Table */}
      {isLoading ? (
        <LoadingState />
      ) : (
        <div className="border rounded-lg bg-elev overflow-hidden">
          <div className="flex items-center gap-2 px-3.5 py-2.5 border-b">
            <span className="text-foreground font-medium text-sm">
              {t('audit.events', 'Events')}
            </span>
            <span className="text-fg-dim font-mono text-2xs ml-auto">{rows.length} rows</span>
          </div>
          <div ref={parentRef} className="max-h-[70vh] overflow-auto">
            <table className="w-full caption-bottom text-sm">
              <thead className="[&_tr]:border-b">
                <tr>
                  <SortableTh
                    label={t('audit.ts', 'Time')}
                    sortKey="ts"
                    sort={auditSort}
                    onToggle={auditToggle}
                    className="whitespace-nowrap"
                  />
                  <SortableTh
                    label={t('audit.action', 'Action')}
                    sortKey="action"
                    sort={auditSort}
                    onToggle={auditToggle}
                  />
                  <th className="px-3 py-2 text-left align-middle font-medium text-2xs uppercase tracking-[0.05em] text-muted-foreground hidden sm:table-cell">
                    {t('audit.admin', 'Admin')}
                  </th>
                  <th className="px-3 py-2 text-left align-middle font-medium text-2xs uppercase tracking-[0.05em] text-muted-foreground hidden sm:table-cell">
                    {t('audit.server', 'Server')}
                  </th>
                  <SortableTh
                    label={t('audit.result', 'Result')}
                    sortKey="result"
                    sort={auditSort}
                    onToggle={auditToggle}
                  />
                  <th className="px-3 py-2 text-left align-middle font-medium text-2xs uppercase tracking-[0.05em] text-muted-foreground hidden md:table-cell">
                    {t('audit.details', 'Details')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={COLS}>
                      <EmptyState title={t('audit.empty')} />
                    </td>
                  </tr>
                ) : (
                  <>
                    {padTop > 0 && <tr aria-hidden><td colSpan={COLS} style={{ height: padTop }} /></tr>}
                    {items.map((vi) => {
                      const r = sortedRows[vi.index]
                      return (
                        <tr
                          key={r.id}
                          data-index={vi.index}
                          className={cn(
                            'border-t transition-colors',
                            r.result === 'error'
                              ? 'bg-err-soft/20 hover:bg-err-soft/30'
                              : 'hover:bg-sunken/60',
                          )}
                        >
                          <td className="px-3 py-2 align-middle font-mono text-2xs text-fg-dim whitespace-nowrap">
                            {r.ts}
                          </td>
                          <td className="px-3 py-2 align-middle font-mono text-xs">{r.action}</td>
                          <td className="px-3 py-2 align-middle hidden sm:table-cell font-mono text-xs text-fg-dim">
                            {r.admin_id ?? '—'}
                          </td>
                          <td className="px-3 py-2 align-middle hidden sm:table-cell font-mono text-xs text-fg-dim">
                            {r.server_id ?? '—'}
                          </td>
                          <td className="px-3 py-2 align-middle">
                            <span
                              className={cn(
                                'font-mono text-xs',
                                r.result === 'error' ? 'text-err' : 'text-ok',
                              )}
                            >
                              {r.result}
                            </span>
                          </td>
                          <td className="px-3 py-2 align-middle hidden md:table-cell font-mono text-2xs text-fg-dim max-w-md">
                            <span className="truncate block">{r.details}</span>
                          </td>
                        </tr>
                      )
                    })}
                    {padBottom > 0 && <tr aria-hidden><td colSpan={COLS} style={{ height: padBottom }} /></tr>}
                  </>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
