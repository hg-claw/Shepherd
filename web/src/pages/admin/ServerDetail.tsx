import { useParams, useNavigate, Link } from 'react-router-dom'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderTree, Terminal as TerminalIcon } from 'lucide-react'
import { useServer, useTelemetry, usePatchServer, useDeleteServer, useRepair, usePushConfig, useServerIPCandidates, useServerInstallCommand } from '@/api/servers'
import { InstallCommandPanel } from '@/components/admin/InstallCommandPanel'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Switch } from '@/components/ui/switch'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { TimeSeriesChart } from '@/components/TimeSeriesChart'
import { InstallProgress } from '@/components/InstallProgress'
import { KpiCard } from '@/components/KpiCard'
import { useUI } from '@/store/ui'
import { bps, bytes, pct } from '@/lib/bytes'
import type { Range } from '@/api/servers'
import { openConsole } from '@/api/console'
import { useConsoleTabs } from '@/store/consoleTabs'

export default function AdminServerDetail() {
  const { id: idStr } = useParams<{ id: string }>()
  const id = Number(idStr)
  const { t } = useTranslation()
  const toast = useUI((s) => s.toast)
  const navigate = useNavigate()
  const openTab = useConsoleTabs((s) => s.open)

  const server = useServer(id, {
    refetchInterval: ((q: any) => {
      const stage = (q?.state?.data as { install_stage?: string } | undefined)?.install_stage
      return stage === 'installing' || stage === 'pending' ? 1500 : 30_000
    }) as unknown as number,
  })
  const s = server.data

  const [range, setRange] = useState<Range>('1h')
  const tele = useTelemetry(id, range, false)

  const patch = usePatchServer(id)
  const repair = useRepair(id)
  const config = usePushConfig(id)
  const del = useDeleteServer()
  const ipCandidates = useServerIPCandidates(id)
  const installCmd = useServerInstallCommand(id)

  const [interval, setIntervalSecs] = useState(30)
  const [repairToken, setRepairToken] = useState<{ token: string; expires: string } | null>(null)
  const [installPanel, setInstallPanel] = useState<{ command: string; expires_at: string } | null>(null)

  if (!s) return <div>{t('common.loading')}</div>

  const points = tele.data ?? []
  const cpu = points.map((p) => ({ ts: p.ts, v: p.cpu_pct ?? 0 }))
  const memPctSeries = points.map((p) => ({ ts: p.ts, v: pct(p.mem_used, p.mem_total) ?? 0 }))
  const netRx = points.map((p) => ({ ts: p.ts, v: p.net_rx_bps ?? 0 }))
  const netTx = points.map((p) => ({ ts: p.ts, v: p.net_tx_bps ?? 0 }))

  // Hero metric values (from server record, not telemetry)
  const isOnline = s.agent_last_seen?.Valid
    ? Date.now() - new Date(s.agent_last_seen.Time).getTime() <= 90_000
    : false

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl sm:text-2xl font-semibold truncate min-w-0 flex-1">{s.name}</h1>
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="destructive" size="sm">{t('admin.delete')}</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('admin.delete')}</DialogTitle>
              <DialogDescription>{t('admin.confirm_delete', { name: s.name })}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="destructive"
                onClick={async () => {
                  await del.mutateAsync(s.id)
                  navigate('/admin/servers')
                }}
              >
                {t('admin.delete')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* Hero metric strip — 4-up KPI cards showing current live values */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <KpiCard
          label={t('metric.cpu', 'CPU')}
          value={isOnline && points.length > 0 ? `${(points[points.length - 1].cpu_pct ?? 0).toFixed(0)}%` : '—'}
        />
        <KpiCard
          label={t('metric.mem', 'MEM')}
          value={isOnline && points.length > 0 ? `${(pct(points[points.length - 1].mem_used, points[points.length - 1].mem_total) ?? 0).toFixed(0)}%` : '—'}
        />
        <KpiCard
          label={t('metric.load1', 'LOAD-1')}
          value={isOnline && points.length > 0 ? (points[points.length - 1].load_1 ?? 0).toFixed(2) : '—'}
        />
        <KpiCard
          label={t('metric.tcp_conn', 'TCP conn')}
          value={isOnline && points.length > 0 ? (points[points.length - 1].tcp_conn ?? 0).toString() : '—'}
        />
      </div>

      <Card>
        <CardHeader><CardTitle>Identity</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4 text-sm">
          <Field label="name" defaultValue={s.name} onBlur={(v) => patch.mutate({ name: v })} />
          <KV k="ssh_host" v={s.ssh_host?.String ?? '-'} />
          <KV k="agent_version" v={s.agent_version?.String ?? '-'} />
          <KV k="agent_os" v={`${s.agent_os?.String ?? '-'}/${s.agent_arch?.String ?? '-'}`} />
          <KV k="agent_kernel" v={s.agent_kernel?.String ?? '-'} />
          <KV k="agent_fingerprint" v={s.agent_fingerprint?.String ?? '-'} long />
          <KV k="agent_last_seen" v={s.agent_last_seen?.Valid ? s.agent_last_seen.Time : '-'} />
          <KV k="install_stage" v={s.install_stage} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>SSH host</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <Field
            label="ssh_host"
            defaultValue={s.ssh_host?.String ?? ''}
            onBlur={(v) => patch.mutate({ ssh_host: v })}
          />
          <div className="space-y-1">
            <Label>Pick from detected IPs</Label>
            {ipCandidates.data && ipCandidates.data.length > 0 ? (
              <Select onValueChange={(v) => patch.mutate({ ssh_host: v })}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a candidate IP…" />
                </SelectTrigger>
                <SelectContent>
                  {ipCandidates.data.map((c) => (
                    <SelectItem key={c.addr} value={c.addr}>
                      {c.addr} — {c.kind} ({c.source})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <p className="text-xs text-muted-foreground">
                No candidates yet — agent hasn&apos;t reported IPs.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-2 mb-2">
        <Button asChild size="sm" variant="outline">
          <Link to={`/admin/files/${id}`}>
            <FolderTree className="h-4 w-4 mr-1" />
            {t('files.title', 'Files')}
          </Link>
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            const out = await openConsole(Number(id), { rows: 24, cols: 80, term: 'xterm-256color' })
            openTab({
              id: `console-${out.session_id}`,
              sid: out.sid,
              sessionId: out.session_id,
              title: `console@${id}`,
              kind: 'console',
            })
          }}
        >
          <TerminalIcon className="h-4 w-4 mr-1" />
          {t('console.open', 'Console')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={installCmd.isPending}
          onClick={async () => {
            try {
              const r = await installCmd.mutateAsync()
              setInstallPanel({ command: r.command, expires_at: r.expires_at })
            } catch (e) {
              toast('error', (e as Error).message ?? 'failed')
            }
          }}
        >
          {installCmd.isPending ? 'Issuing…' : 'Install command'}
        </Button>
      </div>

      {installPanel && (
        <InstallCommandPanel
          command={installPanel.command}
          expiresAt={installPanel.expires_at}
          title="Re-install / upgrade this host"
        />
      )}

      {(s.install_stage === 'installing' || s.install_stage === 'failed') && (
        <Card>
          <CardHeader><CardTitle>{t('admin.install_progress')}</CardTitle></CardHeader>
          <CardContent>
            <InstallProgress log={s.install_log} stage={s.install_stage} />
            {s.install_error?.Valid && (
              <p className="mt-2 text-sm text-destructive">{s.install_error.String}</p>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle>Public visibility</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field
            label="public_alias"
            defaultValue={s.public_alias?.String ?? ''}
            onBlur={(v) => patch.mutate({ public_alias: v })}
          />
          <Field
            label="public_group"
            defaultValue={s.public_group?.String ?? ''}
            onBlur={(v) => patch.mutate({ public_group: v })}
          />
          <Field
            label="country_code"
            defaultValue={s.country_code?.String ?? ''}
            onBlur={(v) => patch.mutate({ country_code: v })}
          />
          <div className="flex items-center gap-2">
            <Switch
              defaultChecked={s.show_on_public}
              onCheckedChange={(v) => patch.mutate({ show_on_public: v })}
            />
            <Label>show_on_public</Label>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Operations</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-end gap-2">
            <div className="flex-1">
              <Label>{t('admin.config_interval')}</Label>
              <Input
                type="number"
                min={5}
                max={3600}
                value={interval}
                onChange={(e) => setIntervalSecs(Number(e.target.value))}
              />
            </div>
            <Button
              onClick={async () => {
                try {
                  await config.mutateAsync({ telemetry_interval_seconds: interval })
                  toast('success', t('admin.config_pushed'))
                } catch (err: any) {
                  toast('error', err?.status === 409 ? t('admin.config_offline') : err?.message ?? t('common.error'))
                }
              }}
            >
              push
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={async () => {
                const out = await repair.mutateAsync()
                setRepairToken({ token: out.enrollment_token, expires: out.expires_at })
                toast('success', t('admin.repair_token_issued', { expires: new Date(out.expires_at).toLocaleString() }))
              }}
            >
              {t('admin.repair')}
            </Button>
            {repairToken && (
              <code className="rounded border bg-muted px-2 py-1 text-xs break-all max-w-full">
                {repairToken.token}
              </code>
            )}
            {repairToken && (
              <Button variant="ghost" size="sm" onClick={() => navigator.clipboard.writeText(repairToken.token).then(() => toast('success', t('common.copied')))}>
                {t('common.copy')}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Telemetry</h2>
        <Tabs value={range} onValueChange={(v) => setRange(v as Range)}>
          <TabsList>
            <TabsTrigger value="1h">{t('range.1h')}</TabsTrigger>
            <TabsTrigger value="24h">{t('range.24h')}</TabsTrigger>
            <TabsTrigger value="7d">{t('range.7d')}</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <Card>
        <CardHeader><CardTitle>{t('metric.cpu')}</CardTitle></CardHeader>
        <CardContent className="min-w-0">
          <TimeSeriesChart series={[{ name: 'CPU%', values: cpu }]} yMin={0} yMax={100} yFormat={(v) => `${v.toFixed(0)}%`} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t('metric.mem')}</CardTitle></CardHeader>
        <CardContent className="min-w-0">
          <TimeSeriesChart series={[{ name: 'MEM%', values: memPctSeries }]} yMin={0} yMax={100} yFormat={(v) => `${v.toFixed(0)}%`} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t('metric.net')}</CardTitle></CardHeader>
        <CardContent className="min-w-0">
          <TimeSeriesChart
            series={[
              { name: 'rx', values: netRx },
              { name: 'tx', values: netTx },
            ]}
            yFormat={(v) => bps(v)}
            tooltipFormat={(v) => bps(v)}
          />
        </CardContent>
      </Card>
      {points.length > 0 && (
        <p className="text-xs text-muted-foreground">
          mem snapshot: {bytes(points[points.length - 1].mem_used)} / {bytes(points[points.length - 1].mem_total)}
        </p>
      )}
    </div>
  )
}

function KV({ k, v, long }: { k: string; v: string; long?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{k}</span>
      <span className={long ? 'truncate font-mono text-xs' : 'font-mono text-xs'}>{v}</span>
    </div>
  )
}

function Field({
  label,
  defaultValue,
  onBlur,
}: {
  label: string
  defaultValue: string
  onBlur: (v: string) => void
}) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <Input
        defaultValue={defaultValue}
        onBlur={(e) => {
          const v = e.target.value
          if (v !== defaultValue) onBlur(v)
        }}
      />
    </div>
  )
}
