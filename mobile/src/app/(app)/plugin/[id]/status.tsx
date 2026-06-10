import { useMemo, useState } from 'react'
import { View, Text, ScrollView, Pressable, ActivityIndicator, RefreshControl } from 'react-native'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import {
  usePluginHosts, useProxyInbounds, useTrafficBatch, useSingboxCerts, useNetqualityLatest,
  type ProxyPluginID, type ProxyInbound, type TrafficSeries,
  type NetqualityISP, type NetqualityLatestRow,
} from '@/api/plugins'
import { useServers, type ServerRow } from '@/api/servers'
import { nullStr } from '@/api/metrics'
import { bytes, cmpStr, relTime } from '@/lib/format'
import { useTheme } from '@/theme'
import { Screen } from '@/components/Screen'
import { NavBar, Card, CardHead, Pill, Button, Empty, AreaChart, type PillKind } from '@/components/ds'

// Plugins that get a status view; index.tsx keeps a matching set for the row.
export function hasStatusView(id?: string): boolean {
  return id === 'singbox' || id === 'xray' || id === 'netquality'
}

// ── pure helpers (exported for tests) ────────────────────────────────────────

// certDaysLeft → whole days until expiry (floor), or null when the cert has no
// real expiry yet — the Go zero time ("0001-01-01T00:00:00Z") while issuing.
export function certDaysLeft(expiresAt: string, now: number = Date.now()): number | null {
  const t = new Date(expiresAt).getTime()
  if (!isFinite(t) || t <= 0) return null
  return Math.floor((t - now) / 86_400_000)
}

// Expiry urgency tone: <14d err, <30d warn, else ok (expired counts as err).
export function certTone(days: number | null): PillKind {
  if (days == null) return 'neutral'
  if (days < 14) return 'err'
  if (days < 30) return 'warn'
  return 'ok'
}

export function certExpiryLabel(days: number | null): string {
  if (days == null) return '—'
  if (days < 0) return 'expired'
  return `${days}d left`
}

export function certStatusKind(status: string): PillKind {
  if (status === 'active') return 'ok'
  if (status === 'issuing') return 'warn'
  return 'err'
}

// Latency tone thresholds mirror the web ResultsTab: loss ≥50% → err,
// RTT ≥250ms → err, ≥150ms → warn, else ok; no sample → neutral.
export function rttKind(rttMs?: number, lossPct?: number): PillKind {
  if (lossPct != null && lossPct >= 50) return 'err'
  if (rttMs == null) return 'neutral'
  if (rttMs >= 250) return 'err'
  if (rttMs >= 150) return 'warn'
  return 'ok'
}

export function fmtRTT(rtt?: number): string {
  return rtt == null ? '—' : `${rtt.toFixed(1)} ms`
}

export function fmtLoss(loss?: number): string {
  return loss == null ? '—' : `${loss.toFixed(0)}%`
}

export type TagTotals = { up: number; down: number; combined: number[] }

// sumSeries folds a traffic batch into per-tag 24h totals plus the combined
// (up+down) per-bucket series for the sparkline.
export function sumSeries(series: readonly TrafficSeries[]): Map<string, TagTotals> {
  const m = new Map<string, TagTotals>()
  for (const s of series) {
    const t = m.get(s.tag) ?? { up: 0, down: 0, combined: [] }
    for (const p of s.points) {
      t.up += p.bytes_up
      t.down += p.bytes_down
      t.combined.push(p.bytes_up + p.bytes_down)
    }
    m.set(s.tag, t)
  }
  return m
}

// ── shared bits ───────────────────────────────────────────────────────────────

function ErrorRetry({ children, onRetry }: { children: string; onRetry: () => void }) {
  const t = useTheme()
  return (
    <View style={{ alignItems: 'center', gap: 12, padding: t.space(6) }}>
      <Text style={{ fontFamily: t.font(), fontSize: t.fs.sm, color: t.err }}>{children}</Text>
      <Button variant="outline" icon="refresh-cw" onPress={onRetry}>Retry</Button>
    </View>
  )
}

// Host picker chips — same pattern as the plugin logs screen, labels resolved
// through the servers join (public_alias is a Go sql.NullString).
function HostChips({ hosts, serverID, onPick }: {
  hosts: { id: number; server_id: number }[]
  serverID: number | null
  onPick: (sid: number) => void
}) {
  const t = useTheme()
  const servers = useServers().data ?? []
  const nameOf = (sid: number) => {
    const s: ServerRow | undefined = servers.find((x) => x.id === sid)
    return s ? (nullStr(s.public_alias) || s.name || `#${sid}`) : `#${sid}`
  }
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ flexGrow: 0, borderBottomWidth: 1, borderBottomColor: t.border }}
      contentContainerStyle={{ gap: 6, paddingHorizontal: 14, paddingVertical: 9, alignItems: 'center' }}
    >
      {hosts.map((h) => {
        const active = h.server_id === serverID
        return (
          <Pressable
            key={String(h.id)}
            testID={`host-${h.server_id}`}
            onPress={() => onPick(h.server_id)}
            style={{
              height: 30, paddingHorizontal: 12, borderRadius: t.radius, justifyContent: 'center',
              backgroundColor: active ? t.sunken : 'transparent',
              borderWidth: 1, borderColor: active ? t.borderStrong : t.border,
            }}
          >
            <Text style={{ fontFamily: t.mono(active ? 500 : 400), fontSize: 12, color: active ? t.text : t.muted }}>
              {nameOf(h.server_id)}
            </Text>
          </Pressable>
        )
      })}
    </ScrollView>
  )
}

// ── singbox / xray: traffic + certificates ────────────────────────────────────

function InboundRow({ inbound, totals }: { inbound: ProxyInbound; totals?: TagTotals }) {
  const t = useTheme()
  const hasPoints = totals != null && totals.combined.length > 0
  return (
    <View style={{ paddingHorizontal: 14, paddingVertical: 10, gap: 6, borderTopWidth: 1, borderTopColor: t.border }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text numberOfLines={1} style={{ flexShrink: 1, fontFamily: t.mono(500), fontSize: t.fs.sm, color: t.text }}>
          {inbound.tag}
        </Text>
        <Pill kind="neutral">{inbound.protocol}</Pill>
        <Text style={{ marginLeft: 'auto', fontFamily: t.mono(), fontSize: t.fs.xs, color: t.muted }}>
          :{inbound.port}
        </Text>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <Text style={{ fontFamily: t.mono(), fontSize: t.fs.xs, color: t.muted }}>
          ↑ {bytes(totals?.up ?? 0)}
        </Text>
        <Text style={{ fontFamily: t.mono(), fontSize: t.fs.xs, color: t.muted }}>
          ↓ {bytes(totals?.down ?? 0)}
        </Text>
      </View>
      {hasPoints ? (
        <AreaChart testID={`chart-${inbound.tag}`} data={totals.combined} height={36} format={(v) => bytes(v)} />
      ) : null}
    </View>
  )
}

function CertRow({ domain, status, expiresAt }: { domain: string; status: string; expiresAt: string }) {
  const t = useTheme()
  const days = certDaysLeft(expiresAt)
  return (
    <View style={{
      flexDirection: 'row', alignItems: 'center', gap: 8,
      paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: 1, borderTopColor: t.border,
    }}>
      <Text numberOfLines={1} style={{ flex: 1, fontFamily: t.mono(500), fontSize: t.fs.sm, color: t.text }}>
        {domain}
      </Text>
      <Pill kind={certStatusKind(status)}>{status}</Pill>
      <Pill kind={certTone(days)}>{certExpiryLabel(days)}</Pill>
    </View>
  )
}

function ProxyStatus({ plugin }: { plugin: ProxyPluginID }) {
  const t = useTheme()
  const hostsQ = usePluginHosts(plugin)
  const hosts = hostsQ.data ?? []
  // Explicit pick wins; otherwise the first deployed host (derived, no effect).
  const [picked, setPicked] = useState<number | null>(null)
  const serverID = picked ?? hosts[0]?.server_id ?? null

  // 24h window frozen per mount; pull-to-refresh slides it to "now" so the
  // query key doesn't churn on every render.
  const [windowEnd, setWindowEnd] = useState(() => Date.now())
  const range = useMemo(() => ({
    from: new Date(windowEnd - 86_400_000).toISOString(),
    to: new Date(windowEnd).toISOString(),
  }), [windowEnd])

  const inboundsQ = useProxyInbounds(plugin, serverID)
  const inbounds = useMemo(
    () => (inboundsQ.data ?? []).filter((i) => i.server_id === serverID),
    [inboundsQ.data, serverID],
  )
  const tags = useMemo(() => inbounds.map((i) => i.tag), [inbounds])
  const trafficQ = useTrafficBatch(plugin, {
    server_id: serverID, tags, from: range.from, to: range.to, resolution: 'hour',
  })
  const totals = useMemo(() => sumSeries(trafficQ.data?.series ?? []), [trafficQ.data])

  const isSingbox = plugin === 'singbox'
  const certsQ = useSingboxCerts(isSingbox)
  const certs = certsQ.data ?? []

  const refreshing = hostsQ.isRefetching || inboundsQ.isRefetching || trafficQ.isRefetching || certsQ.isRefetching
  const onRefresh = () => {
    setWindowEnd(Date.now()) // new from/to → traffic refetches via key change
    void hostsQ.refetch()
    void inboundsQ.refetch()
    if (isSingbox) void certsQ.refetch()
  }

  if (hostsQ.isLoading) {
    return <ActivityIndicator testID="status-loading" color={t.primary} style={{ marginTop: 32 }} />
  }
  if (hostsQ.isError) {
    return <ErrorRetry onRetry={() => { void hostsQ.refetch() }}>Failed to load hosts.</ErrorRetry>
  }

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 16, paddingBottom: 44, gap: 16 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={t.primary} />}
    >
      <Card>
        <CardHead>Traffic (24h)</CardHead>
        {hosts.length === 0 ? (
          <Empty>Not deployed anywhere.</Empty>
        ) : (
          <>
            <HostChips hosts={hosts} serverID={serverID} onPick={setPicked} />
            {inboundsQ.isLoading || trafficQ.isLoading ? (
              <ActivityIndicator testID="traffic-loading" color={t.primary} style={{ marginVertical: 24 }} />
            ) : inboundsQ.isError ? (
              <ErrorRetry onRetry={() => { void inboundsQ.refetch() }}>Failed to load inbounds.</ErrorRetry>
            ) : trafficQ.isError ? (
              <ErrorRetry onRetry={() => { void trafficQ.refetch() }}>Failed to load traffic.</ErrorRetry>
            ) : inbounds.length === 0 ? (
              <Empty>No inbounds on this host.</Empty>
            ) : (
              inbounds.map((i) => <InboundRow key={String(i.id)} inbound={i} totals={totals.get(i.tag)} />)
            )}
          </>
        )}
      </Card>

      {isSingbox ? (
        <Card>
          <CardHead>Certificates</CardHead>
          {certsQ.isLoading ? (
            <ActivityIndicator testID="certs-loading" color={t.primary} style={{ marginVertical: 24 }} />
          ) : certsQ.isError ? (
            <ErrorRetry onRetry={() => { void certsQ.refetch() }}>Failed to load certificates.</ErrorRetry>
          ) : certs.length === 0 ? (
            <Empty>No certificates.</Empty>
          ) : (
            certs.map((c) => (
              <CertRow key={String(c.id)} domain={c.domain} status={c.status} expiresAt={c.expires_at} />
            ))
          )}
        </Card>
      ) : null}
    </ScrollView>
  )
}

// ── netquality: latest samples grid ───────────────────────────────────────────

const ISP_ORDER: NetqualityISP[] = ['telecom', 'unicom', 'mobile', 'overseas']
const ISP_LABEL: Record<NetqualityISP, string> = {
  telecom: '电信',
  unicom: '联通',
  mobile: '移动',
  overseas: '海外',
}

function NetqualityRow({ row }: { row: NetqualityLatestRow }) {
  const t = useTheme()
  return (
    <View style={{
      flexDirection: 'row', alignItems: 'center', gap: 8,
      paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: 1, borderTopColor: t.border,
    }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ fontFamily: t.font(500), fontSize: t.fs.sm, color: t.text }}>
          {row.label}
        </Text>
        <Text numberOfLines={1} style={{ fontFamily: t.font(), fontSize: t.fs.xs, color: t.muted, marginTop: 1 }}>
          {row.region}{row.ts ? ` · ${relTime(row.ts)}` : ''}
        </Text>
      </View>
      <Pill kind={rttKind(row.rtt_avg_ms, row.loss_pct)}>{fmtRTT(row.rtt_avg_ms)}</Pill>
      <Text style={{ fontFamily: t.mono(), fontSize: t.fs.xs, color: t.muted }}>{fmtLoss(row.loss_pct)}</Text>
    </View>
  )
}

function NetqualityStatus() {
  const t = useTheme()
  const hostsQ = usePluginHosts('netquality')
  const hosts = hostsQ.data ?? []
  const [picked, setPicked] = useState<number | null>(null)
  const serverID = picked ?? hosts[0]?.server_id ?? null
  const latestQ = useNetqualityLatest(serverID)

  const grouped = useMemo(() => {
    const m = new Map<NetqualityISP, NetqualityLatestRow[]>()
    for (const r of latestQ.data ?? []) {
      const arr = m.get(r.isp) ?? []
      arr.push(r)
      m.set(r.isp, arr)
    }
    for (const arr of m.values()) arr.sort((a, b) => cmpStr(a.label, b.label))
    return m
  }, [latestQ.data])

  const onRefresh = () => {
    void hostsQ.refetch()
    void latestQ.refetch()
  }

  if (hostsQ.isLoading) {
    return <ActivityIndicator testID="status-loading" color={t.primary} style={{ marginTop: 32 }} />
  }
  if (hostsQ.isError) {
    return <ErrorRetry onRetry={() => { void hostsQ.refetch() }}>Failed to load hosts.</ErrorRetry>
  }
  if (hosts.length === 0) return <Empty>Not deployed anywhere.</Empty>

  return (
    <View style={{ flex: 1 }}>
      <HostChips hosts={hosts} serverID={serverID} onPick={setPicked} />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: 44, gap: 16 }}
        refreshControl={
          <RefreshControl refreshing={hostsQ.isRefetching || latestQ.isRefetching} onRefresh={onRefresh} tintColor={t.primary} />
        }
      >
        {latestQ.isLoading ? (
          <ActivityIndicator testID="latest-loading" color={t.primary} style={{ marginTop: 24 }} />
        ) : latestQ.isError ? (
          <ErrorRetry onRetry={() => { void latestQ.refetch() }}>Failed to load samples.</ErrorRetry>
        ) : (latestQ.data ?? []).length === 0 ? (
          <Empty>No samples yet — wait one sample interval.</Empty>
        ) : (
          ISP_ORDER.map((isp) => {
            const rows = grouped.get(isp) ?? []
            if (rows.length === 0) return null
            return (
              <Card key={isp}>
                <CardHead>{ISP_LABEL[isp]}</CardHead>
                {rows.map((r) => <NetqualityRow key={String(r.target_id)} row={r} />)}
              </Card>
            )
          })
        )}
      </ScrollView>
    </View>
  )
}

// ── screen ────────────────────────────────────────────────────────────────────

export default function PluginStatusScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  return (
    <Screen edges={['bottom']}>
      <Stack.Screen options={{ title: 'Status' }} />
      <NavBar title="Status" onBack={() => router.back()} backLabel="Plugin" />
      {id === 'singbox' || id === 'xray' ? (
        <ProxyStatus plugin={id} />
      ) : id === 'netquality' ? (
        <NetqualityStatus />
      ) : (
        <Empty>No status view for this plugin.</Empty>
      )}
    </Screen>
  )
}
