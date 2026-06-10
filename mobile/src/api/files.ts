import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { authedFetch, authedText } from './authed'
import { APIError } from './client'

export type FileEntry = { name: string; size: number; mode: number; mtime: number; is_dir: boolean; is_link?: boolean }
export type Preview = { kind: 'text'; text: string } | { kind: 'binary' }

// Preview reads are capped server-side at this many bytes (matches web);
// the preview screen compares content length against it to flag truncation.
export const PREVIEW_MAX_BYTES = 65536

export function listDir(serverId: number, path: string): Promise<FileEntry[]> {
  return authedFetch<FileEntry[]>(`/api/admin/files?server_id=${serverId}&path=${encodeURIComponent(path)}`)
}
export async function previewFile(serverId: number, path: string): Promise<Preview> {
  try {
    const text = await authedText(`/api/admin/files/preview?server_id=${serverId}&path=${encodeURIComponent(path)}&max_bytes=${PREVIEW_MAX_BYTES}`)
    return { kind: 'text', text }
  } catch (e) {
    if (e instanceof APIError && e.status === 415) return { kind: 'binary' }
    throw e
  }
}
export function useDir(serverId: number, path: string): UseQueryResult<FileEntry[]> {
  return useQuery({ queryKey: ['files', serverId, path], queryFn: () => listDir(serverId, path) })
}

// Write ops mirror internal/api/files_routes.go filePathReq field names.
export function mkdir(serverId: number, path: string): Promise<{ ok: boolean }> {
  return authedFetch<{ ok: boolean }>('/api/admin/files/mkdir', { method: 'POST', body: { server_id: serverId, path } })
}
export function renamePath(serverId: number, src: string, dst: string): Promise<{ ok: boolean }> {
  return authedFetch<{ ok: boolean }>('/api/admin/files/rename', { method: 'POST', body: { server_id: serverId, src, dst } })
}
export function rmPath(serverId: number, path: string, recursive = false): Promise<{ ok: boolean }> {
  return authedFetch<{ ok: boolean }>('/api/admin/files/rm', { method: 'POST', body: { server_id: serverId, path, recursive } })
}
