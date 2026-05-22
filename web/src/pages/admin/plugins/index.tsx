import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Cloud, Box, Activity, Package, Bell, Route } from 'lucide-react'
import * as icons from 'lucide-react'
import { listPlugins, enablePlugin, disablePlugin, type PluginEntry } from '@/api/plugins'
import { Button } from '@/components/ui/button'
import { KpiCard } from '@/components/KpiCard'
import { Pill } from '@/components/Pill'
import { cn } from '@/lib/utils'

// Map well-known plugin icon names to Lucide components
const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  cloud: Cloud,
  box: Box,
  shield: Activity,
  'file-text': Package,
  bell: Bell,
  route: Route,
}

function PluginIcon({ name, className }: { name: string; className?: string }) {
  const capitalise = (s: string) =>
    s.split('-').map((p) => p[0]?.toUpperCase() + p.slice(1)).join('')
  const Cmp =
    ICON_MAP[name] ||
    (icons as unknown as Record<string, React.ComponentType<{ className?: string }>>)[capitalise(name)] ||
    Package
  return <Cmp className={cn('h-[18px] w-[18px] text-muted-foreground', className)} />
}

type FilterKey = 'all' | 'enabled' | 'disabled'

export default function PluginsIndex() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [filter, setFilter] = useState<FilterKey>('all')

  const q = useQuery({ queryKey: ['plugins'], queryFn: listPlugins, refetchInterval: 30_000 })
  const plugins = q.data ?? []

  const enable = useMutation({
    mutationFn: (id: string) => enablePlugin(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plugins'] }),
  })
  const disable = useMutation({
    mutationFn: (id: string) => disablePlugin(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plugins'] }),
  })

  const enabledCount = plugins.filter((p) => p.enabled).length
  const disabledCount = plugins.length - enabledCount
  const totalHosts = plugins.reduce((acc, p) => acc + (p.host_count ?? 0), 0)

  const visible = plugins.filter((p) => {
    if (filter === 'enabled') return p.enabled
    if (filter === 'disabled') return !p.enabled
    return true
  })

  const chips: { key: FilterKey; label: string; count: number }[] = [
    { key: 'all',      label: t('filter.all', 'All'),           count: plugins.length },
    { key: 'enabled',  label: t('plugins.enabled', 'Enabled'),  count: enabledCount },
    { key: 'disabled', label: t('plugins.disabled', 'Disabled'), count: disabledCount },
  ]

  const isPending = enable.isPending || disable.isPending

  return (
    <div className="flex flex-col gap-5">
      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight m-0">
            {t('nav.plugins', 'Plugins')}
          </h1>
          <p className="text-[13px] text-muted-foreground mt-1 max-w-[720px]">
            {t('plugins.subtitle', 'Extend the Shepherd agent with log parsers, extra metric collectors, proxy runtimes, and alert routers.')}
          </p>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-3 gap-3">
        <KpiCard
          label={t('plugins.kpi.installed', 'Installed')}
          value={String(plugins.length)}
          sub={t('plugins.kpi.installed_sub', 'local registry')}
        />
        <KpiCard
          label={t('plugins.kpi.enabled', 'Enabled')}
          value={String(enabledCount)}
          sub={t('plugins.kpi.enabled_sub', 'actively running')}
          tone={enabledCount > 0 ? 'ok' : undefined}
        />
        <KpiCard
          label={t('plugins.kpi.hosts', 'Hosts')}
          value={String(totalHosts)}
          sub={t('plugins.kpi.hosts_sub', 'across all plugins')}
        />
      </div>

      {/* Filter chips */}
      <div className="flex items-center gap-2 flex-wrap">
        {chips.map((c) => (
          <button
            key={c.key}
            onClick={() => setFilter(c.key)}
            className={cn(
              'inline-flex items-center gap-1.5 h-[26px] px-2.5 rounded-full text-[12px] transition-colors',
              'bg-sunken border border-transparent text-muted-foreground hover:text-foreground',
              filter === c.key && 'bg-accent text-accent-foreground',
            )}
          >
            {c.label}
            <span className="font-mono text-[11px] opacity-70">{c.count}</span>
          </button>
        ))}
      </div>

      {/* Plugin grid */}
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
        {visible.map((p) => (
          <PluginCard
            key={p.id}
            p={p}
            isPending={isPending}
            onEnable={() => enable.mutate(p.id)}
            onDisable={() => disable.mutate(p.id)}
          />
        ))}
      </div>
    </div>
  )
}

interface PluginCardProps {
  p: PluginEntry
  isPending: boolean
  onEnable: () => void
  onDisable: () => void
}

function PluginCard({ p, isPending, onEnable, onDisable }: PluginCardProps) {
  const { t } = useTranslation()

  return (
    <div className="bg-elev border rounded-lg flex flex-col">
      {/* Clickable top area */}
      <Link
        to={`/admin/plugins/${p.id}`}
        className="flex items-start gap-3 p-[14px_16px] color-inherit hover:no-underline flex-1"
      >
        <div className="h-9 w-9 rounded-md bg-sunken border grid place-items-center shrink-0">
          <PluginIcon name={p.meta.icon} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-mono font-medium text-[13.5px] truncate flex-1 min-w-0 text-foreground">
              {p.meta.name}
            </span>
            <Pill kind={p.enabled ? 'ok' : 'neutral'}>
              {p.enabled ? t('plugins.pill.enabled', 'enabled') : t('plugins.pill.disabled', 'disabled')}
            </Pill>
          </div>
          <p className="text-[12.5px] text-muted-foreground mt-1.5 leading-[1.45] min-h-[2.4em] line-clamp-2">
            {p.meta.description}
          </p>
        </div>
      </Link>

      {/* Footer row */}
      <div className="border-t border-dashed px-[14px] py-[10px] flex items-center gap-3 font-mono text-[11.5px] text-fg-dim mt-auto">
        <span>{p.meta.category}</span>
        {p.enabled && p.host_count != null && (
          <>
            <span>·</span>
            <span>{p.host_count} {t('plugins.hosts', 'hosts')}</span>
          </>
        )}
        <span className="ml-auto">
          {p.enabled ? (
            <Button
              size="sm"
              variant="outline"
              className="h-[26px] text-[12px]"
              disabled={isPending}
              onClick={onDisable}
            >
              {t('plugins.action.disable', 'Disable')}
            </Button>
          ) : (
            <Button
              size="sm"
              className="h-[26px] text-[12px]"
              disabled={isPending}
              onClick={onEnable}
            >
              {t('plugins.action.enable', 'Enable')}
            </Button>
          )}
        </span>
      </div>
    </div>
  )
}
