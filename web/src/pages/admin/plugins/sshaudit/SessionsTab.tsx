import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useServers, type ServerRecord } from '@/api/servers'
import { APIError } from '@/api/client'
import { fetchSSHAuditSessions, type SSHSession } from '@/api/sshaudit'

export default function SessionsTab() {
  const [sp, setSP] = useSearchParams()
  const initialID = Number(sp.get('server_id') || 0) || undefined

  const { data: servers = [] } = useServers()
  const [serverID, setServerID] = useState<number | undefined>(initialID)

  // Pick the first server when nothing is selected so the operator
  // doesn't see an empty page on first open.
  const effectiveID = serverID ?? (servers[0]?.id as number | undefined)

  const sessionsQ = useQuery({
    queryKey: ['sshaudit', 'sessions', effectiveID],
    queryFn: () => fetchSSHAuditSessions(effectiveID!),
    enabled: !!effectiveID,
    retry: false,
  })

  // A 502 from the backend means "host offline / no agent" — surface that as
  // a friendly state rather than a hard error toast.
  const err = sessionsQ.error as APIError | null
  const offline = err != null && (err.status === 502 || err.status === 504)
  const sessions: SSHSession[] = sessionsQ.data?.sessions ?? []

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <span className="text-[12.5px] text-muted-foreground">Server</span>
        <Select
          value={effectiveID ? String(effectiveID) : ''}
          onValueChange={(v) => {
            const n = Number(v)
            setServerID(n)
            sp.set('server_id', String(n))
            setSP(sp, { replace: true })
          }}
        >
          <SelectTrigger className="h-8 w-72 text-[12.5px]">
            <SelectValue placeholder="Pick a server" />
          </SelectTrigger>
          <SelectContent>
            {servers.map((s: ServerRecord) => (
              <SelectItem key={s.id} value={String(s.id)} className="text-[12.5px]">
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="sm"
          className="h-8 text-[12px]"
          disabled={!effectiveID || sessionsQ.isFetching}
          onClick={() => sessionsQ.refetch()}
        >
          <RefreshCw className={`h-3.5 w-3.5 mr-1 ${sessionsQ.isFetching ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
        {sessionsQ.data?.collected_at && !offline && (
          <span className="text-[11.5px] text-muted-foreground font-mono">
            as of {new Date(sessionsQ.data.collected_at).toLocaleTimeString()}
          </span>
        )}
      </div>

      {offline ? (
        <div className="border rounded-md p-6 text-center bg-elev">
          <div className="text-[13px] font-medium">Host offline / no agent</div>
          <div className="text-[12px] text-muted-foreground mt-1">
            Couldn't reach the agent to read live sessions. Make sure the server is online and try
            again.
          </div>
        </div>
      ) : err ? (
        <p className="text-[12.5px] text-err">{err.message}</p>
      ) : (
        <div className="border rounded-md overflow-hidden">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b text-[11px] text-muted-foreground uppercase tracking-wide">
                <th className="text-left py-2 pl-3 pr-4 font-medium">User</th>
                <th className="text-left py-2 pr-4 font-medium font-mono">Source IP</th>
                <th className="text-left py-2 pr-4 font-medium">TTY</th>
                <th className="text-left py-2 pr-4 font-medium">Login at</th>
                <th className="text-left py-2 pr-3 font-medium">PID</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s, i) => (
                <tr key={`${s.tty}-${s.pid ?? i}`} className="border-b last:border-0">
                  <td className="py-2 pl-3 pr-4 font-medium">{s.user}</td>
                  <td className="py-2 pr-4 font-mono text-[12px] text-muted-foreground">{s.source_ip || '—'}</td>
                  <td className="py-2 pr-4 font-mono text-[12px]">{s.tty || '—'}</td>
                  <td className="py-2 pr-4 text-[12px]">
                    {s.login_at ? new Date(s.login_at).toLocaleString() : '—'}
                  </td>
                  <td className="py-2 pr-3 font-mono text-[12px] text-muted-foreground">{s.pid ?? '—'}</td>
                </tr>
              ))}
              {sessions.length === 0 && !sessionsQ.isLoading && (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-muted-foreground text-[13px]">
                    No active SSH sessions.
                  </td>
                </tr>
              )}
              {sessionsQ.isLoading && (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-muted-foreground text-[13px]">
                    Loading…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
