import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Search, ChevronRight } from 'lucide-react'
import { useServers } from '@/api/servers'
import { Input } from '@/components/ui/input'
import { OnlineDot } from '@/components/OnlineDot'
import { cn } from '@/lib/utils'

// File browser is per-server (sandbox is configured server-wide but
// applied via the agent on each host). The hub page is the host-picker
// landing matching the design's Files entry — pick a host, then jump
// into the per-host browser at /admin/files/<id>.
export default function FilesHubPage() {
  const { t } = useTranslation()
  const [filter, setFilter] = useState('')
  const { data, isLoading } = useServers({ refetchInterval: 30_000 })

  if (isLoading) return <div className="text-muted-foreground text-[13px] p-4">{t('common.loading')}</div>
  const servers = data ?? []

  const filtered = servers.filter((s) => {
    if (!filter) return true
    const f = filter.toLowerCase()
    return (
      s.name.toLowerCase().includes(f) ||
      (s.ssh_host?.String ?? '').toLowerCase().includes(f) ||
      (s.public_group?.String?.toLowerCase() ?? '').includes(f)
    )
  })

  const onlineCount = servers.filter((s) => {
    const ls = s.agent_last_seen
    if (!ls || !ls.Valid) return false
    return Date.now() - new Date(ls.Time).getTime() <= 90_000
  }).length

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight m-0">{t('nav.files', 'Files')}</h1>
          <p className="text-muted-foreground text-[13px] mt-1">
            {t(
              'files.hub_sub',
              'Browse the remote filesystem and transfer files. Every action is audit-logged.',
            )}
          </p>
        </div>
        <span className="font-mono text-[11.5px] text-fg-dim">
          {onlineCount}/{servers.length} {t('files.online', 'online')}
        </span>
      </div>

      {/* Search */}
      <div className="relative max-w-full sm:max-w-[280px]">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-fg-dim pointer-events-none" />
        <Input
          placeholder={t('common.filter', 'Filter…')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="pl-8 h-8 text-[13px]"
        />
      </div>

      {/* Server card grid */}
      {filtered.length === 0 ? (
        <div className="border rounded-lg bg-elev px-4 py-8 text-center text-fg-dim font-mono text-[12px]">
          {filter ? t('common.no_match', 'no matching hosts') : t('files.hub_empty', 'No hosts available')}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {filtered.map((s) => {
            const ls = s.agent_last_seen
            const online = ls?.Valid
              ? Date.now() - new Date(ls.Time).getTime() <= 90_000
              : false
            return (
              <Link
                key={s.id}
                to={`/admin/files/${s.id}`}
                className={cn(
                  'group flex flex-col gap-2 px-4 py-3.5 border rounded-lg bg-elev transition-colors',
                  'hover:bg-sunken hover:border-muted-foreground/40',
                  !online && 'opacity-60',
                )}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <OnlineDot online={online} />
                  <span className="font-mono font-medium text-[13px] truncate flex-1">{s.name}</span>
                  <ChevronRight className="h-4 w-4 text-fg-dim group-hover:text-foreground transition-colors shrink-0" />
                </div>
                {s.ssh_host?.String && (
                  <div className="font-mono text-[11.5px] text-fg-dim truncate">
                    {s.ssh_host.String}
                  </div>
                )}
                {s.public_group?.String && (
                  <div className="flex items-center gap-1 mt-0.5">
                    <span className="inline-flex items-center h-4 px-1.5 rounded text-[10px] font-mono bg-sunken border border-border text-fg-dim">
                      {s.public_group.String}
                    </span>
                  </div>
                )}
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
