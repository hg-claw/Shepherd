import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './client'

export interface Param {
  name: string
  label?: string
  required?: boolean
  default?: string
}

export interface Script {
  id: number
  name: string
  description: string
  content: string
  params: Param[]
  default_timeout_s?: number | null
}

export interface ScriptRun {
  id: number
  script_id: number
  started_at: string
  finished_at?: string | null
}

export interface ScriptRunTarget {
  id: number
  server_id: number
  pty_session_id?: number | null
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'agent_offline' | 'timeout'
  exit_code?: number | null
  started_at?: string | null
  finished_at?: string | null
}

export function useScripts() {
  return useQuery({ queryKey: ['scripts'], queryFn: () => api.get<Script[]>('/api/admin/scripts') })
}

export function useScript(id: number | undefined) {
  return useQuery({
    queryKey: ['scripts', id],
    queryFn: () => api.get<Script>(`/api/admin/scripts/${id}`),
    enabled: !!id,
  })
}

export function useCreateScript() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (s: Omit<Script, 'id'>) => api.post<Script>('/api/admin/scripts', s),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scripts'] }),
  })
}

export function useUpdateScript() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (s: Script) => api.patch<Script>(`/api/admin/scripts/${s.id}`, s),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scripts'] }),
  })
}

export function useDeleteScript() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => api.delete<void>(`/api/admin/scripts/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scripts'] }),
  })
}

export function useRunScript() {
  return useMutation({
    mutationFn: (v: { id: number; args: Record<string, string>; target_server_ids: number[] }) =>
      api.post<{ run_id: number }>(`/api/admin/scripts/${v.id}/run`, {
        args: v.args,
        target_server_ids: v.target_server_ids,
      }),
  })
}

export function useScriptRuns() {
  return useQuery({ queryKey: ['script-runs'], queryFn: () => api.get<ScriptRun[]>('/api/admin/script-runs') })
}

export function useScriptRunDetail(id: number | undefined, refetchInterval?: number) {
  return useQuery({
    queryKey: ['script-runs', id],
    queryFn: () => api.get<ScriptRunTarget[]>(`/api/admin/script-runs/${id}`),
    enabled: !!id,
    refetchInterval,
  })
}

// useTargetLog fetches the plain-text execution log for one run target,
// keyed by its pty_session_id (the recording the PTY service captured).
// refetchInterval lets callers poll while the target is still running.
export function useTargetLog(ptySessionId: number | null | undefined, refetchInterval?: number) {
  return useQuery({
    queryKey: ['target-log', ptySessionId],
    queryFn: () => api.getText(`/api/admin/recordings/${ptySessionId}/log`),
    enabled: !!ptySessionId,
    refetchInterval,
  })
}
