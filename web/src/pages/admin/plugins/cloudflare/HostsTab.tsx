import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { useServers } from '@/api/servers'
import { listHostDomains, addHostDomain, removeHostDomain, type HostDomain } from '@/api/plugins'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell, TableEmpty } from '@/components/ui/table'
import { useUI } from '@/store/ui'

export default function HostsTab() {
  const { t } = useTranslation()
  const toast = useUI((s) => s.toast)
  const serversQ = useServers()
  const domainsQ = useQuery({
    queryKey: ['cf-host-domains'],
    queryFn: () => listHostDomains(),
    refetchInterval: 30_000,
  })
  const qc = useQueryClient()
  const add = useMutation({
    mutationFn: addHostDomain,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cf-host-domains'] }),
    onError: (e: any) => toast('error', String(e?.message ?? e)),
  })
  const remove = useMutation({
    mutationFn: removeHostDomain,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cf-host-domains'] }),
    onError: (e: any) => toast('error', String(e?.message ?? e)),
  })

  const byServer = new Map<number, HostDomain[]>()
  for (const d of domainsQ.data ?? []) {
    const arr = byServer.get(d.server_id) ?? []
    arr.push(d)
    byServer.set(d.server_id, arr)
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {t('cloudflare.hosts.description_pre', 'Per-server domain mappings. The "Add default" button creates')}{' '}
        <code>{'{server}.{prefix}.{zone}'}</code>{' '}
        {t('cloudflare.hosts.description_post', "pointing to the server's SSH host. Add custom domains via the input.")}
      </p>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>{t('cloudflare.hosts.server', 'Server')}</TableHead>
            <TableHead>{t('cloudflare.hosts.domains', 'Domains')}</TableHead>
            <TableHead className="text-right">{t('cloudflare.hosts.add_header', 'Add')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(serversQ.data ?? []).map((s) => (
            <ServerRow key={s.id} server={s} domains={byServer.get(s.id) ?? []}
              onAddDefault={() => add.mutate({ server_id: s.id })}
              onAddCustom={(domain) => add.mutate({ server_id: s.id, domain })}
              onRemove={(id) => remove.mutate(id)}
              pending={add.isPending || remove.isPending}
            />
          ))}
          {(serversQ.data ?? []).length === 0 && (
            <TableEmpty colSpan={3}>{t('cloudflare.empty.hosts', 'No servers found.')}</TableEmpty>
          )}
        </TableBody>
      </Table>
    </div>
  )
}

function ServerRow({
  server, domains, onAddDefault, onAddCustom, onRemove, pending,
}: {
  server: { id: number; name: string; ssh_host?: { Valid: boolean; String: string } | null }
  domains: HostDomain[]
  onAddDefault: () => void
  onAddCustom: (domain: string) => void
  onRemove: (id: number) => void
  pending: boolean
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState('')
  return (
    <TableRow className="align-top">
      <TableCell className="font-mono">
        <div>{server.name}</div>
        <div className="text-fg-dim text-2xs">
          {server.ssh_host?.Valid ? server.ssh_host.String : '—'}
        </div>
      </TableCell>
      <TableCell>
        {domains.length === 0 ? (
          <span className="text-fg-dim text-xs">{t('cloudflare.hosts.no_domains', 'no domains')}</span>
        ) : (
          <ul className="space-y-1">
            {domains.map((d) => (
              <li key={d.id} className="flex items-center gap-2 text-sm">
                <span className="font-mono">{d.domain}</span>
                <span className="text-fg-dim text-2xs">→ {d.content} ({d.type})</span>
                <Button variant="ghost" size="xs" className="w-7 p-0 ml-auto"
                  onClick={() => onRemove(d.id)} disabled={pending} aria-label={t('cloudflare.hosts.remove_aria', 'remove')}>
                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2 flex gap-2">
          <Input value={draft} onChange={(e) => setDraft(e.target.value)}
            placeholder={t('cloudflare.hosts.custom_domain_placeholder', 'custom.example.com')}
            className="h-7 font-mono text-xs max-w-xs" />
          <Button size="xs" variant="outline"
            disabled={!draft || pending}
            onClick={() => { onAddCustom(draft); setDraft('') }}>
            <Plus className="h-3.5 w-3.5 mr-1" /> {t('cloudflare.hosts.add', 'add')}
          </Button>
        </div>
      </TableCell>
      <TableCell className="text-right">
        <Button size="xs"
          onClick={onAddDefault} disabled={pending}>
          <Plus className="h-3.5 w-3.5 mr-1" /> {t('cloudflare.hosts.default', 'default')}
        </Button>
      </TableCell>
    </TableRow>
  )
}
