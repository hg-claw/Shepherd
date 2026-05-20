import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  AreaChart,
  Area,
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
import { fetchXrayTraffic, type XrayTrafficPoint } from '@/api/plugins'

type TimeRange = '1h' | '24h' | '7d' | '30d'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  serverID: number
  tag: string
  kind: string
}

function rangeToParams(range: TimeRange): {
  from: string
  to: string
  resolution: 'raw' | 'minute' | 'hour'
} {
  const now = new Date()
  const to = now.toISOString()
  switch (range) {
    case '1h':
      return {
        from: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
        to,
        resolution: 'raw',
      }
    case '24h':
      return {
        from: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
        to,
        resolution: 'raw',
      }
    case '7d':
      return {
        from: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
        to,
        resolution: 'minute',
      }
    case '30d':
      return {
        from: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        to,
        resolution: 'hour',
      }
  }
}

function formatBytes(v: number): string {
  if (v >= 1_073_741_824) return `${(v / 1_073_741_824).toFixed(1)} GB`
  if (v >= 1_048_576) return `${(v / 1_048_576).toFixed(1)} MB`
  if (v >= 1024) return `${(v / 1024).toFixed(1)} KB`
  return `${v} B`
}

function formatTime(ts: string, range: TimeRange): string {
  const d = new Date(ts)
  if (range === '30d' || range === '7d') {
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export default function TrafficDrawer({
  open,
  onOpenChange,
  serverID,
  tag,
  kind,
}: Props) {
  const [range, setRange] = useState<TimeRange>('1h')
  const params = rangeToParams(range)

  const q = useQuery({
    queryKey: ['xray-traffic', serverID, tag, kind, range],
    queryFn: () =>
      fetchXrayTraffic({ server_id: serverID, tag, kind, ...params }),
    enabled: open,
    refetchInterval: 30_000,
  })

  const points: XrayTrafficPoint[] = q.data?.points ?? []

  const totalUp = points.reduce((s, p) => s + p.bytes_up, 0)
  const totalDown = points.reduce((s, p) => s + p.bytes_down, 0)

  const chartData = points.map((p) => ({
    ts: p.ts,
    bytes_up: p.bytes_up,
    bytes_down: p.bytes_down,
  }))

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[520px] max-w-full overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="font-mono text-sm">{tag} 流量</SheetTitle>
        </SheetHeader>

        {/* Time range selector */}
        <div className="flex gap-2 mt-4">
          {(['1h', '24h', '7d', '30d'] as TimeRange[]).map((r) => (
            <Button
              key={r}
              size="sm"
              variant={range === r ? 'default' : 'outline'}
              className="h-7 px-3 text-[12px]"
              onClick={() => setRange(r)}
            >
              {r}
            </Button>
          ))}
        </div>

        {/* Cumulative stats */}
        <div className="flex gap-6 mt-4 text-[13px]">
          <div>
            <div className="text-muted-foreground text-[11px] uppercase tracking-wide">
              上行
            </div>
            <div className="font-mono">{formatBytes(totalUp)}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-[11px] uppercase tracking-wide">
              下行
            </div>
            <div className="font-mono">{formatBytes(totalDown)}</div>
          </div>
        </div>

        {/* Area chart */}
        <div className="mt-6">
          {q.isLoading && (
            <div className="h-[200px] flex items-center justify-center text-muted-foreground text-[13px]">
              加载中…
            </div>
          )}
          {!q.isLoading && chartData.length === 0 && (
            <div className="h-[200px] flex items-center justify-center text-muted-foreground text-[13px]">
              暂无数据
            </div>
          )}
          {!q.isLoading && chartData.length > 0 && (
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart
                data={chartData}
                margin={{ top: 4, right: 8, bottom: 0, left: 8 }}
              >
                <XAxis
                  dataKey="ts"
                  tickFormatter={(v) => formatTime(v as string, range)}
                  tick={{ fontSize: 11 }}
                  minTickGap={40}
                />
                <YAxis
                  tickFormatter={(v) => formatBytes(v as number)}
                  tick={{ fontSize: 11 }}
                  width={60}
                />
                <Tooltip
                  formatter={(v: unknown) => formatBytes(Number(v))}
                  labelFormatter={(l: unknown) =>
                    typeof l === 'string' ? formatTime(l, range) : String(l)
                  }
                />
                <Area
                  type="monotone"
                  dataKey="bytes_up"
                  name="上行"
                  stackId="1"
                  fill="#3b82f6"
                  stroke="#3b82f6"
                  fillOpacity={0.3}
                />
                <Area
                  type="monotone"
                  dataKey="bytes_down"
                  name="下行"
                  stackId="1"
                  fill="#22c55e"
                  stroke="#22c55e"
                  fillOpacity={0.3}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
