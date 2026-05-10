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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl sm:text-2xl font-semibold">{t('scripts.title', 'Scripts')}</h1>
        <Button asChild size="sm">
          <Link to="/admin/scripts/new">
            <Plus className="mr-1 h-4 w-4" />
            {t('scripts.new', 'New')}
          </Link>
        </Button>
      </div>
      <div className="rounded-md border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('scripts.name', 'Name')}</TableHead>
              <TableHead className="hidden sm:table-cell">{t('scripts.description', 'Description')}</TableHead>
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
                <TableCell className="hidden sm:table-cell text-sm text-muted-foreground">
                  {s.description}
                </TableCell>
                <TableCell className="text-right whitespace-nowrap">
                  <Button variant="ghost" size="sm" asChild className="px-2">
                    <Link to={`/admin/scripts/${s.id}/run`}>{t('scripts.run', 'Run')}</Link>
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => del.mutate(s.id)}
                    disabled={del.isPending}
                    className="px-2"
                    aria-label="delete"
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
