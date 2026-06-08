import { View, Text, Pressable } from 'react-native'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { useServer } from '@/api/servers'
import { isOnline, memPct, firstDiskPct, nullStr } from '@/api/metrics'
import { bps, pct, relTime } from '@/lib/format'
import { theme } from '@/theme'
import { Screen } from '@/components/Screen'
import { LiveNet } from '@/components/LiveNet'

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: theme.space(2), borderBottomWidth: 1, borderColor: theme.border }}>
      <Text style={{ color: theme.textDim }}>{label}</Text>
      <Text style={{ color: theme.text, fontFamily: 'monospace' }}>{value}</Text>
    </View>
  )
}

export default function ServerDetail() {
  const router = useRouter()
  const { id } = useLocalSearchParams<{ id: string }>()
  const row = useServer(Number(id))
  if (!row) {
    return <Screen edges={['bottom']}><View style={{ padding: theme.space(5) }}><Text style={{ color: theme.textDim }}>Server not found.</Text></View></Screen>
  }
  const l = row.latest
  const lastSeen = typeof row.agent_last_seen === 'object' && row.agent_last_seen?.Valid ? row.agent_last_seen.Time : null
  return (
    <Screen edges={['bottom']}>
    <Stack.Screen options={{ title: row.name }} />
    <View style={{ padding: theme.space(4) }}>
      <Text style={{ color: theme.text, fontSize: 20, fontWeight: '600' }}>{row.name}</Text>
      <Text style={{ color: isOnline(row) ? '#4ade80' : theme.textDim, marginBottom: theme.space(3) }}>{isOnline(row) ? 'online' : 'offline'}</Text>
      <Stat label="CPU" value={pct(l?.cpu_pct ?? null)} />
      <Stat label="Memory" value={pct(memPct(l ?? null))} />
      <Stat label="Disk" value={pct(firstDiskPct(l?.disks_json))} />
      <LiveNet id={Number(id)} fallbackRx={l?.net_rx_bps ?? 0} fallbackTx={l?.net_tx_bps ?? 0}>
        {(rx, tx) => <Stat label="Net" value={`↓ ${bps(rx)}  ↑ ${bps(tx)}`} />}
      </LiveNet>
      <Stat label="Load (1m)" value={l?.load_1 != null ? l.load_1.toFixed(2) : '—'} />
      <Stat label="TCP conns" value={l?.tcp_conn != null ? String(l.tcp_conn) : '—'} />
      <Stat label="OS / Arch" value={`${nullStr(row.agent_os) || '—'} / ${nullStr(row.agent_arch) || '—'}`} />
      <Stat label="Last seen" value={lastSeen ? relTime(lastSeen) : '—'} />
      <Pressable onPress={() => router.push(`/(app)/console/${row.id}`)} style={{ marginTop: theme.space(5), padding: theme.space(3), borderRadius: 8, backgroundColor: theme.accent, alignItems: 'center' }}>
        <Text style={{ color: theme.bg, fontWeight: '600' }}>Open console</Text>
      </Pressable>
      <Pressable onPress={() => router.push(`/(app)/files/${row.id}`)} style={{ marginTop: theme.space(3), padding: theme.space(3), borderRadius: 8, borderWidth: 1, borderColor: theme.border, alignItems: 'center' }}>
        <Text style={{ color: theme.text }}>Files</Text>
      </Pressable>
      <Pressable onPress={() => router.push(`/(app)/scripts?serverId=${row.id}`)} style={{ marginTop: theme.space(3), padding: theme.space(3), borderRadius: 8, borderWidth: 1, borderColor: theme.border, alignItems: 'center' }}>
        <Text style={{ color: theme.text }}>Run script</Text>
      </Pressable>
    </View>
    </Screen>
  )
}
