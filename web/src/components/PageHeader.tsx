import { cn } from '@/lib/utils'

export function PageHeader({ title, actions, className }: {
  title: React.ReactNode
  actions?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex items-center justify-between gap-3', className)}>
      <h1 className="text-title font-semibold tracking-tight m-0">{title}</h1>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}
