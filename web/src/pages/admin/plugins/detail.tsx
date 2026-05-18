import { Suspense } from 'react'
import { useParams, Link, useLocation, Outlet } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { listPlugins } from '@/api/plugins'
import { lazyPluginPage, PluginRegistry } from './PluginRegistry'
import { cn } from '@/lib/utils'

export default function PluginDetail() {
  const { id = '' } = useParams<{ id: string }>()
  const loc = useLocation()
  const q = useQuery({ queryKey: ['plugins'], queryFn: listPlugins })
  const entry = q.data?.find((p) => p.id === id)
  const ui = PluginRegistry[id]
  const PluginPage = lazyPluginPage(id)

  if (!entry || !ui || !PluginPage) {
    return <div className="text-muted-foreground">Unknown plugin: {id}</div>
  }

  const activeTab = (() => {
    const m = loc.pathname.match(/\/admin\/plugins\/[^/]+\/([^/]+)/)
    return m ? m[1] : ui.tabs[0].key
  })()

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-3 flex-wrap">
        <h1 className="text-[22px] font-semibold tracking-tight m-0">{entry.meta.name}</h1>
        <span className="text-fg-dim text-[12.5px] font-mono">{entry.meta.category}</span>
      </div>
      <div className="border-b flex gap-1">
        {ui.tabs.map((t) => (
          <Link
            key={t.key}
            to={`/admin/plugins/${id}/${t.key}`}
            className={cn(
              'px-3 py-1.5 text-[12.5px] -mb-px border-b-2 transition-colors',
              activeTab === t.key
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </Link>
        ))}
      </div>
      <Suspense fallback={<div className="text-muted-foreground">Loading…</div>}>
        <PluginPage />
      </Suspense>
      <Outlet />
    </div>
  )
}
