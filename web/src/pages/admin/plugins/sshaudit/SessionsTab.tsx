import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell, TableEmpty } from '@/components/ui/table'
import { useServers, type ServerRecord } from '@/api/servers'
import { APIError } from '@/api/client'
import { fetchSSHAuditSessions, type SSHSession } from '@/api/sshaudit'

export default function SessionsTab() {
  const { t } = useTranslation()
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
        <span className="text-sm text-muted-foreground">{t('sshaudit.sessions.server_label', 'Server')}</span>
        <Select
          value={effectiveID ? String(effectiveID) : ''}
          onValueChange={(v) => {
            const n = Number(v)
            setServerID(n)
            sp.set('server_id', String(n))
            setSP(sp, { replace: true })
          }}
        >
          <SelectTrigger className="h-8 w-72 text-sm">
            <SelectValue placeholder={t('sshaudit.sessions.server_placeholder', 'Pick a server')} />
          </SelectTrigger>
          <SelectContent>
            {servers.map((s: ServerRecord) => (
              <SelectItem key={s.id} value={String(s.id)} className="text-sm">
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="sm"
          className="text-xs"
          disabled={!effectiveID || sessionsQ.isFetching}
          onClick={() => sessionsQ.refetch()}
        >
          <RefreshCw className={`h-3.5 w-3.5 mr-1 ${sessionsQ.isFetching ? 'animate-spin' : ''}`} />
          {t('sshaudit.refresh', 'Refresh')}
        </Button>
        {sessionsQ.data?.collected_at && !offline && (
          <span className="text-2xs text-muted-foreground font-mono">
            {t('sshaudit.sessions.as_of', 'as of')} {new Date(sessionsQ.data.collected_at).toLocaleTimeString()}
          </span>
        )}
      </div>

      {offline ? (
        <div className="border rounded-md p-6 text-center bg-elev">
          <div className="text-sm font-medium">{t('sshaudit.offline_title', 'Host offline / no agent')}</div>
          <div className="text-xs text-muted-foreground mt-1">
            {t('sshaudit.sessions.offline_desc', "Couldn't reach the agent to read live sessions. Make sure the server is online and try again.")}
          </div>
        </div>
      ) : err ? (
        <p className="text-sm text-err">{err.message}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>{t('sshaudit.sessions.user', 'User')}</TableHead>
              <TableHead className="font-mono">{t('sshaudit.sessions.source_ip', 'Source IP')}</TableHead>
              <TableHead>{t('sshaudit.sessions.tty', 'TTY')}</TableHead>
              <TableHead>{t('sshaudit.sessions.login_at', 'Login at')}</TableHead>
              <TableHead>{t('sshaudit.sessions.pid', 'PID')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sessions.map((s, i) => (
              <TableRow key={`${s.tty}-${s.pid ?? i}`}>
                <TableCell className="font-medium">{s.user}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{s.source_ip || '—'}</TableCell>
                <TableCell className="font-mono text-xs">{s.tty || '—'}</TableCell>
                <TableCell className="text-xs">
                  {s.login_at ? new Date(s.login_at).toLocaleString() : '—'}
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{s.pid ?? '—'}</TableCell>
              </TableRow>
            ))}
            {sessions.length === 0 && !sessionsQ.isLoading && (
              <TableEmpty colSpan={5}>{t('sshaudit.empty.sessions', 'No active SSH sessions.')}</TableEmpty>
            )}
            {sessionsQ.isLoading && (
              <TableRow>
                <TableCell colSpan={5} className="py-6 text-center text-muted-foreground text-sm">
                  {t('common.loading', 'Loading…')}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
