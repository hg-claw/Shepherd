import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { authedFetch, authedText } from './authed'

export type ScriptParam = { name: string; label?: string; required?: boolean; default?: string }
export type Script = { id: number; name: string; description?: string; params: ScriptParam[] }
export type RunTarget = {
  id: number; server_id: number; status: string; exit_code?: number
  started_at?: string; finished_at?: string
  // pty_session_id keys the recording the PTY service captured for this target;
  // null/absent until the agent has spawned the session.
  pty_session_id?: number | null
}

const TERMINAL = new Set(['done', 'success', 'failed', 'error', 'timeout', 'cancelled'])

export function isTerminalStatus(status: string): boolean {
  return TERMINAL.has(status)
}

export function useScripts(): UseQueryResult<Script[]> {
  return useQuery({ queryKey: ['scripts'], queryFn: () => authedFetch<Script[]>('/api/admin/scripts') })
}

// runScript fans the script out to multiple targets. Non-finite ids (e.g. NaN
// from a missing ?serverId= route param) are dropped rather than sent to the
// backend; an empty target list is a caller bug and throws.
export function runScript(id: number, args: Record<string, string>, serverIds: number[]): Promise<{ run_id: number }> {
  const ids = serverIds.filter((n) => Number.isFinite(n))
  if (ids.length === 0) throw new Error('no target servers selected')
  return authedFetch<{ run_id: number }>(`/api/admin/scripts/${id}/run`, { method: 'POST', body: { args, target_server_ids: ids } })
}

export function useRun(runId: number | null): UseQueryResult<RunTarget[]> {
  return useQuery({
    queryKey: ['run', runId],
    enabled: runId != null,
    queryFn: () => authedFetch<RunTarget[]>(`/api/admin/script-runs/${runId}`),
    refetchInterval: (query) => {
      const rows = query.state.data as RunTarget[] | undefined
      const allDone = rows && rows.length > 0 && rows.every((t) => TERMINAL.has(t.status))
      return allDone ? false : 2000
    },
  })
}

// useTargetLog fetches the plain-text execution log for one run target, keyed
// by its pty_session_id. Pass a refetchInterval (e.g. 2000) to poll while the
// target is still running. Disabled until the id is a real finite number.
export function useTargetLog(ptySessionId: number | null | undefined, refetchInterval?: number): UseQueryResult<string> {
  const enabled = typeof ptySessionId === 'number' && Number.isFinite(ptySessionId)
  return useQuery({
    queryKey: ['target-log', ptySessionId],
    enabled,
    queryFn: () => authedText(`/api/admin/recordings/${ptySessionId}/log`),
    refetchInterval: enabled ? refetchInterval : undefined,
    retry: false, // a 404 means "no log (yet)" — polling re-asks anyway
  })
}
