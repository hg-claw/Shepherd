import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useScriptRuns } from '@/api/scripts'
import { Pill } from '@/components/Pill'
import { PageHeader } from '@/components/PageHeader'
import { LoadingState } from '@/components/LoadingState'
import { EmptyState } from '@/components/EmptyState'
import { cn } from '@/lib/utils'

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
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr>
                  <th className="text-left font-medium text-muted-foreground text-2xs uppercase tracking-[0.05em] px-4 py-2 border-b">
                    {t('scripts.run_id', 'Run #')}
                  </th>
                  <th className="text-left font-medium text-muted-foreground text-2xs uppercase tracking-[0.05em] px-4 py-2 border-b hidden sm:table-cell">
                    {t('scripts.script_id', 'Script')}
                  </th>
                  <th className="text-left font-medium text-muted-foreground text-2xs uppercase tracking-[0.05em] px-4 py-2 border-b">
                    {t('scripts.status', 'Status')}
                  </th>
                  <th className="text-left font-medium text-muted-foreground text-2xs uppercase tracking-[0.05em] px-4 py-2 border-b">
                    {t('scripts.started_at', 'Started')}
                  </th>
                  <th className="text-left font-medium text-muted-foreground text-2xs uppercase tracking-[0.05em] px-4 py-2 border-b hidden md:table-cell">
                    {t('scripts.finished_at', 'Finished')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => {
                  const running = r.started_at && !r.finished_at
                  const status = running ? 'running' : 'succeeded'
                  return (
                    <tr
                      key={r.id}
                      className={cn(
                        'border-t transition-colors hover:bg-sunken/60',
                      )}
                    >
                      <td className="px-4 py-2.5">
                        <Link
                          to={`/admin/script-runs/${r.id}`}
                          className="font-mono text-foreground hover:underline"
                        >
                          #{r.id}
                        </Link>
                      </td>
                      <td className="px-4 py-2.5 hidden sm:table-cell font-mono text-fg-dim text-xs">
                        {r.script_id}
                      </td>
                      <td className="px-4 py-2.5">
                        <Pill kind={status === 'running' ? 'warn' : 'ok'}>{status}</Pill>
                      </td>
                      <td className="px-4 py-2.5 font-mono text-fg-dim text-2xs whitespace-nowrap">
                        {r.started_at}
                      </td>
                      <td className="px-4 py-2.5 hidden md:table-cell font-mono text-fg-dim text-2xs whitespace-nowrap">
                        {r.finished_at ?? '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
