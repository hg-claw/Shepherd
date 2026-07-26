import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Table, TableHeader, TableBody, TableFooter, TableRow, TableHead, TableCell, TableEmpty,
} from '@/components/ui/table'

interface Zone   { id: string; name: string }
interface Record { id: string; name: string; type: string; content: string; ttl?: number; proxied?: boolean }

export default function DnsTab() {
  const { t } = useTranslation()
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
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <select value={zoneID} onChange={(e) => setZoneID(e.target.value)}
          className="h-8 px-2 rounded-md border bg-background text-sm font-mono">
          {(zonesQ.data ?? []).map((z) => (
            <option key={z.id} value={z.id}>{z.name}</option>
          ))}
        </select>
      </div>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>{t('cloudflare.dns.name', 'Name')}</TableHead>
            <TableHead>{t('cloudflare.dns.type', 'Type')}</TableHead>
            <TableHead>{t('cloudflare.dns.content', 'Content')}</TableHead>
            <TableHead>{t('cloudflare.dns.ttl', 'TTL')}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {(recsQ.data ?? []).map((r) => (
            <TableRow key={r.id}>
              <TableCell className="font-mono">{r.name}</TableCell>
              <TableCell className="font-mono text-xs">{r.type}</TableCell>
              <TableCell className="font-mono text-xs">{r.content}</TableCell>
              <TableCell className="font-mono text-xs">{r.ttl ?? '—'}</TableCell>
              <TableCell className="text-right">
                <Button variant="ghost" size="xs"
                  onClick={() => remove.mutate(r.id)}>{t('admin.delete', 'Delete')}</Button>
              </TableCell>
            </TableRow>
          ))}
          {(recsQ.data ?? []).length === 0 && (
            <TableEmpty colSpan={5}>{t('cloudflare.empty.dns', 'No DNS records yet.')}</TableEmpty>
          )}
        </TableBody>
        <TableFooter className="bg-sunken/40 font-normal">
          <TableRow className="hover:bg-transparent">
            <TableCell>
              <Input placeholder={t('cloudflare.dns.name_placeholder', 'record name')} value={draft.name ?? ''} className="h-7 font-mono text-sm"
                onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </TableCell>
            <TableCell>
              <select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })}
                className="h-7 px-2 rounded border bg-background text-sm font-mono">
                {['A','AAAA','CNAME','TXT','MX'].map((rt) => <option key={rt}>{rt}</option>)}
              </select>
            </TableCell>
            <TableCell>
              <Input placeholder={t('cloudflare.dns.content_placeholder', 'content')} value={draft.content ?? ''} className="h-7 font-mono text-sm"
                onChange={(e) => setDraft({ ...draft, content: e.target.value })} />
            </TableCell>
            <TableCell className="text-fg-dim text-2xs">{t('cloudflare.dns.ttl_auto', 'auto')}</TableCell>
            <TableCell className="text-right">
              <Button size="xs"
                disabled={!draft.name || !draft.content}
                onClick={() => { create.mutate({ ...draft, ttl: 1, proxied: false }); setDraft({ type: 'A', name: '', content: '' }) }}>
                {t('cloudflare.dns.add', 'Add')}
              </Button>
            </TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    </div>
  )
}
