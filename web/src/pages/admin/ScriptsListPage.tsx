import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { Plus, Trash2 } from 'lucide-react'
import { useScripts, useDeleteScript } from '@/api/scripts'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

export default function ScriptsListPage() {
  const { t } = useTranslation()
  const { data, isLoading } = useScripts()
  const del = useDeleteScript()
  if (isLoading) return <div>{t('common.loading')}</div>
  const scripts = data ?? []
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t('scripts.title', 'Scripts')}</h1>
        <Button asChild>
          <Link to="/admin/scripts/new">
            <Plus className="mr-1 h-4 w-4" />
            {t('scripts.new', 'New')}
          </Link>
        </Button>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('scripts.name', 'Name')}</TableHead>
            <TableHead>{t('scripts.description', 'Description')}</TableHead>
            <TableHead className="w-32 text-right">{t('admin.actions', 'Actions')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {scripts.map((s) => (
            <TableRow key={s.id}>
              <TableCell className="font-medium">
                <Link to={`/admin/scripts/${s.id}`} className="hover:underline">
                  {s.name}
                </Link>
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">{s.description}</TableCell>
              <TableCell className="text-right">
                <Button variant="ghost" size="sm" asChild className="mr-1">
                  <Link to={`/admin/scripts/${s.id}/run`}>{t('scripts.run', 'Run')}</Link>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => del.mutate(s.id)}
                  disabled={del.isPending}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
