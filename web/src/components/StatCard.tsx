import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

type Tone = 'ok' | 'warn' | 'err'

type Props = {
  label: string
  value: string | number
  sub?: string
  tone?: Tone
  icon?: LucideIcon
  variant?: 'kpi' | 'compact'
}

const toneClass: Record<Tone, string> = { ok: 'text-ok', warn: 'text-warn', err: 'text-err' }

/**
 * StatCard — unified stat tile. `kpi` = big number with eyebrow label;
 * `compact` = icon + value row.
 */
export function StatCard({ label, value, sub, tone, icon: Icon, variant = 'kpi' }: Props) {
  if (variant === 'compact') {
    return (
      <div className="bg-elev border rounded-lg p-3.5 flex items-center gap-3">
        {Icon && (
          <span className="grid place-items-center h-[34px] w-[34px] rounded-lg bg-sunken text-muted-foreground shrink-0">
            <Icon className="h-4 w-4" />
          </span>
        )}
        <div className="min-w-0">
          <div className="text-fg-dim text-2xs uppercase tracking-[0.05em]">{label}</div>
          <div className={cn('font-mono tabular-nums truncate text-lg leading-tight', tone && toneClass[tone])}>
            {value}
          </div>
          {sub && <div className="font-mono text-fg-dim truncate text-2xs mt-0.5">{sub}</div>}
        </div>
      </div>
    )
  }
  return (
    <div className="bg-elev border rounded-lg px-4 py-3.5">
      <div className="text-2xs uppercase tracking-[0.05em] text-muted-foreground whitespace-nowrap">
        {label}
      </div>
      <div
        className={cn(
          'font-mono text-display mt-1.5 tabular-nums leading-none tracking-tight',
          tone ? toneClass[tone] : 'text-foreground',
        )}
      >
        {value}
      </div>
      {sub && <div className="font-mono text-2xs text-muted-foreground mt-1.5">{sub}</div>}
    </div>
  )
}
