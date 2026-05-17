import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import * as icons from 'lucide-react'
import { listPlugins, enablePlugin, disablePlugin, type PluginEntry } from '@/api/plugins'
import { Button } from '@/components/ui/button'
import { Pill } from '@/components/Pill'
import { cn } from '@/lib/utils'

function Icon({ name }: { name: string }) {
  const Cmp = (icons as unknown as Record<string, React.ComponentType<{ className?: string }>>)[
    capitalise(name)
  ] || icons.Puzzle
  return <Cmp className="h-5 w-5 text-muted-foreground" />
}
function capitalise(s: string) {
  return s.split('-').map((p) => p[0]?.toUpperCase() + p.slice(1)).join('')
}

export default function PluginsIndex() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['plugins'], queryFn: listPlugins, refetchInterval: 30_000 })
  const enable = useMutation({
    mutationFn: (id: string) => enablePlugin(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plugins'] }),
  })
  const disable = useMutation({
    mutationFn: (id: string) => disablePlugin(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plugins'] }),
  })

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight m-0">
          {t('nav.plugins', 'Plugins')}
        </h1>
        <p className="text-muted-foreground text-[13px] mt-1">
          {t('plugins.subtitle')}
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {(q.data ?? []).map((p) => (
          <PluginCard
            key={p.id}
            p={p}
            onEnable={() => enable.mutate(p.id)}
            onDisable={() => disable.mutate(p.id)}
            pending={enable.isPending || disable.isPending}
          />
        ))}
      </div>
    </div>
  )
}

function PluginCard({
  p, onEnable, onDisable, pending,
}: { p: PluginEntry; onEnable: () => void; onDisable: () => void; pending: boolean }) {
  return (
    <div className="bg-elev border rounded-lg p-4 flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <div className="h-9 w-9 rounded-md bg-sunken border grid place-items-center shrink-0">
          <Icon name={p.meta.icon} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <Link to={`/admin/plugins/${p.id}`} className="font-medium hover:underline truncate">
              {p.meta.name}
            </Link>
            {p.enabled
              ? <Pill kind="ok">enabled</Pill>
              : <Pill kind="neutral">disabled</Pill>}
          </div>
          <p className="text-[12.5px] text-muted-foreground mt-1 line-clamp-2 min-h-[2.4em]">
            {p.meta.description}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 pt-2 border-t border-dashed text-[11.5px] font-mono text-fg-dim">
        <span>{p.meta.category}</span>
        {p.host_count != null && <span>· {p.host_count} hosts</span>}
        <span className="ml-auto">
          {p.enabled ? (
            <Button size="sm" variant="outline" className={cn('h-7 text-[12px]')} disabled={pending} onClick={onDisable}>
              Disable
            </Button>
          ) : (
            <Button size="sm" className={cn('h-7 text-[12px]')} disabled={pending} onClick={onEnable}>
              Enable
            </Button>
          )}
        </span>
      </div>
    </div>
  )
}
