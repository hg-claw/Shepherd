import { Fragment, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { Plus, Search, Trash2, Play, ChevronRight, ChevronDown } from 'lucide-react'
import { useScripts, useDeleteScript, useScriptRuns, useScriptRunDetail, type Script } from '@/api/scripts'
import { useTableSort } from '@/lib/useTableSort'
import { SortableTh } from '@/components/SortableTh'
import { useServers } from '@/api/servers'
import { StatCard } from '@/components/StatCard'
import { Pill } from '@/components/Pill'
import { RunLogDialog } from '@/components/RunLogDialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/PageHeader'
import { LoadingState } from '@/components/LoadingState'
import { EmptyState } from '@/components/EmptyState'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { cn } from '@/lib/utils'

const scriptSortAccessors = {
  name: (s: Script) => s.name,
  description: (s: Script) => s.description,
}

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
  const { data: serversData } = useServers()
  const del = useDeleteScript()
  const [filter, setFilter] = useState('')
  const [expandedRunId, setExpandedRunId] = useState<number | null>(null)
  const [pendingDeleteScript, setPendingDeleteScript] = useState<Script | null>(null)

  const serverName = (id: number) =>
    serversData?.find((s) => s.id === id)?.name ?? `#${id}`

  const scripts = data ?? []
  const filteredLib = useMemo(
    () =>
      scripts.filter((s) => {
        if (!filter) return true
        const f = filter.toLowerCase()
        return s.name.toLowerCase().includes(f) || s.description.toLowerCase().includes(f)
      }),
    [scripts, filter],
  )
  const { sorted: sortedLib, sort: scriptSort, toggle: scriptToggle } = useTableSort(
    filteredLib,
    scriptSortAccessors,
  )

  if (isLoading) return <LoadingState />

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

  return (
    <div className="space-y-4">
      {/* Header */}
      <div>
        <PageHeader
          title={t('scripts.title', 'Scripts')}
          actions={
            <Button asChild size="sm">
              <Link to="/admin/scripts/new">
                <Plus className="h-3.5 w-3.5 mr-1" />
                {t('scripts.new', 'New command')}
              </Link>
            </Button>
          }
        />
        <p className="text-muted-foreground text-sm mt-1 max-w-2xl">
          {t(
            'scripts.sub',
            'Library of batch commands. Run on any subset of hosts — every run records per-host output and exit codes.',
          )}
        </p>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          label={t('scripts.kpi.commands', 'Commands')}
          value={String(scripts.length)}
          sub={t('scripts.kpi.in_library', 'in library')}
        />
        <StatCard
          label={t('scripts.kpi.runs_today', 'Runs today')}
          value={String(runsToday.length)}
          sub={t('scripts.kpi.last_24h', 'last 24h')}
        />
        <StatCard
          label={t('scripts.kpi.success_rate', 'Success rate')}
          value={runsToday.length > 0 ? `${((successToday / runsToday.length) * 100).toFixed(1)}%` : '—'}
          sub={runsToday.length > 0 ? `${runsToday.length - successToday} errored` : 'no runs'}
          tone={runsToday.length > 0 && successToday === runsToday.length ? 'ok' : undefined}
        />
        <StatCard
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
          <span className="text-foreground font-medium text-sm">
            {t('scripts.library', 'Library')}
          </span>
          <span className="text-muted-foreground font-mono text-2xs ml-auto">
            {scripts.length} {t('scripts.commands', 'commands')}
          </span>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-fg-dim pointer-events-none" />
            <Input
              placeholder={t('common.filter', 'filter…')}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="pl-6 h-7 w-48 text-xs font-mono"
            />
          </div>
        </div>

        {sortedLib.length === 0 ? (
          scripts.length === 0 ? (
            <EmptyState
              title={t('scripts.empty')}
              action={
                <Button asChild className="h-8">
                  <Link to="/admin/scripts/new">
                    <Plus className="h-3.5 w-3.5 mr-1" />
                    {t('scripts.new')}
                  </Link>
                </Button>
              }
            />
          ) : (
            <EmptyState
              title={t('common.no_results')}
              action={
                <Button variant="outline" className="h-7" onClick={() => setFilter('')}>
                  {t('common.clear_filter')}
                </Button>
              }
            />
          )
        ) : (
          <Table wrapperClassName="border-0 rounded-none bg-transparent">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <SortableTh
                  label={t('scripts.name', 'Name')}
                  sortKey="name"
                  sort={scriptSort}
                  onToggle={scriptToggle}
                />
                <SortableTh
                  label={t('scripts.description', 'Description')}
                  sortKey="description"
                  sort={scriptSort}
                  onToggle={scriptToggle}
                  className="hidden md:table-cell"
                />
                <TableHead className="hidden sm:table-cell">{t('scripts.params', 'Params')}</TableHead>
                <TableHead className="hidden lg:table-cell">{t('scripts.last_run', 'Last run')}</TableHead>
                <TableHead className="text-right">{t('admin.actions', 'Actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedLib.map((s) => {
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
                  <TableRow key={s.id}>
                    <TableCell>
                      <Link
                        to={`/admin/scripts/${s.id}`}
                        className="font-mono font-medium text-foreground hover:underline text-sm"
                      >
                        {s.name}
                      </Link>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <span className="text-muted-foreground text-xs truncate max-w-xs block">
                        {s.description}
                      </span>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <div className="flex items-center gap-1 flex-wrap">
                        {paramCount === 0 ? (
                          <span className="text-fg-dim font-mono text-2xs">none</span>
                        ) : (
                          s.params?.map((p) => (
                            <span
                              key={p.name}
                              className={cn(
                                'inline-flex items-center h-5 px-1.5 rounded text-2xs font-mono border',
                                p.required
                                  ? 'bg-accent/20 border-accent/40 text-accent-foreground'
                                  : 'bg-sunken border-border text-fg-dim',
                              )}
                            >
                              {p.name}
                              {p.required && (
                                <span className="text-err ml-0.5 text-2xs">*</span>
                              )}
                            </span>
                          ))
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      {lastStatus ? (
                        <Pill kind={statusKind(lastStatus)}>{lastStatus}</Pill>
                      ) : (
                        <span className="text-fg-dim font-mono text-2xs">never</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <Button variant="ghost" size="xs" asChild>
                        <Link to={`/admin/scripts/${s.id}/run`}>
                          <Play className="h-3 w-3 mr-1" />
                          {t('scripts.run', 'Run')}
                        </Link>
                      </Button>
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => setPendingDeleteScript(s)}
                        disabled={del.isPending}
                        className="w-7 p-0"
                        aria-label="delete"
                      >
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </div>

      <ConfirmDialog
        open={pendingDeleteScript != null}
        onOpenChange={(open) => { if (!open) setPendingDeleteScript(null) }}
        title={t('scripts.delete_script')}
        description={t('scripts.delete_script_confirm', { name: pendingDeleteScript?.name ?? '' })}
        onConfirm={() => { if (pendingDeleteScript) del.mutate(pendingDeleteScript.id) }}
      />

      {/* Recent runs */}
      <div className="border rounded-lg bg-elev overflow-hidden">
        <div className="flex items-center gap-2 px-3.5 py-2.5 border-b">
          <span className="text-foreground font-medium text-sm">
            {t('scripts.recent_runs', 'Recent runs')}
          </span>
          <span className="text-fg-dim font-mono text-2xs">· last 30 days</span>
          <Button asChild size="xs" variant="ghost" className="ml-auto">
            <Link to="/admin/script-runs">{t('scripts.view_all', 'View all')}</Link>
          </Button>
        </div>
        {runs.length === 0 ? (
          <EmptyState title={t('scripts.no_runs', 'no runs yet')} />
        ) : (
          <Table wrapperClassName="border-0 rounded-none bg-transparent">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-8" />
                <TableHead>{t('scripts.run_id', 'Run #')}</TableHead>
                <TableHead className="hidden sm:table-cell">{t('scripts.script_id', 'Script')}</TableHead>
                <TableHead>{t('scripts.status', 'Status')}</TableHead>
                <TableHead>{t('scripts.started_at', 'Started')}</TableHead>
                <TableHead className="hidden md:table-cell">{t('scripts.finished_at', 'Finished')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.slice(0, 8).map((r) => {
                const runStatus = r.finished_at ? 'succeeded' : 'running'
                const isExpanded = expandedRunId === r.id
                return (
                  <Fragment key={r.id}>
                    <TableRow
                      className={cn(isExpanded ? 'bg-sunken/50 hover:bg-sunken/50' : 'hover:bg-sunken/40 cursor-pointer')}
                      onClick={() => setExpandedRunId(isExpanded ? null : r.id)}
                    >
                      <TableCell className="w-8">
                        {isExpanded
                          ? <ChevronDown className="h-3.5 w-3.5 text-fg-dim" />
                          : <ChevronRight className="h-3.5 w-3.5 text-fg-dim" />}
                      </TableCell>
                      <TableCell>
                        <Link
                          to={`/admin/script-runs/${r.id}`}
                          className="font-mono text-foreground hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          #{r.id}
                        </Link>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell font-mono text-fg-dim text-xs">
                        {r.script_id}
                      </TableCell>
                      <TableCell>
                        <Pill kind={statusKind(runStatus)}>{runStatus}</Pill>
                      </TableCell>
                      <TableCell className="font-mono text-fg-dim text-2xs whitespace-nowrap">
                        {r.started_at}
                      </TableCell>
                      <TableCell className="hidden md:table-cell font-mono text-fg-dim text-2xs whitespace-nowrap">
                        {r.finished_at ?? '—'}
                      </TableCell>
                    </TableRow>
                    {isExpanded && (
                      <TableRow className="bg-sunken/30 hover:bg-sunken/30">
                        <TableCell colSpan={6}>
                          <ExpandedRunTargets runId={r.id} running={!r.finished_at} serverName={serverName} t={t} />
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                )
              })}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  )
}

// ExpandedRunTargets shows the per-server results for one run inline when
// its row is expanded. Fetches GET /api/admin/script-runs/{id}; polls
// while the run is still in flight so live runs fill in as agents report.
function ExpandedRunTargets({
  runId,
  running,
  serverName,
  t,
}: {
  runId: number
  running: boolean
  serverName: (id: number) => string
  t: (k: string, opts?: any) => string
}) {
  const { data, isLoading } = useScriptRunDetail(runId, running ? 2000 : undefined)
  const targets = data ?? []

  if (isLoading) {
    return <div className="text-fg-dim text-xs py-1">{t('common.loading', 'Loading…')}</div>
  }
  if (targets.length === 0) {
    return <div className="text-fg-dim text-xs py-1">{t('scripts.no_targets', 'No targets recorded for this run.')}</div>
  }
  return (
    <div className="space-y-1">
      {targets.map((tgt) => (
        <div key={tgt.id} className="flex items-center gap-3 text-xs">
          <Pill kind={statusKind(tgt.status)}>{tgt.status}</Pill>
          <span className="font-mono text-foreground">{serverName(tgt.server_id)}</span>
          <span className="font-mono text-fg-dim tabular-nums">
            {t('scripts.exit', 'exit')} {tgt.exit_code ?? '—'}
          </span>
          <span className="ml-auto">
            <RunLogDialog
              ptySessionId={tgt.pty_session_id}
              running={tgt.status === 'running'}
              triggerClassName={cn(
                'text-xs hover:underline',
                tgt.status === 'failed' ? 'text-err' : 'text-muted-foreground',
              )}
              title={`${t('scripts.execution_log', 'Execution log')} · ${serverName(tgt.server_id)}`}
            />
          </span>
        </div>
      ))}
      <Link
        to={`/admin/script-runs/${runId}`}
        className="inline-block text-xs text-muted-foreground hover:underline pt-1"
        onClick={(e) => e.stopPropagation()}
      >
        {t('scripts.view_run_detail', 'Open full run detail →')}
      </Link>
    </div>
  )
}
