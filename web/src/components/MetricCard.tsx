import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { CountryFlag } from './CountryFlag'
import { type DisplayMode } from './MetricBadge'
import type { PublicCard } from '@/api/public'
import { cn } from '@/lib/utils'
import { relativeTime } from '@/lib/time'

type Props = {
  card: PublicCard
  mode: DisplayMode
}

// Highest individual metric % decides the tile's status border.
// Threshold matches `internal/serversvc/thresholds`: 80% warn, 92% alert.
function tileStatus(card: PublicCard): 'ok' | 'warn' | 'err' | 'offline' {
  if (!card.online) return 'offline'
  const l = card.latest
  if (!l) return 'ok'
  const top = Math.max(l.cpu_pct ?? 0, l.mem_pct ?? 0, ...(l.disks_pct ?? []))
  if (top >= 92) return 'err'
  if (top >= 80) return 'warn'
  return 'ok'
}

export function MetricCard({ card, mode: _mode }: Props) {
  const { t } = useTranslation()
  const latest = card.latest
  const lastSeen = relativeTime(latest?.ts)
  const lastSeenLabel = lastSeen ? t(lastSeen.key, { n: lastSeen.n }) : '-'
  const status = tileStatus(card)
  const cpu = latest?.cpu_pct ?? null
  const mem = latest?.mem_pct ?? null
  const disk = latest?.disks_pct?.[0] ?? null

  // Pick the headline metric to show large — CPU when online, mute when offline.
  const headline = status === 'offline' ? '—' : cpu != null ? `${cpu.toFixed(0)}%` : '—'

  return (
    <Link to={`/public/servers/${card.id}`} className="block group">
      <div
        className={cn(
          'relative bg-elev border rounded-lg px-3 py-2.5 transition-colors hover:border-primary',
          status === 'ok' && 'border-[hsl(var(--ok)/0.3)]',
          status === 'warn' && 'border-[hsl(var(--warn)/0.5)]',
          status === 'err' && 'border-[hsl(var(--err)/0.5)]',
          status === 'offline' && 'opacity-60',
        )}
      >
        <div className="flex items-center gap-2">
          <CountryFlag code={card.country_code} />
          <span className="font-mono text-[11.5px] text-muted-foreground truncate">{card.alias}</span>
        </div>
        <div
          className={cn(
            'font-mono text-[22px] mt-0.5 tracking-tight tabular-nums leading-none',
            status === 'warn' && 'text-warn',
            status === 'err' && 'text-err',
          )}
        >
          {headline}
        </div>
        <div className="flex gap-2 mt-1.5 font-mono text-[10.5px] text-fg-dim">
          <span>MEM {mem != null ? `${mem.toFixed(0)}%` : '—'}</span>
          {disk != null && <span>DSK {disk.toFixed(0)}%</span>}
        </div>
        {status === 'offline' && (
          <div className="mt-1.5 text-[10.5px] text-fg-dim font-mono">{lastSeenLabel}</div>
        )}
      </div>
    </Link>
  )
}
