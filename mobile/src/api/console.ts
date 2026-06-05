import { authedFetch } from './authed'

export type ConsoleSessionInfo = { session_id: number; sid: string }

export function openConsole(serverId: number, rows: number, cols: number): Promise<ConsoleSessionInfo> {
  return authedFetch<ConsoleSessionInfo>('/api/admin/console/open', {
    method: 'POST',
    body: { server_id: serverId, user: '', rows, cols, term: 'xterm-256color' },
  })
}
