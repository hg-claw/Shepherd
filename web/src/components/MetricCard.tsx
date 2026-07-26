import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { CountryFlag } from './CountryFlag'
import { type DisplayMode } from './MetricBadge'
import type { PublicCard, NetqualityISPSummary } from '@/api/public'
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
          status === 'ok' && 'border-ok/30',
          status === 'warn' && 'border-warn/50',
          status === 'err' && 'border-err/50',
          status === 'offline' && 'opacity-60',
        )}
      >
        <div className="flex items-center gap-2">
          <CountryFlag code={card.country_code} />
          <span className="font-mono text-2xs text-muted-foreground truncate">{card.alias}</span>
        </div>
        <div
          className={cn(
            'font-mono text-title mt-0.5 tracking-tight tabular-nums leading-none',
            status === 'warn' && 'text-warn',
            status === 'err' && 'text-err',
          )}
        >
          {headline}
        </div>
        <div className="flex gap-2 mt-1.5 font-mono text-2xs text-fg-dim">
          <span>MEM {mem != null ? `${mem.toFixed(0)}%` : '—'}</span>
          {disk != null && <span>DSK {disk.toFixed(0)}%</span>}
        </div>
        {/* Netquality per-ISP RTT pills — render only when the plugin
            is enabled on this server AND has recent samples. Hidden by
            default so cards for hosts without the plugin stay compact. */}
        {card.netquality && card.netquality.length > 0 && (
          <NetqualityPills items={card.netquality} />
        )}
        {status === 'offline' && (
          <div className="mt-1.5 text-2xs text-fg-dim font-mono">{lastSeenLabel}</div>
        )}
      </div>
    </Link>
  )
}

// ── Netquality pills ─────────────────────────────────────────────────────────

const ISP_SHORT: Record<NetqualityISPSummary['isp'], string> = {
  telecom: '电',
  unicom: '联',
  mobile: '移',
  overseas: '外',
}

// Loss > 10% steals the colour from RTT — a fast-looking line that
// drops 30% of packets isn't actually fast.
function rttTone(rtt: number, loss: number): 'ok' | 'warn' | 'err' {
  if (loss >= 50) return 'err'
  if (loss >= 10) return 'warn'
  if (rtt >= 250) return 'err'
  if (rtt >= 150) return 'warn'
  return 'ok'
}

function NetqualityPills({ items }: { items: NetqualityISPSummary[] }) {
  return (
    <div className="flex gap-1.5 mt-1.5 flex-wrap" onClick={(e) => e.preventDefault()}>
      {items.map((it) => {
        const tone = rttTone(it.rtt_avg_ms, it.loss_pct)
        return (
          <span
            key={it.isp}
            className={cn(
              'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-2xs font-mono tabular-nums',
              tone === 'ok' && 'bg-ok/10 text-ok',
              tone === 'warn' && 'bg-warn/15 text-warn',
              tone === 'err' && 'bg-err/15 text-err',
            )}
            title={`${it.isp}: ${it.rtt_avg_ms.toFixed(0)}ms / ${it.loss_pct.toFixed(0)}% loss`}
          >
            <span>{ISP_SHORT[it.isp]}</span>
            <span>{it.rtt_avg_ms.toFixed(0)}ms</span>
          </span>
        )
      })}
    </div>
  )
}
