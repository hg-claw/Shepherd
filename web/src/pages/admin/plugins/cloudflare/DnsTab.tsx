import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface Zone   { id: string; name: string }
interface Record { id: string; name: string; type: string; content: string; ttl?: number; proxied?: boolean }

export default function DnsTab() {
  const qc = useQueryClient()
  const zonesQ = useQuery({
    queryKey: ['cf-zones'],
    queryFn: () => api.get<Zone[]>('/api/admin/plugins/cloudflare/zones'),
    staleTime: 60_000,
  })
  const [zoneID, setZoneID] = useState('')
  useEffect(() => {
    if (!zoneID && zonesQ.data?.length) setZoneID(zonesQ.data[0].id)
  }, [zonesQ.data, zoneID])

  const recsQ = useQuery({
    queryKey: ['cf-records', zoneID],
    enabled: !!zoneID,
    queryFn: () => api.get<Record[]>(`/api/admin/plugins/cloudflare/zones/${zoneID}/records`),
  })

  const create = useMutation({
    mutationFn: (body: Partial<Record>) => api.post(`/api/admin/plugins/cloudflare/zones/${zoneID}/records`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cf-records', zoneID] }),
  })
  const remove = useMutation({
    mutationFn: (rid: string) => api.del(`/api/admin/plugins/cloudflare/zones/${zoneID}/records/${rid}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cf-records', zoneID] }),
  })

  const [draft, setDraft] = useState<Partial<Record>>({ type: 'A', name: '', content: '' })

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <select value={zoneID} onChange={(e) => setZoneID(e.target.value)}
          className="h-8 px-2 rounded-md border bg-background text-sm font-mono">
          {(zonesQ.data ?? []).map((z) => (
            <option key={z.id} value={z.id}>{z.name}</option>
          ))}
        </select>
      </div>
      <div className="rounded-lg border bg-elev overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-left">
              <th className="px-3 py-2 text-2xs uppercase tracking-[0.05em] text-muted-foreground">Name</th>
              <th className="px-3 py-2 text-2xs uppercase tracking-[0.05em] text-muted-foreground">Type</th>
              <th className="px-3 py-2 text-2xs uppercase tracking-[0.05em] text-muted-foreground">Content</th>
              <th className="px-3 py-2 text-2xs uppercase tracking-[0.05em] text-muted-foreground">TTL</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(recsQ.data ?? []).map((r) => (
              <tr key={r.id} className="border-t">
                <td className="px-3 py-2 font-mono">{r.name}</td>
                <td className="px-3 py-2 font-mono text-xs">{r.type}</td>
                <td className="px-3 py-2 font-mono text-xs">{r.content}</td>
                <td className="px-3 py-2 font-mono text-xs">{r.ttl ?? '—'}</td>
                <td className="px-3 py-2 text-right">
                  <Button variant="ghost" size="xs"
                    onClick={() => remove.mutate(r.id)}>Delete</Button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t bg-sunken/40">
              <td className="px-3 py-2">
                <Input placeholder="record name" value={draft.name ?? ''} className="h-7 font-mono text-sm"
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </td>
              <td className="px-3 py-2">
                <select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })}
                  className="h-7 px-2 rounded border bg-background text-sm font-mono">
                  {['A','AAAA','CNAME','TXT','MX'].map((t) => <option key={t}>{t}</option>)}
                </select>
              </td>
              <td className="px-3 py-2">
                <Input placeholder="content" value={draft.content ?? ''} className="h-7 font-mono text-sm"
                  onChange={(e) => setDraft({ ...draft, content: e.target.value })} />
              </td>
              <td className="px-3 py-2 text-fg-dim text-2xs">auto</td>
              <td className="px-3 py-2 text-right">
                <Button size="xs"
                  disabled={!draft.name || !draft.content}
                  onClick={() => { create.mutate({ ...draft, ttl: 1, proxied: false }); setDraft({ type: 'A', name: '', content: '' }) }}>
                  Add
                </Button>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}
