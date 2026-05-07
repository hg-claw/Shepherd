import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './client'

export interface FileEntry {
  name: string
  size: number
  mode: number
  mtime: number
  is_dir: boolean
  is_link?: boolean
  link_target?: string
}

export function useFiles(serverId: number, path: string) {
  return useQuery({
    queryKey: ['files', serverId, path],
    queryFn: () =>
      api.get<FileEntry[]>(
        `/api/admin/files?server_id=${serverId}&path=${encodeURIComponent(path)}`,
      ),
    enabled: !!serverId,
  })
}

export function useMkdir() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { server_id: number; path: string; mode?: number }) =>
      api.post<{ ok: boolean }>('/api/admin/files/mkdir', v),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['files'] }),
  })
}

export function useRm() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { server_id: number; path: string; recursive?: boolean }) =>
      api.post<{ ok: boolean }>('/api/admin/files/rm', v),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['files'] }),
  })
}

export function useRename() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { server_id: number; src: string; dst: string }) =>
      api.post<{ ok: boolean }>('/api/admin/files/rename', v),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['files'] }),
  })
}

export async function previewFile(serverId: number, path: string, maxBytes = 65536) {
  const url = `/api/admin/files/preview?server_id=${serverId}&path=${encodeURIComponent(path)}&max_bytes=${maxBytes}`
  const res = await fetch(url, { credentials: 'include' })
  if (res.status === 415) return { binary: true as const, text: '' }
  if (!res.ok) throw new Error(`preview ${res.status}`)
  const text = await res.text()
  return { binary: false as const, text }
}

export function downloadFileURL(serverId: number, path: string): string {
  return `/api/admin/files/download?server_id=${serverId}&path=${encodeURIComponent(path)}`
}

export async function uploadFile(serverId: number, path: string, file: File): Promise<void> {
  const url = `/api/admin/files/upload?server_id=${serverId}&path=${encodeURIComponent(path)}&mode=420`
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    body: file,
  })
  if (!res.ok) throw new Error(`upload ${res.status}`)
}
