import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Card, CardContent } from './ui/card'
import { CountryFlag } from './CountryFlag'
import { OnlineDot } from './OnlineDot'
import { MetricBadge, type DisplayMode } from './MetricBadge'
import type { PublicCard } from '@/api/public'
import { cn } from '@/lib/utils'
import { relativeTime } from '@/lib/time'

type Props = {
  card: PublicCard
  mode: DisplayMode
}

export function MetricCard({ card, mode }: Props) {
  const { t } = useTranslation()
  const offline = !card.online
  const latest = card.latest

  const lastSeen = relativeTime(latest?.ts)
  const lastSeenLabel = lastSeen ? t(lastSeen.key, { n: lastSeen.n }) : '-'

  const cpuPct = latest?.cpu_pct ?? null
  const memPct = latest?.mem_pct ?? null
  const diskPct = latest?.disks_pct?.[0] ?? null

  return (
    <Link to={`/public/servers/${card.id}`} className="block">
      <Card className={cn('transition-colors hover:border-primary', offline && 'opacity-60')}>
        <CardContent className="space-y-3 p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CountryFlag code={card.country_code} />
              <span className="font-medium">{card.alias}</span>
            </div>
            <OnlineDot online={card.online} />
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t('metric.cpu')}</span>
              <MetricBadge metric="cpu" mode={mode} kind="pct" value={cpuPct} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t('metric.mem')}</span>
              <MetricBadge metric="mem" mode={mode} kind="pct" value={memPct} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t('metric.disk')}</span>
              <MetricBadge metric="disk" mode={mode} kind="pct" value={diskPct} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t('metric.net')}</span>
              <MetricBadge
                metric="net"
                mode={mode}
                kind="net"
                rxBps={latest?.net_rx_bps ?? 0}
                txBps={latest?.net_tx_bps ?? 0}
              />
            </div>
          </div>
          {offline && latest && (
            <div className="text-xs text-muted-foreground">{lastSeenLabel}</div>
          )}
        </CardContent>
      </Card>
    </Link>
  )
}
