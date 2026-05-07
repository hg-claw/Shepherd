import { api } from './client'

export async function openConsole(
  serverId: number,
  opts: { user?: string; rows: number; cols: number; term: string },
) {
  return api.post<{ session_id: number; sid: string }>('/api/admin/console/open', {
    server_id: serverId,
    ...opts,
  })
}

export function consoleWSURL(sid: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${window.location.host}/api/admin/console/ws?sid=${encodeURIComponent(sid)}`
}
