import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { Plus, Search, Trash2, Play, ChevronRight, ChevronDown } from 'lucide-react'
import { useScripts, useDeleteScript, useScriptRuns } from '@/api/scripts'
import { KpiCard } from '@/components/KpiCard'
import { Pill } from '@/components/Pill'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

function statusKind(s?: string | null): 'ok' | 'warn' | 'err' | 'neutral' {
  if (s === 'succeeded') return 'ok'
  if (s === 'failed') return 'err'
  if (s === 'running') return 'warn'
  return 'neutral'
}

export default function ScriptsListPage() {
  const { t } = useTranslation()
  const { data, isLoading } = useScripts()
  const { data: runsData } = useScriptRuns()
  const del = useDeleteScript()
  const [filter, setFilter] = useState('')
  const [expandedRunId, setExpandedRunId] = useState<number | null>(null)

  if (isLoading) return <div className="text-muted-foreground text-[13px] p-4">{t('common.loading')}</div>

  const scripts = data ?? []
  const runs = runsData ?? []

  // KPI calculations
  const now = Date.now()
  const oneDayMs = 24 * 60 * 60 * 1000
  const runsToday = runs.filter((r) => {
    if (!r.started_at) return false
    return now - new Date(r.started_at).getTime() < oneDayMs
  })
  const successToday = runsToday.filter((r) => r.finished_at).length
  const activeRuns = runs.filter((r) => r.started_at && !r.finished_at).length

  const filtered = scripts.filter((s) => {
    if (!filter) return true
    const f = filter.toLowerCase()
    return s.name.toLowerCase().includes(f) || s.description.toLowerCase().includes(f)
  })

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight m-0">
            {t('scripts.title', 'Scripts')}
          </h1>
          <p className="text-muted-foreground text-[13px] mt-1 max-w-2xl">
            {t(
              'scripts.sub',
              'Library of batch commands. Run on any subset of hosts — every run records per-host output and exit codes.',
            )}
          </p>
        </div>
        <Button asChild size="sm">
          <Link to="/admin/scripts/new">
            <Plus className="h-3.5 w-3.5 mr-1" />
            {t('scripts.new', 'New command')}
          </Link>
        </Button>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard
          label={t('scripts.kpi.commands', 'Commands')}
          value={String(scripts.length)}
          sub={t('scripts.kpi.in_library', 'in library')}
        />
        <KpiCard
          label={t('scripts.kpi.runs_today', 'Runs today')}
          value={String(runsToday.length)}
          sub={t('scripts.kpi.last_24h', 'last 24h')}
        />
        <KpiCard
          label={t('scripts.kpi.success_rate', 'Success rate')}
          value={runsToday.length > 0 ? `${((successToday / runsToday.length) * 100).toFixed(1)}%` : '—'}
          sub={runsToday.length > 0 ? `${runsToday.length - successToday} errored` : 'no runs'}
          tone={runsToday.length > 0 && successToday === runsToday.length ? 'ok' : undefined}
        />
        <KpiCard
          label={t('scripts.kpi.active_runs', 'Active runs')}
          value={String(activeRuns)}
          sub={activeRuns > 0 ? t('scripts.kpi.in_progress', 'in progress') : t('scripts.kpi.idle', 'idle')}
          tone={activeRuns > 0 ? 'warn' : undefined}
        />
      </div>

      {/* Library table */}
      <div className="border rounded-lg bg-elev overflow-hidden">
        {/* Card head */}
        <div className="flex items-center gap-2 px-3.5 py-2.5 border-b">
          <span className="text-foreground font-medium text-[12.5px]">
            {t('scripts.library', 'Library')}
          </span>
          <span className="text-muted-foreground font-mono text-[11px] ml-auto">
            {scripts.length} {t('scripts.commands', 'commands')}
          </span>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-fg-dim pointer-events-none" />
            <Input
              placeholder={t('common.filter', 'filter…')}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="pl-6 h-7 w-48 text-[12px] font-mono"
            />
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="px-4 py-8 text-center text-fg-dim font-mono text-[12px]">
            {filter ? t('scripts.no_match', 'no matching commands') : t('scripts.empty', 'no scripts yet')}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px] border-collapse">
              <thead>
                <tr>
                  <th className="text-left font-medium text-muted-foreground text-[10.5px] uppercase tracking-[0.05em] px-4 py-2 border-b">
                    {t('scripts.name', 'Name')}
                  </th>
                  <th className="text-left font-medium text-muted-foreground text-[10.5px] uppercase tracking-[0.05em] px-4 py-2 border-b hidden md:table-cell">
                    {t('scripts.description', 'Description')}
                  </th>
                  <th className="text-left font-medium text-muted-foreground text-[10.5px] uppercase tracking-[0.05em] px-4 py-2 border-b hidden sm:table-cell">
                    {t('scripts.params', 'Params')}
                  </th>
                  <th className="text-left font-medium text-muted-foreground text-[10.5px] uppercase tracking-[0.05em] px-4 py-2 border-b hidden lg:table-cell">
                    {t('scripts.last_run', 'Last run')}
                  </th>
                  <th className="text-right font-medium text-muted-foreground text-[10.5px] uppercase tracking-[0.05em] px-4 py-2 border-b">
                    {t('admin.actions', 'Actions')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((s) => {
                  const paramCount = s.params?.length ?? 0
                  // Find most recent run for this script
                  const lastRun = runs
                    .filter((r) => r.script_id === s.id)
                    .sort((a, b) => {
                      const ta = a.started_at ? new Date(a.started_at).getTime() : 0
                      const tb = b.started_at ? new Date(b.started_at).getTime() : 0
                      return tb - ta
                    })[0]
                  const lastStatus = lastRun
                    ? lastRun.finished_at
                      ? 'succeeded'
                      : 'running'
                    : null
                  return (
                    <tr key={s.id} className="border-t hover:bg-sunken/70 transition-colors">
                      <td className="px-4 py-2.5">
                        <Link
                          to={`/admin/scripts/${s.id}`}
                          className="font-mono font-medium text-foreground hover:underline text-[13px]"
                        >
                          {s.name}
                        </Link>
                      </td>
                      <td className="px-4 py-2.5 hidden md:table-cell">
                        <span className="text-muted-foreground text-[12px] truncate max-w-xs block">
                          {s.description}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 hidden sm:table-cell">
                        <div className="flex items-center gap-1 flex-wrap">
                          {paramCount === 0 ? (
                            <span className="text-fg-dim font-mono text-[11px]">none</span>
                          ) : (
                            s.params?.map((p) => (
                              <span
                                key={p.name}
                                className={cn(
                                  'inline-flex items-center h-5 px-1.5 rounded text-[10.5px] font-mono border',
                                  p.required
                                    ? 'bg-accent/20 border-accent/40 text-accent-foreground'
                                    : 'bg-sunken border-border text-fg-dim',
                                )}
                              >
                                {p.name}
                                {p.required && (
                                  <span className="text-err ml-0.5 text-[10px]">*</span>
                                )}
                              </span>
                            ))
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 hidden lg:table-cell">
                        {lastStatus ? (
                          <Pill kind={statusKind(lastStatus)}>{lastStatus}</Pill>
                        ) : (
                          <span className="text-fg-dim font-mono text-[11px]">never</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right whitespace-nowrap">
                        <Button variant="ghost" size="sm" asChild className="h-7 px-2 text-[12px]">
                          <Link to={`/admin/scripts/${s.id}/run`}>
                            <Play className="h-3 w-3 mr-1" />
                            {t('scripts.run', 'Run')}
                          </Link>
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => del.mutate(s.id)}
                          disabled={del.isPending}
                          className="h-7 w-7 p-0"
                          aria-label="delete"
                        >
                          <Trash2 className="h-3.5 w-3.5 text-destructive" />
                        </Button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Recent runs */}
      <div className="border rounded-lg bg-elev overflow-hidden">
        <div className="flex items-center gap-2 px-3.5 py-2.5 border-b">
          <span className="text-foreground font-medium text-[12.5px]">
            {t('scripts.recent_runs', 'Recent runs')}
          </span>
          <span className="text-fg-dim font-mono text-[11px]">· last 30 days</span>
          <Button asChild size="sm" variant="ghost" className="ml-auto h-6 px-2 text-[12px]">
            <Link to="/admin/script-runs">{t('scripts.view_all', 'View all')}</Link>
          </Button>
        </div>
        {runs.length === 0 ? (
          <div className="px-4 py-6 text-center text-fg-dim font-mono text-[12px]">
            {t('scripts.no_runs', 'no runs yet')}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px] border-collapse">
              <thead>
                <tr>
                  <th className="text-left font-medium text-muted-foreground text-[10.5px] uppercase tracking-[0.05em] px-4 py-2 border-b w-8" />
                  <th className="text-left font-medium text-muted-foreground text-[10.5px] uppercase tracking-[0.05em] px-4 py-2 border-b">
                    {t('scripts.run_id', 'Run #')}
                  </th>
                  <th className="text-left font-medium text-muted-foreground text-[10.5px] uppercase tracking-[0.05em] px-4 py-2 border-b hidden sm:table-cell">
                    {t('scripts.script_id', 'Script')}
                  </th>
                  <th className="text-left font-medium text-muted-foreground text-[10.5px] uppercase tracking-[0.05em] px-4 py-2 border-b">
                    {t('scripts.status', 'Status')}
                  </th>
                  <th className="text-left font-medium text-muted-foreground text-[10.5px] uppercase tracking-[0.05em] px-4 py-2 border-b">
                    {t('scripts.started_at', 'Started')}
                  </th>
                  <th className="text-left font-medium text-muted-foreground text-[10.5px] uppercase tracking-[0.05em] px-4 py-2 border-b hidden md:table-cell">
                    {t('scripts.finished_at', 'Finished')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {runs.slice(0, 8).map((r) => {
                  const runStatus = r.finished_at ? 'succeeded' : 'running'
                  const isExpanded = expandedRunId === r.id
                  return (
                    <tr
                      key={r.id}
                      className={cn('border-t transition-colors', isExpanded ? 'bg-sunken/50' : 'hover:bg-sunken/40 cursor-pointer')}
                      onClick={() => setExpandedRunId(isExpanded ? null : r.id)}
                    >
                      <td className="px-4 py-2 w-8">
                        {isExpanded
                          ? <ChevronDown className="h-3.5 w-3.5 text-fg-dim" />
                          : <ChevronRight className="h-3.5 w-3.5 text-fg-dim" />}
                      </td>
                      <td className="px-4 py-2">
                        <Link
                          to={`/admin/script-runs/${r.id}`}
                          className="font-mono text-foreground hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          #{r.id}
                        </Link>
                      </td>
                      <td className="px-4 py-2 hidden sm:table-cell font-mono text-fg-dim text-[12px]">
                        {r.script_id}
                      </td>
                      <td className="px-4 py-2">
                        <Pill kind={statusKind(runStatus)}>{runStatus}</Pill>
                      </td>
                      <td className="px-4 py-2 font-mono text-fg-dim text-[11.5px] whitespace-nowrap">
                        {r.started_at}
                      </td>
                      <td className="px-4 py-2 hidden md:table-cell font-mono text-fg-dim text-[11.5px] whitespace-nowrap">
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
