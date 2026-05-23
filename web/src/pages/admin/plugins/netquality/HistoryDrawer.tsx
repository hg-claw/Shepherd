import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Area,
  Line,
  ComposedChart,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { fetchNetqualitySamples, type NetqualitySamplePoint } from '@/api/netquality'

type TimeRange = '1h' | '24h' | '7d' | '30d'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  serverID: number
  targetID: number
  label: string
}

// Translate a range into the (resolution, ms) the drawer uses. Picked to
// match the server's /samples auto-resolution rules:
//   span ≤ 2h  → raw
//   span ≤ 7d  → minute
//   else       → hour
function rangeToParams(r: TimeRange): { resolution: 'raw' | 'minute' | 'hour'; ms: number } {
  switch (r) {
    case '1h':  return { resolution: 'raw',    ms: 60 * 60 * 1000 }
    case '24h': return { resolution: 'minute', ms: 24 * 60 * 60 * 1000 }
    case '7d':  return { resolution: 'minute', ms: 7 * 24 * 60 * 60 * 1000 }
    case '30d': return { resolution: 'hour',   ms: 30 * 24 * 60 * 60 * 1000 }
  }
}

function fmtAxisTime(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export default function HistoryDrawer({ open, onOpenChange, serverID, targetID, label }: Props) {
  const [range, setRange] = useState<TimeRange>('1h')
  const { resolution, ms } = rangeToParams(range)

  const q = useQuery({
    queryKey: ['netquality', 'samples', serverID, targetID, range],
    queryFn: () => {
      const now = new Date()
      return fetchNetqualitySamples({
        server_id: serverID,
        target_id: targetID,
        from: new Date(now.getTime() - ms).toISOString(),
        to: now.toISOString(),
        resolution,
      })
    },
    enabled: open,
    refetchInterval: 30_000,
  })

  const points: NetqualitySamplePoint[] = q.data?.points ?? []
  const chartData = points.map((p) => ({
    ts: p.ts,
    rtt: p.rtt_avg_ms ?? null,
    loss: p.loss_pct,
  }))

  // Summary numbers: avg RTT over successful samples, total loss %.
  const okPoints = points.filter((p) => p.rtt_avg_ms != null) as Array<NetqualitySamplePoint & { rtt_avg_ms: number }>
  const avgRTT = okPoints.length
    ? okPoints.reduce((s, p) => s + p.rtt_avg_ms, 0) / okPoints.length
    : null
  const avgLoss = points.length
    ? points.reduce((s, p) => s + (p.loss_pct ?? 0), 0) / points.length
    : null

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[560px] max-w-full overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="text-[15px]">{label}</SheetTitle>
        </SheetHeader>

        <div className="mt-3 flex gap-1">
          {(['1h', '24h', '7d', '30d'] as TimeRange[]).map((r) => (
            <Button
              key={r}
              size="sm"
              variant={r === range ? 'default' : 'outline'}
              className="h-7 px-2.5 text-[11.5px]"
              onClick={() => setRange(r)}
            >
              {r}
            </Button>
          ))}
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 text-[12.5px]">
          <div className="border rounded-md p-3">
            <div className="text-muted-foreground text-[11px] uppercase tracking-wide">Avg RTT</div>
            <div className="text-[18px] font-mono tabular-nums">
              {avgRTT != null ? `${avgRTT.toFixed(1)} ms` : '—'}
            </div>
          </div>
          <div className="border rounded-md p-3">
            <div className="text-muted-foreground text-[11px] uppercase tracking-wide">Avg loss</div>
            <div className="text-[18px] font-mono tabular-nums">
              {avgLoss != null ? `${avgLoss.toFixed(1)}%` : '—'}
            </div>
          </div>
        </div>

        <div className="mt-4 h-64">
          {points.length === 0 ? (
            <div className="h-full grid place-items-center text-[12.5px] text-muted-foreground">
              No samples in this range yet.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData}>
                <XAxis dataKey="ts" tickFormatter={fmtAxisTime} tick={{ fontSize: 11 }} />
                <YAxis yAxisId="rtt" orientation="left" tick={{ fontSize: 11 }} />
                <YAxis yAxisId="loss" orientation="right" tick={{ fontSize: 11 }} unit="%" domain={[0, 100]} />
                <Tooltip
                  labelFormatter={(v) => new Date(v as string).toLocaleString()}
                  formatter={(value, key) => {
                    if (key === 'rtt') return [`${(value as number)?.toFixed(1)} ms`, 'RTT']
                    if (key === 'loss') return [`${(value as number)?.toFixed(1)}%`, 'Loss']
                    return [value, key]
                  }}
                />
                <Area yAxisId="rtt" type="monotone" dataKey="rtt" stroke="hsl(var(--ok))" fill="hsl(var(--ok))" fillOpacity={0.2} />
                <Line yAxisId="loss" type="monotone" dataKey="loss" stroke="hsl(var(--err))" dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="mt-4 text-[11px] text-muted-foreground">
          Resolution: <span className="font-mono">{q.data?.resolution ?? resolution}</span>
        </div>
      </SheetContent>
    </Sheet>
  )
}
