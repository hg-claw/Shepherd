import { ChevronDown, ChevronUp } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SortState } from '@/lib/useTableSort'
import { TableHead } from '@/components/ui/table'

export function SortableTh({
  label,
  sortKey,
  sort,
  onToggle,
  className,
}: {
  label: React.ReactNode
  sortKey: string
  sort: SortState
  onToggle: (key: string) => void
  className?: string
}) {
  const active = sort?.key === sortKey
  return (
    <TableHead
      className={cn('cursor-pointer select-none', className)}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
      onClick={() => onToggle(sortKey)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active &&
          (sort.dir === 'asc' ? (
            <ChevronUp className="h-3 w-3" />
          ) : (
            <ChevronDown className="h-3 w-3" />
          ))}
      </span>
    </TableHead>
  )
}
