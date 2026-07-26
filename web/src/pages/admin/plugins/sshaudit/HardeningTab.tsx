import { useState } from 'react'
import { useTranslation } from 'react-i18next'
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
import { ConfirmDialog } from '@/components/ConfirmDialog'

export default function HardeningTab() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const toast = useUI((s) => s.toast)
  const [sp, setSP] = useSearchParams()
  const initialID = Number(sp.get('server_id') || 0) || undefined

  const { data: servers = [] } = useServers()
  const [serverID, setServerID] = useState<number | undefined>(initialID)
  const [confirmEnable, setConfirmEnable] = useState(false)

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
      toast('success', vars.enabled
        ? t('sshaudit.hardening.enabled_toast', 'fail2ban enabled')
        : t('sshaudit.hardening.disabled_toast', 'fail2ban disabled'))
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
      setConfirmEnable(true)
      return
    }
    toggle.mutate({ serverID: effectiveID, enabled: next })
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {t(
          'sshaudit.hardening.description',
          'fail2ban watches the SSH auth log and temporarily bans source IPs after repeated failed logins — defensive hardening for your managed hosts. Enable it to install, configure, and start the jail; disable to stop it.',
        )}
      </p>

      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-sm text-muted-foreground">{t('sshaudit.hardening.server_label', 'Server')}</span>
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
            <SelectValue placeholder={t('sshaudit.hardening.server_placeholder', 'Pick a server')} />
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
          disabled={!effectiveID || statusQ.isFetching || busy}
          onClick={() => statusQ.refetch()}
        >
          <RefreshCw className={`h-3.5 w-3.5 mr-1 ${statusQ.isFetching ? 'animate-spin' : ''}`} />
          {t('sshaudit.refresh', 'Refresh')}
        </Button>
      </div>

      {busy ? (
        <div className="border rounded-md p-6 text-center bg-elev">
          <div className="inline-flex items-center gap-2 text-sm font-medium">
            <Loader2 className="h-4 w-4 animate-spin" />
            {toggle.variables?.enabled
              ? t('sshaudit.hardening.installing', 'Installing fail2ban…')
              : t('sshaudit.hardening.stopping', 'Stopping fail2ban…')}
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            {t('sshaudit.hardening.busy_hint', 'This can take a moment while the agent runs on the host.')}
          </div>
        </div>
      ) : offline ? (
        <div className="border rounded-md p-6 text-center bg-elev">
          <div className="text-sm font-medium">{t('sshaudit.offline_title', 'Host offline / no agent')}</div>
          <div className="text-xs text-muted-foreground mt-1">
            {t('sshaudit.hardening.offline_desc', "Couldn't reach the agent to read fail2ban status. Make sure the server is online and try again.")}
          </div>
        </div>
      ) : err ? (
        <p className="text-sm text-err">{err.message}</p>
      ) : statusQ.isLoading ? (
        <div className="border rounded-md p-6 text-center text-muted-foreground text-sm">
          {t('common.loading', 'Loading…')}
        </div>
      ) : status ? (
        <StatusCard status={status} busy={busy} onToggle={onToggle} />
      ) : null}

      <ConfirmDialog
        open={confirmEnable}
        onOpenChange={setConfirmEnable}
        title={t('sshaudit.enable_fail2ban', 'Enable fail2ban')}
        description={t('sshaudit.enable_fail2ban_confirm', 'Install, configure, and start the SSH brute-force jail on this host.')}
        destructive={false}
        onConfirm={() => toggle.mutate({ serverID: effectiveID!, enabled: true })}
      />
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
  const { t } = useTranslation()
  // Not installed → a clean call-to-action to enable. Installed → show the
  // running/stopped state, ban counts, and the banned-IP list.
  if (!status.installed) {
    return (
      <div className="border rounded-md p-6 text-center bg-elev space-y-3">
        <div className="inline-flex items-center gap-2 text-sm font-medium">
          <ShieldOff className="h-4 w-4 text-muted-foreground" />
          {t('sshaudit.hardening.not_installed', 'fail2ban is not installed')}
        </div>
        <div className="text-xs text-muted-foreground">
          {t('sshaudit.hardening.not_installed_hint', 'Enable to install, configure, and start the SSH brute-force jail on this host.')}
        </div>
        <Button size="sm" className="text-xs" disabled={busy} onClick={() => onToggle(true)}>
          {t('sshaudit.enable_fail2ban', 'Enable fail2ban')}
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
          <span className="text-sm font-medium">{t('sshaudit.hardening.fail2ban_label', 'fail2ban')}</span>
          <Pill kind={status.active ? 'ok' : 'neutral'}>
            {status.active ? t('sshaudit.hardening.active', 'active') : t('sshaudit.hardening.stopped', 'stopped')}
          </Pill>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {status.active ? t('sshaudit.hardening.enabled', 'Enabled') : t('sshaudit.hardening.disabled', 'Disabled')}
          </span>
          <Switch
            checked={status.active}
            disabled={busy}
            onCheckedChange={(v) => onToggle(v)}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
        <StatCard label={t('sshaudit.hardening.currently_banned', 'Currently banned')} value={status.currently_banned} tone="warn" />
        <StatCard label={t('sshaudit.hardening.total_banned', 'Total banned')} value={status.total_banned} />
        <StatCard label={t('sshaudit.hardening.banned_ips', 'Banned IPs')} value={status.banned_ips.length} />
      </div>

      {status.max_retry > 0 && status.find_time > 0 && status.ban_time > 0 ? (
        <div className="border rounded-md p-3">
          <div className="text-muted-foreground text-2xs uppercase tracking-[0.05em] mb-1">
            {t('sshaudit.hardening.ban_policy', 'Ban policy')}
          </div>
          <div className="text-sm">
            <span className="font-mono tabular-nums">{status.max_retry}</span>{' '}
            {t('sshaudit.hardening.ban_policy_within', 'failed attempts within')}{' '}
            <span className="font-mono tabular-nums">{humanSeconds(status.find_time)}</span>{' '}
            {t('sshaudit.hardening.ban_policy_arrow', '→ ban for')}{' '}
            <span className="font-mono tabular-nums">{humanSeconds(status.ban_time)}</span>
          </div>
        </div>
      ) : null}

      <div className="border rounded-md p-3">
        <div className="text-muted-foreground text-2xs uppercase tracking-[0.05em] mb-2">
          {t('sshaudit.hardening.banned_ips', 'Banned IPs')}
        </div>
        {status.banned_ips.length === 0 ? (
          <div className="text-xs text-muted-foreground">{t('sshaudit.hardening.banned_ips_empty', 'No IPs are currently banned.')}</div>
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

// Compact, locale-free duration: 600→"10m", 3600→"1h", 86400→"24h". Falls back
// to "{n}s" for values that aren't a whole number of minutes/hours. We top out
// at hours (so a 1-day ban reads "24h"), matching how the jail config is shown.
function humanSeconds(n: number): string {
  if (n % 3600 === 0) return `${n / 3600}h`
  if (n % 60 === 0) return `${n / 60}m`
  return `${n}s`
}

function StatCard({ label, value, tone }: { label: string; value: number; tone?: 'warn' }) {
  const toneClass = tone === 'warn' && value > 0 ? 'text-warn' : ''
  return (
    <div className="border rounded-md p-3">
      <div className="text-muted-foreground text-2xs uppercase tracking-[0.05em]">{label}</div>
      <div className={`text-title font-mono tabular-nums ${toneClass}`}>{value}</div>
    </div>
  )
}
