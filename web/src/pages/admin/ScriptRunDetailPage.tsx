import { Link, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Terminal, PlayCircle, AlertTriangle } from 'lucide-react'
import { useScriptRunDetail } from '@/api/scripts'
import { useServers } from '@/api/servers'
import { openConsole } from '@/api/console'
import { useConsoleTabs } from '@/store/consoleTabs'
import { Button } from '@/components/ui/button'
import { Pill, type PillKind } from '@/components/Pill'
import { OnlineDot } from '@/components/OnlineDot'
import { cn } from '@/lib/utils'

function statusKind(s: string): PillKind {
  if (s === 'succeeded') return 'ok'
  if (s === 'failed') return 'err'
  if (s === 'running') return 'warn'
  return 'neutral'
}

export default function ScriptRunDetailPage() {
  const { t } = useTranslation()
  const { id } = useParams<{ id: string }>()
  const numId = id ? Number(id) : undefined
  const { data, isLoading } = useScriptRunDetail(numId, 2000)
  const { data: servers } = useServers()
  const openTab = useConsoleTabs((s) => s.open)

  const attach = async (serverId: number) => {
    const out = await openConsole(serverId, { rows: 24, cols: 80, term: 'xterm-256color' })
    openTab({
      id: `script-${out.session_id}`,
      sid: out.sid,
      sessionId: out.session_id,
      title: `script@${serverId}`,
      kind: 'script',
    })
  }

  if (isLoading) return <div className="text-muted-foreground text-[13px] p-4">{t('common.loading')}</div>
  const targets = data ?? []
  const serverName = (sid: number) => servers?.find((s) => s.id === sid)?.name ?? `#${sid}`
  const serverOnline = (sid: number) => {
    const sv = servers?.find((s) => s.id === sid)
    const ls = sv?.agent_last_seen
    if (!ls || !ls.Valid) return false
    return Date.now() - new Date(ls.Time).getTime() <= 90_000
  }

  // Per-target chip summary
  const okCount = targets.filter((t) => t.status === 'succeeded').length
  const runCount = targets.filter((t) => t.status === 'running').length
  const failCount = targets.filter((t) => t.status === 'failed').length
  const pendCount = targets.filter((t) => !t.status || t.status === 'pending').length

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight m-0">
            {t('scripts.run', 'Run')} #{id}
          </h1>
          <p className="text-muted-foreground text-[13px] mt-1">
            {t('scripts.run_detail_sub', 'Per-target execution results. Attach to running sessions or replay finished ones.')}
          </p>
        </div>
      </div>

      {/* Per-target chip strip */}
      {targets.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          {okCount > 0 && (
            <span className="inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full bg-ok-soft text-ok text-[11px] font-mono border border-transparent">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-ok" />
              {okCount} succeeded
            </span>
          )}
          {runCount > 0 && (
            <span className="inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full bg-warn-soft text-warn text-[11px] font-mono border border-transparent">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-warn shep-pulse-warn" />
              {runCount} running
            </span>
          )}
          {failCount > 0 && (
            <span className="inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full bg-err-soft text-err text-[11px] font-mono border border-transparent">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-err" />
              {failCount} failed
            </span>
          )}
          {pendCount > 0 && (
            <span className="inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full bg-sunken text-muted-foreground text-[11px] font-mono border border-border">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground" />
              {pendCount} pending
            </span>
          )}
          <span className="text-fg-dim font-mono text-[11px] ml-1">
            {targets.length} total
          </span>
        </div>
      )}

      {/* Per-target table */}
      <div className="border rounded-lg bg-elev overflow-hidden">
        <div className="flex items-center gap-2 px-3.5 py-2.5 border-b">
          <span className="text-foreground font-medium text-[12.5px]">
            {t('scripts.targets', 'Target results')}
          </span>
          <span className="text-fg-dim font-mono text-[11px] ml-auto">{targets.length} servers</span>
        </div>

        {targets.length === 0 ? (
          <div className="px-4 py-8 text-center text-fg-dim font-mono text-[12px]">
            {t('scripts.no_targets', 'no target results yet')}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px] border-collapse">
              <thead>
                <tr>
                  <th className="text-left font-medium text-muted-foreground text-[10.5px] uppercase tracking-[0.05em] px-4 py-2 border-b">
                    {t('admin.servers', 'Server')}
                  </th>
                  <th className="text-left font-medium text-muted-foreground text-[10.5px] uppercase tracking-[0.05em] px-4 py-2 border-b">
                    {t('scripts.status', 'Status')}
                  </th>
                  <th className="text-left font-medium text-muted-foreground text-[10.5px] uppercase tracking-[0.05em] px-4 py-2 border-b hidden sm:table-cell">
                    {t('scripts.exit_code', 'Exit')}
                  </th>
                  <th className="text-right font-medium text-muted-foreground text-[10.5px] uppercase tracking-[0.05em] px-4 py-2 border-b">
                    {t('admin.actions', 'Actions')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {targets.map((tgt) => {
                  const name = serverName(tgt.server_id)
                  const online = serverOnline(tgt.server_id)
                  const st = tgt.status ?? 'pending'
                  return (
                    <tr
                      key={tgt.id}
                      className={cn(
                        'border-t transition-colors',
                        st === 'failed' ? 'hover:bg-err-soft/30' : 'hover:bg-sunken/70',
                      )}
                    >
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <OnlineDot online={online} />
                          <span className="font-mono font-medium text-[13px]">{name}</span>
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        <Pill kind={statusKind(st)}>{st}</Pill>
                      </td>
                      <td className="px-4 py-2.5 hidden sm:table-cell">
                        <span
                          className={cn(
                            'font-mono text-[12px] tabular-nums',
                            tgt.exit_code != null && tgt.exit_code !== 0 ? 'text-err' : 'text-fg-dim',
                          )}
                        >
                          {tgt.exit_code ?? '—'}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right whitespace-nowrap">
                        {st === 'running' && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2 text-[12px] gap-1"
                            onClick={() => attach(tgt.server_id)}
                          >
                            <Terminal className="h-3 w-3" />
                            {t('console.attach', 'Attach')}
                          </Button>
                        )}
                        {tgt.pty_session_id && st !== 'running' && st !== 'failed' && (
                          <Button size="sm" variant="ghost" asChild className="h-7 px-2 text-[12px] gap-1">
                            <a href={`/admin/recordings/${tgt.pty_session_id}`}>
                              <PlayCircle className="h-3 w-3" />
                              {t('recording.replay', 'Replay')}
                            </a>
                          </Button>
                        )}
                        {st === 'failed' && (
                          <Button size="sm" variant="ghost" asChild className="h-7 px-2 text-[12px] gap-1 text-err hover:text-err">
                            <Link to={`/admin/script-runs/${id}/targets/${tgt.id}`}>
                              <AlertTriangle className="h-3 w-3" />
                              {t('scripts.view_error', 'View error')}
                            </Link>
                          </Button>
                        )}
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
