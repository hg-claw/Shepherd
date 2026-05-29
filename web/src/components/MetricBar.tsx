import { cn } from '@/lib/utils'

// MetricBar: a thin labeled usage bar. Threshold colors match the product's
// 80% warn / 92% alert bands.
export function MetricBar({ label, value }: { label: string; value: number }) {
  const tone = value >= 92 ? 'err' : value >= 80 ? 'warn' : 'ok'
  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-fg-dim text-[10px] w-[30px] shrink-0">{label}</span>
      <div className="flex-1 h-1.5 rounded-[3px] bg-sunken overflow-hidden">
        <div
          className={cn('h-full rounded-[3px]', tone === 'err' ? 'bg-err' : tone === 'warn' ? 'bg-warn' : 'bg-primary')}
          style={{ width: `${Math.min(100, value)}%` }}
        />
      </div>
      <span
        className={cn('font-mono tabular-nums text-[11px] w-[34px] text-right', tone === 'warn' && 'text-warn', tone === 'err' && 'text-err')}
      >
        {value.toFixed(0)}%
      </span>
    </div>
  )
}
