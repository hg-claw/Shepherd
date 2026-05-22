import { cn } from '@/lib/utils'

interface SegOption<T extends string> {
  value: T
  label: string
  icon?: React.ComponentType<{ className?: string }>
}

interface SegProps<T extends string> {
  value: T
  onChange: (v: T) => void
  options: SegOption<T>[]
  size?: 'sm' | 'default'
  className?: string
}

/**
 * Seg — segmented toggle control.
 * Pill-style segment selector used for view toggles and small option groups.
 * Mirrors the design's <Seg> primitive.
 */
export function Seg<T extends string>({ value, onChange, options, size = 'default', className }: SegProps<T>) {
  const h = size === 'sm' ? 'h-7' : 'h-8'
  return (
    <div
      className={cn(
        'inline-flex border rounded-md bg-elev overflow-hidden',
        h,
        className,
      )}
    >
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            'px-2.5 font-mono text-[12px] inline-flex items-center gap-1.5 transition-colors',
            i < options.length - 1 && 'border-r',
            value === o.value
              ? 'bg-sunken text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {o.icon && <o.icon className="h-3.5 w-3.5" />}
          <span className="hidden sm:inline">{o.label}</span>
        </button>
      ))}
    </div>
  )
}
