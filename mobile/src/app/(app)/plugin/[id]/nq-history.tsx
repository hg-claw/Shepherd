import { useMemo, useState } from 'react'
import { View, Text, ScrollView, ActivityIndicator, RefreshControl } from 'react-native'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import {
  useNetqualitySamples, type NetqualityRange, type NetqualitySamplePoint,
} from '@/api/netquality'
import { useTheme } from '@/theme'
import { Screen } from '@/components/Screen'
import { NavBar, Card, CardHead, Kpi, Segmented, Button, Empty, ErrLine, AreaChart, type ChartPoint } from '@/components/ds'

const RANGES: { value: NetqualityRange; label: string }[] = [
  { value: '1h', label: '1h' },
  { value: '24h', label: '24h' },
]

// ── pure helpers (exported for tests) ─────────────────────────────────────────

// fmtRTT / fmtLoss mirror the netquality screen's renderers (no Intl — Hermes).
export function fmtRTT(rtt?: number | null): string {
  return rtt == null ? '—' : `${rtt.toFixed(1)} ms`
}

export function fmtLoss(loss?: number | null): string {
  return loss == null ? '—' : `${loss.toFixed(1)}%`
}

// rttSeries / lossSeries map sample points to the AreaChart's {x,y} input.
// rtt_avg_ms is null on a fully-lost bucket → rendered as a gap. x is the
// sample's epoch ms so the chart spaces points by time, not index.
export function rttSeries(points: readonly NetqualitySamplePoint[]): ChartPoint[] {
  return points.map((p) => ({ x: new Date(p.ts).getTime(), y: p.rtt_avg_ms ?? null }))
}

export function lossSeries(points: readonly NetqualitySamplePoint[]): ChartPoint[] {
  return points.map((p) => ({ x: new Date(p.ts).getTime(), y: p.loss_pct ?? null }))
}

// avgRTT averages only the buckets that actually recorded a latency (null =
// no successful probe, excluded). Returns null when nothing succeeded.
export function avgRTT(points: readonly NetqualitySamplePoint[]): number | null {
  const ok = points.filter((p) => p.rtt_avg_ms != null) as { rtt_avg_ms: number }[]
  if (ok.length === 0) return null
  return ok.reduce((s, p) => s + p.rtt_avg_ms, 0) / ok.length
}

// avgLoss averages loss across every bucket (null loss counts as 0, matching
// the web HistoryDrawer). Returns null when there are no points at all.
export function avgLoss(points: readonly NetqualitySamplePoint[]): number | null {
  if (points.length === 0) return null
  return points.reduce((s, p) => s + (p.loss_pct ?? 0), 0) / points.length
}

// ── history body ──────────────────────────────────────────────────────────────

function History({ serverID, targetID }: { serverID: number; targetID: number }) {
  const t = useTheme()
  const [range, setRange] = useState<NetqualityRange>('1h')
  // Freeze the window end per range pick / pull-to-refresh so the query key
  // doesn't churn every render (same pattern as status.tsx's windowEnd).
  const [windowEnd, setWindowEnd] = useState(() => Date.now())

  const q = useNetqualitySamples({ serverID, targetID, range, windowEnd })
  const points = useMemo(() => q.data?.points ?? [], [q.data])

  const summary = useMemo(() => ({
    rtt: avgRTT(points),
    loss: avgLoss(points),
    rttPts: rttSeries(points),
    lossPts: lossSeries(points),
  }), [points])

  const onRefresh = () => { setWindowEnd(Date.now()); void q.refetch() }
  const pickRange = (r: NetqualityRange) => { setRange(r); setWindowEnd(Date.now()) }

  return (
    <View style={{ flex: 1 }}>
      <View style={{ paddingHorizontal: 16, paddingVertical: 12, alignItems: 'center', borderBottomWidth: 1, borderBottomColor: t.border }}>
        <Segmented<NetqualityRange> value={range} onChange={pickRange} options={RANGES} />
      </View>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: 44, gap: 16 }}
        refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={onRefresh} tintColor={t.primary} />}
      >
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <Kpi label="avg rtt" value={fmtRTT(summary.rtt)} />
          </View>
          <View style={{ flex: 1 }}>
            <Kpi label="avg loss" value={fmtLoss(summary.loss)} />
          </View>
        </View>

        {q.isLoading ? (
          <ActivityIndicator testID="history-loading" color={t.primary} style={{ marginTop: 24 }} />
        ) : q.isError ? (
          <View style={{ alignItems: 'center', gap: 12, padding: 24 }}>
            <ErrLine>Failed to load history.</ErrLine>
            <Button variant="outline" icon="refresh-cw" onPress={() => { void q.refetch() }}>Retry</Button>
          </View>
        ) : points.length === 0 ? (
          <Empty>No samples in this range yet.</Empty>
        ) : (
          <>
            <Card>
              <CardHead>RTT (ms)</CardHead>
              <View style={{ padding: 14 }}>
                <AreaChart testID="history-rtt" data={summary.rttPts} height={120} color={t.ok} format={(v) => `${Math.round(v)}`} />
              </View>
            </Card>
            <Card>
              <CardHead>Loss (%)</CardHead>
              <View style={{ padding: 14 }}>
                <AreaChart testID="history-loss" data={summary.lossPts} height={120} color={t.err} format={(v) => `${Math.round(v)}%`} />
              </View>
            </Card>
            <Text style={{ fontFamily: t.mono(), fontSize: 11.5, color: t.fgDim, textAlign: 'center' }}>
              {points.length} {points.length === 1 ? 'sample' : 'samples'} · {q.data?.resolution ?? ''}
            </Text>
          </>
        )}
      </ScrollView>
    </View>
  )
}

// ── screen ────────────────────────────────────────────────────────────────────

export default function NetqualityHistoryScreen() {
  const router = useRouter()
  const { serverId, targetId, label } = useLocalSearchParams<{
    id: string; serverId?: string; targetId?: string; label?: string
  }>()
  const sid = Number(serverId)
  const tid = Number(targetId)
  const valid =
    serverId != null && serverId !== 'undefined' && Number.isFinite(sid) &&
    targetId != null && targetId !== 'undefined' && Number.isFinite(tid)
  const title = (typeof label === 'string' && label.length > 0) ? label : 'History'
  return (
    <Screen edges={['bottom']}>
      <Stack.Screen options={{ title }} />
      <NavBar title={title} onBack={() => router.back()} backLabel="Network quality" />
      {valid ? (
        <History serverID={sid} targetID={tid} />
      ) : (
        <Empty>No target selected.</Empty>
      )}
    </Screen>
  )
}
