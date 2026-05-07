import { useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useScriptRunDetail } from '@/api/scripts'
import { useServers } from '@/api/servers'
import { openConsole } from '@/api/console'
import { useConsoleTabs } from '@/store/consoleTabs'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'

export default function ScriptRunDetailPage() {
  const { t } = useTranslation()
  const { id } = useParams<{ id: string }>()
  const numId = id ? Number(id) : undefined
  const { data, isLoading } = useScriptRunDetail(numId, 2000)
  const { data: servers } = useServers()
  const openTab = useConsoleTabs((s) => s.open)

  const attach = async (serverId: number) => {
    const out = await openConsole(serverId, { rows: 24, cols: 80, term: 'xterm-256color' })
    openTab({
      id: `script-${out.session_id}`,
      sid: out.sid,
      sessionId: out.session_id,
      title: `script@${serverId}`,
      kind: 'script',
    })
  }

  if (isLoading) return <div>{t('common.loading')}</div>
  const targets = data ?? []
  const serverName = (sid: number) => servers?.find((s) => s.id === sid)?.name ?? `#${sid}`

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">
        {t('scripts.run', 'Run')} #{id}
      </h1>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('admin.servers', 'Server')}</TableHead>
            <TableHead>{t('scripts.status', 'Status')}</TableHead>
            <TableHead>{t('scripts.exit_code', 'Exit')}</TableHead>
            <TableHead className="text-right">{t('admin.actions', 'Actions')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {targets.map((tgt) => (
            <TableRow key={tgt.id}>
              <TableCell>{serverName(tgt.server_id)}</TableCell>
              <TableCell>
                <Badge variant={tgt.status === 'succeeded' ? 'default' : 'secondary'}>
                  {tgt.status}
                </Badge>
              </TableCell>
              <TableCell>{tgt.exit_code ?? '-'}</TableCell>
              <TableCell className="text-right">
                {tgt.status === 'running' && (
                  <Button size="sm" variant="outline" onClick={() => attach(tgt.server_id)}>
                    {t('console.attach', 'Attach')}
                  </Button>
                )}
                {tgt.pty_session_id && tgt.status !== 'running' && (
                  <Button size="sm" variant="ghost" asChild>
                    <a href={`/admin/recordings/${tgt.pty_session_id}`}>
                      {t('recording.replay', 'Replay')}
                    </a>
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
