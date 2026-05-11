import { useTranslation } from 'react-i18next'
import { usePublicServers, usePublicSettings } from '@/api/public'
import { MetricCard } from '@/components/MetricCard'

export default function Wall() {
  const { t } = useTranslation()
  const servers = usePublicServers()
  const settings = usePublicSettings()
  const mode = settings.data?.public_display_mode ?? 'both'

  if (servers.isLoading) return <div>{t('common.loading')}</div>
  if (servers.error) return <div>{t('common.error')}</div>

  const list = servers.data ?? []
  if (list.length === 0) {
    return <div className="text-muted-foreground">{t('wall.no_servers')}</div>
  }

  const groups = new Map<string, typeof list>()
  for (const s of list) {
    const key = s.group || ''
    const arr = groups.get(key) ?? []
    arr.push(s)
    groups.set(key, arr)
  }
  const orderedGroups = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))

  return (
    <div className="space-y-8">
      <h1 className="text-xl sm:text-2xl font-semibold">{t('wall.title')}</h1>
      {orderedGroups.map(([group, servers]) => (
        <section key={group} className="space-y-3">
          <h2 className="text-sm uppercase text-muted-foreground">
            {group || t('wall.ungrouped')}
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
            {servers
              .slice()
              .sort((a, b) => a.alias.localeCompare(b.alias))
              .map((s) => (
                <MetricCard key={s.id} card={s} mode={mode} />
              ))}
          </div>
        </section>
      ))}
    </div>
  )
}
