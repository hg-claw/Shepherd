import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft } from 'lucide-react'
import { Pill, type PillKind } from '@/components/Pill'
import { CountryFlag } from '@/components/CountryFlag'
import { TimeSeriesChart } from '@/components/TimeSeriesChart'
import { Seg } from '@/components/Seg'
import { usePublicTelemetry, usePublicServers, usePublicNetquality } from '@/api/public'
import type { Range } from '@/api/servers'
import { bps, pct } from '@/lib/bytes'
import { relativeTime } from '@/lib/time'
import { cn } from '@/lib/utils'

function statusKind(card: {
  online: boolean
  latest?: { cpu_pct: number; mem_pct: number; disks_pct: number[] }
}): { kind: PillKind; label: string } {
  if (!card.online) return { kind: 'neutral', label: 'Offline' }
  const l = card.latest
  if (!l) return { kind: 'ok', label: 'Operational' }
  const top = Math.max(l.cpu_pct ?? 0, l.mem_pct ?? 0, ...(l.disks_pct ?? []))
  if (top >= 92) return { kind: 'err', label: 'Degraded' }
  if (top >= 80) return { kind: 'warn', label: 'Warning' }
  return { kind: 'ok', label: 'Operational' }
}

const RANGE_OPTIONS: { value: Range; label: string }[] = [
  { value: '1h', label: '1h' },
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
]

// Series labels for the netquality chart. Kept short so the legend
// chips fit alongside the line colours.
const ISP_SERIES_LABEL: Record<'telecom' | 'unicom' | 'mobile' | 'overseas', string> = {
  telecom: '电信',
  unicom: '联通',
  mobile: '移动',
  overseas: '海外',
}

export default function PublicServerDetail() {
  const { id: idStr } = useParams<{ id: string }>()
  const id = Number(idStr)
  const { t } = useTranslation()
  const [range, setRange] = useState<Range>('1h')

  // Reuse the wall list so we only expose public-facing card data
  // (alias, group, country, online flag). No admin fields exposed.
  const wall = usePublicServers()
  const card = wall.data?.find((c) => c.id === id)

  const tele = usePublicTelemetry(id, range)
  // History from the netquality plugin. Empty when the plugin isn't on
  // for this server — the chart card hides itself in that case.
  const netq = usePublicNetquality(id, range)

  if (wall.isLoading || tele.isLoading)
    return <div className="text-muted-foreground">{t('common.loading')}</div>
  if (wall.error || !card)
    return (
      <div className="flex flex-col gap-3">
        <h1 className="text-[22px] font-semibold m-0">{t('common.not_found', 'Not found')}</h1>
        <p className="text-muted-foreground">
          {t('public_detail.not_found', 'Host #{{id}} was not found.', { id })}
        </p>
        <div>
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            {t('common.back', 'Back')}
          </Link>
        </div>
      </div>
    )

  const points = tele.data ?? []
  const cpu = points.map((p) => ({ ts: p.ts, v: p.cpu_pct ?? 0 }))
  const memPct = points.map((p) => ({ ts: p.ts, v: pct(p.mem_used, p.mem_total) ?? 0 }))
  const netRx = points.map((p) => ({ ts: p.ts, v: p.net_rx_bps ?? 0 }))
  const netTx = points.map((p) => ({ ts: p.ts, v: p.net_tx_bps ?? 0 }))
  const load = points.map((p) => ({ ts: p.ts, v: p.load_1 ?? 0 }))

  const latest = card.latest
  const { kind, label } = statusKind(card)
  const headlineCpu = latest ? `${latest.cpu_pct.toFixed(0)}%` : '—'
  const headlineMem = latest ? `${latest.mem_pct.toFixed(0)}%` : '—'
  const headlineDisk =
    latest?.disks_pct?.[0] != null ? `${latest.disks_pct[0].toFixed(0)}%` : '—'
  const lastSeenLabel = lastSeenStr(card, t)
  const rangeStr = rangeLabel(range, t)

  return (
    <div className="border rounded-lg bg-elev overflow-hidden">
      {/* Header bar — back + alias + group + country + status.
          NOTE: No hostname, no IP, no fingerprint, no kernel — public-only fields. */}
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b">
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
              'inline-block h-2 w-2 rounded-full flex-shrink-0',
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

      {/* KPI row — 4 metric mini-cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-4">
        <MiniKpi label="CPU" value={headlineCpu} tone={kind} />
        <MiniKpi label="Memory" value={headlineMem} />
        <MiniKpi label="Disk" value={headlineDisk} />
        <MiniKpi label={t('public_detail.last_seen', 'Last seen')} value={lastSeenLabel} mono />
      </div>

      {/* Range toggle — uses Seg primitive (same as design) */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pb-3 border-b">
        <span className="text-[12px] text-muted-foreground">
          {t('public_detail.window', 'Telemetry window')}
        </span>
        <Seg<Range>
          value={range}
          onChange={setRange}
          size="sm"
          options={RANGE_OPTIONS}
        />
      </div>

      {/* 2×2 chart grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 min-w-0">
        <ChartCard title={`CPU · ${rangeStr}`}>
          <TimeSeriesChart
            series={[{ name: 'CPU%', values: cpu }]}
            yMin={0}
            yMax={100}
            yFormat={(v) => `${v.toFixed(0)}%`}
          />
        </ChartCard>
        <ChartCard title={`Memory · ${rangeStr}`} className="md:border-l border-t md:border-t-0">
          <TimeSeriesChart
            series={[{ name: 'MEM%', values: memPct }]}
            yMin={0}
            yMax={100}
            yFormat={(v) => `${v.toFixed(0)}%`}
          />
        </ChartCard>
        <ChartCard title={`Network · ${rangeStr}`} className="border-t">
          <TimeSeriesChart
            series={[
              { name: 'rx', values: netRx },
              { name: 'tx', values: netTx },
            ]}
            yFormat={(v) => bps(v)}
            tooltipFormat={(v) => bps(v)}
          />
        </ChartCard>
        <ChartCard
          title={`Load · ${rangeStr}`}
          className="border-t md:border-l"
        >
          <TimeSeriesChart
            series={[{ name: 'load1', values: load }]}
            yFormat={(v) => v.toFixed(1)}
          />
        </ChartCard>
      </div>

      {/* Per-ISP ping history. Plugin opt-in; the row is hidden when
          netquality isn't enabled (empty array from /netquality). */}
      {netq.data && netq.data.length > 0 && (
        <div className="border-t">
          <ChartCard title={`Network quality · ${rangeStr}`}>
            <TimeSeriesChart
              series={netq.data.map((row) => ({
                name: ISP_SERIES_LABEL[row.isp] ?? row.isp,
                values: row.points.map((p) => ({
                  ts: p.ts,
                  v: p.rtt_avg_ms ?? 0,
                })),
              }))}
              yFormat={(v) => `${v.toFixed(0)} ms`}
              tooltipFormat={(v) => `${v.toFixed(1)} ms`}
            />
          </ChartCard>
        </div>
      )}

      {/* Redaction disclaimer — identifying fields are intentionally omitted */}
      <div className="px-4 py-3 border-t text-center text-[11.5px] font-mono text-fg-dim">
        {t(
          'public_detail.redaction',
          'Identifying details (hostname, IP, datacenter) are intentionally redacted on the public status page.',
        )}
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
    <div className={cn('flex flex-col min-w-0', className)}>
      <div className="px-4 py-2.5 text-[11.5px] uppercase tracking-[0.05em] text-muted-foreground">
        {title}
      </div>
      <div className="px-4 pb-4 min-w-0">{children}</div>
    </div>
  )
}

function rangeLabel(r: Range, t: (k: string) => string): string {
  if (r === '1h') return t('range.1h')
  if (r === '24h') return t('range.24h')
  return t('range.7d')
}

function lastSeenStr(
  card: { online: boolean; latest?: { ts: string } },
  t: (k: string, opts?: Record<string, unknown>) => string,
): string {
  if (!card.latest?.ts) return '—'
  const rel = relativeTime(card.latest.ts)
  if (!rel) return '—'
  return t(rel.key, { n: rel.n })
}
