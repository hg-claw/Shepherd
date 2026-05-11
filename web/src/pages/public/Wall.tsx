import { useTranslation } from 'react-i18next'
import { usePublicServers, usePublicSettings } from '@/api/public'
import { MetricCard } from '@/components/MetricCard'

export default function Wall() {
  const { t } = useTranslation()
  const servers = usePublicServers()
  const settings = usePublicSettings()
  const mode = settings.data?.public_display_mode ?? 'both'

  if (servers.isLoading) return <div className="text-muted-foreground">{t('common.loading')}</div>
  if (servers.error) return <div className="text-err">{t('common.error')}</div>

  const list = servers.data ?? []
  const total = list.length
  const online = list.filter((s) => s.online).length

  if (total === 0) {
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
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline gap-4 border-b pb-3.5">
        <div>
          <h1 className="text-[18px] font-mono tracking-tight">{t('wall.title')}</h1>
          <p className="text-[12px] text-muted-foreground mt-0.5">
            {t('wall.subtitle', 'Public health overview — identifying data redacted.')}
          </p>
        </div>
        <div className="ml-auto flex gap-5 sm:gap-6">
          <Stat label={t('wall.stat.total', 'Hosts')} value={String(total)} />
          <Stat label={t('wall.online')} value={String(online)} tone="ok" />
          <Stat label={t('wall.offline')} value={String(total - online)} tone={total - online > 0 ? 'err' : undefined} />
        </div>
      </div>
      {orderedGroups.map(([group, servers]) => (
        <section key={group} className="space-y-3">
          <div className="flex items-baseline gap-4 px-1 pt-1 pb-2 border-b border-dashed">
            <div>
              <h2 className="font-mono text-[13.5px] tracking-tight">{group || t('wall.ungrouped')}</h2>
              <p className="text-[11.5px] text-muted-foreground mt-0.5">{servers.length} hosts</p>
            </div>
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2">
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

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'err' }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10.5px] uppercase tracking-[0.06em] text-fg-dim whitespace-nowrap">{label}</span>
      <span
        className={
          'font-mono text-[18px] tabular-nums ' +
          (tone === 'ok' ? 'text-ok' : tone === 'err' ? 'text-err' : '')
        }
      >
        {value}
      </span>
    </div>
  )
}
