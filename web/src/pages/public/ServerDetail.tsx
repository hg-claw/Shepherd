import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft } from 'lucide-react'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Pill, type PillKind } from '@/components/Pill'
import { CountryFlag } from '@/components/CountryFlag'
import { TimeSeriesChart } from '@/components/TimeSeriesChart'
import { usePublicTelemetry, usePublicServers } from '@/api/public'
import type { Range } from '@/api/servers'
import { bps, pct } from '@/lib/bytes'
import { cn } from '@/lib/utils'

function statusKind(card: { online: boolean; latest?: { cpu_pct: number; mem_pct: number; disks_pct: number[] } }): {
  kind: PillKind
  label: string
} {
  if (!card.online) return { kind: 'neutral', label: 'Offline' }
  const l = card.latest
  if (!l) return { kind: 'ok', label: 'Operational' }
  const top = Math.max(l.cpu_pct ?? 0, l.mem_pct ?? 0, ...(l.disks_pct ?? []))
  if (top >= 92) return { kind: 'err', label: 'Degraded' }
  if (top >= 80) return { kind: 'warn', label: 'Warning' }
  return { kind: 'ok', label: 'Operational' }
}

export default function PublicServerDetail() {
  const { id: idStr } = useParams<{ id: string }>()
  const id = Number(idStr)
  const { t } = useTranslation()
  const [range, setRange] = useState<Range>('1h')

  // Reuse the wall list query so we pull the public-facing card data
  // (alias, group, country, online flag) without exposing internal names.
  const wall = usePublicServers()
  const card = wall.data?.find((c) => c.id === id)

  const tele = usePublicTelemetry(id, range)
  if (wall.isLoading || tele.isLoading) return <div className="text-muted-foreground">{t('common.loading')}</div>
  if (wall.error || !card) return <div className="text-err">{t('common.not_found')}</div>

  const points = tele.data ?? []
  const cpu = points.map((p) => ({ ts: p.ts, v: p.cpu_pct ?? 0 }))
  const memPct = points.map((p) => ({
    ts: p.ts,
    v: pct(p.mem_used, p.mem_total) ?? 0,
  }))
  const netRx = points.map((p) => ({ ts: p.ts, v: p.net_rx_bps ?? 0 }))
  const netTx = points.map((p) => ({ ts: p.ts, v: p.net_tx_bps ?? 0 }))
  const load = points.map((p) => ({ ts: p.ts, v: p.load_1 ?? 0 }))

  const latest = card.latest
  const { kind, label } = statusKind(card)
  const headlineCpu = latest ? `${latest.cpu_pct.toFixed(0)}%` : '—'
  const headlineMem = latest ? `${latest.mem_pct.toFixed(0)}%` : '—'
  const headlineDisk = latest?.disks_pct?.[0] != null ? `${latest.disks_pct[0].toFixed(0)}%` : '—'

  return (
    <div className="space-y-4">
      <div className="border rounded-lg bg-elev overflow-hidden">
        {/* Header bar — mirrors the design's TileDetail card-head */}
        <div className="flex items-center gap-3 px-4 py-3 border-b flex-wrap">
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            {t('common.back', 'Back')}
          </Link>
          <span className="text-fg-dim">/</span>
          <span className="flex items-center gap-2">
            <span
              className={cn(
                'inline-block h-2 w-2 rounded-full',
                kind === 'ok' && 'bg-ok',
                kind === 'warn' && 'bg-warn',
                kind === 'err' && 'bg-err',
                kind === 'neutral' && 'bg-fg-dim',
              )}
            />
            <span className="font-mono font-medium text-[14px]">{card.alias}</span>
          </span>
          {card.group && <Pill kind="neutral">{card.group}</Pill>}
          {card.country_code && (
            <Pill kind="neutral">
              <CountryFlag code={card.country_code} />
              <span className="ml-1">{card.country_code}</span>
            </Pill>
          )}
          <span className="ml-auto flex items-center gap-2 text-[12px] font-mono text-muted-foreground">
            status ·{' '}
            <span
              className={cn(
                'font-medium',
                kind === 'ok' && 'text-ok',
                kind === 'warn' && 'text-warn',
                kind === 'err' && 'text-err',
              )}
            >
              {label}
            </span>
          </span>
        </div>

        {/* KPI row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-4">
          <MiniKpi label="CPU" value={headlineCpu} tone={kind} />
          <MiniKpi label="Memory" value={headlineMem} />
          <MiniKpi label="Disk" value={headlineDisk} />
          <MiniKpi label="Last seen" value={lastSeenLabel(card, t)} mono />
        </div>

        {/* Range toggle */}
        <div className="px-4 pb-3 flex items-center justify-between flex-wrap gap-2 border-b">
          <p className="text-[12px] text-muted-foreground">
            {t('public_detail.window', 'Telemetry window')}
          </p>
          <Tabs value={range} onValueChange={(v) => setRange(v as Range)}>
            <TabsList className="h-8">
              <TabsTrigger value="1h" className="text-[12px] px-2.5">{t('range.1h')}</TabsTrigger>
              <TabsTrigger value="24h" className="text-[12px] px-2.5">{t('range.24h')}</TabsTrigger>
              <TabsTrigger value="7d" className="text-[12px] px-2.5">{t('range.7d')}</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        {/* 2x2 chart grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-0 divide-y md:divide-y-0 md:divide-x">
          <ChartCard title={`CPU · ${rangeLabel(range, t)}`}>
            <TimeSeriesChart
              series={[{ name: 'CPU%', values: cpu }]}
              yMin={0}
              yMax={100}
              yFormat={(v) => `${v.toFixed(0)}%`}
            />
          </ChartCard>
          <ChartCard title={`Memory · ${rangeLabel(range, t)}`}>
            <TimeSeriesChart
              series={[{ name: 'MEM%', values: memPct }]}
              yMin={0}
              yMax={100}
              yFormat={(v) => `${v.toFixed(0)}%`}
            />
          </ChartCard>
          <ChartCard title={`Network · ${rangeLabel(range, t)}`} className="border-t md:border-t">
            <TimeSeriesChart
              series={[
                { name: 'rx', values: netRx },
                { name: 'tx', values: netTx },
              ]}
              yFormat={(v) => bps(v)}
              tooltipFormat={(v) => bps(v)}
            />
          </ChartCard>
          <ChartCard title={`Load · ${rangeLabel(range, t)}`} className="border-t md:border-t">
            <TimeSeriesChart series={[{ name: 'load1', values: load }]} yFormat={(v) => v.toFixed(1)} />
          </ChartCard>
        </div>

        {/* Footer redaction disclaimer */}
        <div className="px-4 py-3 border-t text-center text-[11.5px] font-mono text-fg-dim">
          {t(
            'public_detail.redaction',
            'Identifying details (hostname, IP, datacenter) are intentionally redacted on the public status page.',
          )}
        </div>
      </div>
    </div>
  )
}

function MiniKpi({
  label,
  value,
  tone,
  mono,
}: {
  label: string
  value: string
  tone?: PillKind
  mono?: boolean
}) {
  return (
    <div className="border rounded-lg bg-background px-3 py-2.5">
      <div className="text-[10.5px] uppercase tracking-[0.05em] text-fg-dim">{label}</div>
      <div
        className={cn(
          'font-mono text-[22px] mt-0.5 tracking-tight tabular-nums leading-none',
          tone === 'warn' && 'text-warn',
          tone === 'err' && 'text-err',
          mono && 'text-[14px] mt-1',
        )}
      >
        {value}
      </div>
    </div>
  )
}

function ChartCard({
  title,
  children,
  className,
}: {
  title: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-col', className)}>
      <div className="px-4 py-2.5 text-[11.5px] uppercase tracking-[0.05em] text-muted-foreground">
        {title}
      </div>
      <div className="px-4 pb-4">{children}</div>
    </div>
  )
}

function rangeLabel(r: Range, t: (k: string, opts?: any) => string): string {
  if (r === '1h') return t('range.1h')
  if (r === '24h') return t('range.24h')
  return t('range.7d')
}

function lastSeenLabel(
  card: { online: boolean; latest?: { ts: string } },
  t: (k: string, opts?: any) => string,
): string {
  if (!card.latest?.ts) return '—'
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(card.latest.ts).getTime()) / 1000))
  if (seconds < 60) return t('common.just_now', 'just now')
  if (seconds < 3600) return t('common.minute_ago', { n: Math.floor(seconds / 60) })
  if (seconds < 86400) return t('common.hour_ago', { n: Math.floor(seconds / 3600) })
  return t('common.day_ago', { n: Math.floor(seconds / 86400) })
}

