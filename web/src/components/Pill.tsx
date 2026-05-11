import { cn } from '@/lib/utils'

export type PillKind = 'ok' | 'warn' | 'err' | 'neutral'

const styles: Record<PillKind, { bg: string; text: string; dot: string; pulse: string }> = {
  ok: { bg: 'bg-ok-soft', text: 'text-ok', dot: 'bg-ok', pulse: 'shep-pulse' },
  warn: { bg: 'bg-warn-soft', text: 'text-warn', dot: 'bg-warn', pulse: 'shep-pulse-warn' },
  err: { bg: 'bg-err-soft', text: 'text-err', dot: 'bg-err', pulse: 'shep-pulse-err' },
  neutral: { bg: 'bg-sunken', text: 'text-muted-foreground', dot: 'bg-muted-foreground', pulse: '' },
}

interface PillProps {
  kind: PillKind
  children: React.ReactNode
  className?: string
}

export function Pill({ kind, children, className }: PillProps) {
  const s = styles[kind]
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 h-5 px-2 rounded-full text-[11px] font-mono tracking-wide whitespace-nowrap border border-transparent',
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
