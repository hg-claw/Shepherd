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
      <h1 className="text-2xl font-semibold">{t('scripts.runs', 'Run history')}</h1>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('scripts.run_id', 'Run #')}</TableHead>
            <TableHead>{t('scripts.script_id', 'Script')}</TableHead>
            <TableHead>{t('scripts.started_at', 'Started')}</TableHead>
            <TableHead>{t('scripts.finished_at', 'Finished')}</TableHead>
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
              <TableCell>{r.script_id}</TableCell>
              <TableCell className="text-xs">{r.started_at}</TableCell>
              <TableCell className="text-xs">{r.finished_at ?? '-'}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
