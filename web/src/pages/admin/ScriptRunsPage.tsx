import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useScriptRuns } from '@/api/scripts'
import { Pill } from '@/components/Pill'
import { PageHeader } from '@/components/PageHeader'
import { LoadingState } from '@/components/LoadingState'
import { EmptyState } from '@/components/EmptyState'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'

export default function ScriptRunsPage() {
  const { t } = useTranslation()
  const { data, isLoading } = useScriptRuns()
  if (isLoading) return <LoadingState />
  const runs = data ?? []

  return (
    <div className="space-y-4">
      {/* Header */}
      <div>
        <PageHeader title={t('scripts.runs', 'Run history')} />
        <p className="text-muted-foreground text-sm mt-1">
          {t('scripts.runs_sub', 'All script executions across all hosts.')}
        </p>
      </div>

      <div className="border rounded-lg bg-elev overflow-hidden">
        <div className="flex items-center gap-2 px-3.5 py-2.5 border-b">
          <span className="text-foreground font-medium text-sm">
            {t('scripts.runs', 'Runs')}
          </span>
          <span className="text-fg-dim font-mono text-2xs ml-auto">{runs.length} total</span>
        </div>

        {runs.length === 0 ? (
          <EmptyState title={t('scripts.no_runs', 'no runs yet')} />
        ) : (
          <Table wrapperClassName="border-0 rounded-none bg-transparent">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t('scripts.run_id', 'Run #')}</TableHead>
                <TableHead className="hidden sm:table-cell">{t('scripts.script_id', 'Script')}</TableHead>
                <TableHead>{t('scripts.status', 'Status')}</TableHead>
                <TableHead>{t('scripts.started_at', 'Started')}</TableHead>
                <TableHead className="hidden md:table-cell">{t('scripts.finished_at', 'Finished')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((r) => {
                const running = r.started_at && !r.finished_at
                const status = running ? 'running' : 'succeeded'
                return (
                  <TableRow key={r.id}>
                    <TableCell>
                      <Link
                        to={`/admin/script-runs/${r.id}`}
                        className="font-mono text-foreground hover:underline"
                      >
                        #{r.id}
                      </Link>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell font-mono text-fg-dim text-xs">
                      {r.script_id}
                    </TableCell>
                    <TableCell>
                      <Pill kind={status === 'running' ? 'warn' : 'ok'}>{status}</Pill>
                    </TableCell>
                    <TableCell className="font-mono text-fg-dim text-2xs whitespace-nowrap">
                      {r.started_at}
                    </TableCell>
                    <TableCell className="hidden md:table-cell font-mono text-fg-dim text-2xs whitespace-nowrap">
                      {r.finished_at ?? '—'}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  )
}
