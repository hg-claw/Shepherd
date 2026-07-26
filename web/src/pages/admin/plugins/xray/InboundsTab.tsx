import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Pill } from '@/components/Pill'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell, TableEmpty } from '@/components/ui/table'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { useUI } from '@/store/ui'
import { copyText } from '@/lib/clipboard'
import { buildShareURL } from './templates'
import InboundDialog from './InboundDialog'
import BulkRelayDialog from './BulkRelayDialog'
import {
  listXrayInbounds, deleteXrayInbound, listPluginHosts, patchXrayServerVersion,
  fetchXrayTrafficBatch,
  type XrayInbound, type PluginHost,
} from '@/api/plugins'
import { useServers } from '@/api/servers'

export default function InboundsTab() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const toast = useUI((s) => s.toast)
  const serversQ = useServers({ refetchInterval: 30_000 })
  const inboundsQ = useQuery({
    queryKey: ['xray-inbounds'],
    queryFn: () => listXrayInbounds(),
    refetchInterval: 5_000,
  })
  const hostsQ = useQuery({
    queryKey: ['plugin-hosts', 'xray'],
    queryFn: () => listPluginHosts('xray'),
    refetchInterval: 5_000,
  })

  // Group inbounds by server_id; one section per server.
  const groups = useMemo(() => {
    const m = new Map<number, XrayInbound[]>()
    for (const i of inboundsQ.data ?? []) {
      const arr = m.get(i.server_id) ?? []
      arr.push(i)
      m.set(i.server_id, arr)
    }
    return m
  }, [inboundsQ.data])

  // Count relay dependents per landing-inbound id
  const dependentsByLandingID = useMemo(() => {
    const m = new Map<number, number>()
    for (const i of inboundsQ.data ?? []) {
      if (i.role === 'relay' && i.upstream_inbound_id != null) {
        m.set(i.upstream_inbound_id, (m.get(i.upstream_inbound_id) ?? 0) + 1)
      }
    }
    return m
  }, [inboundsQ.data])

  // PluginHost lookup for xray version + process status
  const hostByServer = useMemo(() => {
    const m = new Map<number, PluginHost>()
    for (const h of hostsQ.data ?? []) m.set(h.server_id, h)
    return m
  }, [hostsQ.data])

  const del = useMutation({
    mutationFn: (id: number) => deleteXrayInbound(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['xray-inbounds'] })
      qc.invalidateQueries({ queryKey: ['plugin-hosts', 'xray'] })
    },
    onError: (e: any) => toast('error', String(e?.message ?? e)),
  })

  // Batch traffic fetch: one call per server section covering all tags for that server.
  // We build a per-server map of tag → sparkline values.
  const allTags = useMemo(() => (inboundsQ.data ?? []).map((i) => i.tag), [inboundsQ.data])

  // Group tags by server_id for batch fetches.
  const tagsByServer = useMemo(() => {
    const m = new Map<number, string[]>()
    for (const i of inboundsQ.data ?? []) {
      const arr = m.get(i.server_id) ?? []
      arr.push(i.tag)
      m.set(i.server_id, arr)
    }
    return m
  }, [inboundsQ.data])

  // Active/idle detection: an inbound is "active" when at least one sample in
  // the last ~2 minutes has bytes > 0. We only need a binary signal here, not
  // a full sparkline (the Traffic tab handles that). Small window keeps the
  // query cheap and the indicator responsive.
  const activeByTag = useQuery({
    queryKey: ['xray-traffic-active', allTags.join(',')],
    queryFn: async () => {
      const now = new Date()
      const from = new Date(now.getTime() - 2 * 60 * 1000).toISOString()
      const to = now.toISOString()
      const results = await Promise.all(
        Array.from(tagsByServer.entries()).map(([serverID, tags]) =>
          fetchXrayTrafficBatch({ server_id: serverID, tags, kind: 'inbound', from, to, resolution: 'raw' })
        )
      )
      const active = new Map<string, boolean>()
      for (const res of results) {
        for (const series of res.series ?? []) {
          const hasTraffic = series.points.some((p) => p.bytes_up + p.bytes_down > 0)
          active.set(series.tag, hasTraffic)
        }
      }
      return active
    },
    enabled: allTags.length > 0,
    refetchInterval: 30_000,
  })

  const activeMap: Map<string, boolean> = activeByTag.data ?? new Map()

  const [dialog, setDialog] = useState<
    { kind: 'new'; serverID?: number } |
    { kind: 'edit'; inbound: XrayInbound } |
    { kind: 'bulk'; landing: XrayInbound } |
    null
  >(null)

  const [pendingDelete, setPendingDelete] = useState<XrayInbound | null>(null)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {t('xray.inbounds.description', 'Each row is one xray inbound. A single server can host multiple inbounds.')}
        </p>
        <Button size="sm" onClick={() => setDialog({ kind: 'new' })}>
          + {t('xray.inbounds.new_inbound', 'New inbound')}
        </Button>
      </div>

      {inboundsQ.isLoading && (
        <p className="text-sm text-muted-foreground px-1">{t('common.loading', 'Loading…')}</p>
      )}

      {!inboundsQ.isLoading && (serversQ.data ?? []).map((s) => {
        const inbounds = groups.get(s.id) ?? []
        const host = hostByServer.get(s.id)
        return (
          <div key={s.id} className="rounded-lg border bg-elev overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 border-b bg-background/40">
              <div className="text-sm font-mono">
                <span className="font-medium">{s.name}</span>
                <span className="text-fg-dim ml-2">
                  {s.ssh_host?.Valid ? s.ssh_host.String : '—'}
                </span>
                {host && (
                  <span className="text-fg-dim ml-3"><VersionInline serverID={s.id} current={host?.deployed_version ?? null} /></span>
                )}
                {host && (
                  <span className="ml-3"><Pill kind={host.status === 'running' ? 'ok' : 'neutral'}>{host.status}</Pill></span>
                )}
              </div>
              <Button size="xs" variant="ghost"
                onClick={() => setDialog({ kind: 'new', serverID: s.id })}>
                + {t('xray.inbounds.add_inbound', 'Add inbound')}
              </Button>
            </div>
            <Table wrapperClassName="border-0 rounded-none bg-transparent">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t('xray.inbounds.tag', 'Tag')}</TableHead>
                  <TableHead>{t('xray.inbounds.role', 'Role')}</TableHead>
                  <TableHead>{t('xray.inbounds.protocol', 'Protocol')}</TableHead>
                  <TableHead>{t('xray.inbounds.port', 'Port')}</TableHead>
                  <TableHead>{t('xray.inbounds.alias', 'Alias')}</TableHead>
                  <TableHead className="text-right">{t('admin.actions', 'Actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {inbounds.length === 0 && (
                  <TableEmpty colSpan={6}>{t('xray.empty.inbounds', 'No inbounds on this server.')}</TableEmpty>
                )}
                {inbounds.map((i) => {
                  const dep = dependentsByLandingID.get(i.id) ?? 0
                  const isLanding = i.role === 'landing'
                  const hostname = s.ssh_host?.Valid ? s.ssh_host.String : ''
                  const shareURL = hostname && i.uuid && i.public_key && i.sni
                    ? buildShareURL({
                        inbound: 'vless-reality',
                        port: i.port, uuid: i.uuid, sni: i.sni,
                        publicKey: i.public_key, shortID: i.short_id,
                      }, hostname, `${s.name}/${i.tag}`)
                    : null
                  const isActive = activeMap.get(i.tag) === true
                  return (
                    <TableRow key={i.id}>
                      <TableCell className="font-mono">
                        <span
                          className={`inline-block w-1.5 h-1.5 rounded-full mr-2 align-middle ${
                            isActive ? 'bg-ok' : 'bg-fg-dim/40'
                          }`}
                          title={isActive ? t('xray.inbounds.active_title', 'active (traffic in last 2 min)') : t('xray.inbounds.idle_title', 'idle (no recent traffic)')}
                        />
                        {i.tag}
                      </TableCell>
                      <TableCell>
                        {isLanding
                          ? <Pill kind="neutral">landing</Pill>
                          : (
                            <span className="font-mono">
                              <Pill kind="ok">relay</Pill>
                              <span className="text-fg-dim ml-1">→ {i.upstream_tag} @ {i.upstream_server_name}</span>
                            </span>
                          )}
                      </TableCell>
                      <TableCell className="font-mono text-sm">{i.protocol}</TableCell>
                      <TableCell className="font-mono text-sm">{i.port}</TableCell>
                      <TableCell className="font-mono text-sm text-muted-foreground">{i.alias || '—'}</TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        <Button size="xs" variant="ghost"
                          disabled={!shareURL}
                          title={shareURL ? t('xray.inbounds.copy_url_title', 'Copy share URL') : t('xray.inbounds.copy_url_disabled_title', 'cannot build URL')}
                          onClick={async () => {
                            if (!shareURL) return
                            try { await copyText(shareURL); toast('success', t('xray.inbounds.copy_url_copied_toast', 'Share URL copied')) }
                            catch (e) { toast('error', String((e as Error)?.message ?? e)) }
                          }}>
                          {t('xray.inbounds.copy_url_button', 'Copy URL')}
                        </Button>
                        {isLanding && (
                          <Button size="xs" variant="ghost"
                            onClick={() => setDialog({ kind: 'bulk', landing: i })}>
                            + {t('xray.inbounds.bulk_relay_button', 'Bulk Relay')}
                          </Button>
                        )}
                        <Button size="xs" variant="ghost"
                          onClick={() => setDialog({ kind: 'edit', inbound: i })}>
                          {t('xray.inbounds.edit_button', 'Edit')}
                        </Button>
                        <Button size="xs" variant="ghost" className="text-destructive"
                          disabled={del.isPending || dep > 0}
                          title={dep > 0 ? t('xray.inbounds.delete_disabled_title', '{{n}} relay(s) depend on this landing; delete them first', { n: dep }) : undefined}
                          onClick={() => setPendingDelete(i)}>
                          {t('admin.delete', 'Delete')}
                        </Button>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )
      })}

      <ConfirmDialog
        open={pendingDelete != null}
        onOpenChange={(open) => { if (!open) setPendingDelete(null) }}
        title={t('xray.delete_inbound')}
        description={t('xray.delete_inbound_confirm', { name: pendingDelete?.alias || (pendingDelete?.tag ?? '') })}
        onConfirm={() => { if (pendingDelete) del.mutate(pendingDelete.id) }}
      />

      {dialog?.kind === 'new' && (
        <InboundDialog
          key={`new-${dialog.serverID ?? 'any'}`}
          open={true}
          onOpenChange={(open: boolean) => { if (!open) setDialog(null) }}
          mode="create"
          defaultServerID={dialog.serverID}
          allInbounds={inboundsQ.data ?? []}
        />
      )}
      {dialog?.kind === 'edit' && (
        <InboundDialog
          key={`edit-${dialog.inbound.id}`}
          open={true}
          onOpenChange={(open: boolean) => { if (!open) setDialog(null) }}
          mode="edit"
          inbound={dialog.inbound}
          allInbounds={inboundsQ.data ?? []}
        />
      )}
      {dialog?.kind === 'bulk' && (
        <BulkRelayDialog
          key={`bulk-${dialog.landing.id}`}
          open={true}
          onOpenChange={(open: boolean) => { if (!open) setDialog(null) }}
          landingInbound={dialog.landing}
          allInbounds={inboundsQ.data ?? []}
        />
      )}
    </div>
  )
}

function VersionInline({ serverID, current }: { serverID: number; current: string | null }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const toast = useUI((s) => s.toast)
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(current ?? '')
  const apply = useMutation({
    mutationFn: () => patchXrayServerVersion(serverID, value),
    onSuccess: () => {
      toast('success', t('xray.deploy.upgrading_toast', 'Upgrading to v{{version}}', { version: value }))
      qc.invalidateQueries({ queryKey: ['plugin-hosts', 'xray'] })
      setEditing(false)
    },
    onError: (e: any) => toast('error', String(e?.message ?? e)),
  })
  if (!editing) {
    return (
      <span className="text-fg-dim">
        xray v{current ?? '—'}{' '}
        <button className="text-fg-dim underline" onClick={() => setEditing(true)}>{t('xray.deploy.change', 'change')}</button>
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1">
      <Input value={value} onChange={(e) => setValue(e.target.value)}
        className="h-7 w-20 font-mono text-2xs" />
      <Button size="xs" className="text-2xs" disabled={apply.isPending}
        onClick={() => apply.mutate()}>{t('xray.deploy.apply', 'Apply')}</Button>
      <button className="text-fg-dim text-2xs" onClick={() => setEditing(false)}>{t('xray.deploy.cancel', 'cancel')}</button>
    </span>
  )
}
