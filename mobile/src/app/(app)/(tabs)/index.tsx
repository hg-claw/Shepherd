import { useState } from 'react'
import { ScrollView, View, Text, Pressable, RefreshControl, ActivityIndicator } from 'react-native'
import { useRouter } from 'expo-router'
import { useServers, useServersLatest, type ServerRow } from '@/api/servers'
import { isOnline, memPct, firstDiskPct, nullStr } from '@/api/metrics'
import { bps, cmpStr } from '@/lib/format'
import { useWallLiveStore } from '@/api/wallLive'
import { LiveNet } from '@/components/LiveNet'
import {
  Header, Kpi, Card, MetricBar, Pill, OnlineDot, Cc, Icon, IconButton, Empty, statusOf,
} from '@/components/ds'
import { useTheme, useThemeMode } from '@/theme'

const aliasOf = (r: ServerRow) => nullStr(r.public_alias) || r.name
const alertingScore = (l: ServerRow['latest']) =>
  Math.max(l?.cpu_pct ?? 0, memPct(l) ?? 0, firstDiskPct(l?.disks_json) ?? 0)

// Subscribes to the live store so only this strip re-renders on a frame.
function TrafficCard({ onlineRows }: { onlineRows: ServerRow[] }) {
  const t = useTheme()
  const live = useWallLiveStore((s) => s.live)
  const rx = onlineRows.reduce((a, r) => a + (live[r.id]?.rx_bps ?? r.latest?.net_rx_bps ?? 0), 0)
  const tx = onlineRows.reduce((a, r) => a + (live[r.id]?.tx_bps ?? r.latest?.net_tx_bps ?? 0), 0)
  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 13, paddingHorizontal: 14 }}>
        <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Icon name="arrow-down" size={15} color={t.primary} />
          <Text style={{ fontFamily: t.mono(500), fontSize: 14, color: t.text }}>{bps(rx)}</Text>
          <Text style={{ fontFamily: t.mono(), fontSize: 10.5, color: t.fgDim }}>in</Text>
        </View>
        <View style={{ width: 1, alignSelf: 'stretch', marginHorizontal: 14, marginVertical: -2, backgroundColor: t.border }} />
        <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
          <Icon name="arrow-up" size={15} color={t.muted} />
          <Text style={{ fontFamily: t.mono(500), fontSize: 14, color: t.text }}>{bps(tx)}</Text>
          <Text style={{ fontFamily: t.mono(), fontSize: 10.5, color: t.fgDim }}>out</Text>
        </View>
      </View>
    </Card>
  )
}

function HostCard({ row, onPress }: { row: ServerRow; onPress: () => void }) {
  const t = useTheme()
  const online = isOnline(row)
  const l = row.latest
  const alias = aliasOf(row)
  const cc = nullStr(row.country_code)
  const os = nullStr(row.agent_os)
  const st = statusOf({
    online,
    cpu: l?.cpu_pct ?? 0,
    mem: memPct(l) ?? 0,
    disk: firstDiskPct(l?.disks_json) ?? 0,
  })
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        backgroundColor: t.surface, borderWidth: 1,
        borderColor: pressed ? t.borderStrong : t.border,
        borderRadius: t.radiusLg, padding: 14, opacity: online ? 1 : 0.6,
      })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <OnlineDot online={online} />
        {cc ? <Cc code={cc} /> : null}
        <Text numberOfLines={1} style={{ flex: 1, fontFamily: t.mono(500), fontSize: t.fs.md, color: t.text }}>{alias}</Text>
        {online ? <Pill kind={st.kind}>{st.label}</Pill> : null}
      </View>
      {online ? (
        <>
          {os || l?.load_1 != null ? (
            <Text style={{ fontFamily: t.mono(), fontSize: 10.5, color: t.fgDim, marginTop: 6 }}>
              {[os, l?.load_1 != null ? `load ${l.load_1.toFixed(2)}` : null].filter(Boolean).join(' · ')}
            </Text>
          ) : null}
          <View style={{ marginTop: 11, gap: 7 }}>
            <MetricBar label="CPU" value={l?.cpu_pct ?? null} />
            <MetricBar label="MEM" value={memPct(l)} />
            <MetricBar label="DSK" value={firstDiskPct(l?.disks_json)} />
          </View>
          <LiveNet id={row.id} fallbackRx={l?.net_rx_bps ?? 0} fallbackTx={l?.net_tx_bps ?? 0}>
            {(rx, tx) => (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 9 }}>
                <Text style={{ fontFamily: t.mono(), fontSize: 11, color: t.muted }}>↓ {bps(rx)}</Text>
                <Text style={{ fontFamily: t.mono(), fontSize: 11, color: t.muted }}>↑ {bps(tx)}</Text>
                {l?.tcp_conn != null ? (
                  <Text style={{ marginLeft: 'auto', fontFamily: t.mono(), fontSize: 11, color: t.fgDim }}>
                    {l.tcp_conn.toLocaleString()} conns
                  </Text>
                ) : null}
              </View>
            )}
          </LiveNet>
        </>
      ) : (
        <Text style={{ fontFamily: t.mono(), fontSize: 10.5, color: t.fgDim, marginTop: 8 }}>agent offline</Text>
      )}
    </Pressable>
  )
}

export default function Home() {
  const t = useTheme()
  const router = useRouter()
  const toggleTheme = useThemeMode((s) => s.toggle)
  const list = useServers()          // fast — paints the list immediately
  const latest = useServersLatest()  // metrics — fills the bars in after
  const [refreshing, setRefreshing] = useState(false)
  const onRefresh = async () => {
    setRefreshing(true)
    try { await Promise.all([list.refetch(), latest.refetch()]) } finally { setRefreshing(false) }
  }
  // Merge: prefer the metric-enriched row once it arrives, else the plain row.
  const byId = new Map((latest.data ?? []).map((s) => [s.id, s]))
  const rows = (list.data ?? []).map((s) => byId.get(s.id) ?? s)
  const total = rows.length
  const onlineRows = rows.filter(isOnline)
  const alerting = onlineRows.filter((r) => alertingScore(r.latest) >= 80).length
  const offline = total - onlineRows.length

  const groups = new Map<string, ServerRow[]>()
  for (const r of rows) {
    const k = nullStr(r.public_group)
    const a = groups.get(k) ?? []
    a.push(r)
    groups.set(k, a)
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => cmpStr(a, b))

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <Header
        title="Servers"
        sub="Fleet at a glance"
        actions={
          <>
            <IconButton name={t.mode === 'dark' ? 'sun' : 'moon'} size={19} onPress={() => { void toggleTheme() }} />
            <IconButton name="plus" size={20} />
          </>
        }
      />
      {list.isLoading ? (
        <ActivityIndicator color={t.primary} style={{ marginTop: 32 }} />
      ) : list.isError ? (
        <Text style={{ color: t.error, padding: 16 }}>
          {list.error instanceof Error ? list.error.message : 'failed to load'}
        </Text>
      ) : (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 16, paddingBottom: 92, gap: 16 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={t.primary} />}
        >
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
            <View style={{ flexGrow: 1, flexBasis: '46%' }}><Kpi label="Nodes" value={total} /></View>
            <View style={{ flexGrow: 1, flexBasis: '46%' }}><Kpi label="Online" value={onlineRows.length} tone="ok" /></View>
            <View style={{ flexGrow: 1, flexBasis: '46%' }}><Kpi label="Offline" value={offline} tone={offline > 0 ? 'err' : undefined} /></View>
            <View style={{ flexGrow: 1, flexBasis: '46%' }}><Kpi label="Alerting" value={alerting} tone={alerting > 0 ? 'warn' : undefined} /></View>
          </View>

          <TrafficCard onlineRows={onlineRows} />

          {ordered.length === 0 ? <Empty>No servers.</Empty> : null}

          {ordered.map(([group, ss]) => {
            const gOnline = ss.filter(isOnline).length
            const sorted = ss.slice().sort((a, b) => {
              const oa = isOnline(a) ? 0 : 1, ob = isOnline(b) ? 0 : 1
              return oa - ob || cmpStr(aliasOf(a), aliasOf(b))
            })
            return (
              <View key={group || '_'} style={{ gap: 8 }}>
                <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, paddingHorizontal: 2 }}>
                  <Text style={{ fontFamily: t.mono(600), fontSize: 12.5, color: t.text }}>{group || 'Ungrouped'}</Text>
                  <Text style={{ fontFamily: t.mono(), fontSize: 11, color: t.fgDim }}>{gOnline}/{ss.length} online</Text>
                </View>
                {sorted.map((r) => (
                  <HostCard key={r.id} row={r} onPress={() => router.push(`/(app)/server/${r.id}`)} />
                ))}
              </View>
            )
          })}
        </ScrollView>
      )}
    </View>
  )
}
