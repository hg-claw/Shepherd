import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

type Props = {
  icon?: LucideIcon
  title: string
  description?: string
  action?: React.ReactNode
  className?: string
}

export function EmptyState({ icon: Icon, title, description, action, className }: Props) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 py-10 text-center', className)}>
      {Icon && <Icon className="h-5 w-5 text-fg-dim" />}
      <div className="text-sm text-muted-foreground">{title}</div>
      {description && <div className="text-xs text-fg-dim">{description}</div>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  )
}
