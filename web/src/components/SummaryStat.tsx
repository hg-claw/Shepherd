import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export function SummaryStat({
  label, value, sub, tone, icon: Icon,
}: {
  label: string; value: string; sub?: string; tone?: 'ok' | 'err'; icon: LucideIcon
}) {
  return (
    <div className="bg-elev border rounded-lg p-3.5 flex items-center gap-3">
      <span className="grid place-items-center h-[34px] w-[34px] rounded-lg bg-sunken text-muted-foreground shrink-0">
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <div className="text-fg-dim text-[10.5px] uppercase tracking-[0.05em]">{label}</div>
        <div className={cn('font-mono tabular-nums truncate text-[16px] leading-tight', tone === 'ok' && 'text-ok', tone === 'err' && 'text-err')}>{value}</div>
        {sub && <div className="font-mono text-fg-dim truncate text-[11px] mt-0.5">{sub}</div>}
      </div>
    </div>
  )
}
