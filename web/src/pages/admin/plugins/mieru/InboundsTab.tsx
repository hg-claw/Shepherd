import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Pill } from '@/components/Pill'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell, TableEmpty } from '@/components/ui/table'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { useUI } from '@/store/ui'
import { copyText } from '@/lib/clipboard'
import InboundDialog from './InboundDialog'
import { listMieruInbounds, deleteMieruInbound, listPluginHosts, type MieruInbound } from '@/api/plugins'
import { useServers } from '@/api/servers'

function shareURL(i: MieruInbound, host: string): string {
  const q = new URLSearchParams({
    profile: 'default',
    mtu: String(i.mtu || 1400),
    multiplexing: i.multiplexing || 'MULTIPLEXING_OFF',
    'handshake-mode': i.handshake_mode || 'HANDSHAKE_NO_WAIT',
    port: String(i.port),
    protocol: i.protocol === 'BOTH' ? 'TCP' : i.protocol,
  })
  if (i.protocol === 'BOTH') {
    q.append('port', String(i.port + 1))
    q.append('protocol', 'UDP')
  }
  const user = encodeURIComponent(i.username)
  const pass = encodeURIComponent(i.password)
  return `mierus://${user}:${pass}@${host}:${i.port}?${q.toString()}`
}

export default function InboundsTab() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const toast = useUI((s) => s.toast)
  const serversQ = useServers({ refetchInterval: 30_000 })
  const inboundsQ = useQuery({ queryKey: ['mieru-inbounds'], queryFn: () => listMieruInbounds() })
  const hostsQ = useQuery({ queryKey: ['plugin-hosts', 'mieru'], queryFn: () => listPluginHosts('mieru') })

  const groups = useMemo(() => {
    const m = new Map<number, MieruInbound[]>()
    for (const i of inboundsQ.data ?? []) {
      const list = m.get(i.server_id) ?? []
      list.push(i)
      m.set(i.server_id, list)
    }
    return m
  }, [inboundsQ.data])

  const hostByServer = useMemo(() => {
    const m = new Map<number, string>()
    for (const h of hostsQ.data ?? []) m.set(h.server_id, h.status)
    return m
  }, [hostsQ.data])

  const del = useMutation({
    mutationFn: (id: number) => deleteMieruInbound(id),
    onSuccess: () => { toast('success', 'Deleted'); qc.invalidateQueries({ queryKey: ['mieru-inbounds'] }) },
    onError: (e: Error) => toast('error', e.message),
  })

  const [dialog, setDialog] = useState<
    { kind: 'new'; serverID?: number } | { kind: 'edit'; inbound: MieruInbound } | null
  >(null)
  const [pendingDelete, setPendingDelete] = useState<MieruInbound | null>(null)

  const servers = serversQ.data ?? []
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setDialog({ kind: 'new' })}>{t('mieru.inbound.new', 'New inbound')}</Button>
      </div>
      {servers.map((s) => {
        const rows = groups.get(s.id) ?? []
        const host = s.ssh_host?.Valid ? s.ssh_host.String : ''
        const status = hostByServer.get(s.id)
        return (
          <div key={s.id} className="space-y-2">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-medium">{s.name}</h3>
              {status && <Pill kind={status === 'running' ? 'ok' : 'neutral'}>{status}</Pill>}
              <Button size="xs" variant="outline" onClick={() => setDialog({ kind: 'new', serverID: s.id })}>+</Button>
            </div>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Tag</TableHead>
                  <TableHead>Port</TableHead>
                  <TableHead>Proto</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell className="font-mono text-xs">{i.alias || i.tag}</TableCell>
                    <TableCell>{i.port}{i.protocol === 'BOTH' ? `/${i.port + 1}` : ''}</TableCell>
                    <TableCell>{i.protocol}</TableCell>
                    <TableCell className="font-mono text-xs">{i.username}</TableCell>
                    <TableCell>
                      <span className="inline-flex gap-1">
                        <Button size="xs" variant="ghost" onClick={() => {
                          if (!host) { toast('error', 'no host'); return }
                          copyText(shareURL(i, host)).then(() => toast('success', 'Copied mierus://'))
                        }}>Copy URL</Button>
                        <Button size="xs" variant="ghost" onClick={() => setDialog({ kind: 'edit', inbound: i })}>Edit</Button>
                        <Button size="xs" variant="ghost" onClick={() => setPendingDelete(i)}>Delete</Button>
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
                {rows.length === 0 && <TableEmpty colSpan={5}>No inbounds</TableEmpty>}
              </TableBody>
            </Table>
          </div>
        )
      })}
      {dialog?.kind === 'new' && (
        <InboundDialog open onOpenChange={(o) => { if (!o) setDialog(null) }} mode="create" defaultServerID={dialog.serverID} />
      )}
      {dialog?.kind === 'edit' && (
        <InboundDialog open onOpenChange={(o) => { if (!o) setDialog(null) }} mode="edit" inbound={dialog.inbound} />
      )}
      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(o) => { if (!o) setPendingDelete(null) }}
        title="Delete inbound?"
        onConfirm={() => { if (pendingDelete) del.mutate(pendingDelete.id); setPendingDelete(null) }}
      />
    </div>
  )
}
