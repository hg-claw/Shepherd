import { useState } from 'react'
import { FlatList, View, Text, Pressable, RefreshControl, ActivityIndicator } from 'react-native'
import { useRouter } from 'expo-router'
import { useServers, useServersLatest, type ServerRow } from '@/api/servers'
import { isOnline, memPct, firstDiskPct, nullStr } from '@/api/metrics'
import { bps, countryFlag, cmpStr } from '@/lib/format'
import { useAuth } from '@/store/auth'
import { useWallLiveStore } from '@/api/wallLive'
import { LiveNet } from '@/components/LiveNet'
import { MetricBar } from '@/components/MetricBar'
import { OnlineDot } from '@/components/OnlineDot'
import { Screen } from '@/components/Screen'
import { theme } from '@/theme'

const aliasOf = (r: ServerRow) => nullStr(r.public_alias) || r.name

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'ok' | 'err' }) {
  return (
    <View style={{ flexGrow: 1, flexBasis: 90, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 8, padding: theme.space(2) }}>
      <Text style={{ color: theme.textDim, fontSize: 10 }}>{label}</Text>
      <Text style={{ color: tone === 'err' ? theme.error : tone === 'ok' ? '#4ade80' : theme.text, fontSize: 16, fontWeight: '700' }}>{value}</Text>
      {sub ? <Text style={{ color: theme.textDim, fontSize: 10 }}>{sub}</Text> : null}
    </View>
  )
}

function RealtimeStat({ onlineRows }: { onlineRows: ServerRow[] }) {
  const live = useWallLiveStore((s) => s.live)
  const rx = onlineRows.reduce((a, r) => a + (live[r.id]?.rx_bps ?? r.latest?.net_rx_bps ?? 0), 0)
  const tx = onlineRows.reduce((a, r) => a + (live[r.id]?.tx_bps ?? r.latest?.net_tx_bps ?? 0), 0)
  return <Stat label="Realtime" value={`↓ ${bps(rx)}`} sub={`↑ ${bps(tx)}`} />
}

function SummaryStrip({ total, online, offline, onlineRows }: { total: number; online: number; offline: number; onlineRows: ServerRow[] }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space(2), padding: theme.space(3) }}>
      <Stat label="Nodes" value={String(total)} />
      <Stat label="Online" value={String(online)} tone="ok" />
      <Stat label="Offline" value={String(offline)} tone={offline > 0 ? 'err' : undefined} />
      <RealtimeStat onlineRows={onlineRows} />
    </View>
  )
}

function ServerCard({ row, onPress }: { row: ServerRow; onPress: () => void }) {
  const online = isOnline(row)
  const l = row.latest
  const flag = countryFlag(nullStr(row.country_code))
  return (
    <Pressable onPress={onPress} style={{ backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 10, padding: theme.space(3), marginBottom: theme.space(2), opacity: online ? 1 : 0.6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space(2) }}>
        <OnlineDot online={online} />
        {flag ? <Text style={{ fontSize: 14 }}>{flag}</Text> : null}
        <Text style={{ color: theme.text, fontWeight: '600', flex: 1 }} numberOfLines={1}>{aliasOf(row)}</Text>
        {online && l ? <Text style={{ color: theme.textDim, fontSize: 11 }}>load {l.load_1?.toFixed(2) ?? '—'}</Text> : null}
      </View>
      {l ? (
        <View style={{ marginTop: theme.space(2), gap: theme.space(1) }}>
          {nullStr(row.agent_os) ? <Text style={{ color: theme.textDim, fontSize: 10 }}>{nullStr(row.agent_os)}{nullStr(row.agent_arch) ? ` · ${nullStr(row.agent_arch)}` : ''}</Text> : null}
          <MetricBar label="CPU" value={l.cpu_pct ?? null} />
          <MetricBar label="MEM" value={memPct(l)} />
          <MetricBar label="DSK" value={firstDiskPct(l.disks_json)} />
          <LiveNet id={row.id} fallbackRx={l.net_rx_bps ?? 0} fallbackTx={l.net_tx_bps ?? 0}>
            {(rx, tx) => <Text style={{ color: theme.textDim, fontFamily: 'monospace', fontSize: 11, marginTop: theme.space(1) }}>↓ {bps(rx)}   ↑ {bps(tx)}</Text>}
          </LiveNet>
        </View>
      ) : online ? null : <Text style={{ color: theme.textDim, fontSize: 11, marginTop: theme.space(1) }}>offline</Text>}
    </Pressable>
  )
}

export default function Home() {
  const router = useRouter()
  const logout = useAuth((s) => s.logout)
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

  const groups = new Map<string, ServerRow[]>()
  for (const r of rows) {
    const k = nullStr(r.public_group)
    const a = groups.get(k) ?? []
    a.push(r)
    groups.set(k, a)
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => cmpStr(a, b))

  return (
    <Screen>
      <View style={{ flexDirection: 'row', alignItems: 'center', padding: theme.space(3), borderBottomWidth: 1, borderColor: theme.border }}>
        <Text style={{ color: theme.text, fontSize: 18, fontWeight: '600', flex: 1 }}>Servers</Text>
        <Pressable onPress={() => router.push('/(app)/plugins')} style={{ marginRight: theme.space(3) }}><Text style={{ color: theme.accent }}>Plugins</Text></Pressable>
        <Pressable onPress={() => router.push('/(app)/settings')} style={{ marginRight: theme.space(3) }}><Text style={{ color: theme.accent }}>Settings</Text></Pressable>
        <Pressable onPress={logout}><Text style={{ color: theme.accent }}>Log out</Text></Pressable>
      </View>
      {list.isLoading ? <ActivityIndicator color={theme.accent} style={{ marginTop: theme.space(8) }} />
        : list.isError ? <Text style={{ color: theme.error, padding: theme.space(4) }}>{list.error instanceof Error ? list.error.message : 'failed to load'}</Text>
        : <FlatList
            data={ordered}
            keyExtractor={([g]) => g || '_'}
            ListHeaderComponent={<SummaryStrip total={total} online={onlineRows.length} offline={total - onlineRows.length} onlineRows={onlineRows} />}
            renderItem={({ item }: { item: [string, ServerRow[]] }) => {
              const [group, ss] = item
              const gOnline = ss.filter(isOnline).length
              const sorted = ss.slice().sort((a, b) => {
                const oa = isOnline(a) ? 0 : 1, ob = isOnline(b) ? 0 : 1
                return oa - ob || cmpStr(aliasOf(a), aliasOf(b))
              })
              return (
                <View style={{ paddingHorizontal: theme.space(3), paddingTop: theme.space(3) }}>
                  <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: theme.space(2), marginBottom: theme.space(2) }}>
                    <Text style={{ color: theme.text, fontWeight: '600', fontSize: 13 }}>{group || 'Ungrouped'}</Text>
                    <Text style={{ color: theme.textDim, fontSize: 11 }}>{gOnline}/{ss.length} online</Text>
                  </View>
                  {sorted.map((r) => <ServerCard key={r.id} row={r} onPress={() => router.push(`/(app)/server/${r.id}`)} />)}
                </View>
              )
            }}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.accent} />}
            ListEmptyComponent={<Text style={{ color: theme.textDim, padding: theme.space(4) }}>No servers.</Text>}
          />}
    </Screen>
  )
}
