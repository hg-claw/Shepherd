import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { authedFetch } from './authed'

export type ScriptParam = { name: string; label?: string; required?: boolean; default?: string }
export type Script = { id: number; name: string; description?: string; params: ScriptParam[] }
export type RunTarget = { id: number; server_id: number; status: string; exit_code?: number; started_at?: string; finished_at?: string }

const TERMINAL = new Set(['done', 'success', 'failed', 'error', 'timeout', 'cancelled'])

export function useScripts(): UseQueryResult<Script[]> {
  return useQuery({ queryKey: ['scripts'], queryFn: () => authedFetch<Script[]>('/api/admin/scripts') })
}

export function runScript(id: number, args: Record<string, string>, serverId: number): Promise<{ run_id: number }> {
  return authedFetch<{ run_id: number }>(`/api/admin/scripts/${id}/run`, { method: 'POST', body: { args, target_server_ids: [serverId] } })
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
