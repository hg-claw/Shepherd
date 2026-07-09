import { cn } from '@/lib/utils'
import { statusStyles, type StatusKind } from '@/lib/status'

export type PillKind = StatusKind

interface PillProps {
  kind: PillKind
  children: React.ReactNode
  className?: string
}

export function Pill({ kind, children, className }: PillProps) {
  const s = statusStyles[kind]
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 h-5 px-2 rounded-full text-2xs font-mono tracking-wide whitespace-nowrap border border-transparent',
        kind === 'neutral' && 'border-border',
        s.bg,
        s.text,
        className,
      )}
    >
      <span className={cn('inline-block h-1.5 w-1.5 rounded-full', s.dot, s.pulse)} />
      {children}
    </span>
  )
}
