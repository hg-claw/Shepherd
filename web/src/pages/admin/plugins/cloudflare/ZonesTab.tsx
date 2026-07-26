import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/api/client'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell, TableEmpty } from '@/components/ui/table'

interface Zone { id: string; name: string; status?: string; plan?: { name?: string } }

export default function ZonesTab() {
  const { t } = useTranslation()
  const q = useQuery({
    queryKey: ['cf-zones'],
    queryFn: () => api.get<Zone[]>('/api/admin/plugins/cloudflare/zones'),
    staleTime: 60_000,
  })
  const zones = q.data ?? []
  if (q.isError) {
    return (
      <div className="text-err text-sm">
        {t('cloudflare.zones.load_error', 'Failed to load zones: {{message}}', {
          message: (q.error as Error).message,
        })}
      </div>
    )
  }
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>{t('cloudflare.zones.name', 'Name')}</TableHead>
          <TableHead>{t('cloudflare.zones.status', 'Status')}</TableHead>
          <TableHead>{t('cloudflare.zones.plan', 'Plan')}</TableHead>
          <TableHead>{t('cloudflare.zones.id', 'ID')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {zones.map((z) => (
          <TableRow key={z.id}>
            <TableCell className="font-mono">{z.name}</TableCell>
            <TableCell className="text-xs text-muted-foreground">{z.status ?? '—'}</TableCell>
            <TableCell className="text-xs text-muted-foreground">{z.plan?.name ?? '—'}</TableCell>
            <TableCell className="font-mono text-2xs text-fg-dim">{z.id}</TableCell>
          </TableRow>
        ))}
        {zones.length === 0 && (
          <TableEmpty colSpan={4}>{t('cloudflare.empty.zones', 'No zones.')}</TableEmpty>
        )}
      </TableBody>
    </Table>
  )
}
