import { useNavigate } from 'react-router-dom'
import { Sparkline } from './Sparkline'

export type TopListItem = {
  id: number
  name: string
  value: string
  sparkData: number[]
}

type Props = {
  title: string
  items: TopListItem[]
  /** Base path prefix; navigate will be called with `${linkBase}/${item.id}` */
  linkBase: string
}

/**
 * TopList — card with title + N clickable rows.
 * Each row: name (mono), sparkline, value (mono, tabular, right-aligned).
 * Maps to the design's <TopList> primitive.
 */
export function TopList({ title, items, linkBase }: Props) {
  const navigate = useNavigate()

  return (
    <div className="bg-elev border rounded-lg overflow-hidden">
      {/* card-head */}
      <div className="px-4 pt-3 pb-2.5 flex items-center gap-2 border-b">
        <span className="text-foreground font-medium text-[12.5px]">{title}</span>
      </div>

      <div className="px-3.5 py-2">
        {items.length === 0 && (
          <p className="text-muted-foreground text-[12.5px] py-2">—</p>
        )}
        {items.map((item, i) => (
          <button
            key={item.id}
            className={
              'w-full flex items-center gap-3 py-2 text-left cursor-pointer hover:bg-muted/40 transition-colors ' +
              (i < items.length - 1 ? 'border-b border-dashed' : '')
            }
            onClick={() => navigate(`${linkBase}/${item.id}`)}
          >
            <span className="font-mono text-[13px] flex-1 min-w-0 truncate text-foreground">
              {item.name}
            </span>
            <Sparkline
              values={item.sparkData}
              width={64}
              height={20}
              className="text-primary shrink-0"
              ariaLabel={`${item.name} sparkline`}
            />
            <span className="font-mono tabular-nums text-[13px] font-medium min-w-[48px] text-right shrink-0">
              {item.value}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
