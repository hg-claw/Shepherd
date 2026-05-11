import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useScriptRuns } from '@/api/scripts'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

export default function ScriptRunsPage() {
  const { t } = useTranslation()
  const { data, isLoading } = useScriptRuns()
  if (isLoading) return <div>{t('common.loading')}</div>
  const runs = data ?? []
  return (
    <div className="space-y-4">
      <h1 className="text-xl sm:text-2xl font-semibold">{t('scripts.runs', 'Run history')}</h1>
      <div className="rounded-md border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('scripts.run_id', 'Run #')}</TableHead>
              <TableHead className="hidden sm:table-cell">{t('scripts.script_id', 'Script')}</TableHead>
              <TableHead>{t('scripts.started_at', 'Started')}</TableHead>
              <TableHead className="hidden md:table-cell">{t('scripts.finished_at', 'Finished')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((r) => (
              <TableRow key={r.id}>
                <TableCell>
                  <Link to={`/admin/script-runs/${r.id}`} className="hover:underline font-mono">
                    #{r.id}
                  </Link>
                </TableCell>
                <TableCell className="hidden sm:table-cell">{r.script_id}</TableCell>
                <TableCell className="text-xs whitespace-nowrap">{r.started_at}</TableCell>
                <TableCell className="hidden md:table-cell text-xs whitespace-nowrap">
                  {r.finished_at ?? '-'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
