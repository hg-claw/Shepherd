import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, RefreshCw, ShieldCheck, ShieldOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Pill } from '@/components/Pill'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useServers, type ServerRecord } from '@/api/servers'
import { APIError } from '@/api/client'
import { useUI } from '@/store/ui'
import {
  fetchSSHAuditFail2ban,
  setSSHAuditFail2ban,
  type SSHFail2banStatus,
} from '@/api/sshaudit'

export default function HardeningTab() {
  const qc = useQueryClient()
  const toast = useUI((s) => s.toast)
  const [sp, setSP] = useSearchParams()
  const initialID = Number(sp.get('server_id') || 0) || undefined

  const { data: servers = [] } = useServers()
  const [serverID, setServerID] = useState<number | undefined>(initialID)

  // Pick the first server when nothing is selected so the operator
  // doesn't see an empty page on first open.
  const effectiveID = serverID ?? (servers[0]?.id as number | undefined)

  const statusQ = useQuery({
    queryKey: ['sshaudit', 'fail2ban', effectiveID],
    queryFn: () => fetchSSHAuditFail2ban(effectiveID!),
    enabled: !!effectiveID,
    retry: false,
  })

  const toggle = useMutation({
    mutationFn: ({ serverID, enabled }: { serverID: number; enabled: boolean }) =>
      setSSHAuditFail2ban(serverID, enabled),
    onSuccess: (status, vars) => {
      // Write through so the UI reflects the new state without a refetch gap.
      qc.setQueryData(['sshaudit', 'fail2ban', vars.serverID], status)
      toast('success', vars.enabled ? 'fail2ban enabled' : 'fail2ban disabled')
    },
    onError: (e: unknown) => toast('error', String((e as Error)?.message ?? e)),
  })

  // A 502/504 from the backend means "host offline / no agent" — surface that
  // as a friendly state rather than a hard error toast.
  const err = statusQ.error as APIError | null
  const offline = err != null && (err.status === 502 || err.status === 504)
  const status = statusQ.data
  const busy = toggle.isPending

  const onToggle = (next: boolean) => {
    if (!effectiveID) return
    if (next) {
      if (!confirm('Enable fail2ban? This installs, configures, and starts the SSH brute-force jail on this host.')) {
        return
      }
    }
    toggle.mutate({ serverID: effectiveID, enabled: next })
  }

  return (
    <div className="space-y-4">
      <div className="text-[12.5px] text-muted-foreground">
        fail2ban watches the SSH auth log and temporarily bans source IPs after repeated failed
        logins — defensive hardening for your managed hosts. Enable it to install, configure, and
        start the jail; disable to stop it.
      </div>

      <div className="flex items-center gap-3 flex-wrap">
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
          disabled={!effectiveID || statusQ.isFetching || busy}
          onClick={() => statusQ.refetch()}
        >
          <RefreshCw className={`h-3.5 w-3.5 mr-1 ${statusQ.isFetching ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {busy ? (
        <div className="border rounded-md p-6 text-center bg-elev">
          <div className="inline-flex items-center gap-2 text-[13px] font-medium">
            <Loader2 className="h-4 w-4 animate-spin" />
            {toggle.variables?.enabled ? 'Installing fail2ban…' : 'Stopping fail2ban…'}
          </div>
          <div className="text-[12px] text-muted-foreground mt-1">
            This can take a moment while the agent runs on the host.
          </div>
        </div>
      ) : offline ? (
        <div className="border rounded-md p-6 text-center bg-elev">
          <div className="text-[13px] font-medium">Host offline / no agent</div>
          <div className="text-[12px] text-muted-foreground mt-1">
            Couldn't reach the agent to read fail2ban status. Make sure the server is online and try
            again.
          </div>
        </div>
      ) : err ? (
        <p className="text-[12.5px] text-err">{err.message}</p>
      ) : statusQ.isLoading ? (
        <div className="border rounded-md p-6 text-center text-muted-foreground text-[13px]">
          Loading…
        </div>
      ) : status ? (
        <StatusCard status={status} busy={busy} onToggle={onToggle} />
      ) : null}
    </div>
  )
}

function StatusCard({
  status,
  busy,
  onToggle,
}: {
  status: SSHFail2banStatus
  busy: boolean
  onToggle: (next: boolean) => void
}) {
  // Not installed → a clean call-to-action to enable. Installed → show the
  // running/stopped state, ban counts, and the banned-IP list.
  if (!status.installed) {
    return (
      <div className="border rounded-md p-6 text-center bg-elev space-y-3">
        <div className="inline-flex items-center gap-2 text-[13px] font-medium">
          <ShieldOff className="h-4 w-4 text-muted-foreground" />
          fail2ban is not installed
        </div>
        <div className="text-[12px] text-muted-foreground">
          Enable to install, configure, and start the SSH brute-force jail on this host.
        </div>
        <Button size="sm" className="h-8 text-[12px]" disabled={busy} onClick={() => onToggle(true)}>
          Enable fail2ban
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="border rounded-md p-4 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          {status.active ? (
            <ShieldCheck className="h-4 w-4 text-ok" />
          ) : (
            <ShieldOff className="h-4 w-4 text-muted-foreground" />
          )}
          <span className="text-[13px] font-medium">fail2ban</span>
          <Pill kind={status.active ? 'ok' : 'neutral'}>{status.active ? 'active' : 'stopped'}</Pill>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-muted-foreground">
            {status.active ? 'Enabled' : 'Disabled'}
          </span>
          <Switch
            checked={status.active}
            disabled={busy}
            onCheckedChange={(v) => onToggle(v)}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-[12.5px]">
        <StatCard label="Currently banned" value={status.currently_banned} tone="warn" />
        <StatCard label="Total banned" value={status.total_banned} />
        <StatCard label="Banned IPs" value={status.banned_ips.length} />
      </div>

      <div className="border rounded-md p-3">
        <div className="text-muted-foreground text-[11px] uppercase tracking-wide mb-2">
          Banned IPs
        </div>
        {status.banned_ips.length === 0 ? (
          <div className="text-[12px] text-muted-foreground">No IPs are currently banned.</div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {status.banned_ips.map((ip) => (
              <Pill key={ip} kind="err">
                {ip}
              </Pill>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function StatCard({ label, value, tone }: { label: string; value: number; tone?: 'warn' }) {
  const toneClass = tone === 'warn' && value > 0 ? 'text-warn' : ''
  return (
    <div className="border rounded-md p-3">
      <div className="text-muted-foreground text-[11px] uppercase tracking-wide">{label}</div>
      <div className={`text-[20px] font-mono tabular-nums ${toneClass}`}>{value}</div>
    </div>
  )
}
