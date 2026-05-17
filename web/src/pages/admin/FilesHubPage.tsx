import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { FolderTree, ChevronRight } from 'lucide-react'
import { useServers } from '@/api/servers'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

// File browser is per-server (sandbox is configured server-wide but
// applied via the agent on each host). The hub page is the host-picker
// landing matching the design's Files entry — pick a host, then jump
// into the per-host browser at /admin/files/<id>.
export default function FilesHubPage() {
  const { t } = useTranslation()
  const [filter, setFilter] = useState('')
  const { data, isLoading } = useServers({ refetchInterval: 30_000 })

  if (isLoading) return <div className="text-muted-foreground">{t('common.loading')}</div>
  const servers = (data ?? []).filter((s) => {
    if (!filter) return true
    const f = filter.toLowerCase()
    return s.name.toLowerCase().includes(f) || (s.ssh_host?.String ?? '').toLowerCase().includes(f)
  })

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight m-0">{t('nav.files', 'Files')}</h1>
        <p className="text-muted-foreground text-[13px] mt-1">
          {t('files.hub_sub', 'Pick a host to browse its filesystem and transfer files.')}
        </p>
      </div>

      <Input
        placeholder={t('common.filter', 'Filter…')}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        className="max-w-full sm:max-w-[260px] h-8 text-[13px]"
      />

      <div className="border rounded-lg bg-elev divide-y">
        {servers.length === 0 && (
          <div className="px-4 py-8 text-center text-muted-foreground text-[13px]">
            {t('files.hub_empty', 'No hosts available')}
          </div>
        )}
        {servers.map((s) => {
          const online =
            s.agent_last_seen?.Valid &&
            Date.now() - new Date(s.agent_last_seen.Time).getTime() <= 90_000
          return (
            <Link
              key={s.id}
              to={`/admin/files/${s.id}`}
              className="flex items-center gap-3 px-4 py-2.5 hover:bg-sunken transition-colors"
            >
              <FolderTree className="h-4 w-4 text-muted-foreground shrink-0" />
              <span
                className={cn(
                  'inline-block h-1.5 w-1.5 rounded-full shrink-0',
                  online ? 'bg-ok' : 'bg-fg-dim',
                )}
              />
              <span className="font-mono text-[13px] truncate flex-1">{s.name}</span>
              <span className="font-mono text-[11.5px] text-fg-dim truncate hidden sm:inline">
                {s.ssh_host?.String ?? '—'}
              </span>
              <ChevronRight className="h-4 w-4 text-fg-dim shrink-0" />
            </Link>
          )
        })}
      </div>
    </div>
  )
}
