import { Suspense } from 'react'
import { useParams, Link, useLocation, Outlet } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Cloud, Box, Activity, Package, Bell, Route, ChevronRight } from 'lucide-react'
import * as icons from 'lucide-react'
import { listPlugins } from '@/api/plugins'
import { lazyPluginPage, PluginRegistry } from './PluginRegistry'
import { Pill } from '@/components/Pill'
import { cn } from '@/lib/utils'

// Mirror the same icon map used by the index page
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
  return <Cmp className={cn('h-[22px] w-[22px] text-muted-foreground', className)} />
}

export default function PluginDetail() {
  const { t } = useTranslation()
  const { id = '' } = useParams<{ id: string }>()
  const loc = useLocation()
  const q = useQuery({ queryKey: ['plugins'], queryFn: listPlugins })
  const entry = q.data?.find((p) => p.id === id)
  const ui = PluginRegistry[id]
  const PluginPage = lazyPluginPage(id)

  if (!entry || !ui || !PluginPage) {
    return (
      <div className="flex flex-col gap-3">
        <h1 className="text-[22px] font-semibold tracking-tight m-0">
          {t('plugins.unknown', 'Unknown plugin')}
        </h1>
        <p className="text-muted-foreground text-[13px]">
          {t('plugins.unknown_body', 'No plugin registered with id')}{' '}
          <code className="font-mono bg-sunken px-1 rounded text-[12px]">{id}</code>
        </p>
        <div>
          <Link
            to="/admin/plugins"
            className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground transition-colors"
          >
            ← {t('plugins.back', 'Back to plugins')}
          </Link>
        </div>
      </div>
    )
  }

  const activeTab = (() => {
    const m = loc.pathname.match(/\/admin\/plugins\/[^/]+\/([^/]+)/)
    return m ? m[1] : ui.tabs[0].key
  })()

  return (
    <div className="flex flex-col gap-4">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
        <Link to="/admin/plugins" className="hover:text-foreground transition-colors">
          {t('nav.plugins', 'Plugins')}
        </Link>
        <ChevronRight className="h-3 w-3 opacity-50" />
        <span className="text-foreground">{entry.meta.name}</span>
      </nav>

      {/* Plugin header */}
      <div className="flex items-start gap-3">
        {/* Icon tile */}
        <div className="h-11 w-11 rounded-lg bg-sunken border grid place-items-center shrink-0">
          <PluginIcon name={entry.meta.icon} />
        </div>

        {/* Title + meta */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-[22px] font-semibold tracking-tight m-0">{entry.meta.name}</h1>
            <Pill kind={entry.enabled ? 'ok' : 'neutral'}>
              {entry.enabled ? t('plugins.pill.enabled', 'enabled') : t('plugins.pill.disabled', 'disabled')}
            </Pill>
            <span className="font-mono text-[11.5px] text-fg-dim">{entry.meta.category}</span>
            {entry.host_count != null && (
              <>
                <span className="font-mono text-[11.5px] text-fg-dim">·</span>
                <span className="font-mono text-[11.5px] text-fg-dim">
                  {entry.host_count} {t('plugins.hosts', 'hosts')}
                </span>
              </>
            )}
          </div>
          <p className="text-[13px] text-muted-foreground mt-1.5 max-w-[720px]">
            {entry.meta.description}
          </p>
        </div>
      </div>

      {/* Tab bar — underline style matching design */}
      <div className="border-b flex gap-1 overflow-x-auto">
        {ui.tabs.map((tab) => (
          <Link
            key={tab.key}
            to={`/admin/plugins/${id}/${tab.key}`}
            className={cn(
              'px-3 py-2 text-[13px] whitespace-nowrap -mb-px border-b-2 transition-colors',
              activeTab === tab.key
                ? 'border-foreground text-foreground font-medium'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
          </Link>
        ))}
      </div>

      {/* Tab content */}
      <Suspense fallback={<div className="text-muted-foreground text-[13px]">{t('common.loading', 'Loading…')}</div>}>
        <PluginPage />
      </Suspense>
      <Outlet />
    </div>
  )
}
