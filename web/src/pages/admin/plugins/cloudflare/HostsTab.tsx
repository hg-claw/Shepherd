import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { useServers } from '@/api/servers'
import { listHostDomains, addHostDomain, removeHostDomain, type HostDomain } from '@/api/plugins'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useUI } from '@/store/ui'

export default function HostsTab() {
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
    <div className="space-y-3">
      <p className="text-[12.5px] text-muted-foreground">
        Per-server domain mappings. The "Add default" button creates <code>{'{server}.{prefix}.{zone}'}</code> pointing to the server's SSH host. Add custom domains via the input.
      </p>
      <div className="rounded-lg border bg-elev overflow-x-auto">
        <table className="w-full text-[13px] border-collapse">
          <thead>
            <tr className="text-left">
              <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Server</th>
              <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Domains</th>
              <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground text-right">Add</th>
            </tr>
          </thead>
          <tbody>
            {(serversQ.data ?? []).map((s) => (
              <ServerRow key={s.id} server={s} domains={byServer.get(s.id) ?? []}
                onAddDefault={() => add.mutate({ server_id: s.id })}
                onAddCustom={(domain) => add.mutate({ server_id: s.id, domain })}
                onRemove={(id) => remove.mutate(id)}
                pending={add.isPending || remove.isPending}
              />
            ))}
          </tbody>
        </table>
      </div>
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
  const [draft, setDraft] = useState('')
  return (
    <tr className="border-t align-top">
      <td className="px-3 py-2 font-mono">
        <div>{server.name}</div>
        <div className="text-fg-dim text-[11px]">
          {server.ssh_host?.Valid ? server.ssh_host.String : '—'}
        </div>
      </td>
      <td className="px-3 py-2">
        {domains.length === 0 ? (
          <span className="text-fg-dim text-[12px]">no domains</span>
        ) : (
          <ul className="space-y-1">
            {domains.map((d) => (
              <li key={d.id} className="flex items-center gap-2 text-[12.5px]">
                <span className="font-mono">{d.domain}</span>
                <span className="text-fg-dim text-[11px]">→ {d.content} ({d.type})</span>
                <Button variant="ghost" size="sm" className="h-6 w-6 p-0 ml-auto"
                  onClick={() => onRemove(d.id)} disabled={pending} aria-label="remove">
                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2 flex gap-2">
          <Input value={draft} onChange={(e) => setDraft(e.target.value)}
            placeholder="custom.example.com"
            className="h-7 font-mono text-[12px] max-w-xs" />
          <Button size="sm" variant="outline" className="h-7 px-2 text-[12px]"
            disabled={!draft || pending}
            onClick={() => { onAddCustom(draft); setDraft('') }}>
            <Plus className="h-3.5 w-3.5 mr-1" /> add
          </Button>
        </div>
      </td>
      <td className="px-3 py-2 text-right">
        <Button size="sm" className="h-7 px-2 text-[12px]"
          onClick={onAddDefault} disabled={pending}>
          <Plus className="h-3.5 w-3.5 mr-1" /> default
        </Button>
      </td>
    </tr>
  )
}
