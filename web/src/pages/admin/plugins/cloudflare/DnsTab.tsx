import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  Table, TableHeader, TableBody, TableFooter, TableRow, TableHead, TableCell, TableEmpty,
} from '@/components/ui/table'

interface Zone   { id: string; name: string }
interface DnsRecord { id: string; name: string; type: string; content: string; ttl?: number; proxied?: boolean }

const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'MX']

// Only these types may carry Cloudflare's proxied flag; sending proxied for
// TXT/MX makes the API reject the whole update.
const PROXIABLE: Record<string, true> = { A: true, AAAA: true, CNAME: true }

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
    queryFn: () => api.get<DnsRecord[]>(`/api/admin/plugins/cloudflare/zones/${zoneID}/records`),
  })

  const create = useMutation({
    mutationFn: (body: Partial<DnsRecord>) => api.post(`/api/admin/plugins/cloudflare/zones/${zoneID}/records`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cf-records', zoneID] }),
  })
  const update = useMutation({
    mutationFn: ({ rid, body }: { rid: string; body: Partial<DnsRecord> }) =>
      api.patch(`/api/admin/plugins/cloudflare/zones/${zoneID}/records/${rid}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cf-records', zoneID] })
      setEditing(null)
    },
  })
  const remove = useMutation({
    mutationFn: (rid: string) => api.del(`/api/admin/plugins/cloudflare/zones/${zoneID}/records/${rid}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cf-records', zoneID] }),
  })

  const [draft, setDraft] = useState<Partial<DnsRecord>>({ type: 'A', name: '', content: '' })
  const [editing, setEditing] = useState<DnsRecord | null>(null)

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
              {/* TXT values (SPF/DKIM/domain-verify) run hundreds of chars;
                  truncate with ellipsis, full value in the tooltip. */}
              <TableCell className="font-mono text-xs max-w-[16rem] sm:max-w-[24rem]">
                <span className="block truncate" title={r.content}>{r.content}</span>
              </TableCell>
              <TableCell className="font-mono text-xs">{r.ttl ?? '—'}</TableCell>
              <TableCell className="text-right">
                <div className="inline-flex gap-1">
                  <Button variant="ghost" size="xs"
                    onClick={() => setEditing(r)}>{t('cloudflare.dns.edit', 'Edit')}</Button>
                  <Button variant="ghost" size="xs"
                    onClick={() => remove.mutate(r.id)}>{t('admin.delete', 'Delete')}</Button>
                </div>
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
                {RECORD_TYPES.map((rt) => <option key={rt}>{rt}</option>)}
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

      {/* key resets the form when a different record is opened */}
      {editing && (
        <EditRecordDialog
          key={editing.id}
          rec={editing}
          saving={update.isPending}
          onClose={() => setEditing(null)}
          onSave={(body) => update.mutate({ rid: editing.id, body })}
        />
      )}
    </div>
  )
}

function EditRecordDialog({
  rec, saving, onClose, onSave,
}: {
  rec: DnsRecord
  saving: boolean
  onClose: () => void
  onSave: (body: Partial<DnsRecord>) => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState(rec.name)
  const [type, setType] = useState(rec.type)
  const [content, setContent] = useState(rec.content)
  const [ttl, setTtl] = useState(String(rec.ttl ?? 1))
  const [proxied, setProxied] = useState(rec.proxied ?? false)

  const canSave = name.trim() !== '' && content.trim() !== '' && !saving
  const submit = () => {
    const parsed = parseInt(ttl, 10)
    const body: Partial<DnsRecord> = {
      type,
      name: name.trim(),
      content: content.trim(),
      ttl: Number.isFinite(parsed) && parsed > 0 ? parsed : 1,
    }
    if (PROXIABLE[type]) body.proxied = proxied
    onSave(body)
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('cloudflare.dns.edit_title', 'Edit record')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-[1fr_120px] gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="cf-edit-name">{t('cloudflare.dns.name', 'Name')}</Label>
              <Input id="cf-edit-name" className="font-mono text-sm" value={name}
                onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cf-edit-type">{t('cloudflare.dns.type', 'Type')}</Label>
              <select id="cf-edit-type" value={type} onChange={(e) => setType(e.target.value)}
                className="h-9 w-full px-2 rounded-md border bg-background text-sm font-mono">
                {RECORD_TYPES.map((rt) => <option key={rt}>{rt}</option>)}
              </select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cf-edit-content">{t('cloudflare.dns.content', 'Content')}</Label>
            <Input id="cf-edit-content" className="font-mono text-sm" value={content}
              onChange={(e) => setContent(e.target.value)} />
          </div>
          <div className="grid grid-cols-[120px_1fr] gap-3 items-end">
            <div className="space-y-1.5">
              <Label htmlFor="cf-edit-ttl">{t('cloudflare.dns.ttl', 'TTL')}</Label>
              <Input id="cf-edit-ttl" className="font-mono text-sm" value={ttl}
                placeholder={t('cloudflare.dns.ttl_hint', '1 = auto')}
                onChange={(e) => setTtl(e.target.value)} />
            </div>
            {PROXIABLE[type] && (
              <label className="flex items-center gap-2 text-sm pb-2 cursor-pointer">
                <input type="checkbox" checked={proxied}
                  onChange={(e) => setProxied(e.target.checked)} />
                {t('cloudflare.dns.proxied', 'Proxied (orange cloud)')}
              </label>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button size="sm" disabled={!canSave} onClick={submit}>
            {saving ? t('admin.saving', 'Saving…') : t('admin.save', 'Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
