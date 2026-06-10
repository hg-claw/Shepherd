import React, { useState } from 'react'
import { ScrollView, View, Text, ActivityIndicator } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useServersLatest } from '@/api/servers'
import { isOnline, memPct, firstDiskPct, nullStr, useTelemetrySeries, type TelemetryRange } from '@/api/metrics'
import { bps, pct, relTime } from '@/lib/format'
import { LiveNet } from '@/components/LiveNet'
import {
  NavBar, IconButton, Pill, Card, CardHead, Button, Cc, Empty, Kpi, statusOf, barKind,
  Segmented, AreaChart,
} from '@/components/ds'
import { useTheme } from '@/theme'

const EM_DASH = '—'

// One line in the details Card: dim label left, mono value right. `first` drops
// the top divider so it doesn't double up with the Card border.
function Row({ label, value, first }: { label: string; value: React.ReactNode; first?: boolean }) {
  const t = useTheme()
  return (
    <View style={{
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8,
      paddingVertical: 11, paddingHorizontal: 14,
      borderTopWidth: first ? 0 : 1, borderTopColor: t.border,
    }}>
      <Text style={{ fontFamily: t.font(), fontSize: 13, color: t.muted }}>{label}</Text>
      <Text style={{ fontFamily: t.mono(), fontSize: 13, color: t.text }}>{value}</Text>
    </View>
  )
}

const RANGES: { value: TelemetryRange; label: string }[] = [
  { value: '1h', label: '1h' }, { value: '24h', label: '24h' }, { value: '7d', label: '7d' },
]

// One labelled chart inside the History card: mono label left, sparkline below.
function ChartBlock({ label, values, color, format }: {
  label: string; values: (number | null)[]; color?: string; format?: (v: number) => string
}) {
  const t = useTheme()
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ fontFamily: t.mono(), fontSize: 10, letterSpacing: 0.4, color: t.muted }}>{label}</Text>
      <AreaChart data={values} height={56} color={color} format={format} />
    </View>
  )
}

// History: telemetry charts (CPU / MEM / NET) with a 1h/24h/7d range selector.
function History({ id }: { id: number }) {
  const t = useTheme()
  const [range, setRange] = useState<TelemetryRange>('1h')
  const q = useTelemetrySeries(id, range)
  const pts = q.data ?? []
  const fmtPct = (v: number) => pct(v)
  return (
    <Card>
      <CardHead>
        <Text style={{ flex: 1, fontFamily: t.font(500), fontSize: 12.5, color: t.text }}>History</Text>
        <Segmented value={range} onChange={setRange} options={RANGES} />
      </CardHead>
      <View style={{ padding: 14, gap: 14 }}>
        {q.isLoading ? (
          <ActivityIndicator color={t.primary} style={{ marginVertical: 40 }} />
        ) : (
          <>
            <ChartBlock label="CPU %" values={pts.map((p) => p.cpu_pct ?? null)} format={fmtPct} />
            <ChartBlock label="MEM %" values={pts.map((p) => memPct(p))} color={t.ok} format={fmtPct} />
            <ChartBlock label="NET ↓ RX" values={pts.map((p) => p.net_rx_bps ?? null)} format={bps} />
            <ChartBlock label="NET ↑ TX" values={pts.map((p) => p.net_tx_bps ?? null)} color={t.warn} format={bps} />
          </>
        )}
      </View>
    </Card>
  )
}

export default function ServerDetail() {
  const t = useTheme()
  const router = useRouter()
  const { id } = useLocalSearchParams<{ id: string }>()
  const latest = useServersLatest()
  const row = latest.data?.find((s) => s.id === Number(id))

  if (!row && latest.isLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: t.bg }}>
        <NavBar backLabel="Servers" onBack={() => router.back()} />
        <ActivityIndicator color={t.primary} style={{ marginTop: 32 }} />
      </View>
    )
  }
  if (!row) {
    return (
      <View style={{ flex: 1, backgroundColor: t.bg }}>
        <NavBar title="Not found" backLabel="Servers" onBack={() => router.back()} />
        <Empty>Host #{String(id)} not found.</Empty>
      </View>
    )
  }

  const l = row.latest
  const online = isOnline(row)
  const alias = nullStr(row.public_alias) || row.name
  const group = nullStr(row.public_group)
  const cc = nullStr(row.country_code)
  const kernel = nullStr(row.agent_kernel)
  const st = statusOf({
    online,
    cpu: l?.cpu_pct ?? 0,
    mem: memPct(l) ?? 0,
    disk: firstDiskPct(l?.disks_json) ?? 0,
  })
  const lastSeen = typeof row.agent_last_seen === 'object' && row.agent_last_seen?.Valid
    ? row.agent_last_seen.Time
    : null
  const load = l?.load_1 != null ? l.load_1.toFixed(2) : EM_DASH

  const openConsole = () => router.push(`/(app)/console/${row.id}`)

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <NavBar
        title={alias}
        backLabel="Servers"
        onBack={() => router.back()}
        actions={<IconButton name="square-terminal" size={20} onPress={openConsole} />}
      />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 44, gap: 16 }}>
        <View style={{ gap: 9 }}>
          <Text
            numberOfLines={1}
            style={{ fontFamily: t.mono(600), fontSize: 23, letterSpacing: -0.23, color: t.text }}
          >
            {row.name}
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
            <Pill kind={st.kind}>{st.label}</Pill>
            {group ? <Pill kind="neutral">{group}</Pill> : null}
            {cc ? <Pill kind="neutral"><Cc code={cc} /></Pill> : null}
          </View>
        </View>

        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          <View style={{ flexGrow: 1, flexBasis: '46%' }}>
            <Kpi label="CPU" value={online ? pct(l?.cpu_pct ?? null) : EM_DASH} tone={barKind(l?.cpu_pct) || undefined} />
          </View>
          <View style={{ flexGrow: 1, flexBasis: '46%' }}>
            <Kpi label="Memory" value={online ? pct(memPct(l)) : EM_DASH} tone={barKind(memPct(l)) || undefined} />
          </View>
          <View style={{ flexGrow: 1, flexBasis: '46%' }}>
            <Kpi label="Disk" value={online ? pct(firstDiskPct(l?.disks_json)) : EM_DASH} tone={barKind(firstDiskPct(l?.disks_json)) || undefined} />
          </View>
          <View style={{ flexGrow: 1, flexBasis: '46%' }}>
            <Kpi label="Load 1m" value={online ? load : EM_DASH} />
          </View>
        </View>

        <Card>
          <LiveNet id={Number(id)} fallbackRx={l?.net_rx_bps ?? 0} fallbackTx={l?.net_tx_bps ?? 0}>
            {(rx, tx) => <Row first label="Net" value={online ? `↓ ${bps(rx)}  ↑ ${bps(tx)}` : EM_DASH} />}
          </LiveNet>
          <Row label="TCP conns" value={online && l?.tcp_conn != null ? l.tcp_conn.toLocaleString() : EM_DASH} />
          <Row label="OS / Arch" value={`${nullStr(row.agent_os) || EM_DASH} / ${nullStr(row.agent_arch) || EM_DASH}`} />
          <Row label="Kernel" value={kernel || EM_DASH} />
          <Row label="Last seen" value={lastSeen ? relTime(lastSeen) : EM_DASH} />
        </Card>

        <History id={row.id} />

        <View style={{ gap: 12 }}>
          <Button variant="primary" block icon="square-terminal" onPress={openConsole}>Open console</Button>
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <View style={{ flex: 1 }}>
              <Button variant="outline" block icon="folder-tree" onPress={() => router.push(`/(app)/files/${row.id}`)}>Files</Button>
            </View>
            <View style={{ flex: 1 }}>
              <Button variant="outline" block icon="play" onPress={() => router.push(`/(app)/scripts?serverId=${row.id}`)}>Run script</Button>
            </View>
          </View>
        </View>
      </ScrollView>
    </View>
  )
}
