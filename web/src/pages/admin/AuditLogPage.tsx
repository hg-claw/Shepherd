import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download } from 'lucide-react'
import { useAuditLog, type AuditRow } from '@/api/audit'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'

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

  const handleDownloadCSV = () => {
    const csv = rowsToCSV(data ?? [])
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `audit-${new Date().toISOString()}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl sm:text-2xl font-semibold">{t('audit.title')}</h1>
        <Button size="sm" variant="outline" onClick={handleDownloadCSV}>
          <Download className="h-4 w-4 mr-1" />
          CSV
        </Button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
        <Input
          placeholder={t('audit.action_filter')}
          value={action}
          onChange={(e) => setAction(e.target.value)}
        />
        <Input
          placeholder={t('audit.server_id_filter')}
          value={serverID}
          onChange={(e) => setServerID(e.target.value)}
        />
        <Input
          placeholder={t('audit.from')}
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <Input
          placeholder={t('audit.to')}
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
      </div>
      {isLoading ? (
        <div>{t('common.loading')}</div>
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('audit.ts')}</TableHead>
                <TableHead>{t('audit.action')}</TableHead>
                <TableHead className="hidden sm:table-cell">{t('audit.admin')}</TableHead>
                <TableHead className="hidden sm:table-cell">{t('audit.server')}</TableHead>
                <TableHead>{t('audit.result')}</TableHead>
                <TableHead className="hidden md:table-cell">{t('audit.details')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data ?? []).map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs whitespace-nowrap">{r.ts}</TableCell>
                  <TableCell className="font-mono text-xs">{r.action}</TableCell>
                  <TableCell className="hidden sm:table-cell">{r.admin_id ?? '-'}</TableCell>
                  <TableCell className="hidden sm:table-cell">{r.server_id ?? '-'}</TableCell>
                  <TableCell className={r.result === 'error' ? 'text-destructive' : ''}>
                    {r.result}
                  </TableCell>
                  <TableCell className="hidden md:table-cell font-mono text-xs max-w-md truncate">
                    {r.details}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
